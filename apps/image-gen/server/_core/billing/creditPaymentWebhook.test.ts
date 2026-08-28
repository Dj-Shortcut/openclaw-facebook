import { describe, expect, it, vi } from "vitest";

import type { MolliePayment } from "./mollieClient";
import {
  applyCreditPaymentWebhookSnapshot,
  createDeterministicCreditGrantEntryId,
} from "./creditPaymentWebhook";
import type { CreditPaymentGrantEvidence } from "./creditPaymentWebhookStore";

const INTENT_ID = "22222222-2222-2222-2222-222222222222";
const WALLET_ID = "11111111-1111-1111-1111-111111111111";
const PAYMENT_ID = "tr_credit1";

const payment = {
  resource: "payment",
  id: PAYMENT_ID,
  mode: "test",
  status: "paid",
  amount: { currency: "EUR", value: "4.99" },
  description: "Leaderbot - 8 premium beeldcredits",
  method: "bancontact",
  sequenceType: "oneoff",
  customerId: null,
  mandateId: null,
  subscriptionId: null,
  metadata: {
    billingIntentId: INTENT_ID,
    purpose: "premium_image_credits",
    version: 1,
    metadataHash: "d".repeat(64),
  },
  createdAt: "2026-08-28T10:00:00.000Z",
  paidAt: "2026-08-28T10:01:00.000Z",
} satisfies MolliePayment;

const grant = {
  workspaceId: 11,
  mode: "test",
  channelConnectionId: 12,
  bindingEpoch: 13,
  privacyEpoch: 14,
  userKey: "a".repeat(64),
  walletId: WALLET_ID,
  financialSubjectRef: "b".repeat(64),
  intentId: INTENT_ID,
  authorizationEpoch: 15,
  providerPaymentId: PAYMENT_ID,
  evidenceHash: "c".repeat(64),
  webhookPaymentId: PAYMENT_ID,
  deliverySnapshotHash: "c".repeat(64),
} satisfies CreditPaymentGrantEvidence;

function dependencies(
  persisted:
    | { result: "unknown" | "mismatch" | "processed" | "duplicate" }
    | {
        result: "grant_pending";
        duplicateSnapshot: boolean;
        grant: CreditPaymentGrantEvidence;
      }
) {
  return {
    persist: vi.fn(async () => persisted),
    grant: vi.fn(async () => ({ result: "applied" as const, entryId: "x" })),
    finish: vi.fn(async () => undefined),
    resolveGrantFailure: vi.fn(async () => "retryable" as const),
  };
}

