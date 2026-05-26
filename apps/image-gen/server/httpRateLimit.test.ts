import http from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";

import { createGlobalHttpRateLimiter } from "./_core/httpRateLimit";
import { bindTestHttpServer } from "./testHttpServer";

const originalWindowMs = process.env.HTTP_RATE_LIMIT_WINDOW_MS;
const originalMaxRequests = process.env.HTTP_RATE_LIMIT_MAX_REQUESTS;

afterEach(() => {
  if (originalWindowMs === undefined) {
    delete process.env.HTTP_RATE_LIMIT_WINDOW_MS;
  } else {
    process.env.HTTP_RATE_LIMIT_WINDOW_MS = originalWindowMs;
  }

  if (originalMaxRequests === undefined) {
    delete process.env.HTTP_RATE_LIMIT_MAX_REQUESTS;
  } else {
    process.env.HTTP_RATE_LIMIT_MAX_REQUESTS = originalMaxRequests;
  }
});

async function startServer(options?: { forceIp?: string; pathPrefix?: string }) {
  const app = express();
  const limitedPath = `${options?.pathPrefix ?? ""}/limited`;
  const healthPath = "/healthz";
  const rateLimiter = createGlobalHttpRateLimiter();

  if (options?.forceIp) {
    app.use((req, _res, next) => {
      Object.defineProperty(req, "ip", {
        value: options.forceIp,
        configurable: true,
      });
      next();
    });
  }

  app.use(rateLimiter);

  app.get(limitedPath, (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.get(healthPath, rateLimiter, (_req, res) => {
    res.status(200).send("ok");
  });

  const server = http.createServer(app);
  const boundServer = await bindTestHttpServer(server);

  return {
    baseUrl: boundServer.baseUrl,
    limitedPath,
    healthPath,
    close: boundServer.close,
  };
}

describe("global http rate limiter", () => {
  it("returns 429 after exceeding the per-IP request budget", async () => {
    process.env.HTTP_RATE_LIMIT_WINDOW_MS = "60000";
    process.env.HTTP_RATE_LIMIT_MAX_REQUESTS = "2";

    const server = await startServer({
      forceIp: "203.0.113.11",
      pathPrefix: "/budget-a",
    });

    try {
      const first = await fetch(`${server.baseUrl}${server.limitedPath}`);
      const second = await fetch(`${server.baseUrl}${server.limitedPath}`);
      const third = await fetch(`${server.baseUrl}${server.limitedPath}`);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(third.status).toBe(429);
      expect(third.headers.get("retry-after")).not.toBeNull();
      expect(await third.json()).toEqual({
        error: "Too Many Requests",
        message: "Global HTTP rate limit exceeded. Please retry shortly.",
      });
    } finally {
      await server.close();
    }
  });

  it("does not rate limit health checks", async () => {
    process.env.HTTP_RATE_LIMIT_WINDOW_MS = "60000";
    process.env.HTTP_RATE_LIMIT_MAX_REQUESTS = "1";

    const server = await startServer({ forceIp: "203.0.113.12" });

    try {
      const first = await fetch(`${server.baseUrl}${server.healthPath}`);
      const second = await fetch(`${server.baseUrl}${server.healthPath}`);
      const third = await fetch(`${server.baseUrl}${server.healthPath}`);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(third.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("does not trust caller-controlled x-forwarded-for when req.ip is already resolved", async () => {
    process.env.HTTP_RATE_LIMIT_WINDOW_MS = "60000";
    process.env.HTTP_RATE_LIMIT_MAX_REQUESTS = "1";

    const server = await startServer({
      forceIp: "203.0.113.10",
      pathPrefix: "/limited-c",
    });

    try {
      const first = await fetch(`${server.baseUrl}${server.limitedPath}`, {
        headers: {
          "X-Forwarded-For": "198.51.100.1",
        },
      });
      const second = await fetch(`${server.baseUrl}${server.limitedPath}`, {
        headers: {
          "X-Forwarded-For": "198.51.100.2",
        },
      });

      expect(first.status).toBe(200);
      expect(second.status).toBe(429);
    } finally {
      await server.close();
    }
  });
});
