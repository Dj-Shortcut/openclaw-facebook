import { afterEach, describe, expect, it } from "vitest";

import { assertProductionStateStoreConfig } from "./_core/stateStore";

describe("stateStore production config", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalRedisUrl = process.env.REDIS_URL;

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }

    if (originalRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = originalRedisUrl;
    }
  });

  it("requires REDIS_URL in production", () => {
    process.env.NODE_ENV = "production";
    delete process.env.REDIS_URL;

    expect(() => assertProductionStateStoreConfig()).toThrow(
      "REDIS_URL must be configured in production for state consistency",
    );
  });

  it("does not throw when REDIS_URL is configured in production", () => {
    process.env.NODE_ENV = "production";
    process.env.REDIS_URL = "redis://example.test:6379";

    expect(() => assertProductionStateStoreConfig()).not.toThrow();
  });
});
