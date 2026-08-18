import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getMessengerRequestPageId: vi.fn(),
  rearmFailedPortalHandoffAfterInbound: vi.fn(),
  setLastUserMessageAt: vi.fn(),
  toUserKey: vi.fn(() => "a".repeat(64)),
}));

vi.mock("./_core/messengerState", () => ({
  setLastUserMessageAt: mocks.setLastUserMessageAt,
}));
vi.mock("./_core/messengerRequestContext", () => ({
  getMessengerRequestPageId: mocks.getMessengerRequestPageId,
}));
vi.mock("./_core/privacy", () => ({ toUserKey: mocks.toUserKey }));
vi.mock("./_core/billing/portalHandoffRecovery", () => ({
  rearmFailedPortalHandoffAfterInbound:
    mocks.rearmFailedPortalHandoffAfterInbound,
}));

import { recordInboundUserActivity } from "./_core/messengerInboundActivity";
import type { InboundEventClassification } from "./_core/messengerInboundClassification";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getMessengerRequestPageId.mockReturnValue("page-42");
  mocks.rearmFailedPortalHandoffAfterInbound.mockResolvedValue(true);
});

describe("Messenger inbound activity", () => {
  it("rearms only the matching Page-scoped paid handoff after user activity", async () => {
    await recordInboundUserActivity(
      "raw-psid",
      { timestamp: 1_700_000_000_000 },
      { isInboundUserEvent: true } as InboundEventClassification
    );

    expect(mocks.setLastUserMessageAt).toHaveBeenCalledWith(
      "raw-psid",
      1_700_000_000_000
    );
    expect(mocks.rearmFailedPortalHandoffAfterInbound).toHaveBeenCalledWith({
      facebookPageId: "page-42",
      messengerSenderUserKey: "a".repeat(64),
    });
  });

  it("does not rearm for echoes, delivery receipts, or other non-user events", async () => {
    await recordInboundUserActivity(
      "raw-psid",
      { timestamp: 1_700_000_000_000 },
      { isInboundUserEvent: false } as InboundEventClassification
    );

    expect(mocks.setLastUserMessageAt).not.toHaveBeenCalled();
    expect(mocks.rearmFailedPortalHandoffAfterInbound).not.toHaveBeenCalled();
  });

  it("does not attempt recovery without an authenticated Page context", async () => {
    mocks.getMessengerRequestPageId.mockReturnValue(null);

    await recordInboundUserActivity(
      "raw-psid",
      { timestamp: 1_700_000_000_000 },
      { isInboundUserEvent: true } as InboundEventClassification
    );

    expect(mocks.setLastUserMessageAt).toHaveBeenCalled();
    expect(mocks.rearmFailedPortalHandoffAfterInbound).not.toHaveBeenCalled();
  });
});
