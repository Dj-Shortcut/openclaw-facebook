import http from "node:http";
import express from "express";
import { describe, expect, it } from "vitest";

import {
  attachRequestTracing,
  getRequestId,
  getTraceContext,
  recordHttpRequestMetric,
  registerMetricsRoute,
} from "./_core/observability";
import { bindTestHttpServer } from "./testHttpServer";

async function startServer(configure?: (app: express.Express) => void) {
  const app = express();
  app.use(attachRequestTracing());
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      recordHttpRequestMetric(req.method, req.path, res.statusCode, durationMs);
    });
    next();
  });
  configure?.(app);
  registerMetricsRoute(app);

  const server = http.createServer(app);
  const boundServer = await bindTestHttpServer(server);

  return {
    baseUrl: boundServer.baseUrl,
    close: boundServer.close,
  };
}

describe("observability", () => {
  it("propagates incoming X-Request-Id headers", async () => {
    const server = await startServer(app => {
      app.get("/trace", (req, res) => {
        res.status(200).json({
          reqId: getRequestId(req) ?? null,
          traceId: getTraceContext(req)?.traceId ?? null,
          spanId: getTraceContext(req)?.spanId ?? null,
        });
      });
    });

    try {
      const response = await fetch(`${server.baseUrl}/trace`, {
        headers: {
          "X-Request-Id": "req-test-123",
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("x-request-id")).toBe("req-test-123");
      expect(response.headers.get("x-trace-id")).toMatch(/^[0-9a-f]{32}$/);
      expect(response.headers.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
      expect(await response.json()).toEqual({
        reqId: "req-test-123",
        traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
        spanId: expect.stringMatching(/^[0-9a-f]{16}$/),
      });
    } finally {
      await server.close();
    }
  });

  it("continues an incoming traceparent and creates a fresh server span", async () => {
    const incomingTraceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const server = await startServer(app => {
      app.get("/traceparent", (req, res) => {
        res.status(200).json({
          traceparent: getTraceContext(req)?.traceparent ?? null,
          traceId: getTraceContext(req)?.traceId ?? null,
          spanId: getTraceContext(req)?.spanId ?? null,
        });
      });
    });

    try {
      const response = await fetch(`${server.baseUrl}/traceparent`, {
        headers: {
          traceparent: incomingTraceparent,
        },
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
      expect(payload.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(payload.spanId).not.toBe("00f067aa0ba902b7");
      expect(response.headers.get("traceparent")).toMatch(
        /^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/,
      );
    } finally {
      await server.close();
    }
  });

  it("exposes Prometheus-style HTTP metrics", async () => {
    const server = await startServer(app => {
      app.get("/ok", (_req, res) => {
        res.status(200).json({ ok: true });
      });
    });

    try {
      await fetch(`${server.baseUrl}/ok`);
      const response = await fetch(`${server.baseUrl}/metrics`);
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/plain");
      expect(body).toContain("http_requests_total");
      expect(body).toContain('path="/ok"');
      expect(body).toContain("http_request_duration_seconds_bucket");
    } finally {
      await server.close();
    }
  });
});
