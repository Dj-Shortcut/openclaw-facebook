import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMessengerStartScreenPills } from "./_core/messengerProfile";

const originalToken = process.env.FB_PAGE_ACCESS_TOKEN;
const originalGraphVersion = process.env.FB_GRAPH_API_VERSION;
const originalClearFlag = process.env.MESSENGER_CLEAR_ICE_BREAKERS_ON_STARTUP;
const originalRemoveFlag = process.env.MESSENGER_REMOVE_START_SCREEN_PILLS;
const originalNodeEnv = process.env.NODE_ENV;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

describe("messenger profile start-screen pills", () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
  };

  beforeEach(() => {
    process.env.FB_PAGE_ACCESS_TOKEN = "page-token";
    process.env.NODE_ENV = "production";
    delete process.env.FB_GRAPH_API_VERSION;
    delete process.env.MESSENGER_CLEAR_ICE_BREAKERS_ON_STARTUP;
    delete process.env.MESSENGER_REMOVE_START_SCREEN_PILLS;
    logger.info.mockClear();
    logger.warn.mockClear();
  });

  afterEach(() => {
    restoreEnv("FB_PAGE_ACCESS_TOKEN", originalToken);
    restoreEnv("FB_GRAPH_API_VERSION", originalGraphVersion);
    restoreEnv("MESSENGER_CLEAR_ICE_BREAKERS_ON_STARTUP", originalClearFlag);
    restoreEnv("MESSENGER_REMOVE_START_SCREEN_PILLS", originalRemoveFlag);
    restoreEnv("NODE_ENV", originalNodeEnv);
  });

  it("deletes Messenger ice breakers so new conversations do not show stale pills", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ result: "success" }), { status: 200 })
      );

    await expect(
      clearMessengerStartScreenPills({ fetchImpl, logger })
    ).resolves.toEqual({ status: "cleared" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://graph.facebook.com/v21.0/me/messenger_profile?fields=%5B%22ice_breakers%22%5D"
    );
    expect(init).toMatchObject({
      method: "DELETE",
      headers: { Authorization: "Bearer page-token" },
      signal: expect.any(AbortSignal),
    });
  });

  it("does not clear live Page ice breakers from non-production runs unless explicitly enabled", async () => {
    process.env.NODE_ENV = "test";
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      clearMessengerStartScreenPills({ fetchImpl, logger })
    ).resolves.toEqual({ status: "skipped", reason: "disabled" });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("can be disabled for environments that intentionally manage ice breakers elsewhere", async () => {
    process.env.MESSENGER_CLEAR_ICE_BREAKERS_ON_STARTUP = "false";
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      clearMessengerStartScreenPills({ fetchImpl, logger })
    ).resolves.toEqual({ status: "skipped", reason: "disabled" });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips cleanup when no Page token is configured", async () => {
    delete process.env.FB_PAGE_ACCESS_TOKEN;
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      clearMessengerStartScreenPills({ fetchImpl, logger })
    ).resolves.toEqual({ status: "skipped", reason: "missing_token" });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "[messenger profile] FB_PAGE_ACCESS_TOKEN missing; cannot clear start-screen ice breakers"
    );
  });

  it("throws a sanitized error when Meta rejects the profile cleanup", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "bad token" } }), {
        status: 400,
      })
    );

    await expect(
      clearMessengerStartScreenPills({ fetchImpl, logger })
    ).rejects.toThrow("Messenger profile ice breaker cleanup failed (400)");
  });
});
