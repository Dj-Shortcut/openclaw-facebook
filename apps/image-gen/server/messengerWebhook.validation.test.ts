import { createHmac } from "node:crypto";
import http from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindTestHttpServer } from "./testHttpServer";

import {
  captureMetaWebhookRawBody,
  verifyMetaWebhookSignature,
} from "./_core/webhookSignatureVerification";
import { registerMetaWebhookRoutes } from "./_core/meta/webhookRoutes";
import * as webhookIngressQueue from "./_core/meta/webhookIngressQueue";

function buildSignature(body: string, secret: string): string {
  const digest = createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${digest}`;
}

async function postWebhook(
  body: string,
  signature: string,
  path = "/webhook/facebook",
): Promise<{ status: number; payload: string }> {
  const app = express();

  app.use(
    express.json({
      verify: captureMetaWebhookRawBody,
    }),
  );
  app.use("/webhook", verifyMetaWebhookSignature);
  registerMetaWebhookRoutes(app);

  const server = http.createServer(app);
  const boundServer = await bindTestHttpServer(server);

  try {
    return await new Promise<{ status: number; payload: string }>((resolve, reject) => {
      const request = http.request(
        {
          hostname: "127.0.0.1",
          port: boundServer.port,
          path,
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            "x-hub-signature-256": signature,
          },
        },
        response => {
          let payload = "";
          response.on("data", chunk => {
            payload += chunk;
          });
          response.on("end", () => {
            resolve({ status: response.statusCode ?? 0, payload });
          });
        },
      );

      request.on("error", reject);
      request.write(body);
      request.end();
    });
  } finally {
    await boundServer.close();
  }
}

describe("messenger webhook payload validation", () => {
  const validMessengerPayload = {
    object: "page",
    entry: [
      {
        id: "page-123",
        time: 1_776_447_284_000,
        messaging: [
          {
            sender: { id: "user-123" },
            recipient: { id: "page-123" },
            timestamp: 1_776_447_284_000,
            message: {
              mid: "mid.123",
              text: "hello",
            },
          },
        ],
      },
    ],
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    delete process.env.FB_APP_SECRET;
    delete process.env.REDIS_URL;
  });

  it("rejects schema-invalid signed webhook payloads", async () => {
    const secret = "test-secret";
    process.env.FB_APP_SECRET = secret;

    const body = JSON.stringify({ object: "page", entry: [{ messaging: "invalid" }] });
    const response = await postWebhook(body, buildSignature(body, secret));

    expect(response.status).toBe(400);
    expect(response.payload).toContain("Invalid webhook payload");
  });

  it("accepts signed payloads on the generic /webhook callback path", async () => {
    const secret = "test-secret";
    process.env.FB_APP_SECRET = secret;

    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [],
    });
    const response = await postWebhook(body, buildSignature(body, secret), "/webhook");

    expect(response.status).toBe(200);
  });

  it("does not rate limit repeated signed webhook deliveries from the same IP", async () => {
    const secret = "test-secret";
    process.env.FB_APP_SECRET = secret;

    const body = JSON.stringify({ object: "page", entry: [] });
    let response: { status: number; payload: string } | undefined;

    for (let attempt = 0; attempt < 61; attempt += 1) {
      response = await postWebhook(body, buildSignature(body, secret));
    }

    expect(response?.status).toBe(400);
  }, 15000);

  it("falls back to inline processing when durable enqueue fails in redis-backed mode", async () => {
    const secret = "test-secret";
    process.env.FB_APP_SECRET = secret;
    process.env.REDIS_URL = "redis://example.test:6379";

    const inlineSpy = vi
      .spyOn(webhookIngressQueue, "processWebhookDeliveryInline")
      .mockImplementation(() => {});
    vi.spyOn(webhookIngressQueue, "enqueueWebhookIngressDelivery").mockRejectedValue(
      new Error("redis unavailable"),
    );
    vi.spyOn(webhookIngressQueue, "scheduleWebhookIngressDrain").mockImplementation(() => {});

    const body = JSON.stringify(validMessengerPayload);
    const response = await postWebhook(body, buildSignature(body, secret));

    expect(response.status).toBe(200);
    expect(inlineSpy).toHaveBeenCalledWith("facebook", validMessengerPayload);
  });

  it("acks after durable enqueue succeeds in redis-backed mode", async () => {
    const secret = "test-secret";
    process.env.FB_APP_SECRET = secret;
    process.env.REDIS_URL = "redis://example.test:6379";

    const enqueueSpy = vi
      .spyOn(webhookIngressQueue, "enqueueWebhookIngressDelivery")
      .mockResolvedValue();
    const drainSpy = vi
      .spyOn(webhookIngressQueue, "scheduleWebhookIngressDrain")
      .mockImplementation(() => {});

    const body = JSON.stringify(validMessengerPayload);
    const response = await postWebhook(body, buildSignature(body, secret));

    expect(response.status).toBe(200);
    expect(enqueueSpy).toHaveBeenCalledWith("facebook", validMessengerPayload);
    expect(drainSpy).toHaveBeenCalled();
  });
});
