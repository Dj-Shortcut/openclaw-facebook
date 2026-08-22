import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reserve: vi.fn(),
  mark: vi.fn(),
  finalize: vi.fn(),
}));

vi.mock("./_core/messengerProviderAttemptFence", () => ({
  reserveMessengerProviderAttemptFence: mocks.reserve,
  markMessengerProviderAttemptStarted: mocks.mark,
  finalizeMessengerProviderAttemptFence: mocks.finalize,
}));

import {
  runWithMessengerRequestContext,
  setMessengerRequestPrivacySubject,
} from "./_core/messengerRequestContext";
import {
  reserveWhatsAppProviderAttemptFence,
  WhatsAppProviderAttemptFenceError,
} from "./_core/whatsappProviderAttemptFence";

const originalNodeEnv = process.env.NODE_ENV;
const SCOPE = Object.freeze({
  workspaceId: 42,
  channelConnectionId: 8,
  bindingEpoch: 3,
  privacyEpoch: 2,
});

describe("WhatsApp provider attempt fence", () => {
  beforeEach(() => {
    mocks.reserve.mockResolvedValue({
      leaseToken: "lease",
      attemptKeyHash: "a".repeat(64),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it("pins the exact inbound ownership and privacy epoch", async () => {
    await runWithMessengerRequestContext(
      "404040404040404",
      async () => {
        setMessengerRequestPrivacySubject({
          userKey: "u:whatsapp-user",
          privacyEpoch: SCOPE.privacyEpoch,
        });
        await reserveWhatsAppProviderAttemptFence({
          reqId: "wa-request",
          userKey: "u:whatsapp-user",
          providerOperation: "whatsapp_graph_text",
          expectedScope: SCOPE,
        });
      },
      SCOPE
    );

    expect(mocks.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        psid: "u:whatsapp-user",
        userId: "u:whatsapp-user",
        pageId: "404040404040404",
        workspaceId: SCOPE.workspaceId,
        channelConnectionId: SCOPE.channelConnectionId,
        bindingEpoch: SCOPE.bindingEpoch,
        privacyEpoch: SCOPE.privacyEpoch,
        reqId: "wa-request",
      }),
      "whatsapp_graph_text",
      1,
      expect.any(Date),
      "whatsapp"
    );
  });

  it("rejects a stale expected binding before reserving", async () => {
    await expect(
      runWithMessengerRequestContext(
        "404040404040404",
        async () => {
          setMessengerRequestPrivacySubject({
            userKey: "u:whatsapp-user",
            privacyEpoch: SCOPE.privacyEpoch,
          });
          return reserveWhatsAppProviderAttemptFence({
            reqId: "wa-request",
            userKey: "u:whatsapp-user",
            providerOperation: "whatsapp_openai_image",
            expectedScope: { ...SCOPE, bindingEpoch: SCOPE.bindingEpoch - 1 },
          });
        },
        SCOPE
      )
    ).rejects.toBeInstanceOf(WhatsAppProviderAttemptFenceError);
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("fails closed without immutable request scope in production", async () => {
    process.env.NODE_ENV = "production";
    await expect(
      reserveWhatsAppProviderAttemptFence({
        reqId: "wa-request",
        userKey: "u:whatsapp-user",
        providerOperation: "whatsapp_graph_text",
      })
    ).rejects.toBeInstanceOf(WhatsAppProviderAttemptFenceError);
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
});
