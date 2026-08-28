import { createHash } from "node:crypto";

import type { MollieMode } from "./config";
import { grantCreditPurchase } from "./creditWalletStore";
import type { MolliePayment } from "./mollieClient";
import {
  finishCreditPaymentGrant,
  persistCreditPaymentWebhookSnapshot,
  resolveCreditGrantFailure,
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
}>;

const defaultDependencies: Dependencies = Object.freeze({
  persist: persistCreditPaymentWebhookSnapshot,
  grant: grantCreditPurchase,
  finish: finishCreditPaymentGrant,
  resolveGrantFailure: resolveCreditGrantFailure,
});

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
    return persisted.duplicateSnapshot || applied.result === "already_applied"
      ? "duplicate"
      : "processed";
  } catch (error) {
    const resolution = await dependencies.resolveGrantFailure(persisted.grant);
    if (resolution === "already_applied") return "duplicate";
    if (resolution === "contained") return "mismatch";
    throw error;
  }
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