describe("credit payment webhook grant orchestration", () => {
  it.each(["unknown", "mismatch", "processed", "duplicate"] as const)(
    "returns %s without granting",
    async result => {
      const deps = dependencies({ result });
      await expect(
        applyCreditPaymentWebhookSnapshot(
          { webhookPaymentId: PAYMENT_ID, expectedMode: "test", payment },
          deps
        )
      ).resolves.toBe(result);
      expect(deps.grant).not.toHaveBeenCalled();
      expect(deps.finish).not.toHaveBeenCalled();
    }
  );

  it("never grants after the store durably contains an adjusted payment", async () => {
    const deps = dependencies({ result: "mismatch" });
    const adjustedPayment = {
      ...payment,
      _embedded: {
        refunds: [
          {
            id: "re_credit_1",
            status: "refunded",
            amount: { currency: "EUR", value: "4.99" },
          },
        ],
      },
    } satisfies MolliePayment;

    await expect(
      applyCreditPaymentWebhookSnapshot(
        {
          webhookPaymentId: PAYMENT_ID,
          expectedMode: "test",
          payment: adjustedPayment,
        },
        deps
      )
    ).resolves.toBe("mismatch");

    expect(deps.persist).toHaveBeenCalledWith(
      expect.objectContaining({ payment: adjustedPayment })
    );
    expect(deps.grant).not.toHaveBeenCalled();
    expect(deps.finish).not.toHaveBeenCalled();
  });

  it("grants the exact payment once and then marks the webhook complete", async () => {
    const deps = dependencies({
      result: "grant_pending",
      duplicateSnapshot: false,
      grant,
    });
    await expect(
      applyCreditPaymentWebhookSnapshot(
        { webhookPaymentId: PAYMENT_ID, expectedMode: "test", payment },
        deps
      )
    ).resolves.toBe("processed");

    expect(deps.grant).toHaveBeenCalledOnce();
    expect(deps.grant).toHaveBeenCalledWith({
      workspaceId: 11,
      mode: "test",
      channelConnectionId: 12,
      bindingEpoch: 13,
      privacyEpoch: 14,
      userKey: "a".repeat(64),
      walletId: WALLET_ID,
      financialSubjectRef: "b".repeat(64),
      intentId: INTENT_ID,
      providerPaymentId: PAYMENT_ID,
      entryId: createDeterministicCreditGrantEntryId(grant),
      evidenceHash: "c".repeat(64),
    });
    expect(deps.finish).toHaveBeenCalledWith(grant);
    expect(deps.grant.mock.invocationCallOrder[0]).toBeLessThan(
      deps.finish.mock.invocationCallOrder[0]!
    );
  });

  it("replays a pending delivery with the same immutable grant ID", async () => {
    const first = dependencies({
      result: "grant_pending",
      duplicateSnapshot: true,
      grant,
    });
    first.grant.mockResolvedValueOnce({
      result: "already_applied",
      entryId: "x",
    });
    await expect(
      applyCreditPaymentWebhookSnapshot(
        { webhookPaymentId: PAYMENT_ID, expectedMode: "test", payment },
        first
      )
    ).resolves.toBe("duplicate");
    expect(first.finish).toHaveBeenCalledOnce();

    expect(createDeterministicCreditGrantEntryId(grant)).toBe(
      createDeterministicCreditGrantEntryId({ ...grant })
    );
    expect(createDeterministicCreditGrantEntryId(grant)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it("keeps a still-eligible grant failure retryable", async () => {
    const deps = dependencies({
      result: "grant_pending",
      duplicateSnapshot: false,
      grant,
    });
    const outage = new Error("database unavailable");
    deps.grant.mockRejectedValueOnce(outage);
    await expect(
      applyCreditPaymentWebhookSnapshot(
        { webhookPaymentId: PAYMENT_ID, expectedMode: "test", payment },
        deps
      )
    ).rejects.toBe(outage);
    expect(deps.resolveGrantFailure).toHaveBeenCalledWith(grant);
    expect(deps.finish).not.toHaveBeenCalled();
  });

  it("treats an idempotently applied grant after a crash as duplicate", async () => {
    const deps = dependencies({
      result: "grant_pending",
      duplicateSnapshot: true,
      grant,
    });
    deps.grant.mockRejectedValueOnce(new Error("response lost"));
    deps.resolveGrantFailure.mockResolvedValueOnce("already_applied");
    await expect(
      applyCreditPaymentWebhookSnapshot(
        { webhookPaymentId: PAYMENT_ID, expectedMode: "test", payment },
        deps
      )
    ).resolves.toBe("duplicate");
  });

  it("contains a paid result when the user boundary changed before grant", async () => {
    const deps = dependencies({
      result: "grant_pending",
      duplicateSnapshot: false,
      grant,
    });
    deps.grant.mockRejectedValueOnce(new Error("scope changed"));
    deps.resolveGrantFailure.mockResolvedValueOnce("contained");
    await expect(
      applyCreditPaymentWebhookSnapshot(
        { webhookPaymentId: PAYMENT_ID, expectedMode: "test", payment },
        deps
      )
    ).resolves.toBe("mismatch");
  });

  it("uses distinct stable grant IDs for different provider payments", () => {
    expect(
      createDeterministicCreditGrantEntryId({
        ...grant,
        providerPaymentId: "tr_credit2",
      })
    ).not.toBe(createDeterministicCreditGrantEntryId(grant));
  });
});
