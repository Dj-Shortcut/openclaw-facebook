import { afterEach, describe, expect, it, vi } from "vitest";
import { assertProductionMessengerVideoConfig } from "./_core/video-generation/videoConfig";

function configureValidProductionVideoPolicy(): void {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("MESSENGER_VIDEO_GENERATION_ENABLED", "true");
  vi.stubEnv("MESSENGER_VIDEO_ALLOWED_USER_KEYS", "a".repeat(64));
  vi.stubEnv("MESSENGER_VIDEO_ALLOWED_PAGE_BINDINGS", "42:7:3:123456789");
  vi.stubEnv("MESSENGER_VIDEO_PROVIDER", "openai");
  vi.stubEnv("OPENAI_API_KEY", "test-video-api-key");
  vi.stubEnv("OPENAI_VIDEO_MODEL", "sora-2");
  vi.stubEnv("OPENAI_VIDEO_SIZE", "1280x720");
  vi.stubEnv("OPENAI_VIDEO_SECONDS", "8");
  vi.stubEnv("OPENAI_VIDEO_MAX_RETRIES", "0");
  vi.stubEnv("OPENAI_VIDEO_MAX_OUTPUT_BYTES", "25165824");
  vi.stubEnv("OPENAI_VIDEO_MAX_REFERENCE_IMAGE_BYTES", "12582912");
  vi.stubEnv("MESSENGER_TTS_ENABLED", "false");
  vi.stubEnv("MESSENGER_VIDEO_AMBIGUOUS_CREATE_RETENTION_APPROVED", "true");
  vi.stubEnv("MESSENGER_VIDEO_GENERATION_DAILY_LIMIT", "1");
  vi.stubEnv("MESSENGER_GLOBAL_DAILY_VIDEO_CAP", "10");
  vi.stubEnv("OPENAI_VIDEO_GENERATION_ESTIMATED_COST_USD", "0.80");
  vi.stubEnv("MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD", "20");
  vi.stubEnv("MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD", "200");
  vi.stubEnv("MESSENGER_USER_DAILY_SPEND_CAP_USD", "2");
  vi.stubEnv("MESSENGER_VIDEO_GENERATION_TIMEOUT_MS", "240000");
  vi.stubEnv("MESSENGER_VIDEO_FLOW_TIMEOUT_MS", "300000");
  vi.stubEnv("REDIS_URL", "redis://video-policy.test");
}

describe("Messenger video production policy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not require video credentials while the feature is disabled", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MESSENGER_VIDEO_GENERATION_ENABLED", "false");

    expect(() => assertProductionMessengerVideoConfig()).not.toThrow();
  });

  it("accepts the exact bounded initial rollout policy", () => {
    configureValidProductionVideoPolicy();

    expect(() => assertProductionMessengerVideoConfig()).not.toThrow();
  });

  it("rejects an enabled rollout without a priced provider attempt", () => {
    configureValidProductionVideoPolicy();
    vi.stubEnv("OPENAI_VIDEO_GENERATION_ESTIMATED_COST_USD", "");

    expect(() => assertProductionMessengerVideoConfig()).toThrow(
      "OPENAI_VIDEO_GENERATION_ESTIMATED_COST_USD must be explicitly set"
    );
  });

  it("rejects an enabled rollout without an explicit pilot allowlist", () => {
    configureValidProductionVideoPolicy();
    vi.stubEnv("MESSENGER_VIDEO_ALLOWED_USER_KEYS", "");

    expect(() => assertProductionMessengerVideoConfig()).toThrow(
      "MESSENGER_VIDEO_ALLOWED_USER_KEYS must contain"
    );
  });

  it("requires durable cleanup storage before enabling billable video jobs", () => {
    configureValidProductionVideoPolicy();
    vi.stubEnv("REDIS_URL", "");

    expect(() => assertProductionMessengerVideoConfig()).toThrow(
      "REDIS_URL must be configured"
    );
  });

  it("requires an exact owner Page binding for the pilot", () => {
    configureValidProductionVideoPolicy();
    vi.stubEnv("MESSENGER_VIDEO_ALLOWED_PAGE_BINDINGS", "");

    expect(() => assertProductionMessengerVideoConfig()).toThrow(
      "MESSENGER_VIDEO_ALLOWED_PAGE_BINDINGS must contain"
    );
  });

  it("rejects output-memory cap drift in the bounded pilot", () => {
    configureValidProductionVideoPolicy();
    vi.stubEnv("OPENAI_VIDEO_MAX_OUTPUT_BYTES", "999999999");

    expect(() => assertProductionMessengerVideoConfig()).toThrow(
      "OPENAI_VIDEO_MAX_OUTPUT_BYTES must be explicitly set to 25165824"
    );
  });

  it("rejects client-independent provider policy drift", () => {
    configureValidProductionVideoPolicy();
    vi.stubEnv("OPENAI_VIDEO_MODEL", "unreviewed-model");

    expect(() => assertProductionMessengerVideoConfig()).toThrow(
      "OPENAI_VIDEO_MODEL must be explicitly set to sora-2"
    );
  });

  it("forbids billable transport retries in the bounded pilot", () => {
    configureValidProductionVideoPolicy();
    vi.stubEnv("OPENAI_VIDEO_MAX_RETRIES", "1");

    expect(() => assertProductionMessengerVideoConfig()).toThrow(
      "OPENAI_VIDEO_MAX_RETRIES must be explicitly set to 0"
    );
  });

  it("keeps optional TTS disabled until its cost and deletion path are reviewed", () => {
    configureValidProductionVideoPolicy();
    vi.stubEnv("MESSENGER_TTS_ENABLED", "true");

    expect(() => assertProductionMessengerVideoConfig()).toThrow(
      "MESSENGER_TTS_ENABLED must be explicitly set to false"
    );
  });

  it("requires explicit approval of the residual ambiguous-create boundary", () => {
    configureValidProductionVideoPolicy();
    vi.stubEnv("MESSENGER_VIDEO_AMBIGUOUS_CREATE_RETENTION_APPROVED", "false");

    expect(() => assertProductionMessengerVideoConfig()).toThrow(
      "MESSENGER_VIDEO_AMBIGUOUS_CREATE_RETENTION_APPROVED must be explicitly set to true"
    );
  });

  it("requires the outer flow deadline to exceed the provider deadline", () => {
    configureValidProductionVideoPolicy();
    vi.stubEnv("MESSENGER_VIDEO_FLOW_TIMEOUT_MS", "240000");

    expect(() => assertProductionMessengerVideoConfig()).toThrow(
      "MESSENGER_VIDEO_FLOW_TIMEOUT_MS must exceed"
    );
  });
});
