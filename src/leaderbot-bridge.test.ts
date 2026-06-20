import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_IMAGE_GEN_URL,
  forwardLeaderbotMessengerEvent,
  requestLeaderbotImageGeneration,
  resolveImageGenRequestConfig,
  type LeaderbotBridgeTrace,
} from "./leaderbot-bridge.js";

const originalInternalToken = process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN;
const originalFallbackToken = process.env.INTERNAL_IMAGE_REQUEST_TOKEN;
const originalImageGenUrl = process.env.LEADERBOT_IMAGE_GEN_URL;

const trace: LeaderbotBridgeTrace = {
  accountId: "account-1",
  psidHash: "sha256:redacted",
  reqId: "req-1",
  startedAt: 0,
};

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalInternalToken === undefined) {
    delete process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN;
  } else {
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = originalInternalToken;
  }
  if (originalFallbackToken === undefined) {
    delete process.env.INTERNAL_IMAGE_REQUEST_TOKEN;
  } else {
    process.env.INTERNAL_IMAGE_REQUEST_TOKEN = originalFallbackToken;
  }
  if (originalImageGenUrl === undefined) {
    delete process.env.LEADERBOT_IMAGE_GEN_URL;
  } else {
    process.env.LEADERBOT_IMAGE_GEN_URL = originalImageGenUrl;
  }
});

describe("resolveImageGenRequestConfig", () => {
  it("does not use host tokens unless the Leaderbot bridge is enabled", () => {
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = " internal-token ";
    delete process.env.INTERNAL_IMAGE_REQUEST_TOKEN;
    delete process.env.LEADERBOT_IMAGE_GEN_URL;

    expect(resolveImageGenRequestConfig()).toEqual({
      ok: false,
      reason: "disabled_by_config",
    });
  });

  it("uses the production Leaderbot URL by default with the primary internal token when enabled", () => {
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = " internal-token ";
    delete process.env.INTERNAL_IMAGE_REQUEST_TOKEN;
    delete process.env.LEADERBOT_IMAGE_GEN_URL;

    expect(resolveImageGenRequestConfig({ leaderbotBridgeEnabled: true })).toEqual({
      ok: true,
      endpoint: `${DEFAULT_IMAGE_GEN_URL}/internal/messenger/image-request`,
      token: "internal-token",
    });
  });

  it("falls back to INTERNAL_IMAGE_REQUEST_TOKEN when the Leaderbot token is absent", () => {
    delete process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN;
    process.env.INTERNAL_IMAGE_REQUEST_TOKEN = " fallback-token ";
    process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test/base";

    expect(resolveImageGenRequestConfig({ leaderbotBridgeEnabled: true })).toEqual({
      ok: true,
      endpoint: "https://image-gen.example.test/internal/messenger/image-request",
      token: "fallback-token",
    });
  });

  it("rejects missing tokens and non-local plain HTTP URLs", () => {
    delete process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN;
    delete process.env.INTERNAL_IMAGE_REQUEST_TOKEN;
    process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test";

    expect(resolveImageGenRequestConfig({ leaderbotBridgeEnabled: true })).toEqual({
      ok: false,
      reason: "missing_token",
    });

    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
    process.env.LEADERBOT_IMAGE_GEN_URL = "http://image-gen.example.test";

    expect(resolveImageGenRequestConfig({ leaderbotBridgeEnabled: true })).toEqual({
      ok: false,
      reason: "invalid_url",
    });
  });

  it("allows localhost HTTP endpoints for local bridge development", () => {
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
    process.env.LEADERBOT_IMAGE_GEN_URL = "http://localhost:8787";

    expect(resolveImageGenRequestConfig({ leaderbotBridgeEnabled: true })).toEqual({
      ok: true,
      endpoint: "http://localhost:8787/internal/messenger/image-request",
      token: "internal-token",
    });
  });
});

describe("Leaderbot bridge requests", () => {
  it("does not send image-generation requests when only the host token is present", async () => {
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
    process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test";
    const logStage = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      requestLeaderbotImageGeneration({
        psid: "psid-1",
        prompt: "Maak een robot",
        reqId: "req-1",
        timestamp: 1_700_000_000_000,
        trace,
        logStage,
      }),
    ).resolves.toBe(false);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(logStage).toHaveBeenCalledWith(trace, "image_gen_request_skipped", {
      reason: "disabled_by_config",
    });
  });

  it("sends image-generation requests to the image-request endpoint", async () => {
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
    process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test";
    const logStage = vi.fn();
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ status: "queued" }), { status: 202 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      requestLeaderbotImageGeneration({
        psid: "psid-1",
        prompt: "Maak een robot",
        reqId: "req-1",
        timestamp: 1_700_000_000_000,
        trace,
        leaderbotBridgeEnabled: true,
        sourceImageUrl: "https://cdn.example.test/image.jpg",
        logStage,
      }),
    ).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://image-gen.example.test/internal/messenger/image-request",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer internal-token",
        "Content-Type": "application/json",
      },
    });
    expect(
      JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)),
    ).toMatchObject({
      psid: "psid-1",
      prompt: "Maak een robot",
      reqId: "req-1",
      lang: "nl",
      timestamp: 1_700_000_000_000,
      sourceImageUrl: "https://cdn.example.test/image.jpg",
    });
    expect(logStage).toHaveBeenCalledWith(trace, "image_gen_request_sent", { status: 202 });
  });

  it("sends Messenger events to the webhook-event endpoint and reports fallback failure", async () => {
    process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
    process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test";
    const logStage = vi.fn();
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      forwardLeaderbotMessengerEvent({
        event: {
          sender: { id: "sender-1" },
          recipient: { id: "page-1" },
          timestamp: 1_700_000_000_000,
          message: { mid: "mid-1", text: "Maak een robot" },
        },
        trace,
        leaderbotBridgeEnabled: true,
        logStage,
      }),
    ).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://image-gen.example.test/internal/messenger/webhook-event",
    );
    expect(
      JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)),
    ).toMatchObject({
      event: {
        sender: { id: "sender-1" },
        recipient: { id: "page-1" },
        message: { mid: "mid-1", text: "Maak een robot" },
      },
    });
    expect(logStage).toHaveBeenCalledWith(trace, "messenger_event_forward_sent", { status: 503 });
  });
});
