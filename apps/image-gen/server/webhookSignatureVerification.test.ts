import { createHmac } from "node:crypto";
import http from "node:http";
import express, { type Request, type Response } from "express";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureMetaWebhookRawBody,
  verifyMetaWebhookSignature,
} from "./_core/webhookSignatureVerification";
import { bindTestHttpServer } from "./testHttpServer";

function buildSignature(body: string, secret: string): string {
  const digest = createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${digest}`;
}

async function postWebhook(
  body: string,
  signature?: string,
  path = "/webhook/facebook"
): Promise<{ status: number; payload: string }> {
  const app = express();

  app.use(
    express.json({
      verify: captureMetaWebhookRawBody,
    })
  );

  app.post("/webhook/:channel", verifyMetaWebhookSignature, (req: Request, res: Response) => {
    res.status(200).json({
      channel: req.params.channel,
      ok: true,
      object: (req.body as { object?: string }).object,
    });
  });

  const server = http.createServer(app);
  const boundServer = await bindTestHttpServer(server);

  const headers: Record<string, string | number> = {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  };

  if (signature) {
    headers["x-hub-signature-256"] = signature;
  }

  const result = await new Promise<{ status: number; payload: string }>((resolve, reject) => {
    const request = http.request(
          {
            hostname: "127.0.0.1",
            port: boundServer.port,
            path,
            method: "POST",
        headers,
      },
      (response) => {
        let payload = "";
        response.on("data", (chunk) => {
          payload += chunk;
        });
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, payload });
        });
      }
    );

    request.on("error", reject);
    request.write(body);
    request.end();
  });

  await boundServer.close();

  return result;
}

describe("Meta webhook signature verification", () => {
  afterEach(() => {
    delete process.env.FB_APP_SECRET;
  });

  it("rejects webhook requests with a missing signature", async () => {
    process.env.FB_APP_SECRET = "test-secret";

    const body = JSON.stringify({ object: "page", entry: [] });
    const response = await postWebhook(body);

    expect(response.status).toBe(403);
    expect(response.payload).toContain("Signature verification failed");
  });

  it("rejects unsigned WhatsApp webhook requests", async () => {
    process.env.FB_APP_SECRET = "test-secret";

    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    const response = await postWebhook(body, undefined, "/webhook/whatsapp");

    expect(response.status).toBe(403);
    expect(response.payload).toContain("Signature verification failed");
  });

  it("accepts webhook requests with a valid signature", async () => {
    const secret = "test-secret";
    process.env.FB_APP_SECRET = secret;

    const body = JSON.stringify({ object: "page", entry: [] });
    const response = await postWebhook(body, buildSignature(body, secret));

    expect(response.status).toBe(200);
    expect(response.payload).toContain('"ok":true');
  });

  it("allows signed WhatsApp webhook requests to reach the registered route", async () => {
    const secret = "test-secret";
    process.env.FB_APP_SECRET = secret;

    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    const response = await postWebhook(
      body,
      buildSignature(body, secret),
      "/webhook/whatsapp"
    );

    expect(response.status).toBe(200);
    expect(response.payload).toContain('"channel":"whatsapp"');
    expect(response.payload).toContain('"ok":true');
  });

  it("rejects webhook requests with an invalid signature", async () => {
    process.env.FB_APP_SECRET = "test-secret";

    const body = JSON.stringify({ object: "page", entry: [] });
    const response = await postWebhook(body, "sha256=invalid");

    expect(response.status).toBe(403);
    expect(response.payload).toContain("Signature verification failed");
  });

});
