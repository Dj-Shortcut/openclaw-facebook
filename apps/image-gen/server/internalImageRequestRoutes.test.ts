import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  acceptInternalMessengerImageRequestMock,
  processFacebookWebhookPayloadMock,
} = vi.hoisted(() => ({
  acceptInternalMessengerImageRequestMock: vi.fn(async () => undefined),
  processFacebookWebhookPayloadMock: vi.fn(async () => undefined),
}));

vi.mock("./_core/messengerWebhook", () => ({
  acceptInternalMessengerImageRequest: acceptInternalMessengerImageRequestMock,
  processFacebookWebhookPayload: processFacebookWebhookPayloadMock,
}));

import { registerInternalImageRequestRoutes } from "./_core/internalImageRequestRoutes";

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

function postInternalImageRequest(baseUrl: string): Promise<Response> {
  return fetch(`${baseUrl}/internal/messenger/image-request`, {
    method: "POST",
    headers: {
      authorization: "Bearer route-token",
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

beforeEach(() => {
  process.env.INTERNAL_IMAGE_REQUEST_TOKEN = "route-token";
  acceptInternalMessengerImageRequestMock.mockReset();
  acceptInternalMessengerImageRequestMock.mockResolvedValue(undefined);
  processFacebookWebhookPayloadMock.mockReset();
});

afterEach(() => {
  if (originalToken === undefined) {
    delete process.env.INTERNAL_IMAGE_REQUEST_TOKEN;
  } else {
    process.env.INTERNAL_IMAGE_REQUEST_TOKEN = originalToken;
  }
});

describe("internal Messenger image request route", () => {
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

      await new Promise(resolve => setTimeout(resolve, 25));
      expect(acceptInternalMessengerImageRequestMock).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);

      resolveAccept();
      const response = await responsePromise;

      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ status: "queued" });
    });
  });
});
