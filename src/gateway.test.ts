import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { messengerGatewayAdapter } from "./gateway.js";
import { clearMessengerRuntime, setMessengerRuntime } from "./runtime.js";

const originalEnv = { ...process.env };

function gatewayContext() {
  return {
    account: {
      accountId: "default",
      enabled: true,
      pageId: "page-1",
      pageAccessToken: "page-token",
      appSecret: "app-secret",
      verifyToken: "verify-token",
      tokenSource: "config",
      config: {},
    },
    cfg: {},
    runtime: {},
    abortSignal: new AbortController().signal,
    log: { info: vi.fn() },
  };
}

beforeEach(() => {
  process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
  process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test";
  delete process.env.LEADERBOT_AI_ANSWER_ENFORCEMENT_ENABLED;
});

afterEach(() => {
  process.env = { ...originalEnv };
  clearMessengerRuntime();
  vi.unstubAllGlobals();
});

describe("Messenger gateway quota readiness", () => {
  it("starts without the quota handshake while enforcement is disabled", async () => {
    const monitor = vi.fn(async () => undefined);
    setMessengerRuntime({
      channel: { facebook: { monitorMessengerProvider: monitor } },
    } as never);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await messengerGatewayAdapter.startAccount(gatewayContext() as never);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(monitor).toHaveBeenCalledTimes(1);
  });

  it("requires the exact ready admission and drain handshake before traffic", async () => {
    process.env.LEADERBOT_AI_ANSWER_ENFORCEMENT_ENABLED = "true";
    const monitor = vi.fn(async () => undefined);
    setMessengerRuntime({
      channel: { facebook: { monitorMessengerProvider: monitor } },
    } as never);
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          protocol: "leaderbot-ai-answer-quota-v1",
          preflightReady: true,
          admissionEnabled: true,
          drainEnabled: true,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await messengerGatewayAdapter.startAccount(gatewayContext() as never);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://image-gen.example.test/internal/messenger/ai-answer-quota/readiness",
    );
    expect(monitor).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      protocol: "stale-protocol",
      preflightReady: true,
      admissionEnabled: true,
      drainEnabled: true,
    },
    {
      protocol: "leaderbot-ai-answer-quota-v1",
      preflightReady: true,
      admissionEnabled: false,
      drainEnabled: true,
    },
    {
      protocol: "leaderbot-ai-answer-quota-v1",
      preflightReady: true,
      admissionEnabled: true,
      drainEnabled: false,
    },
  ])("fails closed before Messenger traffic for %#", async (payload) => {
    process.env.LEADERBOT_AI_ANSWER_ENFORCEMENT_ENABLED = "true";
    const monitor = vi.fn(async () => undefined);
    setMessengerRuntime({
      channel: { facebook: { monitorMessengerProvider: monitor } },
    } as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify(payload), { status: 200 }),
      ),
    );

    await expect(
      messengerGatewayAdapter.startAccount(gatewayContext() as never),
    ).rejects.toThrow("quota readiness is unavailable");
    expect(monitor).not.toHaveBeenCalled();
  });
});
