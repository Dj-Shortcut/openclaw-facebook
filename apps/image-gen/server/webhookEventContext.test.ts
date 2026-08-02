import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createHandlerContext } from "./_core/webhookHandlerContext";
import { handleEntry } from "./_core/webhookEventRouter";
import { resetStateStore } from "./_core/messengerState";

describe("Messenger webhook request correlation privacy", () => {
  const originalLogLevel = process.env.LOG_LEVEL;
  const originalPrivacyPepper = process.env.PRIVACY_PEPPER;
  const originalRedisUrl = process.env.REDIS_URL;

  beforeEach(() => {
    process.env.LOG_LEVEL = "debug";
    process.env.PRIVACY_PEPPER = "webhook-event-context-test-pepper";
    delete process.env.REDIS_URL;
  });

  afterEach(() => {
    resetStateStore();
    vi.restoreAllMocks();

    if (originalLogLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = originalLogLevel;
    }
    if (originalPrivacyPepper === undefined) {
      delete process.env.PRIVACY_PEPPER;
    } else {
      process.env.PRIVACY_PEPPER = originalPrivacyPepper;
    }
    if (originalRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = originalRedisUrl;
    }
  });

  it("keeps an opaque correlation id while excluding inbound identifiers and content", async () => {
    const rawPsid = "raw-psid-987654321";
    const rawPageId = "raw-page-id-123456789";
    const rawPhone = "+32470123456";
    const rawPrompt = "paint my private family portrait in neon";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const ctx = createHandlerContext({
      defaultLang: "en",
      runImageGeneration: vi.fn(async () => ({ sent: true })),
    });
    ctx.claimEventReplayOrLog = vi.fn(async () => true);

    await handleEntry(ctx, {
      id: rawPageId,
      messaging: [
        {
          sender: { id: rawPsid },
          timestamp: 1_750_000_000_000,
          message: {
            mid: "raw-message-id-sensitive",
            is_echo: true,
            text: `${rawPhone} ${rawPrompt}`,
          },
        },
      ],
    });

    const loggedPayloads = logSpy.mock.calls.map(
      call => JSON.parse(String(call[0])) as Record<string, unknown>
    );
    const requestIds = loggedPayloads
      .map(payload => payload.reqId)
      .filter((value): value is string => typeof value === "string");
    const serializedLogs = JSON.stringify(loggedPayloads);

    expect(requestIds.length).toBeGreaterThan(0);
    expect(new Set(requestIds).size).toBe(1);
    expect(requestIds[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(serializedLogs).not.toContain(rawPsid);
    expect(serializedLogs).not.toContain(rawPageId);
    expect(serializedLogs).not.toContain(rawPhone);
    expect(serializedLogs).not.toContain(rawPrompt);
    expect(serializedLogs).not.toContain("raw-message-id-sensitive");
  });
});
