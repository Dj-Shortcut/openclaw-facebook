import { describe, expect, it, vi } from "vitest";

import type { MolliePayment } from "./mollieClient";
import {
  applyCreditPaymentWebhookSnapshot,
  CreditPaymentAdjustmentPendingError,
  createDeterministicCreditAdjustmentEntryId,
  createDeterministicCreditGrantEntryId,
} from "./creditPaymentWebhook";
import type {
  CreditPaymentAdjustmentEvidence,
  CreditPaymentGrantEvidence,
  CreditPaymentPersistenceResult,
} from "./creditPaymentWebhookStore";

const INTENT_ID = "22222222-2222-2222-2222-222222222222";
const WALLET_ID = "11111111-1111-1111-1111-111111111111";
const PAYMENT_ID = "tr_credit1";
const ROOT_GRANT_ID = "33333333-3333-3333-3333-333333333333";

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

const refundAdjustment = {
  workspaceId: 11,
  mode: "test",
  channelConnectionId: 12,
  bindingEpoch: 13,
  privacyEpoch: 14,
  walletId: WALLET_ID,
  financialSubjectRef: "b".repeat(64),
  intentId: INTENT_ID,
  authorizationEpoch: 15,
  paymentLedgerId: 16,
  providerPaymentId: PAYMENT_ID,
  rootGrantEntryId: ROOT_GRANT_ID,
  evidenceHash: "e".repeat(64),
  webhookPaymentId: PAYMENT_ID,
  deliverySnapshotHash: "e".repeat(64),
  kind: "refund_debit",
  providerEffectIds: ["re_credit_1"],
} satisfies CreditPaymentAdjustmentEvidence;

const chargebackAdjustment = {
  ...refundAdjustment,
  kind: "chargeback_debit",
  providerEffectId: "chb_credit_1",
} satisfies CreditPaymentAdjustmentEvidence;

