import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  acceptInternalMessengerImageRequestMock,
  processFacebookWebhookPayloadMock,
  timingSafeEqualMock,
} = vi.hoisted(() => ({
  acceptInternalMessengerImageRequestMock: vi.fn(async () => undefined),
  processFacebookWebhookPayloadMock: vi.fn(async () => undefined),
  timingSafeEqualMock: vi.fn((left: Buffer, right: Buffer) =>
    left.equals(right)
  ),
}));

vi.mock("node:crypto", async importOriginal => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    timingSafeEqual: timingSafeEqualMock,
  };
});

vi.mock("./_core/messengerWebhook", () => ({
  acceptInternalMessengerImageRequest: acceptInternalMessengerImageRequestMock,
  processFacebookWebhookPayload: processFacebookWebhookPayloadMock,
}));

import {
  registerInternalImageRequestRoutes,
  timingSafeTokenEqual,
} from "./_core/internalImageRequestRoutes";
import { InternalMessengerImageRequestNotQueuedError } from "./_core/internalImageRequestErrors";
import { MESSENGER_SEND_SKIPPED } from "./_core/webhookFallback";

const originalToken = process.env.INTERNAL_IMAGE_REQUEST_TOKEN;

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  registerInternalImageRequestRoutes(app);
  return app;
}

async function withListeningApp<T>(
  app: express.Express,
  callback: (baseUrl: string) => Promise<T>
): Promise<T> {
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });
  }
}

function postInternalImageRequest(
  baseUrl: string,
  token = "route-token"
): Promise<Response> {
  return fetch(`${baseUrl}/internal/messenger/image-request`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      psid: "route-user",
      prompt: "Restyle deze foto cinematic",
      reqId: "req-route",
      lang: "nl",
      timestamp: 1_771_000_000_000,
      sourceImageUrl: "https://img.example/source.jpg",
    }),
  });
}

async function waitForMockCall(
  mock: { mock: { calls: unknown[][] } },
  expectedCalls: number
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (mock.mock.calls.length < expectedCalls) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${expectedCalls} mock call(s)`);
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

beforeEach(() => {
  process.env.INTERNAL_IMAGE_REQUEST_TOKEN = "route-token";
  acceptInternalMessengerImageRequestMock.mockReset();
  acceptInternalMessengerImageRequestMock.mockResolvedValue(undefined);
  processFacebookWebhookPayloadMock.mockReset();
  timingSafeEqualMock.mockClear();
});

afterEach(() => {
  if (originalToken === undefined) {
    delete process.env.INTERNAL_IMAGE_REQUEST_TOKEN;
    return;
  }
  process.env.INTERNAL_IMAGE_REQUEST_TOKEN = originalToken;
});

describe("internal Messenger image request route", () => {
  it("compares internal bearer tokens with the timing-safe helper", () => {
    expect(timingSafeTokenEqual("route-token", "route-token")).toBe(true);
    expect(timingSafeEqualMock).toHaveBeenCalledTimes(1);

    expect(timingSafeTokenEqual("route-token", "route-taken")).toBe(false);
    expect(timingSafeEqualMock).toHaveBeenCalledTimes(2);

    expect(timingSafeTokenEqual("route-token", "short")).toBe(false);
    expect(timingSafeTokenEqual("", "route-token")).toBe(false);
    expect(timingSafeTokenEqual("route-token", "")).toBe(false);
    expect(timingSafeEqualMock).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid bearer tokens before accepting internal image requests", async () => {
    await withListeningApp(createApp(), async baseUrl => {
      const response = await postInternalImageRequest(baseUrl, "wrongtoken");

      expect(response.status).toBe(403);
    });

    expect(acceptInternalMessengerImageRequestMock).not.toHaveBeenCalled();
  });

  it("does not return 202 when durable accept/enqueue fails", async () => {
    acceptInternalMessengerImageRequestMock.mockRejectedValueOnce(
      new Error("Redis unavailable")
    );

    await withListeningApp(createApp(), async baseUrl => {
      const response = await postInternalImageRequest(baseUrl);

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "Image request was not queued",
      });
    });

    expect(acceptInternalMessengerImageRequestMock).toHaveBeenCalledWith({
      psid: "route-user",
      prompt: "Restyle deze foto cinematic",
      reqId: "req-route",
      lang: "nl",
      timestamp: 1_771_000_000_000,
      sourceImageUrl: "https://img.example/source.jpg",
    });
  });

  it("maps non-queued control-flow errors to a non-retryable response", async () => {
    acceptInternalMessengerImageRequestMock.mockRejectedValueOnce(
      new InternalMessengerImageRequestNotQueuedError("missing source image")
    );

    await withListeningApp(createApp(), async baseUrl => {
      const response = await postInternalImageRequest(baseUrl);

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "Image request was not queued",
        reason: "not_queued",
        retryable: false,
      });
    });
  });

  it("maps named non-queued errors across module boundaries", async () => {
    const crossBoundaryError = new Error("missing source image");
    crossBoundaryError.name = "InternalMessengerImageRequestNotQueuedError";
    acceptInternalMessengerImageRequestMock.mockRejectedValueOnce(
      crossBoundaryError
    );

    await withListeningApp(createApp(), async baseUrl => {
      const response = await postInternalImageRequest(baseUrl);

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "Image request was not queued",
        reason: "not_queued",
        retryable: false,
      });
    });
  });

  it("maps skipped internal request outcomes to a non-retryable response", async () => {
    acceptInternalMessengerImageRequestMock.mockResolvedValueOnce({
      ...MESSENGER_SEND_SKIPPED,
    });

    await withListeningApp(createApp(), async baseUrl => {
      const response = await postInternalImageRequest(baseUrl);

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "Image request was not queued",
        reason: "not_queued",
        retryable: false,
      });
    });
  });

  it("returns 202 only after acceptInternalMessengerImageRequest resolves", async () => {
    let resolveAccept!: () => void;
    acceptInternalMessengerImageRequestMock.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          resolveAccept = resolve;
        })
    );

    await withListeningApp(createApp(), async baseUrl => {
      let settled = false;
      const responsePromise = postInternalImageRequest(baseUrl).then(
        response => {
          settled = true;
          return response;
        }
      );

      await waitForMockCall(acceptInternalMessengerImageRequestMock, 1);
      expect(acceptInternalMessengerImageRequestMock).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);

      resolveAccept();
      const response = await responsePromise;

      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ status: "queued" });
    });
  });
});
