import type express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRedisClient: vi.fn(),
  isRedisEnabled: vi.fn(),
}));

vi.mock("./redis", () => ({
  getRedisClient: mocks.getRedisClient,
  isRedisEnabled: mocks.isRedisEnabled,
}));

import { createSharedRedisRateLimiter } from "./redisRateLimit";

describe("shared Redis rate limiter operation timeout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isRedisEnabled.mockReturnValue(true);
  });

  it("routes a hanging Redis client lookup through onUnavailable", async () => {
    mocks.getRedisClient.mockReturnValue(new Promise(() => undefined));

    const result = await invokeLimiter();

    expect(result.error).toMatchObject({
      message: "shared rate limiter Redis operation timed out",
    });
    expect(result.next).not.toHaveBeenCalled();
  });

  it("routes a hanging Redis eval through onUnavailable", async () => {
    const evalMock = vi.fn().mockReturnValue(new Promise(() => undefined));
    mocks.getRedisClient.mockResolvedValue({ eval: evalMock });

    const result = await invokeLimiter();

    expect(evalMock).toHaveBeenCalledTimes(1);
    expect(result.error).toMatchObject({
      message: "shared rate limiter Redis operation timed out",
    });
    expect(result.next).not.toHaveBeenCalled();
  });

  it("preserves successful rate-limit behavior", async () => {
    mocks.getRedisClient.mockResolvedValue({
      eval: vi.fn().mockResolvedValue(1),
    });

    const result = await invokeLimiter();

    expect(result.error).toBeNull();
    expect(result.next).toHaveBeenCalledTimes(1);
  });
});

async function invokeLimiter(): Promise<{
  error: unknown;
  next: ReturnType<typeof vi.fn>;
}> {
  const req = {
    method: "POST",
    ip: "203.0.113.9",
    socket: { remoteAddress: "203.0.113.9" },
  } as express.Request;
  const res = { setHeader: vi.fn() } as unknown as express.Response;
  const next = vi.fn();

  return new Promise(resolve => {
    const limiter = createSharedRedisRateLimiter({
      keyPrefix: "test-rate-limit:",
      windowMs: 60_000,
      operationTimeoutMs: 10,
      limit: () => 10,
      keyGenerator: request => `${request.method}:${request.ip}`,
      onLimited: () => {
        resolve({ error: new Error("unexpected rate limit"), next });
      },
      onUnavailable: error => {
        resolve({ error, next });
      },
    });

    limiter(req, res, () => {
      next();
      resolve({ error: null, next });
    });
  });
}
