import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestMessengerPortalHandoff } from "./_core/messengerPortalHandoff";

const mocks = vi.hoisted(() => ({
  findPortalHandoffReentryBinding: vi.fn(),
  findUniqueConnectedFacebookWorkspaceId: vi.fn(),
  sendPortalHandoffLink: vi.fn(),
}));

vi.mock("./db", () => ({
  findPortalHandoffReentryBinding: mocks.findPortalHandoffReentryBinding,
  findUniqueConnectedFacebookWorkspaceId:
    mocks.findUniqueConnectedFacebookWorkspaceId,
}));

vi.mock("./_core/portalHandoffDelivery", () => ({
  sendPortalHandoffLink: mocks.sendPortalHandoffLink,
}));

describe("Messenger portal re-entry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findPortalHandoffReentryBinding.mockResolvedValue({
      workspaceId: 42,
      userId: 7,
    });
    mocks.sendPortalHandoffLink.mockResolvedValue({
      ok: true,
      sent: true,
      expiresAt: new Date("2026-08-20T20:10:00.000Z"),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("issues a short account-restricted link for an existing binding", async () => {
    await expect(
      requestMessengerPortalHandoff({
        facebookPageId: "facebook-page-42",
        messengerSenderId: "page-scoped-user-id",
        messengerSenderUserKey: "a".repeat(64),
        requestId: "request-123",
      })
    ).resolves.toBe("sent");

    expect(mocks.findPortalHandoffReentryBinding).toHaveBeenCalledWith({
      facebookPageId: "facebook-page-42",
      messengerSenderUserKey: "a".repeat(64),
    });
    expect(mocks.sendPortalHandoffLink).toHaveBeenCalledWith({
      workspaceId: 42,
      messengerSenderUserKey: "a".repeat(64),
      expectedFacebookPageId: "facebook-page-42",
      createdByUserId: 7,
      ttlMs: 600_000,
      deliveryIdempotencyKey: "messenger_portal_reentry_v1:42:7:request-123",
      messageVariant: "portal_reentry",
    });
  });

  it("fails closed when Page, prior claim, or membership is missing", async () => {
    mocks.findPortalHandoffReentryBinding.mockResolvedValue(null);

    await expect(
      requestMessengerPortalHandoff({
        facebookPageId: "facebook-page-42",
        messengerSenderId: "page-scoped-user-id",
        messengerSenderUserKey: "a".repeat(64),
        requestId: "request-123",
      })
    ).resolves.toBe("not_linked");
    expect(mocks.sendPortalHandoffLink).not.toHaveBeenCalled();
  });

  it("allows a configured Messenger admin to bootstrap the connected workspace", async () => {
    vi.stubEnv("MESSENGER_ADMIN_IDS", "page-scoped-user-id");
    mocks.findPortalHandoffReentryBinding.mockResolvedValue(null);
    mocks.findUniqueConnectedFacebookWorkspaceId.mockResolvedValue(42);

    await expect(
      requestMessengerPortalHandoff({
        facebookPageId: "facebook-page-42",
        messengerSenderId: "page-scoped-user-id",
        messengerSenderUserKey: "a".repeat(64),
        requestId: "request-admin",
      })
    ).resolves.toBe("sent");

    expect(mocks.sendPortalHandoffLink).toHaveBeenCalledWith({
      workspaceId: 42,
      messengerSenderUserKey: "a".repeat(64),
      expectedFacebookPageId: "facebook-page-42",
      createdByUserId: null,
      ttlMs: 600_000,
      deliveryIdempotencyKey:
        "messenger_portal_reentry_v1:42:admin-bootstrap:request-admin",
      messageVariant: "admin_onboarding",
    });
  });

  it("never bootstraps an unlisted Messenger user", async () => {
    vi.stubEnv("MESSENGER_ADMIN_IDS", "different-user");
    mocks.findPortalHandoffReentryBinding.mockResolvedValue(null);

    await expect(
      requestMessengerPortalHandoff({
        facebookPageId: "facebook-page-42",
        messengerSenderId: "page-scoped-user-id",
        messengerSenderUserKey: "a".repeat(64),
        requestId: "request-unlisted",
      })
    ).resolves.toBe("not_linked");
    expect(mocks.findUniqueConnectedFacebookWorkspaceId).not.toHaveBeenCalled();
    expect(mocks.sendPortalHandoffLink).not.toHaveBeenCalled();
  });

  it("does not attempt a lookup without the inbound Page binding", async () => {
    await expect(
      requestMessengerPortalHandoff({
        facebookPageId: null,
        messengerSenderId: "page-scoped-user-id",
        messengerSenderUserKey: "a".repeat(64),
        requestId: "request-123",
      })
    ).resolves.toBe("not_linked");
    expect(mocks.findPortalHandoffReentryBinding).not.toHaveBeenCalled();
  });

  it("returns a generic failure when database or delivery is unavailable", async () => {
    mocks.findPortalHandoffReentryBinding.mockRejectedValueOnce(
      new Error("database unavailable")
    );
    await expect(
      requestMessengerPortalHandoff({
        facebookPageId: "facebook-page-42",
        messengerSenderId: "page-scoped-user-id",
        messengerSenderUserKey: "a".repeat(64),
        requestId: "request-123",
      })
    ).resolves.toBe("unavailable");

    mocks.findPortalHandoffReentryBinding.mockResolvedValue({
      workspaceId: 42,
      userId: 7,
    });
    mocks.sendPortalHandoffLink.mockResolvedValue({
      ok: false,
      reason: "send_failed",
    });
    await expect(
      requestMessengerPortalHandoff({
        facebookPageId: "facebook-page-42",
        messengerSenderId: "page-scoped-user-id",
        messengerSenderUserKey: "a".repeat(64),
        requestId: "request-456",
      })
    ).resolves.toBe("unavailable");
  });
});
