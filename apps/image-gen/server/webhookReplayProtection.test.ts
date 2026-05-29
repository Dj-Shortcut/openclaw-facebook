import { afterEach, describe, expect, it } from "vitest";

import { assertProductionWebhookReplayProtectionConfig } from "./_core/webhookReplayProtection";

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

describe("webhook replay protection config", () => {
  it("requires REDIS_URL in production", () => {
    process.env.NODE_ENV = "production";
    delete process.env.REDIS_URL;

    expect(() => assertProductionWebhookReplayProtectionConfig()).toThrow(
      "REDIS_URL must be configured in production for webhook replay protection",
    );
  });

  it("allows dev mode without REDIS_URL", () => {
    process.env.NODE_ENV = "development";
    delete process.env.REDIS_URL;

    expect(() => assertProductionWebhookReplayProtectionConfig()).not.toThrow();
  });
});
