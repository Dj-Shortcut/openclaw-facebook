import { createHash } from "node:crypto";

import type { MollieMode } from "./config";
import {
  applyCreditChargebackDebit,
  applyCreditChargebackRestore,
  applyCreditRefundDebit,
  grantCreditPurchase,
} from "./creditWalletStore";
import type { MolliePayment } from "./mollieClient";
import {
  finishCreditPaymentAdjustment,
  finishCreditPaymentGrant,
  persistCreditPaymentWebhookSnapshot,
  resolveCreditGrantFailure,
  type CreditPaymentAdjustmentEvidence,
  type CreditPaymentGrantEvidence,
  type CreditPaymentPersistenceResult,
} from "./creditPaymentWebhookStore";

export type CreditPaymentWebhookResult =
  "unknown" | "mismatch" | "processed" | "duplicate";

type Dependencies = Readonly<{
  persist: (input: {
    webhookPaymentId: string;
    expectedMode: MollieMode;
    payment: MolliePayment;
  }) => Promise<CreditPaymentPersistenceResult>;
  grant: typeof grantCreditPurchase;
  finish: typeof finishCreditPaymentGrant;
  resolveGrantFailure: typeof resolveCreditGrantFailure;
  refundDebit: typeof applyCreditRefundDebit;
  chargebackDebit: typeof applyCreditChargebackDebit;
  chargebackRestore: typeof applyCreditChargebackRestore;
  finishAdjustment: typeof finishCreditPaymentAdjustment;
}>;

const defaultDependencies: Dependencies = Object.freeze({
  persist: persistCreditPaymentWebhookSnapshot,
  grant: grantCreditPurchase,
  finish: finishCreditPaymentGrant,
  resolveGrantFailure: resolveCreditGrantFailure,
  refundDebit: applyCreditRefundDebit,
  chargebackDebit: applyCreditChargebackDebit,
  chargebackRestore: applyCreditChargebackRestore,
  finishAdjustment: finishCreditPaymentAdjustment,
});

export class CreditPaymentAdjustmentPendingError extends Error {
  constructor() {
    super("Credit payment adjustment is waiting for active credit holds");
    this.name = "CreditPaymentAdjustmentPendingError";
  }
}

/**
 * Applies a provider-fetched credit Payment. Browser redirects never call this
 * function and therefore cannot grant credits.
 */
export async function applyCreditPaymentWebhookSnapshot(
  input: Readonly<{
    webhookPaymentId: string;
    expectedMode: MollieMode;
    payment: MolliePayment;
  }>,
  dependencies: Dependencies = defaultDependencies
): Promise<CreditPaymentWebhookResult> {
  const persisted = await dependencies.persist(input);
  if (persisted.result === "adjustment_pending") {
    return applyCreditPaymentAdjustment(persisted, dependencies);
  }
  if (persisted.result !== "grant_pending") return persisted.result;

  const entryId = createDeterministicCreditGrantEntryId(persisted.grant);
  try {
    const applied = await dependencies.grant({
      workspaceId: persisted.grant.workspaceId,
      mode: persisted.grant.mode,
      channelConnectionId: persisted.grant.channelConnectionId,
      bindingEpoch: persisted.grant.bindingEpoch,
      privacyEpoch: persisted.grant.privacyEpoch,
      userKey: persisted.grant.userKey,
      walletId: persisted.grant.walletId,
      financialSubjectRef: persisted.grant.financialSubjectRef,
      intentId: persisted.grant.intentId,
      providerPaymentId: persisted.grant.providerPaymentId,
      entryId,
      evidenceHash: persisted.grant.evidenceHash,
    });
    await dependencies.finish(persisted.grant);
    // Snapshot deduplication and wallet-effect deduplication are distinct.
    // A replay may be the caller that actually completes a previously pending
    // grant; report that real effect as processed. Only the immutable wallet
    // routine can prove that the grant itself was already applied.
    return applied.result === "already_applied" ? "duplicate" : "processed";
  } catch (error) {
    const resolution = await dependencies.resolveGrantFailure(persisted.grant);
    if (resolution === "already_applied") return "duplicate";
    if (resolution === "contained") return "mismatch";
    throw error;
  }
}

async function applyCreditPaymentAdjustment(
  persisted: Extract<
    CreditPaymentPersistenceResult,
    { result: "adjustment_pending" }
  >,
  dependencies: Dependencies
): Promise<CreditPaymentWebhookResult> {
  const adjustment = persisted.adjustment;
  const entryId =
    adjustment.replayEntryId ??
    createDeterministicCreditAdjustmentEntryId(adjustment);
  const common = {
    workspaceId: adjustment.workspaceId,
    mode: adjustment.mode,
    channelConnectionId: adjustment.channelConnectionId,
    bindingEpoch: adjustment.bindingEpoch,
    privacyEpoch: adjustment.privacyEpoch,
    walletId: adjustment.walletId,
    financialSubjectRef: adjustment.financialSubjectRef,
    rootGrantEntryId: adjustment.rootGrantEntryId,
    entryId,
    evidenceHash: adjustment.evidenceHash,
  };

  if (adjustment.kind === "refund_debit") {
    const outcome = await dependencies.refundDebit(common);
    if (outcome.result === "pending_holds") {
      throw new CreditPaymentAdjustmentPendingError();
    }
    await dependencies.finishAdjustment({
      adjustment,
      entryId,
      outcome: outcome.result,
    });
    if (outcome.result === "manual_review") return "mismatch";
    return persisted.duplicateSnapshot || outcome.result === "already_applied"
      ? "duplicate"
      : "processed";
  }

  const chargebackInput = {
    ...common,
    providerEffectId: adjustment.providerEffectId,
  };
  if (adjustment.kind === "chargeback_debit") {
    const outcome = await dependencies.chargebackDebit(chargebackInput);
    if (outcome.result === "pending_holds") {
      throw new CreditPaymentAdjustmentPendingError();
    }
    await dependencies.finishAdjustment({
      adjustment,
      entryId,
      outcome: outcome.result,
    });
    if (outcome.result === "manual_review") return "mismatch";
    return persisted.duplicateSnapshot || outcome.result === "already_applied"
      ? "duplicate"
      : "processed";
  }

  const outcome = await dependencies.chargebackRestore(chargebackInput);
  await dependencies.finishAdjustment({
    adjustment,
    entryId,
    outcome: outcome.result,
  });
  return outcome.result === "already_applied" || persisted.duplicateSnapshot
    ? "duplicate"
    : "processed";
}

/** Stable UUID derived only from immutable, metadata-only payment evidence. */
export function createDeterministicCreditGrantEntryId(
  input: Pick<
    CreditPaymentGrantEvidence,
    "mode" | "intentId" | "providerPaymentId"
  >
): string {
  const digest = createHash("sha256")
    .update(
      `credit-grant-entry-v1\n${input.mode}\n${input.intentId}\n${input.providerPaymentId}`
    )
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Stable UUID for one exact financial adjustment and provider snapshot. */
export function createDeterministicCreditAdjustmentEntryId(
  input: Pick<
    CreditPaymentAdjustmentEvidence,
    "kind" | "mode" | "rootGrantEntryId" | "evidenceHash"
  > & { readonly providerEffectId?: string }
): string {
  const digest = createHash("sha256")
    .update(
      [
        "credit-adjustment-entry-v1",
        input.mode,
        input.rootGrantEntryId,
        input.kind,
        input.providerEffectId ?? "refund-set",
        input.evidenceHash,
      ].join("\n")
    )
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
