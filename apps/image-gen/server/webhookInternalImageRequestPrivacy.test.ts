import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admitPrivacy: vi.fn(),
  resolveOwnership: vi.fn(),
}));

vi.mock("./_core/messengerPrivacySubject", async importOriginal => {
  const actual =
    await importOriginal<typeof import("./_core/messengerPrivacySubject")>();
  return {
    ...actual,
    admitMessengerPrivacySubjectFromMetaEvent: mocks.admitPrivacy,
  };
});
vi.mock("./_core/workspaceEntitlementRuntime", async importOriginal => {
  const actual =
    await importOriginal<
      typeof import("./_core/workspaceEntitlementRuntime")
    >();
  return {
    ...actual,
    resolveMessengerGenerationOwnership: mocks.resolveOwnership,
  };
});

import { createInternalMessengerImageRequestHandler } from "./_core/webhookInternalImageRequest";
import { getMessengerRequestPrivacySubject } from "./_core/messengerRequestContext";
import { toUserKey } from "./_core/privacy";

describe("internal Messenger image action privacy", () => {
  beforeEach(() => {
    process.env.PRIVACY_PEPPER = "internal-image-privacy-test-pepper";
    mocks.admitPrivacy.mockReset().mockResolvedValue(5);
    mocks.resolveOwnership.mockReset().mockResolvedValue({
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      pageId: "page-a",
    });
  });

  it("checks the Meta timestamp without ever granting reactivation authority", async () => {
    const timestamp = 1_777_000_000_321;
    const userKey = toUserKey("sender-a");
    const runImageGeneration = vi.fn(async () => {
      expect(getMessengerRequestPrivacySubject()).toEqual({
        userKey,
        privacyEpoch: 5,
      });
      return { sent: true as const };
    });
    const handler = createInternalMessengerImageRequestHandler({
      defaultLang: "nl",
      maybeSendInFlightMessage: vi.fn(async () => ({
        handled: false as const,
      })),
      runImageGeneration,
      sendLoggedText: vi.fn(async () => ({ sent: true as const })),
    });

    await handler.acceptInternalMessengerImageRequest({
      psid: "sender-a",
      pageId: "page-a",
      prompt: "maak een foto",
      reqId: "req-internal-privacy",
      timestamp,
    });

    expect(mocks.admitPrivacy).toHaveBeenCalledWith({
      workspaceId: 42,
      channelConnectionId: 7,
      userKey,
      eventOccurredAt: new Date(timestamp),
      allowReactivation: false,
    });
    expect(runImageGeneration).toHaveBeenCalledTimes(1);
  });
});
