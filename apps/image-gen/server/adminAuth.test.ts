import http from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindTestHttpServer } from "./testHttpServer";

const { getRedisClientMock, isRedisEnabledMock, safeLogMock } = vi.hoisted(() => ({
  getRedisClientMock: vi.fn(),
  isRedisEnabledMock: vi.fn(() => false),
  safeLogMock: vi.fn(),
}));

vi.mock("./_core/messengerApi", () => ({
  safeLog: safeLogMock,
}));

vi.mock("./_core/redis", () => ({
  getRedisClient: getRedisClientMock,
  isRedisEnabled: isRedisEnabledMock,
}));

import {
  createAdminAuthRateLimiter,
  resetAdminAuthRateLimiterForTests,
  verifyAdminToken,
} from "./_core/adminAuth";

const originalAdminToken = process.env.ADMIN_TOKEN;

afterEach(() => {
  resetAdminAuthRateLimiterForTests();
  getRedisClientMock.mockReset();
  isRedisEnabledMock.mockReset();
  isRedisEnabledMock.mockReturnValue(false);
  safeLogMock.mockClear();
  if (originalAdminToken === undefined) {
    delete process.env.ADMIN_TOKEN;
  } else {
    process.env.ADMIN_TOKEN = originalAdminToken;
  }
});

async function startServer() {
  const app = express();
  app.set("trust proxy", 1);
  app.get(
    "/admin/test",
    createAdminAuthRateLimiter({ eventName: "admin_test_rate_limited" }),
    (_req, res) => res.status(403).send("forbidden")
  );

  const server = http.createServer(app);
  const boundServer = await bindTestHttpServer(server);

  return {
    baseUrl: boundServer.baseUrl,
    close: boundServer.close,
  };
}

describe("admin auth", () => {
  it("uses constant-time token verification without accepting mismatches", () => {
    process.env.ADMIN_TOKEN = "correct-token";

    expect(
      verifyAdminToken({
        providedToken: "correct-token",
        eventName: "admin_auth_failed",
      })
    ).toBe(true);
    expect(
      verifyAdminToken({
        providedToken: "wrong-token",
        eventName: "admin_auth_failed",
      })
    ).toBe(false);
    expect(safeLogMock).toHaveBeenCalledWith("admin_auth_failed", {
      reason: "length_mismatch",
    });
  });

  it("rate limits repeated admin auth attempts per endpoint", async () => {
    const server = await startServer();

    try {
      const responses: Response[] = [];
      for (let index = 0; index < 6; index += 1) {
        responses.push(await fetch(`${server.baseUrl}/admin/test`));
      }

      expect(responses.slice(0, 5).map(response => response.status)).toEqual([
        403,
        403,
        403,
        403,
        403,
      ]);
      expect(responses[5].status).toBe(429);
      expect(responses[5].headers.get("retry-after")).not.toBeNull();
      expect(safeLogMock).toHaveBeenCalledWith("admin_test_rate_limited", {
        reason: "rate_limited",
      });
    } finally {
      await server.close();
    }
  });

  it("uses Redis for admin auth rate limits when Redis is configured", async () => {
    const redis = {
      expire: vi.fn(async () => 1),
      incr: vi.fn(async () => 6),
      ttl: vi.fn(async () => 600),
    };
    isRedisEnabledMock.mockReturnValue(true);
    getRedisClientMock.mockResolvedValue(redis);

    const server = await startServer();

    try {
      const response = await fetch(`${server.baseUrl}/admin/test`);

      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("600");
      expect(redis.incr).toHaveBeenCalledWith(
        expect.stringContaining("admin-auth-rate-limit:GET:/admin/test:")
      );
      expect(redis.expire).not.toHaveBeenCalled();
      expect(redis.ttl).toHaveBeenCalledWith(
        expect.stringContaining("admin-auth-rate-limit:GET:/admin/test:")
      );
      expect(safeLogMock).toHaveBeenCalledWith("admin_test_rate_limited", {
        reason: "rate_limited",
      });
    } finally {
      await server.close();
    }
  });
});
