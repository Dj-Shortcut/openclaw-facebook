import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { redisClient, redisConstructorMock } = vi.hoisted(() => {
  const redisClient = Object.freeze({});
  const redisConstructorMock = vi.fn(function RedisMock() {
    return redisClient;
  });
  return { redisClient, redisConstructorMock };
});

vi.mock("ioredis", () => ({
  default: redisConstructorMock,
}));

import { getRedisClient, resetRedisClientForTests } from "./_core/redis";

const ORIGINAL_REDIS_URL = process.env.REDIS_URL;
const TEST_REDIS_URL = "redis://127.0.0.1:6380/1";

beforeEach(() => {
  process.env.REDIS_URL = TEST_REDIS_URL;
  redisConstructorMock.mockClear();
  resetRedisClientForTests();
});

afterEach(() => {
  resetRedisClientForTests();
  if (ORIGINAL_REDIS_URL === undefined) {
    delete process.env.REDIS_URL;
  } else {
    process.env.REDIS_URL = ORIGINAL_REDIS_URL;
  }
});

describe("shared Redis client", () => {
  it("bounds every Redis command with a client-level timeout", async () => {
    await expect(getRedisClient()).resolves.toBe(redisClient);
    expect(redisConstructorMock).toHaveBeenCalledExactlyOnceWith(
      TEST_REDIS_URL,
      { commandTimeout: 5_000 }
    );
  });
});
