import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumePortalHandoffToken,
  createPortalHandoffToken,
  hashMessengerSenderForHandoff,
  hashPortalHandoffToken,
} from "./_core/portalHandoff";

const mocks = vi.hoisted(() => ({
  createPortalHandoffToken: vi.fn(),
  getPortalHandoffTokenByHash: vi.fn(),
  markPortalHandoffTokenConsumed: vi.fn(),
  insertAuditLog: vi.fn(),
}));

const originalPrivacyPepper = process.env.PRIVACY_PEPPER;

vi.mock("./db", () => ({
  createPortalHandoffToken: mocks.createPortalHandoffToken,
  getPortalHandoffTokenByHash: mocks.getPortalHandoffTokenByHash,
  markPortalHandoffTokenConsumed: mocks.markPortalHandoffTokenConsumed,
  insertAuditLog: mocks.insertAuditLog,
}));

describe("portal handoff tokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PRIVACY_PEPPER = "portal-handoff-test-pepper";
  });

  afterEach(() => {
    if (originalPrivacyPepper === undefined) {
      delete process.env.PRIVACY_PEPPER;
      return;
    }
    process.env.PRIVACY_PEPPER = originalPrivacyPepper;
  });

  it("hashes Messenger sender identifiers before handoff storage", () => {
    const senderId = "1234567890123456";

    expect(hashMessengerSenderForHandoff(senderId)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashMessengerSenderForHandoff(senderId)).not.toContain(senderId);
  });

  it("creates an opaque token but persists only the hash and metadata", async () => {
    const now = new Date("2026-06-30T10:00:00.000Z");

    const result = await createPortalHandoffToken({
      workspaceId: 42,
      messengerSenderUserKey: "hashed-sender-key",
      createdByUserId: 7,
      now,
      ttlMs: 60_000,
    });

    expect(result.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(result.tokenHash).toBe(hashPortalHandoffToken(result.token));
    expect(result.expiresAt.toISOString()).toBe("2026-06-30T10:01:00.000Z");
    expect(mocks.createPortalHandoffToken).toHaveBeenCalledWith({
      workspaceId: 42,
      tokenHash: result.tokenHash,
      messengerSenderUserKey: "hashed-sender-key",
      purpose: "workspace_onboarding",
      status: "pending",
      expiresAt: result.expiresAt,
      createdByUserId: 7,
    });
    expect(JSON.stringify(mocks.createPortalHandoffToken.mock.calls)).not.toContain(
      result.token
    );
    expect(mocks.insertAuditLog).toHaveBeenCalledWith({
      workspaceId: 42,
      userId: 7,
      event: "portal_handoff.created",
      metadata: {
        purpose: "workspace_onboarding",
        hasMessengerSenderUserKey: true,
        expiresAt: result.expiresAt.toISOString(),
      },
    });
    expect(JSON.stringify(mocks.insertAuditLog.mock.calls)).not.toContain(result.token);
  });

  it("consumes a pending unexpired token exactly once", async () => {
    const token = "handoff-token";
    const tokenHash = hashPortalHandoffToken(token);
    mocks.getPortalHandoffTokenByHash.mockResolvedValue({
      workspaceId: 42,
      tokenHash,
      messengerSenderUserKey: "hashed-sender-key",
      purpose: "workspace_onboarding",
      status: "pending",
      expiresAt: new Date("2026-06-30T10:05:00.000Z"),
    });
    mocks.markPortalHandoffTokenConsumed.mockResolvedValue(true);

    await expect(
      consumePortalHandoffToken(token, new Date("2026-06-30T10:00:00.000Z"))
    ).resolves.toEqual({
      ok: true,
      workspaceId: 42,
      purpose: "workspace_onboarding",
      messengerSenderUserKey: "hashed-sender-key",
    });
    expect(mocks.getPortalHandoffTokenByHash).toHaveBeenCalledWith(tokenHash);
    expect(mocks.markPortalHandoffTokenConsumed).toHaveBeenCalledWith(tokenHash);
  });

  it("rejects missing, expired, and already-consumed tokens", async () => {
    mocks.getPortalHandoffTokenByHash.mockResolvedValueOnce(null);
    await expect(consumePortalHandoffToken("missing")).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });

    mocks.getPortalHandoffTokenByHash.mockResolvedValueOnce({
      workspaceId: 42,
      tokenHash: hashPortalHandoffToken("expired"),
      messengerSenderUserKey: null,
      purpose: "workspace_onboarding",
      status: "pending",
      expiresAt: new Date("2026-06-30T09:59:59.000Z"),
    });
    await expect(
      consumePortalHandoffToken("expired", new Date("2026-06-30T10:00:00.000Z"))
    ).resolves.toEqual({
      ok: false,
      reason: "expired",
    });

    mocks.getPortalHandoffTokenByHash.mockResolvedValueOnce({
      workspaceId: 42,
      tokenHash: hashPortalHandoffToken("consumed"),
      messengerSenderUserKey: null,
      purpose: "workspace_onboarding",
      status: "consumed",
      expiresAt: new Date("2026-06-30T10:05:00.000Z"),
    });
    await expect(consumePortalHandoffToken("consumed")).resolves.toEqual({
      ok: false,
      reason: "already_used",
    });
  });
});
