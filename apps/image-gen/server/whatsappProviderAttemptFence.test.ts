import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reserve: vi.fn(),
  claimErasure: vi.fn(),
  mark: vi.fn(),
  finalize: vi.fn(),
}));

vi.mock("./_core/messengerProviderAttemptFence", () => ({
  WHATSAPP_ERASURE_CONTROL_PROVIDER_OPERATION:
    "whatsapp_graph_erasure_control_text",
  reserveMessengerProviderAttemptFence: mocks.reserve,
  claimWhatsAppErasureControlProviderAttemptFence: mocks.claimErasure,
  markMessengerProviderAttemptStarted: mocks.mark,
  finalizeMessengerProviderAttemptFence: mocks.finalize,
}));

import {
  runWithMessengerErasureControlDelivery,
  runWithMessengerRequestContext,
  setMessengerRequestErasurePrivacySubject,
  setMessengerRequestPrivacySubject,
} from "./_core/messengerRequestContext";
import {
  claimWhatsAppErasureControlProviderAttempt,
  reserveWhatsAppProviderAttemptFence,
  WhatsAppProviderAttemptFenceError,
} from "./_core/whatsappProviderAttemptFence";

const originalNodeEnv = process.env.NODE_ENV;
const SCOPE = Object.freeze({
  workspaceId: 42,
  channelConnectionId: 8,
  bindingEpoch: 3,
  privacyEpoch: 2,
  userKey: "u:whatsapp-user",
});

describe("WhatsApp provider attempt fence", () => {
  beforeEach(() => {
    mocks.reserve.mockResolvedValue({
      leaseToken: "lease",
      attemptKeyHash: "a".repeat(64),
    });
    mocks.claimErasure.mockResolvedValue({
      kind: "owned",
      fence: {
        leaseToken: "erasure-lease",
        attemptKeyHash: "b".repeat(64),
      },
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
      { ...SCOPE, channel: "whatsapp" }
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

  it("uses a dedicated durable fence mode only for deletion outcomes", async () => {
    await runWithMessengerRequestContext(
      "404040404040404",
      async () => {
        setMessengerRequestErasurePrivacySubject({
          userKey: "u:whatsapp-user",
          privacyEpoch: 3,
          dataPrivacyEpoch: 2,
        });
        await runWithMessengerErasureControlDelivery(() =>
          claimWhatsAppErasureControlProviderAttempt({
            reqId: "wa-delete-outcome",
            userKey: "u:whatsapp-user",
          })
        );
      },
      {
        ...SCOPE,
        privacyEpoch: undefined,
        channel: "whatsapp",
      }
    );

    expect(mocks.claimErasure).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u:whatsapp-user",
        privacyEpoch: 3,
      }),
      expect.any(Date)
    );
    expect(mocks.reserve).not.toHaveBeenCalled();
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
        { ...SCOPE, channel: "whatsapp" }
      )
    ).rejects.toBeInstanceOf(WhatsAppProviderAttemptFenceError);
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("rejects partial request scope outside production", async () => {
    await expect(
      runWithMessengerRequestContext(
        "404040404040404",
        () =>
          reserveWhatsAppProviderAttemptFence({
            reqId: "wa-request",
            userKey: "u:whatsapp-user",
            providerOperation: "whatsapp_graph_text",
          }),
        { ...SCOPE, channel: "facebook_messenger" }
      )
    ).rejects.toBeInstanceOf(WhatsAppProviderAttemptFenceError);

    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("refuses the erasure-control operation on a generation fence", async () => {
    await expect(
      runWithMessengerRequestContext(
        "404040404040404",
        async () => {
          setMessengerRequestPrivacySubject({
            userKey: SCOPE.userKey,
            privacyEpoch: SCOPE.privacyEpoch,
          });
          return reserveWhatsAppProviderAttemptFence({
            reqId: "wa-delete-outcome",
            userKey: SCOPE.userKey,
            providerOperation: "whatsapp_graph_erasure_control_text",
          });
        },
        { ...SCOPE, channel: "whatsapp" }
      )
    ).rejects.toBeInstanceOf(WhatsAppProviderAttemptFenceError);

    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.claimErasure).not.toHaveBeenCalled();
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
