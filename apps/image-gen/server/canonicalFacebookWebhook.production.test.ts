import { createHmac } from "node:crypto";
import http from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureMetaWebhookRawBody } from "./_core/webhookSignatureVerification";
import { bindTestHttpServer } from "./testHttpServer";

const queueMocks = vi.hoisted(() => ({
  enqueue:
    vi.fn<
      (channel: "facebook" | "whatsapp", payload: unknown) => Promise<void>
    >(),
  inline: vi.fn(),
  schedule: vi.fn(),
}));

vi.mock("./_core/meta/webhookIngressQueue", async importOriginal => {
  const actual =
    await importOriginal<typeof import("./_core/meta/webhookIngressQueue")>();

  return {
    ...actual,
    enqueueWebhookIngressDelivery: queueMocks.enqueue,
    processWebhookDeliveryInline: queueMocks.inline,
    scheduleWebhookIngressDrain: queueMocks.schedule,
  };
});

const CANONICAL_FACEBOOK_WEBHOOK_PATH = "/facebook/webhook";
const FACEBOOK_APP_SECRET = "synthetic-facebook-app-secret";
const FACEBOOK_VERIFY_TOKEN = "synthetic-facebook-verify-token";

const validMessengerPayload = {
  object: "page",
  entry: [
    {
      id: "synthetic-page-id",
      time: 1_777_000_000_000,
      messaging: [
        {
          sender: { id: "synthetic-sender-id" },
          recipient: { id: "synthetic-page-id" },
          timestamp: 1_777_000_000_000,
          message: {
            mid: "synthetic-message-id",
            text: "synthetic test message",
          },
        },
      ],
    },
  ],
};

function signBody(body: string): string {
  return `sha256=${createHmac("sha256", FACEBOOK_APP_SECRET)
    .update(body)
    .digest("hex")}`;
}

async function withCanonicalFacebookWebhookApp<T>(
  run: (baseUrl: string) => Promise<T>
): Promise<T> {
  const { registerWebhookRuntime } =
    await import("./_core/runtime/webhookRuntime");
  const app = express();

  app.use(
    express.json({
      verify: captureMetaWebhookRawBody,
    })
  );
  registerWebhookRuntime(app);

  const server = http.createServer(app);
  const boundServer = await bindTestHttpServer(server);

  try {
    return await run(boundServer.baseUrl);
  } finally {
    await boundServer.close();
  }
}

async function postCanonicalWebhook(
  baseUrl: string,
  body: string,
  signature?: string
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (signature) {
    headers["x-hub-signature-256"] = signature;
  }

  return fetch(`${baseUrl}${CANONICAL_FACEBOOK_WEBHOOK_PATH}`, {
    method: "POST",
    headers,
    body,
  });
}

describe("canonical production Facebook webhook route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FB_APP_SECRET", FACEBOOK_APP_SECRET);
    vi.stubEnv("FB_VERIFY_TOKEN", FACEBOOK_VERIFY_TOKEN);
    vi.stubEnv("META_VERIFY_TOKEN", "");
    vi.stubEnv("REDIS_URL", "redis://synthetic.invalid:6379");
    vi.stubEnv("WEBHOOK_INGRESS_ENQUEUE_TIMEOUT_MS", "25");
    queueMocks.enqueue.mockResolvedValue();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the Meta challenge on the exact canonical callback", async () => {
    await withCanonicalFacebookWebhookApp(async baseUrl => {
      const query = new URLSearchParams({
        "hub.mode": "subscribe",
        "hub.verify_token": FACEBOOK_VERIFY_TOKEN,
        "hub.challenge": "synthetic-challenge",
      });
      const response = await fetch(
        `${baseUrl}${CANONICAL_FACEBOOK_WEBHOOK_PATH}?${query}`
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/plain");
      await expect(response.text()).resolves.toBe("synthetic-challenge");
      expect(queueMocks.enqueue).not.toHaveBeenCalled();
    });
  });

  it("acks a signed delivery only after durable enqueue succeeds", async () => {
    const body = JSON.stringify(validMessengerPayload);

    await withCanonicalFacebookWebhookApp(async baseUrl => {
      const response = await postCanonicalWebhook(
        baseUrl,
        body,
        signBody(body)
      );

      expect(response.status).toBe(200);
      expect(queueMocks.enqueue).toHaveBeenCalledOnce();
      expect(queueMocks.enqueue).toHaveBeenCalledWith(
        "facebook",
        validMessengerPayload
      );
      expect(queueMocks.schedule).toHaveBeenCalledTimes(2);
      expect(queueMocks.inline).not.toHaveBeenCalled();
    });
  });

  it("rejects a missing signature before durable enqueue", async () => {
    const body = JSON.stringify(validMessengerPayload);

    await withCanonicalFacebookWebhookApp(async baseUrl => {
      const response = await postCanonicalWebhook(baseUrl, body);

      expect(response.status).toBe(403);
      expect(queueMocks.enqueue).not.toHaveBeenCalled();
      expect(queueMocks.inline).not.toHaveBeenCalled();
    });
  });

  it("rejects a bad signature before durable enqueue", async () => {
    const body = JSON.stringify(validMessengerPayload);

    await withCanonicalFacebookWebhookApp(async baseUrl => {
      const response = await postCanonicalWebhook(
        baseUrl,
        body,
        `sha256=${"0".repeat(64)}`
      );

      expect(response.status).toBe(403);
      expect(queueMocks.enqueue).not.toHaveBeenCalled();
      expect(queueMocks.inline).not.toHaveBeenCalled();
    });
  });

  it("rejects a signed schema-invalid payload before durable enqueue", async () => {
    const body = JSON.stringify({ object: "page", entry: [] });

    await withCanonicalFacebookWebhookApp(async baseUrl => {
      const response = await postCanonicalWebhook(
        baseUrl,
        body,
        signBody(body)
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Invalid webhook payload",
      });
      expect(queueMocks.enqueue).not.toHaveBeenCalled();
      expect(queueMocks.inline).not.toHaveBeenCalled();
    });
  });

  it("returns 503 without inline fallback when durable enqueue fails", async () => {
    queueMocks.enqueue.mockRejectedValueOnce(
      new Error("synthetic durable queue failure")
    );
    const body = JSON.stringify(validMessengerPayload);

    await withCanonicalFacebookWebhookApp(async baseUrl => {
      const response = await postCanonicalWebhook(
        baseUrl,
        body,
        signBody(body)
      );

      expect(response.status).toBe(503);
      expect(queueMocks.enqueue).toHaveBeenCalledOnce();
      expect(queueMocks.schedule).toHaveBeenCalledOnce();
      expect(queueMocks.inline).not.toHaveBeenCalled();
    });
  });

  it("returns 503 without ack or inline fallback when durable enqueue times out", async () => {
    vi.stubEnv("WEBHOOK_INGRESS_ENQUEUE_TIMEOUT_MS", "1");
    queueMocks.enqueue.mockImplementationOnce(
      () => new Promise<void>(() => undefined)
    );
    const body = JSON.stringify(validMessengerPayload);

    await withCanonicalFacebookWebhookApp(async baseUrl => {
      const response = await postCanonicalWebhook(
        baseUrl,
        body,
        signBody(body)
      );

      expect(response.status).toBe(503);
      expect(queueMocks.enqueue).toHaveBeenCalledOnce();
      expect(queueMocks.schedule).toHaveBeenCalledOnce();
      expect(queueMocks.inline).not.toHaveBeenCalled();
    });
  });
});
