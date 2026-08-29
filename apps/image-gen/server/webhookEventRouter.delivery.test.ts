import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  confirmReceipts: vi.fn(),
  commitPaidCredit: vi.fn(),
  getActivePrivacyEpoch: vi.fn(),
  resolveOwnership: vi.fn(),
}));
vi.mock("./_core/messengerPrivacySubject", async importOriginal => {
  const actual =
    await importOriginal<typeof import("./_core/messengerPrivacySubject")>();
  return {
    ...actual,
    getActiveMessengerPrivacySubjectEpoch: mocks.getActivePrivacyEpoch,
  };
});

vi.mock("./_core/messengerGenerationCompletion", async importOriginal => {
  const actual =
    await importOriginal<
      typeof import("./_core/messengerGenerationCompletion")
    >();
  return {
    ...actual,
    confirmMessengerGenerationDeliveryReceipts: mocks.confirmReceipts,
  };
});
vi.mock("./_core/webhookGenerationJobs", async importOriginal => {
  const actual =
    await importOriginal<typeof import("./_core/webhookGenerationJobs")>();
  return {
    ...actual,
    commitPaidCreditFromDeliveredCompletion: mocks.commitPaidCredit,
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

import { handleEntry } from "./_core/webhookEventRouter";
import {
  runWithMessengerRequestContext,
  setMessengerRequestPrivacySubject,
} from "./_core/messengerRequestContext";
import { toUserKey } from "./_core/privacy";
import type { HandlerContext } from "./_core/webhookHandlerTypes";

const OWNER = {
  workspaceId: 42,
  channelConnectionId: 7,
  bindingEpoch: 3,
};
const PAGE_ID = "page-delivery-receipt";
const PSID = "psid-delivery-receipt";
let USER_KEY = "";

async function runScoped(action: () => Promise<void>): Promise<void> {
  await runWithMessengerRequestContext(
    PAGE_ID,
    async () => {
      setMessengerRequestPrivacySubject({ userKey: USER_KEY, privacyEpoch: 9 });
      await action();
    },
    { channel: "facebook_messenger", ...OWNER }
  );
}

describe("Messenger delivery receipt routing", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.PRIVACY_PEPPER = "delivery-receipt-test-pepper";
    USER_KEY = toUserKey(PSID);
    mocks.resolveOwnership.mockReset().mockResolvedValue(OWNER);
    mocks.getActivePrivacyEpoch.mockReset().mockResolvedValue(9);
    mocks.commitPaidCredit.mockReset().mockResolvedValue(undefined);
    mocks.confirmReceipts.mockReset().mockResolvedValue([
      {
        reqId: "req-paid-receipt",
        imageUrl: "https://assets.example/generated/paid.png",
        completedAt: Date.now(),
        deliveryStatus: "delivered",
        quotaAccountingMode: "paid_credit_delivery_v1",
        paidCreditMode: "test",
        userKey: USER_KEY,
        ...OWNER,
        privacyEpoch: 9,
        pageId: PAGE_ID,
        channel: "facebook_messenger",
      },
    ]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("commits only the exact paid completion confirmed by scoped Meta mids", async () => {
    const ctx = {} as HandlerContext;
    await runScoped(() =>
      handleEntry(ctx, {
        id: PAGE_ID,
        messaging: [
          {
            sender: { id: PSID },
            recipient: { id: PAGE_ID },
            delivery: { mids: ["mid-paid-receipt"] },
          },
        ],
      })
    );

    const fence = {
      ...OWNER,
      privacyEpoch: 9,
      userKey: USER_KEY,
      pageId: PAGE_ID,
      channel: "facebook_messenger",
    };
    expect(mocks.confirmReceipts).toHaveBeenCalledWith(
      ["mid-paid-receipt"],
      fence
    );
    expect(mocks.commitPaidCredit).toHaveBeenCalledOnce();
    expect(mocks.commitPaidCredit).toHaveBeenCalledWith({
      reqId: "req-paid-receipt",
      userId: USER_KEY,
      imageUrl: "https://assets.example/generated/paid.png",
      completionFence: fence,
      paidCreditMode: "test",
    });
  });

  it("leaves the hold untouched when a delivery callback has no mids", async () => {
    await runScoped(() =>
      handleEntry({} as HandlerContext, {
        id: PAGE_ID,
        messaging: [
          {
            sender: { id: PSID },
            recipient: { id: PAGE_ID },
            delivery: {},
          },
        ],
      })
    );

    expect(mocks.confirmReceipts).not.toHaveBeenCalled();
    expect(mocks.commitPaidCredit).not.toHaveBeenCalled();
  });

  it("resolves only an existing active subject when no privacy context is inherited", async () => {
    await runWithMessengerRequestContext(
      PAGE_ID,
      () =>
        handleEntry({} as HandlerContext, {
          id: PAGE_ID,
          messaging: [
            {
              sender: { id: PSID },
              recipient: { id: PAGE_ID },
              delivery: { mids: ["mid-active-subject"] },
            },
          ],
        }),
      { channel: "facebook_messenger", ...OWNER }
    );

    expect(mocks.getActivePrivacyEpoch).toHaveBeenCalledWith({
      ...OWNER,
      userKey: USER_KEY,
    });
    expect(mocks.confirmReceipts).toHaveBeenCalledWith(
      ["mid-active-subject"],
      expect.objectContaining({
        ...OWNER,
        privacyEpoch: 9,
        userKey: USER_KEY,
        pageId: PAGE_ID,
      })
    );
  });
});