function dependencies(persisted: CreditPaymentPersistenceResult) {
  return {
    persist: vi.fn(async () => persisted),
    grant: vi.fn(async () => ({ result: "applied" as const, entryId: "x" })),
    finish: vi.fn(async () => undefined),
    resolveGrantFailure: vi.fn(async () => "retryable" as const),
    refundDebit: vi.fn(async () => ({
      result: "applied" as const,
      entryId: "x",
    })),
    chargebackDebit: vi.fn(async () => ({
      result: "applied" as const,
      entryId: "x",
    })),
    chargebackRestore: vi.fn(async () => ({
      result: "applied_review_required" as const,
      entryId: "x",
    })),
    finishAdjustment: vi.fn(async () => undefined),
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
    expect(deps.refundDebit).not.toHaveBeenCalled();
    expect(deps.chargebackDebit).not.toHaveBeenCalled();
    expect(deps.chargebackRestore).not.toHaveBeenCalled();
    expect(deps.finishAdjustment).not.toHaveBeenCalled();
  });

  it("applies a full refund with one stable ledger entry before finishing", async () => {
    const deps = dependencies({
      result: "adjustment_pending",
      duplicateSnapshot: false,
      adjustment: refundAdjustment,
    });

    await expect(
      applyCreditPaymentWebhookSnapshot(
        { webhookPaymentId: PAYMENT_ID, expectedMode: "test", payment },
        deps
      )
    ).resolves.toBe("processed");

    const entryId =
      createDeterministicCreditAdjustmentEntryId(refundAdjustment);
    expect(deps.refundDebit).toHaveBeenCalledExactlyOnceWith({
      workspaceId: 11,
      mode: "test",
      channelConnectionId: 12,
      bindingEpoch: 13,
      privacyEpoch: 14,
      walletId: WALLET_ID,
      financialSubjectRef: "b".repeat(64),
      rootGrantEntryId: ROOT_GRANT_ID,
      entryId,
      evidenceHash: "e".repeat(64),
    });
    expect(deps.finishAdjustment).toHaveBeenCalledWith({
      adjustment: refundAdjustment,
      entryId,
      outcome: "applied",
    });
    expect(deps.refundDebit.mock.invocationCallOrder[0]).toBeLessThan(
      deps.finishAdjustment.mock.invocationCallOrder[0]!
    );
  });

  it("replays a refund with the same entry ID and never double-debits", async () => {
    const deps = dependencies({
      result: "adjustment_pending",
      duplicateSnapshot: false,
      adjustment: refundAdjustment,
    });
    deps.refundDebit
      .mockResolvedValueOnce({ result: "applied", entryId: "x" })
      .mockResolvedValueOnce({ result: "already_applied", entryId: "x" });

    await expect(
      applyCreditPaymentWebhookSnapshot(
        { webhookPaymentId: PAYMENT_ID, expectedMode: "test", payment },
        deps
      )
    ).resolves.toBe("processed");
    await expect(
      applyCreditPaymentWebhookSnapshot(
        { webhookPaymentId: PAYMENT_ID, expectedMode: "test", payment },
        deps
      )
    ).resolves.toBe("duplicate");

    expect(deps.refundDebit).toHaveBeenCalledTimes(2);
    expect(deps.refundDebit.mock.calls[0]?.[0].entryId).toBe(
      deps.refundDebit.mock.calls[1]?.[0].entryId
    );
  });

  it("runs the exact active chargeback debit routine", async () => {
    const deps = dependencies({
      result: "adjustment_pending",
      duplicateSnapshot: false,
      adjustment: chargebackAdjustment,
    });

    await expect(
      applyCreditPaymentWebhookSnapshot(
        { webhookPaymentId: PAYMENT_ID, expectedMode: "test", payment },
        deps
      )
    ).resolves.toBe("processed");
    expect(deps.chargebackDebit).toHaveBeenCalledWith(
      expect.objectContaining({
        providerEffectId: "chb_credit_1",
        entryId:
          createDeterministicCreditAdjustmentEntryId(chargebackAdjustment),
      })
    );
    expect(deps.finishAdjustment).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "applied" })
    );
  });

  it("restores only the exact reversed chargeback and records review", async () => {
    const adjustment = {
      ...chargebackAdjustment,
      kind: "chargeback_restore",
    } satisfies CreditPaymentAdjustmentEvidence;
    const deps = dependencies({
      result: "adjustment_pending",
      duplicateSnapshot: false,
      adjustment,
    });

    await expect(
      applyCreditPaymentWebhookSnapshot(
        { webhookPaymentId: PAYMENT_ID, expectedMode: "test", payment },
        deps
      )
    ).resolves.toBe("processed");
    expect(deps.chargebackRestore).toHaveBeenCalledWith(
      expect.objectContaining({ providerEffectId: "chb_credit_1" })
    );
    expect(deps.finishAdjustment).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "applied_review_required" })
    );
  });

  it("keeps active holds retryable and does not acknowledge the webhook", async () => {
    const deps = dependencies({
      result: "adjustment_pending",
      duplicateSnapshot: false,
      adjustment: refundAdjustment,
    });
    deps.refundDebit.mockResolvedValueOnce({
      result: "pending_holds",
      rootGrantEntryId: ROOT_GRANT_ID,
    });

    await expect(
      applyCreditPaymentWebhookSnapshot(
        { webhookPaymentId: PAYMENT_ID, expectedMode: "test", payment },
        deps
      )
    ).rejects.toBeInstanceOf(CreditPaymentAdjustmentPendingError);
    expect(deps.finishAdjustment).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "refund debit",
      routine: "refundDebit" as const,
      adjustment: {
        ...refundAdjustment,
        evidenceHash: "d".repeat(64),
        deliverySnapshotHash: "e".repeat(64),
        replayEntryId: "44444444-4444-4444-8444-444444444444",
      } satisfies CreditPaymentAdjustmentEvidence,
    },
    {
      label: "chargeback debit",
      routine: "chargebackDebit" as const,
      adjustment: {
        ...chargebackAdjustment,
        evidenceHash: "d".repeat(64),
        deliverySnapshotHash: "e".repeat(64),
        replayEntryId: "55555555-5555-4555-8555-555555555555",
      } satisfies CreditPaymentAdjustmentEvidence,
    },
    {
      label: "chargeback restore",
      routine: "chargebackRestore" as const,
      adjustment: {
        ...chargebackAdjustment,
        kind: "chargeback_restore",
        evidenceHash: "c".repeat(64),
        deliverySnapshotHash: "e".repeat(64),
        replayEntryId: "66666666-6666-4666-8666-666666666666",
      } satisfies CreditPaymentAdjustmentEvidence,
    },
  ])(
    "reuses the immutable $label entry after a later payment snapshot",
    async ({ routine, adjustment }) => {
      const deps = dependencies({
        result: "adjustment_pending",
        duplicateSnapshot: false,
        adjustment,
      });
      deps[routine].mockResolvedValueOnce({
        result: "already_applied",
        entryId: adjustment.replayEntryId,
      });

      await expect(
        applyCreditPaymentWebhookSnapshot(
          { webhookPaymentId: PAYMENT_ID, expectedMode: "test", payment },
          deps
        )
      ).resolves.toBe("duplicate");
      expect(deps[routine]).toHaveBeenCalledWith(
        expect.objectContaining({
          entryId: adjustment.replayEntryId,
          evidenceHash: adjustment.evidenceHash,
        })
      );
      expect(deps.finishAdjustment).toHaveBeenCalledWith({
        adjustment,
        entryId: adjustment.replayEntryId,
        outcome: "already_applied",
      });
    }
  );

  it("durably finishes a routine-declared manual review without another debit", async () => {
    const deps = dependencies({
      result: "adjustment_pending",
      duplicateSnapshot: false,
      adjustment: refundAdjustment,
    });
    deps.refundDebit.mockResolvedValueOnce({
      result: "manual_review",
      rootGrantEntryId: ROOT_GRANT_ID,
    });

    await expect(
      applyCreditPaymentWebhookSnapshot(
        { webhookPaymentId: PAYMENT_ID, expectedMode: "test", payment },
        deps
      )
    ).resolves.toBe("mismatch");
    expect(deps.finishAdjustment).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "manual_review" })
    );
    expect(deps.chargebackDebit).not.toHaveBeenCalled();
    expect(deps.chargebackRestore).not.toHaveBeenCalled();
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

  it("reports a real grant as processed even when the provider snapshot is a replay", async () => {
    const deps = dependencies({
      result: "grant_pending",
      duplicateSnapshot: true,
      grant,
    });
    deps.grant.mockResolvedValueOnce({ result: "applied", entryId: "x" });

    await expect(
      applyCreditPaymentWebhookSnapshot(
        { webhookPaymentId: PAYMENT_ID, expectedMode: "test", payment },
        deps
      )
    ).resolves.toBe("processed");
    expect(deps.finish).toHaveBeenCalledWith(grant);
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
