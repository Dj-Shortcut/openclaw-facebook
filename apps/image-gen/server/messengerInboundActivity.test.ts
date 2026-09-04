import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setLastUserMessageAt: vi.fn(),
}));

vi.mock("./_core/messengerState", () => ({
  setLastUserMessageAt: mocks.setLastUserMessageAt,
}));

import { recordInboundUserActivity } from "./_core/messengerInboundActivity";
import type { InboundEventClassification } from "./_core/messengerInboundClassification";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Messenger inbound activity", () => {
  it("does not rearm for echoes, delivery receipts, or other non-user events", async () => {
    await recordInboundUserActivity(
      "raw-psid",
      { timestamp: 1_700_000_000_000 },
      { isInboundUserEvent: false } as InboundEventClassification
    );

    expect(mocks.setLastUserMessageAt).not.toHaveBeenCalled();
  });
});
