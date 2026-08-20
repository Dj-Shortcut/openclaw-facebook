import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPortalHandoffUrl,
  sendPortalHandoffLink,
} from "./_core/portalHandoffDelivery";

const mocks = vi.hoisted(() => ({
  createPortalHandoffToken: vi.fn(),
  revokePortalHandoffToken: vi.fn(),
  listChannelConnections: vi.fn(),
  findStateByUserKey: vi.fn(),
  hasOpenMessengerResponseWindow: vi.fn(),
  sendText: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("./_core/portalHandoff", () => ({
  createPortalHandoffToken: mocks.createPortalHandoffToken,
}));

vi.mock("./db", () => ({
  revokePortalHandoffToken: mocks.revokePortalHandoffToken,
  listChannelConnections: mocks.listChannelConnections,
}));

vi.mock("./_core/messengerState", () => ({
  findStateByUserKey: mocks.findStateByUserKey,
  hasOpenMessengerResponseWindow: mocks.hasOpenMessengerResponseWindow,
}));

vi.mock("./_core/messengerApi", () => ({
  sendText: mocks.sendText,
}));

vi.mock("./_core/logger", () => ({
  safeLog: mocks.safeLog,
}));

const messengerSenderUserKey = "a".repeat(64);

const messengerState = {
  psid: "page-scoped-user-id",
  userKey: messengerSenderUserKey,
  pageId: "facebook-page-42",
  stage: "IDLE",
  state: "IDLE",
  preferredLang: "nl",
  lastPhotoUrl: null,
  lastPhoto: null,
  consentGiven: true,
  hasSeenIntro: true,
  quota: { dayKey: "2026-07-06", count: 0 },
  videoGenerationQuota: { dayKey: "2026-07-06", count: 0 },
  transcriptionQuota: { dayKey: "2026-07-06", count: 0 },
  updatedAt: Date.now(),
};

describe("portal handoff delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findStateByUserKey.mockResolvedValue(messengerState);
    mocks.listChannelConnections.mockResolvedValue([
      {
        channel: "facebook_messenger",
        status: "connected",
        externalId: "facebook-page-42",
      },
    ]);
    mocks.hasOpenMessengerResponseWindow.mockResolvedValue(true);
    mocks.createPortalHandoffToken.mockResolvedValue({
      token: "opaque-token",
      tokenHash: "sha256:opaque-token-hash",
      expiresAt: new Date("2026-07-06T11:30:00.000Z"),
    });
    mocks.sendText.mockResolvedValue({ sent: true });
    mocks.revokePortalHandoffToken.mockResolvedValue(true);
  });

  it("builds handoff links on the portal domain", () => {
    expect(buildPortalHandoffUrl("opaque-token", "https://leaderbot.live")).toBe(
      "https://leaderbot.live/handoff/opaque-token"
    );
  });

  it("creates and sends a one-time portal link through Messenger", async () => {
    await expect(
      sendPortalHandoffLink({
        workspaceId: 42,
        messengerSenderUserKey,
        createdByUserId: 7,
        baseUrl: "https://leaderbot.live",
        now: new Date("2026-07-06T10:30:00.000Z"),
        ttlMs: 3_600_000,
      })
    ).resolves.toEqual({
      ok: true,
      sent: true,
      expiresAt: new Date("2026-07-06T11:30:00.000Z"),
    });

    expect(mocks.findStateByUserKey).toHaveBeenCalledWith(
      messengerSenderUserKey,
      undefined
    );
    expect(mocks.hasOpenMessengerResponseWindow).toHaveBeenCalledWith(
      "page-scoped-user-id",
      undefined,
      "facebook-page-42"
    );
    expect(mocks.createPortalHandoffToken).toHaveBeenCalledWith({
      workspaceId: 42,
      facebookPageId: "facebook-page-42",
      messengerSenderUserKey,
      createdByUserId: 7,
      now: new Date("2026-07-06T10:30:00.000Z"),
      ttlMs: 3_600_000,
      deliveryIdempotencyKey: null,
    });
    expect(mocks.sendText).toHaveBeenCalledWith(
      "page-scoped-user-id",
      expect.stringContaining("https://leaderbot.live/handoff/opaque-token"),
      { pageId: "facebook-page-42" }
    );
    expect(mocks.revokePortalHandoffToken).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.safeLog.mock.calls)).not.toContain("opaque-token");
    expect(JSON.stringify(mocks.safeLog.mock.calls)).not.toContain("page-scoped-user-id");
  });

  it("does not create a token when the Messenger user cannot be found", async () => {
    mocks.findStateByUserKey.mockResolvedValue(null);

    await expect(
      sendPortalHandoffLink({
        workspaceId: 42,
        messengerSenderUserKey,
      })
    ).resolves.toEqual({
      ok: false,
      reason: "messenger_user_not_found",
    });

    expect(mocks.createPortalHandoffToken).not.toHaveBeenCalled();
    expect(mocks.sendText).not.toHaveBeenCalled();
  });

  it("does not create a token when the Messenger response window is closed", async () => {
    mocks.hasOpenMessengerResponseWindow.mockResolvedValue(false);

    await expect(
      sendPortalHandoffLink({
        workspaceId: 42,
        messengerSenderUserKey,
      })
    ).resolves.toEqual({
      ok: false,
      reason: "response_window_closed",
    });

    expect(mocks.createPortalHandoffToken).not.toHaveBeenCalled();
    expect(mocks.sendText).not.toHaveBeenCalled();
  });

  it("refuses delivery when the paid handoff Page does not match inbound Messenger state", async () => {
    await expect(
      sendPortalHandoffLink({
        workspaceId: 42,
        messengerSenderUserKey,
        expectedFacebookPageId: "facebook-page-other-tenant",
      })
    ).resolves.toEqual({ ok: false, reason: "page_binding_unavailable" });

    expect(mocks.createPortalHandoffToken).not.toHaveBeenCalled();
    expect(mocks.sendText).not.toHaveBeenCalled();
  });

  it("refuses delivery when the inbound Page is no longer connected to the workspace", async () => {
    mocks.listChannelConnections.mockResolvedValue([]);

    await expect(
      sendPortalHandoffLink({
        workspaceId: 42,
        messengerSenderUserKey,
      })
    ).resolves.toEqual({ ok: false, reason: "page_binding_unavailable" });

    expect(mocks.createPortalHandoffToken).not.toHaveBeenCalled();
    expect(mocks.sendText).not.toHaveBeenCalled();
  });

  it("can safely recover after the customer reopens the Messenger response window", async () => {
    mocks.hasOpenMessengerResponseWindow
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(
      sendPortalHandoffLink({
        workspaceId: 42,
        messengerSenderUserKey,
      })
    ).resolves.toEqual({ ok: false, reason: "response_window_closed" });

    await expect(
      sendPortalHandoffLink({
        workspaceId: 42,
        messengerSenderUserKey,
      })
    ).resolves.toEqual({
      ok: true,
      sent: true,
      expiresAt: new Date("2026-07-06T11:30:00.000Z"),
    });

    // The closed-window attempt creates neither a token nor a Messenger send.
    // Retrying delivery does not interact with the payment flow.
    expect(mocks.createPortalHandoffToken).toHaveBeenCalledTimes(1);
    expect(mocks.sendText).toHaveBeenCalledTimes(1);
  });

  it("revokes a created token if Messenger declines the send", async () => {
    mocks.sendText.mockResolvedValue({
      sent: false,
      reason: "rate_limited",
    });

    await expect(
      sendPortalHandoffLink({
        workspaceId: 42,
        messengerSenderUserKey,
      })
    ).resolves.toEqual({
      ok: false,
      reason: "rate_limited",
    });

    expect(mocks.revokePortalHandoffToken).toHaveBeenCalledWith(
      "sha256:opaque-token-hash"
    );
  });

  it("revokes a created token if Messenger delivery fails", async () => {
    mocks.sendText.mockRejectedValue(new Error("graph send failed"));

    await expect(
      sendPortalHandoffLink({
        workspaceId: 42,
        messengerSenderUserKey,
      })
    ).resolves.toEqual({
      ok: false,
      reason: "send_failed",
    });

    expect(mocks.revokePortalHandoffToken).toHaveBeenCalledWith(
      "sha256:opaque-token-hash"
    );
    expect(JSON.stringify(mocks.safeLog.mock.calls)).not.toContain("graph send failed");
  });

  it("returns send_failed when token cleanup also fails after a delivery error", async () => {
    mocks.sendText.mockRejectedValue(new Error("graph send failed"));
    mocks.revokePortalHandoffToken.mockRejectedValue(new Error("db down"));

    await expect(
      sendPortalHandoffLink({
        workspaceId: 42,
        messengerSenderUserKey,
      })
    ).resolves.toEqual({
      ok: false,
      reason: "send_failed",
    });

    expect(mocks.revokePortalHandoffToken).toHaveBeenCalledWith(
      "sha256:opaque-token-hash"
    );
    expect(mocks.safeLog).toHaveBeenCalledWith(
      "portal_handoff_revoke_failed",
      expect.objectContaining({
        level: "error",
        workspaceId: 42,
      })
    );
  });
});
