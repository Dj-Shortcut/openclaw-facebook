import { createHmac } from "node:crypto";
import http from "node:http";
import express from "express";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  captureMetaWebhookRawBody,
  verifyMetaWebhookSignature,
} from "./_core/webhookSignatureVerification";
import {
  attachRequestTracing,
  createRequestMetricsMiddleware,
  registerMetricsRoute,
} from "./_core/observability";
import { bindTestHttpServer } from "./testHttpServer";

const { rateLimitMock } = vi.hoisted(() => ({
  rateLimitMock: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock("express-rate-limit", () => ({
  default: rateLimitMock,
}));

async function getWebhook(
  path: string,
  options: { includeSignatureMiddleware?: boolean } = {}
): Promise<{
  contentType: string;
  payload: string;
  signatureMiddlewareCalls: number;
  status: number;
}> {
  const { registerMetaWebhookRoutes } = await import("./_core/meta/webhookRoutes");
  const app = express();
  let signatureMiddlewareCalls = 0;

  if (options.includeSignatureMiddleware) {
    app.use("/webhook", (req, res, next) => {
      signatureMiddlewareCalls += 1;
      verifyMetaWebhookSignature(req, res, next);
    });
  }

  registerMetaWebhookRoutes(app);

  const server = http.createServer(app);
  const boundServer = await bindTestHttpServer(server);

  const response = await (async () => {
    try {
      return await new Promise<{ contentType: string; payload: string; status: number }>((resolve, reject) => {
        const request = http.request(
          {
            hostname: "127.0.0.1",
            port: boundServer.port,
            path,
            method: "GET",
          },
          res => {
            let payload = "";
            res.on("data", chunk => {
              payload += chunk;
            });
            res.on("end", () => {
              resolve({
                contentType: String(res.headers["content-type"] ?? ""),
                payload,
                status: res.statusCode ?? 0,
              });
            });
          },
        );

        request.on("error", reject);
        request.end();
      });
    } finally {
      await boundServer.close();
    }
  })();

  return { ...response, signatureMiddlewareCalls };
}

describe("messenger webhook verification route", () => {
  afterEach(() => {
    delete process.env.FB_VERIFY_TOKEN;
    delete process.env.META_VERIFY_TOKEN;
    delete process.env.FB_APP_SECRET;
    vi.restoreAllMocks();
    vi.resetModules();
    rateLimitMock.mockClear();
  });

  it("fails closed when FB_VERIFY_TOKEN is missing", async () => {
    const response = await getWebhook(
      "/webhook/facebook?hub.mode=subscribe&hub.verify_token=test&hub.challenge=abc",
    );

    expect(response.status).toBe(403);
  }, 15000);

  it("rejects requests with a missing challenge", async () => {
    process.env.FB_VERIFY_TOKEN = "test-token";

    const response = await getWebhook(
      "/webhook/facebook?hub.mode=subscribe&hub.verify_token=test-token",
    );

    expect(response.status).toBe(403);
  }, 15000);

  it("returns challenge for valid token", async () => {
    process.env.FB_VERIFY_TOKEN = "test-token";

    const response = await getWebhook(
      "/webhook/facebook?hub.mode=subscribe&hub.verify_token=test-token&hub.challenge=abc123",
    );

    expect(response.status).toBe(200);
    expect(response.payload).toBe("abc123");
  });

  it("returns the raw WhatsApp verification challenge as plain text", async () => {
    process.env.META_VERIFY_TOKEN = "test-token";

    const response = await getWebhook(
      "/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=test-token&hub.challenge=wa-abc123",
    );

    expect(response.status).toBe(200);
    expect(response.contentType).toContain("text/plain");
    expect(response.payload).toBe("wa-abc123");
  });

  it("allows WhatsApp GET verification through signature middleware without a signature header", async () => {
    process.env.META_VERIFY_TOKEN = "test-token";

    const response = await getWebhook(
      "/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=test-token&hub.challenge=wa-no-signature",
      { includeSignatureMiddleware: true },
    );

    expect(response.status).toBe(200);
    expect(response.payload).toBe("wa-no-signature");
    expect(response.signatureMiddlewareCalls).toBe(1);
  });

  it("rejects WhatsApp verification with an invalid token", async () => {
    process.env.META_VERIFY_TOKEN = "test-token";

    const response = await getWebhook(
      "/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=wa-abc123",
    );

    expect(response.status).toBe(403);
  });

  it("records HTTP metrics for POST /webhook without logging sensitive payload fields", async () => {
    const appSecret = "test-secret";
    process.env.FB_APP_SECRET = appSecret;
    const { registerMetaWebhookRoutes } = await import("./_core/meta/webhookRoutes");
    const app = express();
    const secretPayloadValue = "super-sensitive-message-text";
    const payload = JSON.stringify({
      object: "not-a-valid-meta-object",
      message: secretPayloadValue,
    });
    const signature = `sha256=${createHmac("sha256", appSecret)
      .update(payload)
      .digest("hex")}`;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    app.use(attachRequestTracing());
    app.use(express.json({ verify: captureMetaWebhookRawBody }));
    app.use(createRequestMetricsMiddleware());
    app.use("/webhook", verifyMetaWebhookSignature);
    registerMetaWebhookRoutes(app);
    registerMetricsRoute(app);

    const server = http.createServer(app);
    const boundServer = await bindTestHttpServer(server);

    try {
      const webhookResponse = await fetch(`${boundServer.baseUrl}/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": signature,
        },
        body: payload,
      });
      expect(webhookResponse.status).toBe(400);

      const metricsResponse = await fetch(`${boundServer.baseUrl}/metrics`);
      const metricsBody = await metricsResponse.text();

      expect(metricsResponse.status).toBe(200);
      expect(metricsBody).toContain(
        'http_requests_total{method="POST",path="/webhook",status="400"}'
      );

      const loggedText = [logSpy, infoSpy, warnSpy, errorSpy]
        .flatMap(spy => spy.mock.calls)
        .map(call => call.map(value => JSON.stringify(value)).join(" "))
        .join("\n");
      expect(loggedText).not.toContain(secretPayloadValue);
    } finally {
      await boundServer.close();
    }
  });

  it("registers a high-threshold limiter for webhook delivery routes", async () => {
    const { registerMetaWebhookRoutes } = await import("./_core/meta/webhookRoutes");
    const app = express();

    registerMetaWebhookRoutes(app);

    expect(rateLimitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        legacyHeaders: false,
        max: 1_000,
        standardHeaders: true,
        windowMs: 60_000,
      })
    );
  });
});
