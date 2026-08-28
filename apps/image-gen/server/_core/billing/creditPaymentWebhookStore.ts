import { createHash } from "node:crypto";

import { and, eq, isNull, sql } from "drizzle-orm";

import {
  billingExecutionControls,
  billingIntents,
  billingOutbox,
  billingProviderOperations,
  billingSchedulerTenants,
  billingWebhookRoutes,
  channelConnections,
  creditLedger,
  creditWallets,
  messengerPrivacySubjects,
  paymentLedger,
  webhookDeliveries,
} from "../../../drizzle/schema";
import { getDatabaseOrThrow, type ImageGenTransaction } from "../../db";
import type { MollieMode } from "./config";
import {
  PREMIUM_IMAGE_CREDIT_OFFER_ID,
  PREMIUM_IMAGE_CREDIT_OFFER_VERSION,
  getCreditOffer,
} from "./creditCatalog";
import { validateCreditPaymentContract } from "./creditPaymentContract";
import { freezeCreditWalletForReview } from "./creditWalletStore";
import type { MolliePayment } from "./mollieClient";
import { createPaymentSnapshot } from "./paymentSnapshot";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const USER_KEY_PATTERN =
  /^(?:[0-9a-f]{64}|u2[.]k[1-9][0-9]{0,5}[.][0-9a-f]{64})$/;
const PAYMENT_ID_PATTERN = /^tr_[A-Za-z0-9]{1,60}$/;

type CreditIntent = typeof billingIntents.$inferSelect;

type CreditPaymentCandidate = Readonly<{
  workspaceId: number;
  intent: CreditIntent;
}>;

type LockedCreditBoundary = Readonly<{
  control:
    | Readonly<{ commercialEnabled: boolean; authorizationEpoch: number }>
    | undefined;
  connection:
    | Readonly<{ channel: string; status: string; bindingEpoch: number }>
    | undefined;
  privacy: Readonly<{ status: string; privacyEpoch: number }> | undefined;
  wallet:
    | Readonly<{
        walletId: string;
        channelConnectionId: number;
        bindingEpoch: number;
        privacyEpoch: number;
        currentUserKeyHash: string | null;
        financialSubjectRef: string;
        status: string;
      }>
    | undefined;
  intent: CreditIntent | undefined;
  scheduler: Readonly<{ enabled: boolean; executionEpoch: number }> | undefined;
  operation:
    | Readonly<{
        operationId: string;
        operationType: string;
        operationKey: string;
        intentId: string;
        billingProfileVersion: number;
        authorizationEpoch: number;
        state: string;
        requestFingerprint: string;
        idempotencyKeyHash: string;
        credentialGenerationId: string;
        providerResourceId: string | null;
        providerCustomerId: string | null;
      }>
    | undefined;
  route: Readonly<{ workspaceId: number; intentId: string }> | undefined;
}>;

export type CreditPaymentGrantEvidence = Readonly<{
  workspaceId: number;
  mode: MollieMode;
  channelConnectionId: number;
  bindingEpoch: number;
  privacyEpoch: number;
  userKey: string;
  walletId: string;
  financialSubjectRef: string;
  intentId: string;
  authorizationEpoch: number;
  providerPaymentId: string;
  evidenceHash: string;
  webhookPaymentId: string;
  deliverySnapshotHash: string;
}>;

type CreditPaymentAdjustmentEvidenceBase = Readonly<{
  workspaceId: number;
  mode: MollieMode;
  channelConnectionId: number;
  bindingEpoch: number;
  privacyEpoch: number;
  walletId: string;
  financialSubjectRef: string;
  intentId: string;
  authorizationEpoch: number;
  paymentLedgerId: number;
  providerPaymentId: string;
  rootGrantEntryId: string;
  evidenceHash: string;
  replayEntryId?: string;
  webhookPaymentId: string;
  deliverySnapshotHash: string;
}>;

export type CreditPaymentAdjustmentEvidence =
  | (CreditPaymentAdjustmentEvidenceBase &
      Readonly<{
        kind: "refund_debit";
        providerEffectIds: readonly string[];
      }>)
  | (CreditPaymentAdjustmentEvidenceBase &
      Readonly<{
        kind: "chargeback_debit" | "chargeback_restore";
        providerEffectId: string;
      }>);

export type CreditPaymentAdjustmentCompletion = Readonly<{
  adjustment: CreditPaymentAdjustmentEvidence;
  entryId: string;
  outcome:
    "applied" | "already_applied" | "manual_review" | "applied_review_required";
}>;

export type CreditPaymentPersistenceResult =
  | Readonly<{ result: "unknown" }>
  | Readonly<{ result: "mismatch" | "processed" | "duplicate" }>
  | Readonly<{
      result: "grant_pending";
      duplicateSnapshot: boolean;
      grant: CreditPaymentGrantEvidence;
    }>
  | Readonly<{
      result: "adjustment_pending";
      duplicateSnapshot: boolean;
      adjustment: CreditPaymentAdjustmentEvidence;
    }>;

export type CreditGrantFailureResolution =
  "already_applied" | "contained" | "retryable";

export class CreditPaymentWebhookStoreError extends Error {
  constructor(message = "Credit payment webhook persistence is unavailable") {
    super(message);
    this.name = "CreditPaymentWebhookStoreError";
  }
}

export type CreditPaymentGrantCompletionScope = Readonly<{
  workspaceId: number;
  mode: MollieMode;
  intentId: string;
  providerPaymentId: string;
  walletId: string;
  metadataHash: string;
}>;

/**
 * Browser return pages may show `paid` only when both sides of the atomic
 * purchase grant are present. `billing_intents.status = 'paid'` alone is an
 * internal precondition for the stored procedure, not completion evidence.
 */
export async function isCreditPaymentGrantComplete(
  input: CreditPaymentGrantCompletionScope
): Promise<boolean> {
  if (
    !Number.isSafeInteger(input.workspaceId) ||
    input.workspaceId <= 0 ||
    (input.mode !== "test" && input.mode !== "live") ||
    !UUID_PATTERN.test(input.intentId) ||
    !PAYMENT_ID_PATTERN.test(input.providerPaymentId) ||
    !UUID_PATTERN.test(input.walletId) ||
    !SHA256_PATTERN.test(input.metadataHash)
  ) {
    return false;
  }
  const database = await getDatabaseOrThrow();
  const rows = await database
    .select({ entryId: creditLedger.entryId })
    .from(paymentLedger)
    .innerJoin(
      creditLedger,
      and(
        eq(creditLedger.paymentLedgerId, paymentLedger.id),
        eq(creditLedger.workspaceId, paymentLedger.workspaceId),
        eq(creditLedger.mode, paymentLedger.mode),
        eq(creditLedger.providerPaymentId, paymentLedger.molliePaymentId)
      )
    )
    .where(
      and(
        eq(paymentLedger.workspaceId, input.workspaceId),
        eq(paymentLedger.mode, input.mode),
        eq(paymentLedger.molliePaymentId, input.providerPaymentId),
        eq(paymentLedger.status, "paid"),
        eq(paymentLedger.paidEffectApplied, 1),
        eq(paymentLedger.paymentEffectOwnerKind, "credit_grant"),
        eq(paymentLedger.paymentEffectOwnerRef, input.intentId),
        eq(paymentLedger.creditPurpose, "premium_image_credits"),
        eq(paymentLedger.creditIntentId, input.intentId),
        eq(paymentLedger.creditWalletId, input.walletId),
        eq(paymentLedger.creditMetadataHash, input.metadataHash),
        eq(creditLedger.workspaceId, input.workspaceId),
        eq(creditLedger.mode, input.mode),
        eq(creditLedger.walletId, input.walletId),
        eq(creditLedger.sourceIntentId, input.intentId),
        eq(creditLedger.providerPaymentId, input.providerPaymentId),
        eq(creditLedger.grantPaymentId, input.providerPaymentId),
        eq(creditLedger.entryKind, "purchase_grant"),
        eq(creditLedger.offerId, PREMIUM_IMAGE_CREDIT_OFFER_ID),
        eq(creditLedger.paymentAmount, "4.99"),
        eq(creditLedger.currency, "EUR"),
        eq(creditLedger.purchasedCreditCount, 8),
        eq(
          creditLedger.providerDescription,
          "Leaderbot - 8 premium beeldcredits"
        )
      )
    )
    .limit(2);
  return rows.length === 1;
}

/**
 * Persists provider evidence before a credit grant is attempted. The caller
 * must not acknowledge the webhook until a returned `grant_pending` result is
 * granted and finalized.
 */
export async function persistCreditPaymentWebhookSnapshot(input: {
  webhookPaymentId: string;
  expectedMode: MollieMode;
  payment: MolliePayment;
}): Promise<CreditPaymentPersistenceResult> {
  if (
    !PAYMENT_ID_PATTERN.test(input.webhookPaymentId) ||
    (input.expectedMode !== "test" && input.expectedMode !== "live")
  ) {
    return { result: "unknown" };
  }
  const database = await getDatabaseOrThrow();
  const candidate = await readCreditPaymentCandidate(
    database,
    input.expectedMode,
    input.webhookPaymentId
  );
  if (!candidate) return { result: "unknown" };

  const observed = createPaymentSnapshot(input.payment);
  return database.transaction(async tx => {
    const boundary = await lockCreditPaymentBoundary(
      tx,
      candidate,
      input.expectedMode,
      input.webhookPaymentId
    );
    const intent = boundary.intent;
    if (
      !intent ||
      !isExactCreditStructure(intent, candidate.intent) ||
      boundary.route?.workspaceId !== candidate.workspaceId ||
      boundary.route.intentId !== intent.intentId
    ) {
      throw new CreditPaymentWebhookStoreError();
    }

    const offer = getCreditOffer(
      PREMIUM_IMAGE_CREDIT_OFFER_ID,
      PREMIUM_IMAGE_CREDIT_OFFER_VERSION
    );
    if (!offer) throw new CreditPaymentWebhookStoreError();
    const exactContract = validateCreditPaymentContract(
      input.payment,
      {
        intentId: intent.intentId,
        mode: input.expectedMode,
        metadataHash: intent.creditMetadataHash ?? "",
        offer,
      },
      "webhook"
    );
    const occurredAt = resolveCreditPaymentOccurredAt(input.payment);
    const canPersistLedger =
      input.payment.id === input.webhookPaymentId &&
      input.payment.mode === input.expectedMode &&
      occurredAt !== null;

    const existingDelivery = await lockDelivery(
      tx,
      candidate.workspaceId,
      input.expectedMode,
      input.webhookPaymentId,
      observed.snapshotHash
    );
    if (!existingDelivery) {
      await tx.insert(webhookDeliveries).values({
        workspaceId: candidate.workspaceId,
        mode: input.expectedMode,
        mollieResourceId: input.webhookPaymentId,
        snapshotHash: observed.snapshotHash,
        processingResult: "credit_processing",
      });
    }

    let ledger = await lockPaymentLedger(
      tx,
      input.expectedMode,
      input.webhookPaymentId
    );
    if (ledger && ledger.workspaceId !== candidate.workspaceId) {
      await recordMismatch(
        tx,
        candidate.workspaceId,
        input.expectedMode,
        intent,
        input.webhookPaymentId,
        observed.snapshotHash,
        "credit_payment_ledger_scope_conflict"
      );
      return { result: "mismatch" };
    }

    if (canPersistLedger) {
      ledger = await persistPaymentLedger(tx, {
        workspaceId: candidate.workspaceId,
        payment: input.payment,
        observed,
        occurredAt,
        existing: ledger,
      });
    }

    if (!exactContract.exact || occurredAt === null || !ledger) {
      await recordMismatch(
        tx,
        candidate.workspaceId,
        input.expectedMode,
        intent,
        input.webhookPaymentId,
        observed.snapshotHash,
        exactContract.exact
          ? "credit_payment_timestamp_or_ledger_mismatch"
          : `credit_payment_contract_${exactContract.failure}`
      );
      return { result: "mismatch" };
    }

    if (
      ledger.paymentEffectOwnerKind !== null &&
      !(
        ledger.paymentEffectOwnerKind === "credit_grant" &&
        ledger.paymentEffectOwnerRef === intent.intentId
      )
    ) {
      await recordMismatch(
        tx,
        candidate.workspaceId,
        input.expectedMode,
        intent,
        input.webhookPaymentId,
        ledger.observedSnapshotHash,
        "credit_payment_effect_owner_conflict"
      );
      return { result: "mismatch" };
    }

    // `persistPaymentLedger` keeps the newer or financially stronger snapshot
    // when an older provider observation arrives later. In that case this
    // delivery is durable evidence, but it must not drive the intent from the
    // preserved terminal state back to `open` or replace the durable grant
    // evidence with stale input. The recovery case below resumes only the
    // already-persisted pending grant.
    const acceptedSnapshot = shouldApplyPersistedCreditPaymentSnapshot(
      ledger.observedSnapshotHash,
      observed.snapshotHash
    );
    const recoveringPendingGrant =
      !acceptedSnapshot &&
      shouldRecoverPersistedCreditPaymentGrant(ledger, input.payment);
    if (!acceptedSnapshot && !recoveringPendingGrant) {
      await finishDelivery(
        tx,
        candidate.workspaceId,
        input.expectedMode,
        input.webhookPaymentId,
        observed.snapshotHash,
        "credit_snapshot_preserved"
      );
      return {
        result: existingDelivery?.processedAt ? "duplicate" : "processed",
      };
    }
    if (recoveringPendingGrant) {
      // The first paid delivery may have committed its durable ledger and
      // pending-grant row immediately before the process crashed. A later
      // non-adjustment snapshot must resume that original durable grant,
      // while its own delivery remains an acknowledged preserved observation.
      await finishDelivery(
        tx,
        candidate.workspaceId,
        input.expectedMode,
        input.webhookPaymentId,
        observed.snapshotHash,
        "credit_snapshot_preserved"
      );
    }

    if (ledger.status !== "paid") {
      await applyNonPaidIntentStatus(tx, intent, ledger.status);
      await finishDelivery(
        tx,
        candidate.workspaceId,
        input.expectedMode,
        input.webhookPaymentId,
        observed.snapshotHash,
        `credit_${ledger.status}`
      );
      return {
        result: existingDelivery?.processedAt ? "duplicate" : "processed",
      };
    }

    const adjustmentState = classifyCreditPaymentFinancialAdjustmentState(
      input.payment
    );
    if (adjustmentState === "pending") {
      await finishDelivery(
        tx,
        candidate.workspaceId,
        input.expectedMode,
        input.webhookPaymentId,
        observed.snapshotHash,
        "credit_refund_pending"
      );
      return {
        result: existingDelivery?.processedAt ? "duplicate" : "processed",
      };
    }

    if (adjustmentState === "financial" || adjustmentState === "malformed") {
      if (
        ledger.paidEffectApplied === 1 &&
        ledger.paymentEffectOwnerKind === "credit_grant" &&
        ledger.paymentEffectOwnerRef === intent.intentId &&
        ledger.observedSnapshotHash === observed.snapshotHash
      ) {
        const financial = await lockCreditPaymentFinancialEvidence(
          tx,
          intent,
          boundary,
          ledger,
          input.webhookPaymentId
        );
        const decision = financial
          ? classifyCreditPaymentAdjustment({
              refunds: ledger.refunds,
              chargebacks: ledger.chargebacks,
              snapshotHash: ledger.observedSnapshotHash,
              adjustments: financial.adjustments,
            })
          : null;
        if (financial && decision?.actionable) {
          if (existingDelivery?.processedAt) {
            return existingDelivery.processingResult ===
              completedAdjustmentResult(decision.kind)
              ? { result: "duplicate" }
              : { result: "mismatch" };
          }
          await tx
            .update(billingIntents)
            .set({ status: "contained" })
            .where(exactIntentPredicate(intent));
          await setDeliveryPendingAdjustment(
            tx,
            candidate.workspaceId,
            input.expectedMode,
            input.webhookPaymentId,
            observed.snapshotHash
          );
          const adjustment = buildAdjustmentEvidence(
            intent,
            ledger,
            input.webhookPaymentId,
            observed.snapshotHash,
            financial.rootGrantEntryId,
            decision
          );
          await freezeExactAdjustedCreditWallet(
            tx,
            intent,
            boundary,
            ledger,
            input.webhookPaymentId,
            observed.snapshotHash
          );
          await enqueueCreditPaymentAdjustmentRetry(tx, adjustment);
          return {
            result: "adjustment_pending",
            duplicateSnapshot: Boolean(existingDelivery),
            adjustment,
          };
        }
      }
      await containCreditPaymentAdjustmentAndReview(
        tx,
        candidate.workspaceId,
        input.expectedMode,
        intent,
        boundary,
        ledger,
        input.webhookPaymentId,
        observed.snapshotHash,
        "credit_payment_adjustment_requires_review"
      );
      return { result: "mismatch" };
    }

    if (ledger.paidEffectApplied === 1) {
      if (
        ledger.paymentEffectOwnerKind !== "credit_grant" ||
        ledger.paymentEffectOwnerRef !== intent.intentId
      ) {
        await recordMismatch(
          tx,
          candidate.workspaceId,
          input.expectedMode,
          intent,
          input.webhookPaymentId,
          ledger.observedSnapshotHash,
          "credit_payment_effect_owner_conflict"
        );
        return { result: "mismatch" };
      }
      await finishDelivery(
        tx,
        candidate.workspaceId,
        input.expectedMode,
        input.webhookPaymentId,
        observed.snapshotHash,
        "credit_granted"
      );
      return { result: "duplicate" };
    }

    if (!isGrantEligible(boundary, intent, input.webhookPaymentId)) {
      await containPaidIntentAndReview(
        tx,
        candidate.workspaceId,
        input.expectedMode,
        intent,
        input.webhookPaymentId,
        ledger.observedSnapshotHash,
        "credit_payment_ineligible_at_grant"
      );
      return { result: "mismatch" };
    }

    const paidAt = recoveringPendingGrant
      ? ledger.occurredAt
      : resolveRequiredPaidAt(input.payment);
    if (!paidAt) {
      await recordMismatch(
        tx,
        candidate.workspaceId,
        input.expectedMode,
        intent,
        input.webhookPaymentId,
        observed.snapshotHash,
        "credit_payment_missing_paid_timestamp"
      );
      return { result: "mismatch" };
    }
    await tx
      .update(billingIntents)
      .set({ status: "paid", paidAt })
      .where(exactIntentPredicate(intent));
    const grantDeliverySnapshotHash = recoveringPendingGrant
      ? ledger.observedSnapshotHash
      : observed.snapshotHash;
    if (!recoveringPendingGrant) {
      await setDeliveryPendingGrant(
        tx,
        candidate.workspaceId,
        input.expectedMode,
        input.webhookPaymentId,
        grantDeliverySnapshotHash
      );
    }
    return {
      result: "grant_pending",
      duplicateSnapshot: Boolean(existingDelivery) || recoveringPendingGrant,
      grant: buildGrantEvidence(
        intent,
        input.webhookPaymentId,
        ledger.observedSnapshotHash,
        grantDeliverySnapshotHash
      ),
    };
  });
}

export async function finishCreditPaymentGrant(
  input: CreditPaymentGrantEvidence
): Promise<void> {
  assertGrantEvidence(input);
  const database = await getDatabaseOrThrow();
  const candidate = await readCreditPaymentCandidate(
    database,
    input.mode,
    input.providerPaymentId
  );
  if (!candidate || candidate.intent.intentId !== input.intentId) {
    throw new CreditPaymentWebhookStoreError();
  }
  await database.transaction(async tx => {
    const boundary = await lockCreditPaymentBoundary(
      tx,
      candidate,
      input.mode,
      input.providerPaymentId
    );
    if (
      !boundary.intent ||
      !isExactCreditStructure(boundary.intent, candidate.intent) ||
      boundary.route?.workspaceId !== input.workspaceId ||
      boundary.route.intentId !== input.intentId
    ) {
      throw new CreditPaymentWebhookStoreError();
    }
    const delivery = await lockDelivery(
      tx,
      input.workspaceId,
      input.mode,
      input.webhookPaymentId,
      input.deliverySnapshotHash
    );
    const ledger = await lockPaymentLedger(
      tx,
      input.mode,
      input.providerPaymentId
    );
    if (
      !delivery ||
      !ledger ||
      ledger.workspaceId !== input.workspaceId ||
      ledger.status !== "paid" ||
      ledger.paidEffectApplied !== 1 ||
      ledger.paymentEffectOwnerKind !== "credit_grant" ||
      ledger.paymentEffectOwnerRef !== input.intentId
    ) {
      throw new CreditPaymentWebhookStoreError();
    }
    // A concurrent duplicate may observe the already-applied payment effect
    // and complete this exact delivery before the caller that applied the
    // grant reaches its completion transaction. Treat that exact terminal
    // state as an idempotent success so the effect-owning caller can still
    // report the grant it actually applied.
    if (delivery.processedAt !== null) {
      if (delivery.processingResult !== "credit_granted") {
        throw new CreditPaymentWebhookStoreError();
      }
      return;
    }
    const updated = await tx
      .update(webhookDeliveries)
      .set({ processingResult: "credit_granted", processedAt: new Date() })
      .where(
        and(
          eq(webhookDeliveries.workspaceId, input.workspaceId),
          eq(webhookDeliveries.mode, input.mode),
          eq(webhookDeliveries.mollieResourceId, input.webhookPaymentId),
          eq(webhookDeliveries.snapshotHash, input.deliverySnapshotHash),
          isNull(webhookDeliveries.processedAt)
        )
      );
    if (affectedRows(updated) < 1) {
      throw new CreditPaymentWebhookStoreError();
    }
  });
}

/**
 * Acknowledges an adjustment webhook only after the exact wallet routine has
 * durably produced its ledger outcome (or explicitly returned manual review).
 */
export async function finishCreditPaymentAdjustment(
  input: CreditPaymentAdjustmentCompletion
): Promise<void> {
  assertAdjustmentEvidence(input.adjustment);
  if (
    !UUID_PATTERN.test(input.entryId) ||
    (input.adjustment.replayEntryId !== undefined &&
      input.adjustment.replayEntryId !== input.entryId) ||
    (input.adjustment.kind === "chargeback_restore"
      ? input.outcome !== "already_applied" &&
        input.outcome !== "applied_review_required"
      : input.outcome === "applied_review_required")
  ) {
    throw new CreditPaymentWebhookStoreError();
  }
  const database = await getDatabaseOrThrow();
  const candidate = await readCreditPaymentCandidate(
    database,
    input.adjustment.mode,
    input.adjustment.providerPaymentId
  );
  if (
    !candidate ||
    candidate.workspaceId !== input.adjustment.workspaceId ||
    candidate.intent.intentId !== input.adjustment.intentId
  ) {
    throw new CreditPaymentWebhookStoreError();
  }
  await database.transaction(async tx => {
    const boundary = await lockCreditPaymentBoundary(
      tx,
      candidate,
      input.adjustment.mode,
      input.adjustment.providerPaymentId
    );
    const intent = boundary.intent;
    if (
      !intent ||
      !isExactCreditStructure(intent, candidate.intent) ||
      boundary.route?.workspaceId !== input.adjustment.workspaceId ||
      boundary.route.intentId !== input.adjustment.intentId
    ) {
      throw new CreditPaymentWebhookStoreError();
    }
    const delivery = await lockDelivery(
      tx,
      input.adjustment.workspaceId,
      input.adjustment.mode,
      input.adjustment.webhookPaymentId,
      input.adjustment.deliverySnapshotHash
    );
    const ledger = await lockPaymentLedger(
      tx,
      input.adjustment.mode,
      input.adjustment.providerPaymentId
    );
    if (
      !delivery ||
      !ledger ||
      ledger.id !== input.adjustment.paymentLedgerId ||
      ledger.workspaceId !== input.adjustment.workspaceId ||
      ledger.status !== "paid" ||
      ledger.paidEffectApplied !== 1 ||
      ledger.paymentEffectOwnerKind !== "credit_grant" ||
      ledger.paymentEffectOwnerRef !== input.adjustment.intentId ||
      ledger.observedSnapshotHash !== input.adjustment.deliverySnapshotHash ||
      (!input.adjustment.replayEntryId &&
        ledger.observedSnapshotHash !== input.adjustment.evidenceHash)
    ) {
      throw new CreditPaymentWebhookStoreError();
    }
    const financial = await lockCreditPaymentFinancialEvidence(
      tx,
      intent,
      boundary,
      ledger,
      input.adjustment.providerPaymentId
    );
    if (
      !financial ||
      financial.rootGrantEntryId !== input.adjustment.rootGrantEntryId
    ) {
      throw new CreditPaymentWebhookStoreError();
    }

    if (input.outcome !== "manual_review") {
      const replay = classifyCreditPaymentAdjustment({
        refunds: ledger.refunds,
        chargebacks: ledger.chargebacks,
        snapshotHash: ledger.observedSnapshotHash,
        adjustments: financial.adjustments,
      });
      if (
        !replay.actionable ||
        replay.kind !== input.adjustment.kind ||
        replay.replay?.entryId !== input.entryId ||
        replay.replay.evidenceHash !== input.adjustment.evidenceHash ||
        (replay.kind === "refund_debit" &&
          (input.adjustment.kind !== "refund_debit" ||
            !sameProviderEffectIds(
              replay.providerEffectIds,
              input.adjustment.providerEffectIds
            ))) ||
        (replay.kind !== "refund_debit" &&
          (input.adjustment.kind === "refund_debit" ||
            replay.providerEffectId !== input.adjustment.providerEffectId))
      ) {
        throw new CreditPaymentWebhookStoreError();
      }
    }

    await tx
      .update(billingIntents)
      .set({ status: "contained" })
      .where(exactIntentPredicate(intent));
    const reviewRequired =
      input.outcome === "manual_review" ||
      input.adjustment.kind === "chargeback_restore";
    if (reviewRequired) {
      await enqueueManualReview(
        tx,
        input.adjustment.workspaceId,
        input.adjustment.mode,
        input.adjustment.intentId,
        input.adjustment.providerPaymentId,
        input.adjustment.evidenceHash,
        input.outcome === "manual_review"
          ? "credit_adjustment_routine_manual_review"
          : "credit_chargeback_restored_requires_review"
      );
    }
    await finishDelivery(
      tx,
      input.adjustment.workspaceId,
      input.adjustment.mode,
      input.adjustment.webhookPaymentId,
      input.adjustment.deliverySnapshotHash,
      input.outcome === "manual_review"
        ? "credit_payment_manual_review"
        : completedAdjustmentResult(input.adjustment.kind)
    );
  });
}

/**
 * Distinguishes a transient grant failure from a policy/privacy race. A stale
 * user boundary is contained and reviewed; an otherwise valid boundary keeps
 * the webhook retryable.
 */
export async function resolveCreditGrantFailure(
  input: CreditPaymentGrantEvidence
): Promise<CreditGrantFailureResolution> {
  assertGrantEvidence(input);
  const database = await getDatabaseOrThrow();
  const candidate = await readCreditPaymentCandidate(
    database,
    input.mode,
    input.providerPaymentId
  );
  if (!candidate || candidate.intent.intentId !== input.intentId) {
    return "retryable";
  }
  return database.transaction(async tx => {
    const boundary = await lockCreditPaymentBoundary(
      tx,
      candidate,
      input.mode,
      input.providerPaymentId
    );
    const intent = boundary.intent;
    const delivery = await lockDelivery(
      tx,
      input.workspaceId,
      input.mode,
      input.webhookPaymentId,
      input.deliverySnapshotHash
    );
    const ledger = await lockPaymentLedger(
      tx,
      input.mode,
      input.providerPaymentId
    );
    if (
      delivery &&
      ledger?.workspaceId === input.workspaceId &&
      ledger.paidEffectApplied === 1 &&
      ledger.paymentEffectOwnerKind === "credit_grant" &&
      ledger.paymentEffectOwnerRef === input.intentId
    ) {
      await finishDelivery(
        tx,
        input.workspaceId,
        input.mode,
        input.webhookPaymentId,
        input.deliverySnapshotHash,
        "credit_granted"
      );
      return "already_applied";
    }
    if (
      delivery &&
      intent &&
      ledger?.workspaceId === input.workspaceId &&
      ledger.status === "paid" &&
      ledger.paidEffectApplied === 0 &&
      isGrantEligible(boundary, intent, input.providerPaymentId)
    ) {
      return "retryable";
    }
    if (delivery && intent && ledger?.workspaceId === input.workspaceId) {
      await containPaidIntentAndReview(
        tx,
        input.workspaceId,
        input.mode,
        intent,
        input.providerPaymentId,
        input.deliverySnapshotHash,
        "credit_grant_boundary_changed"
      );
      return "contained";
    }
    return "retryable";
  });
}

async function readCreditPaymentCandidate(
  database: Awaited<ReturnType<typeof getDatabaseOrThrow>>,
  mode: MollieMode,
  paymentId: string
): Promise<CreditPaymentCandidate | null> {
  const routes = await database
    .select({
      workspaceId: billingWebhookRoutes.workspaceId,
      intentId: billingWebhookRoutes.intentId,
    })
    .from(billingWebhookRoutes)
    .where(
      and(
        eq(billingWebhookRoutes.mode, mode),
        eq(billingWebhookRoutes.molliePaymentId, paymentId)
      )
    )
    .limit(2);
  const route = routes.length === 1 ? routes[0] : undefined;
  if (!route) return null;
  // Keep this first read compatible with the deployed 0016 bridge. Legacy
  // billing intents do not have the credit columns added by 0017, and must
  // fall through to the existing payment handler without selecting them.
  const intentKinds = await database
    .select({
      intentId: billingIntents.intentId,
      workspaceId: billingIntents.workspaceId,
      mode: billingIntents.mode,
      kind: billingIntents.kind,
    })
    .from(billingIntents)
    .where(
      and(
        eq(billingIntents.intentId, route.intentId),
        eq(billingIntents.workspaceId, route.workspaceId),
        eq(billingIntents.mode, mode)
      )
    )
    .limit(2);
  if (intentKinds.length !== 1 || intentKinds[0]?.kind !== "credit_purchase") {
    return null;
  }
  const intents = await database
    .select()
    .from(billingIntents)
    .where(
      and(
        eq(billingIntents.intentId, route.intentId),
        eq(billingIntents.workspaceId, route.workspaceId),
        eq(billingIntents.mode, mode),
        eq(billingIntents.kind, "credit_purchase")
      )
    )
    .limit(2);
  if (intents.length !== 1) return null;
  return { workspaceId: route.workspaceId, intent: intents[0] };
}

async function lockCreditPaymentBoundary(
  tx: ImageGenTransaction,
  candidate: CreditPaymentCandidate,
  mode: MollieMode,
  paymentId: string
): Promise<LockedCreditBoundary> {
  const pre = candidate.intent;
  const controls = await tx
    .select({
      commercialEnabled: billingExecutionControls.commercialEnabled,
      authorizationEpoch: billingExecutionControls.authorizationEpoch,
    })
    .from(billingExecutionControls)
    .where(
      and(
        eq(billingExecutionControls.workspaceId, candidate.workspaceId),
        eq(billingExecutionControls.mode, mode)
      )
    )
    .limit(1)
    .for("update");
  const connections =
    typeof pre.messengerChannelConnectionId === "number"
      ? await tx
          .select({
            channel: channelConnections.channel,
            status: channelConnections.status,
            bindingEpoch: channelConnections.bindingEpoch,
          })
          .from(channelConnections)
          .where(
            and(
              eq(channelConnections.workspaceId, candidate.workspaceId),
              eq(channelConnections.id, pre.messengerChannelConnectionId)
            )
          )
          .limit(1)
          .for("update")
      : [];
  const privacy =
    typeof pre.messengerChannelConnectionId === "number" &&
    typeof pre.messengerSenderUserKey === "string"
      ? await tx
          .select({
            status: messengerPrivacySubjects.status,
            privacyEpoch: messengerPrivacySubjects.privacyEpoch,
          })
          .from(messengerPrivacySubjects)
          .where(
            and(
              eq(messengerPrivacySubjects.workspaceId, candidate.workspaceId),
              eq(
                messengerPrivacySubjects.channelConnectionId,
                pre.messengerChannelConnectionId
              ),
              eq(messengerPrivacySubjects.userKey, pre.messengerSenderUserKey)
            )
          )
          .limit(1)
          .for("update")
      : [];
  const wallets =
    typeof pre.creditWalletId === "string"
      ? await tx
          .select({
            walletId: creditWallets.walletId,
            channelConnectionId: creditWallets.channelConnectionId,
            bindingEpoch: creditWallets.bindingEpoch,
            privacyEpoch: creditWallets.privacyEpoch,
            currentUserKeyHash: creditWallets.currentUserKeyHash,
            financialSubjectRef: creditWallets.financialSubjectRef,
            status: creditWallets.status,
          })
          .from(creditWallets)
          .where(
            and(
              eq(creditWallets.walletId, pre.creditWalletId),
              eq(creditWallets.workspaceId, candidate.workspaceId),
              eq(creditWallets.mode, mode)
            )
          )
          .limit(1)
          .for("update")
      : [];
  const intents = await tx
    .select()
    .from(billingIntents)
    .where(
      and(
        eq(billingIntents.intentId, pre.intentId),
        eq(billingIntents.workspaceId, candidate.workspaceId),
        eq(billingIntents.mode, mode)
      )
    )
    .limit(1)
    .for("update");
  const schedulers = await tx
    .select({
      enabled: billingSchedulerTenants.enabled,
      executionEpoch: billingSchedulerTenants.executionEpoch,
    })
    .from(billingSchedulerTenants)
    .where(
      and(
        eq(billingSchedulerTenants.workspaceId, candidate.workspaceId),
        eq(billingSchedulerTenants.mode, mode),
        eq(billingSchedulerTenants.kind, "outbox")
      )
    )
    .limit(1)
    .for("update");
  const operations = await tx
    .select({
      operationId: billingProviderOperations.operationId,
      operationType: billingProviderOperations.operationType,
      operationKey: billingProviderOperations.operationKey,
      intentId: billingProviderOperations.intentId,
      billingProfileVersion: billingProviderOperations.billingProfileVersion,
      authorizationEpoch: billingProviderOperations.authorizationEpoch,
      state: billingProviderOperations.state,
      requestFingerprint: billingProviderOperations.requestFingerprint,
      idempotencyKeyHash: billingProviderOperations.idempotencyKeyHash,
      credentialGenerationId: billingProviderOperations.credentialGenerationId,
      providerResourceId: billingProviderOperations.providerResourceId,
      providerCustomerId: billingProviderOperations.providerCustomerId,
    })
    .from(billingProviderOperations)
    .where(
      and(
        eq(billingProviderOperations.workspaceId, candidate.workspaceId),
        eq(billingProviderOperations.mode, mode),
        eq(billingProviderOperations.operationType, "create_payment"),
        eq(billingProviderOperations.operationKey, pre.intentId),
        eq(billingProviderOperations.intentId, pre.intentId)
      )
    )
    .limit(2)
    .for("update");
  const routes = await tx
    .select({
      workspaceId: billingWebhookRoutes.workspaceId,
      intentId: billingWebhookRoutes.intentId,
    })
    .from(billingWebhookRoutes)
    .where(
      and(
        eq(billingWebhookRoutes.mode, mode),
        eq(billingWebhookRoutes.molliePaymentId, paymentId)
      )
    )
    .limit(1)
    .for("update");
  return {
    control: controls[0],
    connection: connections[0],
    privacy: privacy[0],
    wallet: wallets[0],
    intent: intents[0],
    scheduler: schedulers[0],
    operation: operations.length === 1 ? operations[0] : undefined,
    route: routes[0],
  };
}

function isExactCreditStructure(
  locked: CreditIntent,
  pre: CreditIntent
): boolean {
  return (
    locked.intentId === pre.intentId &&
    locked.workspaceId === pre.workspaceId &&
    locked.mode === pre.mode &&
    locked.kind === "credit_purchase" &&
    locked.planCode === PREMIUM_IMAGE_CREDIT_OFFER_ID &&
    locked.expectedAmount === "4.99" &&
    locked.currency === "EUR" &&
    locked.interval === "oneoff" &&
    isEmptyRecord(locked.entitlements) &&
    locked.mollieDescription === "Leaderbot - 8 premium beeldcredits" &&
    locked.creditCount === 8 &&
    locked.billingProfileVersion === 0 &&
    Number.isSafeInteger(locked.authorizationEpoch) &&
    locked.authorizationEpoch > 0 &&
    locked.molliePaymentId === pre.molliePaymentId &&
    locked.molliePaymentId !== null &&
    UUID_PATTERN.test(locked.creditWalletId ?? "") &&
    SHA256_PATTERN.test(locked.creditFinancialSubjectRef ?? "") &&
    SHA256_PATTERN.test(locked.creditMetadataHash ?? "")
  );
}

function isGrantEligible(
  boundary: LockedCreditBoundary,
  intent: CreditIntent,
  paymentId: string
): boolean {
  const operation = boundary.operation;
  const userKey = intent.messengerSenderUserKey;
  const idempotencyHash = sha256Hex(intent.idempotencyKey);
  return Boolean(
    boundary.control?.commercialEnabled &&
    boundary.control.authorizationEpoch === intent.authorizationEpoch &&
    boundary.connection?.channel === "facebook_messenger" &&
    boundary.connection.status === "connected" &&
    boundary.connection.bindingEpoch === intent.messengerBindingEpoch &&
    boundary.privacy?.status === "active" &&
    boundary.privacy.privacyEpoch === intent.messengerPrivacyEpoch &&
    boundary.wallet?.status === "active" &&
    boundary.wallet.walletId === intent.creditWalletId &&
    boundary.wallet.channelConnectionId ===
      intent.messengerChannelConnectionId &&
    boundary.wallet.bindingEpoch === intent.messengerBindingEpoch &&
    boundary.wallet.privacyEpoch === intent.messengerPrivacyEpoch &&
    boundary.wallet.currentUserKeyHash === userKey &&
    boundary.wallet.financialSubjectRef === intent.creditFinancialSubjectRef &&
    boundary.scheduler?.enabled &&
    boundary.scheduler.executionEpoch === intent.authorizationEpoch &&
    intent.molliePaymentId === paymentId &&
    typeof userKey === "string" &&
    USER_KEY_PATTERN.test(userKey) &&
    intent.creditIdentityErasedAt === null &&
    intent.checkoutCapabilityConsumedAt !== null &&
    intent.checkoutCapabilitySessionNonceHash !== null &&
    intent.urlExposedAt !== null &&
    (intent.status === "open" || intent.status === "paid") &&
    operation?.operationType === "create_payment" &&
    operation.operationKey === intent.intentId &&
    operation.intentId === intent.intentId &&
    operation.billingProfileVersion === 0 &&
    operation.authorizationEpoch === intent.authorizationEpoch &&
    operation.state === "succeeded" &&
    operation.requestFingerprint === intent.creditMetadataHash &&
    operation.idempotencyKeyHash === idempotencyHash &&
    operation.credentialGenerationId.length > 0 &&
    operation.providerResourceId === paymentId &&
    operation.providerCustomerId === null
  );
}

async function lockDelivery(
  tx: ImageGenTransaction,
  workspaceId: number,
  mode: MollieMode,
  paymentId: string,
  snapshotHash: string
) {
  const rows = await tx
    .select({
      processedAt: webhookDeliveries.processedAt,
      processingResult: webhookDeliveries.processingResult,
    })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.workspaceId, workspaceId),
        eq(webhookDeliveries.mode, mode),
        eq(webhookDeliveries.mollieResourceId, paymentId),
        eq(webhookDeliveries.snapshotHash, snapshotHash)
      )
    )
    .limit(1)
    .for("update");
  return rows[0];
}

type LockedPaymentLedger = Readonly<{
  id: number;
  workspaceId: number;
  status: string;
  occurredAt: Date;
  observedSnapshotHash: string;
  paidEffectApplied: number;
  paymentEffectOwnerKind: string | null;
  paymentEffectOwnerRef: string | null;
  refunds: unknown;
  chargebacks: unknown;
}>;

type LockedCreditAdjustment = Readonly<{
  entryId: string;
  entryKind: string;
  providerEffectId: string | null;
  providerEffectType: string | null;
  providerEffectStatus: string | null;
  providerEffectAmount: string | null;
  providerEffectCurrency: string | null;
  providerEffectEvidence: unknown;
  rootAdjustmentSlot: number | null;
  evidenceHash: string;
}>;

type LockedCreditPaymentFinancialEvidence = Readonly<{
  rootGrantEntryId: string;
  adjustments: readonly LockedCreditAdjustment[];
}>;

export type CreditPaymentAdjustmentDecision =
  | Readonly<{ actionable: false; reason: string }>
  | Readonly<{
      actionable: true;
      kind: "refund_debit";
      providerEffectIds: readonly string[];
      replay?: Readonly<{ entryId: string; evidenceHash: string }>;
    }>
  | Readonly<{
      actionable: true;
      kind: "chargeback_debit" | "chargeback_restore";
      providerEffectId: string;
      replay?: Readonly<{ entryId: string; evidenceHash: string }>;
    }>;

async function lockPaymentLedger(
  tx: ImageGenTransaction,
  mode: MollieMode,
  paymentId: string
): Promise<LockedPaymentLedger | undefined> {
  const rows = await tx
    .select({
      id: paymentLedger.id,
      workspaceId: paymentLedger.workspaceId,
      status: paymentLedger.status,
      occurredAt: paymentLedger.occurredAt,
      observedSnapshotHash: paymentLedger.observedSnapshotHash,
      paidEffectApplied: paymentLedger.paidEffectApplied,
      paymentEffectOwnerKind: paymentLedger.paymentEffectOwnerKind,
      paymentEffectOwnerRef: paymentLedger.paymentEffectOwnerRef,
      refunds: paymentLedger.refunds,
      chargebacks: paymentLedger.chargebacks,
    })
    .from(paymentLedger)
    .where(
      and(
        eq(paymentLedger.mode, mode),
        eq(paymentLedger.molliePaymentId, paymentId)
      )
    )
    .limit(2)
    .for("update");
  return rows.length === 1 ? rows[0] : undefined;
}

async function lockCreditPaymentFinancialEvidence(
  tx: ImageGenTransaction,
  intent: CreditIntent,
  boundary: LockedCreditBoundary,
  ledger: LockedPaymentLedger,
  paymentId: string
): Promise<LockedCreditPaymentFinancialEvidence | null> {
  const wallet = boundary.wallet;
  if (
    !wallet ||
    wallet.walletId !== intent.creditWalletId ||
    wallet.channelConnectionId !== intent.messengerChannelConnectionId ||
    wallet.bindingEpoch !== intent.messengerBindingEpoch ||
    wallet.privacyEpoch !== intent.messengerPrivacyEpoch ||
    wallet.financialSubjectRef !== intent.creditFinancialSubjectRef ||
    !["active", "frozen", "erased"].includes(wallet.status)
  ) {
    return null;
  }
  const grants = await tx
    .select({ entryId: creditLedger.entryId })
    .from(creditLedger)
    .where(
      and(
        eq(creditLedger.workspaceId, intent.workspaceId),
        eq(creditLedger.mode, intent.mode),
        eq(creditLedger.walletId, wallet.walletId),
        eq(creditLedger.channelConnectionId, wallet.channelConnectionId),
        eq(creditLedger.bindingEpoch, wallet.bindingEpoch),
        eq(creditLedger.privacyEpoch, wallet.privacyEpoch),
        eq(creditLedger.financialSubjectRef, wallet.financialSubjectRef),
        eq(creditLedger.sourceIntentId, intent.intentId),
        eq(creditLedger.paymentLedgerId, ledger.id),
        eq(creditLedger.providerPaymentId, paymentId),
        eq(creditLedger.grantPaymentId, paymentId),
        eq(creditLedger.entryKind, "purchase_grant"),
        eq(creditLedger.offerId, PREMIUM_IMAGE_CREDIT_OFFER_ID),
        eq(creditLedger.paymentAmount, "4.99"),
        eq(creditLedger.currency, "EUR"),
        eq(creditLedger.purchasedCreditCount, 8),
        eq(
          creditLedger.providerDescription,
          "Leaderbot - 8 premium beeldcredits"
        )
      )
    )
    .limit(2)
    .for("update");
  const rootGrantEntryId = grants.length === 1 ? grants[0]?.entryId : undefined;
  if (!rootGrantEntryId || !UUID_PATTERN.test(rootGrantEntryId)) return null;
  const adjustments = await tx
    .select({
      entryId: creditLedger.entryId,
      entryKind: creditLedger.entryKind,
      providerEffectId: creditLedger.providerEffectId,
      providerEffectType: creditLedger.providerEffectType,
      providerEffectStatus: creditLedger.providerEffectStatus,
      providerEffectAmount: creditLedger.providerEffectAmount,
      providerEffectCurrency: creditLedger.providerEffectCurrency,
      providerEffectEvidence: creditLedger.providerEffectEvidence,
      rootAdjustmentSlot: creditLedger.rootAdjustmentSlot,
      evidenceHash: creditLedger.evidenceHash,
    })
    .from(creditLedger)
    .where(
      and(
        eq(creditLedger.workspaceId, intent.workspaceId),
        eq(creditLedger.mode, intent.mode),
        eq(creditLedger.walletId, wallet.walletId),
        eq(creditLedger.rootGrantEntryId, rootGrantEntryId)
      )
    )
    .limit(3)
    .for("update");
  return { rootGrantEntryId, adjustments };
}

/**
 * Reduces one persisted provider snapshot to the only automatically actionable
 * full-payment adjustments. Anything mixed, partial, malformed, or conflicting
 * remains a manual-review decision.
 */
export function classifyCreditPaymentAdjustment(
  input: Readonly<{
    refunds: unknown;
    chargebacks: unknown;
    snapshotHash: string;
    adjustments?: readonly LockedCreditAdjustment[];
  }>
): CreditPaymentAdjustmentDecision {
  if (!SHA256_PATTERN.test(input.snapshotHash)) {
    return { actionable: false, reason: "snapshot_hash" };
  }
  const adjustments = input.adjustments ?? [];
  if (adjustments.length > 2) {
    return { actionable: false, reason: "adjustment_count" };
  }
  const slotOne = adjustments.filter(row => row.rootAdjustmentSlot === 1);
  const slotTwo = adjustments.filter(row => row.rootAdjustmentSlot === 2);
  if (
    slotOne.length > 1 ||
    slotTwo.length > 1 ||
    adjustments.some(
      row => row.rootAdjustmentSlot !== 1 && row.rootAdjustmentSlot !== 2
    )
  ) {
    return { actionable: false, reason: "adjustment_slots" };
  }

  const refunds = readCompletedRefundSet(input.refunds);
  const chargebacks = readExactChargebackSet(input.chargebacks);
  if (!refunds.valid || !chargebacks.valid) {
    return { actionable: false, reason: "provider_shape" };
  }
  if (refunds.entries.length > 0 && chargebacks.entries.length > 0) {
    return { actionable: false, reason: "mixed_effects" };
  }

  if (refunds.entries.length > 0) {
    if (refunds.totalMinor !== 499 || slotTwo.length > 0) {
      return { actionable: false, reason: "refund_not_full" };
    }
    const existing = slotOne[0];
    if (existing && !isExactRefundReplay(existing, refunds)) {
      return { actionable: false, reason: "refund_slot_conflict" };
    }
    return {
      actionable: true,
      kind: "refund_debit",
      providerEffectIds: refunds.entries.map(entry => entry.id),
      ...(existing
        ? {
            replay: {
              entryId: existing.entryId,
              evidenceHash: existing.evidenceHash,
            },
          }
        : {}),
    };
  }

  if (chargebacks.entries.length !== 1) {
    return { actionable: false, reason: "chargeback_count" };
  }
  const effect = chargebacks.entries[0];
  if (effect.amountMinor !== 499) {
    return { actionable: false, reason: "chargeback_not_full" };
  }
  const debit = slotOne[0];
  const restore = slotTwo[0];
  if (effect.reversed) {
    if (!debit || !isExactChargebackReplay(debit, "chargeback_debit", effect)) {
      return { actionable: false, reason: "restore_without_debit" };
    }
    if (
      restore &&
      !isExactChargebackReplay(restore, "chargeback_restore", effect)
    ) {
      return { actionable: false, reason: "restore_slot_conflict" };
    }
    return {
      actionable: true,
      kind: "chargeback_restore",
      providerEffectId: effect.id,
      ...(restore
        ? {
            replay: {
              entryId: restore.entryId,
              evidenceHash: restore.evidenceHash,
            },
          }
        : {}),
    };
  }
  if (restore) {
    return { actionable: false, reason: "active_after_restore" };
  }
  if (debit && !isExactChargebackReplay(debit, "chargeback_debit", effect)) {
    return { actionable: false, reason: "chargeback_slot_conflict" };
  }
  return {
    actionable: true,
    kind: "chargeback_debit",
    providerEffectId: effect.id,
    ...(debit
      ? {
          replay: {
            entryId: debit.entryId,
            evidenceHash: debit.evidenceHash,
          },
        }
      : {}),
  };
}

function isExactRefundReplay(
  adjustment: LockedCreditAdjustment,
  current: ReturnType<typeof readCompletedRefundSet>
): boolean {
  if (
    adjustment.entryKind !== "refund_debit" ||
    !UUID_PATTERN.test(adjustment.entryId) ||
    !SHA256_PATTERN.test(adjustment.evidenceHash) ||
    !adjustment.providerEffectId ||
    !SHA256_PATTERN.test(adjustment.providerEffectId) ||
    adjustment.providerEffectType !== "refund" ||
    adjustment.providerEffectStatus !== "refunded" ||
    adjustment.providerEffectAmount !== "4.99" ||
    adjustment.providerEffectCurrency !== "EUR"
  ) {
    return false;
  }
  const recorded = readCompletedRefundSet(adjustment.providerEffectEvidence);
  return (
    recorded.valid &&
    recorded.totalMinor === 499 &&
    sameProviderEffects(recorded.entries, current.entries)
  );
}

function isExactChargebackReplay(
  adjustment: LockedCreditAdjustment,
  kind: "chargeback_debit" | "chargeback_restore",
  effect: Readonly<{ id: string; amountMinor: number; reversed: boolean }>
): boolean {
  return (
    adjustment.entryKind === kind &&
    UUID_PATTERN.test(adjustment.entryId) &&
    SHA256_PATTERN.test(adjustment.evidenceHash) &&
    adjustment.providerEffectId === effect.id &&
    adjustment.providerEffectType === "chargeback" &&
    adjustment.providerEffectStatus ===
      (kind === "chargeback_debit" ? "active" : "reversed") &&
    adjustment.providerEffectAmount === "4.99" &&
    adjustment.providerEffectCurrency === "EUR" &&
    adjustment.providerEffectEvidence === null &&
    effect.amountMinor === 499
  );
}

function sameProviderEffects(
  left: readonly Readonly<{ id: string; amountMinor: number }>[],
  right: readonly Readonly<{ id: string; amountMinor: number }>[]
): boolean {
  if (left.length !== right.length) return false;
  const canonical = (
    entries: readonly Readonly<{ id: string; amountMinor: number }>[]
  ) =>
    entries
      .map(entry => `${entry.id}\u0000${entry.amountMinor}`)
      .sort()
      .join("\u0001");
  return canonical(left) === canonical(right);
}

function sameProviderEffectIds(
  left: readonly string[],
  right: readonly string[]
): boolean {
  const sortedRight = [...right].sort();
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === sortedRight[index])
  );
}

function readCompletedRefundSet(value: unknown): Readonly<{
  valid: boolean;
  totalMinor: number;
  entries: readonly Readonly<{ id: string; amountMinor: number }>[];
}> {
  if (!Array.isArray(value)) {
    return { valid: false, totalMinor: 0, entries: [] };
  }
  const entries: Array<Readonly<{ id: string; amountMinor: number }>> = [];
  const ids = new Set<string>();
  let totalMinor = 0;
  for (const item of value) {
    if (!isPlainRecord(item) || !isPlainRecord(item.amount)) {
      return { valid: false, totalMinor: 0, entries: [] };
    }
    const id = item.id;
    const status = item.status;
    const currency = item.amount.currency;
    const amountMinor = readPositiveEuroMinor(item.amount.value);
    if (
      typeof id !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(id) ||
      ids.has(id) ||
      typeof status !== "string" ||
      !/^[a-z][a-z_]{0,23}$/.test(status) ||
      currency !== "EUR" ||
      amountMinor === null
    ) {
      return { valid: false, totalMinor: 0, entries: [] };
    }
    ids.add(id);
    if (status === "refunded") {
      totalMinor += amountMinor;
      if (!Number.isSafeInteger(totalMinor)) {
        return { valid: false, totalMinor: 0, entries: [] };
      }
      entries.push({ id, amountMinor });
    }
  }
  return { valid: true, totalMinor, entries };
}

function readExactChargebackSet(value: unknown): Readonly<{
  valid: boolean;
  entries: readonly Readonly<{
    id: string;
    amountMinor: number;
    reversed: boolean;
  }>[];
}> {
  if (!Array.isArray(value)) return { valid: false, entries: [] };
  const entries: Array<
    Readonly<{ id: string; amountMinor: number; reversed: boolean }>
  > = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (!isPlainRecord(item) || !isPlainRecord(item.amount)) {
      return { valid: false, entries: [] };
    }
    const id = item.id;
    const currency = item.amount.currency;
    const amountMinor = readPositiveEuroMinor(item.amount.value);
    const reversedAt = item.reversedAt;
    const reversed = reversedAt !== null;
    if (
      typeof id !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(id) ||
      ids.has(id) ||
      currency !== "EUR" ||
      amountMinor === null ||
      (reversed &&
        (typeof reversedAt !== "string" ||
          !isExactProviderTimestamp(reversedAt)))
    ) {
      return { valid: false, entries: [] };
    }
    ids.add(id);
    entries.push({ id, amountMinor, reversed });
  }
  return { valid: true, entries };
}

function isExactProviderTimestamp(value: string): boolean {
  if (value.length < 20 || value.length > 40) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().length > 0;
}

function readPositiveEuroMinor(value: unknown): number | null {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]{0,7})[.][0-9]{2}$/.test(value)
  ) {
    return null;
  }
  const [major, minor] = value.split(".");
  const amount = Number(major) * 100 + Number(minor);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

async function persistPaymentLedger(
  tx: ImageGenTransaction,
  input: Readonly<{
    workspaceId: number;
    payment: MolliePayment;
    observed: ReturnType<typeof createPaymentSnapshot>;
    occurredAt: Date;
    existing: LockedPaymentLedger | undefined;
  }>
): Promise<LockedPaymentLedger | undefined> {
  // Freeze the first paid evidence until its grant owns the payment effect,
  // except when the newer snapshot proves a financial adjustment. Adjustment
  // evidence must replace the pending grant snapshot so the same transaction
  // can freeze the wallet and contain the intent before a grant can proceed.
  if (shouldPreservePendingCreditGrantSnapshot(input.existing, input.payment)) {
    return input.existing;
  }
  // Once an adjustment has been observed for an applied grant, a later stale
  // provider snapshot may not erase that evidence. The wallet remains frozen
  // until the exact adjustment is reconciled or an operator resolves it.
  if (
    input.existing?.paidEffectApplied === 1 &&
    hasPersistedCreditPaymentAdjustment(input.existing) &&
    !hasCreditPaymentFinancialAdjustment(input.payment)
  ) {
    return input.existing;
  }
  const settlementAmount = input.payment.settlementAmount?.value ?? null;
  if (input.existing) {
    const preservePaid =
      input.existing.status === "paid" && input.payment.status !== "paid";
    if (
      preservePaid ||
      input.occurredAt.getTime() < input.existing.occurredAt.getTime()
    ) {
      return input.existing;
    }
    await tx
      .update(paymentLedger)
      .set({
        grossAmount: input.payment.amount.value,
        currency: input.payment.amount.currency,
        status: input.payment.status,
        paymentMethod: input.payment.method ?? null,
        refunds: input.observed.refunds,
        chargebacks: input.observed.chargebacks,
        observedSnapshotHash: input.observed.snapshotHash,
        settlementAmount,
        occurredAt: input.occurredAt,
      })
      .where(
        and(
          eq(paymentLedger.id, input.existing.id),
          eq(paymentLedger.workspaceId, input.workspaceId),
          eq(paymentLedger.mode, input.payment.mode),
          eq(paymentLedger.molliePaymentId, input.payment.id)
        )
      );
  } else {
    await tx.insert(paymentLedger).values({
      molliePaymentId: input.payment.id,
      workspaceId: input.workspaceId,
      mode: input.payment.mode,
      grossAmount: input.payment.amount.value,
      currency: input.payment.amount.currency,
      status: input.payment.status,
      paymentMethod: input.payment.method ?? null,
      refunds: input.observed.refunds,
      chargebacks: input.observed.chargebacks,
      observedSnapshotHash: input.observed.snapshotHash,
      settlementId: null,
      settlementAmount,
      mollieFees: null,
      invoiceNumber: null,
      occurredAt: input.occurredAt,
    });
  }
  return lockPaymentLedger(tx, input.payment.mode, input.payment.id);
}

export function shouldPreservePendingCreditGrantSnapshot(
  existing: Readonly<{ status: string; paidEffectApplied: number }> | undefined,
  payment: MolliePayment
): boolean {
  return Boolean(
    existing?.status === "paid" &&
    existing.paidEffectApplied === 0 &&
    !hasCreditPaymentFinancialAdjustment(payment)
  );
}

export function shouldApplyPersistedCreditPaymentSnapshot(
  persistedSnapshotHash: string,
  incomingSnapshotHash: string
): boolean {
  return persistedSnapshotHash === incomingSnapshotHash;
}

export function shouldRecoverPersistedCreditPaymentGrant(
  existing: Readonly<{ status: string; paidEffectApplied: number }>,
  payment: MolliePayment
): boolean {
  return shouldPreservePendingCreditGrantSnapshot(existing, payment);
}

function hasPersistedCreditPaymentAdjustment(
  existing: Pick<LockedPaymentLedger, "refunds" | "chargebacks">
): boolean {
  if (Array.isArray(existing.chargebacks) && existing.chargebacks.length > 0) {
    return true;
  }
  if (!Array.isArray(existing.refunds)) return false;
  return existing.refunds.some(refund => {
    if (!isPlainRecord(refund) || typeof refund.status !== "string") {
      return true;
    }
    return !["queued", "pending", "processing", "failed", "canceled"].includes(
      refund.status
    );
  });
}

async function applyNonPaidIntentStatus(
  tx: ImageGenTransaction,
  intent: CreditIntent,
  providerStatus: string
): Promise<void> {
  if (intent.status === "paid" || intent.status === "contained") return;
  const next =
    providerStatus === "failed" ||
    providerStatus === "canceled" ||
    providerStatus === "expired"
      ? providerStatus
      : "open";
  await tx
    .update(billingIntents)
    .set({ status: next })
    .where(exactIntentPredicate(intent));
}

async function recordMismatch(
  tx: ImageGenTransaction,
  workspaceId: number,
  mode: MollieMode,
  intent: CreditIntent,
  paymentId: string,
  snapshotHash: string,
  detailCode: string
): Promise<void> {
  if (intent.status !== "paid" && intent.status !== "contained") {
    await tx
      .update(billingIntents)
      .set({ status: "mismatch" })
      .where(exactIntentPredicate(intent));
  }
  await enqueueManualReview(
    tx,
    workspaceId,
    mode,
    intent.intentId,
    paymentId,
    snapshotHash,
    detailCode
  );
  await finishDelivery(
    tx,
    workspaceId,
    mode,
    paymentId,
    snapshotHash,
    "credit_payment_mismatch"
  );
}

async function containPaidIntentAndReview(
  tx: ImageGenTransaction,
  workspaceId: number,
  mode: MollieMode,
  intent: CreditIntent,
  paymentId: string,
  snapshotHash: string,
  detailCode: string
): Promise<void> {
  await tx
    .update(billingIntents)
    .set({ status: "contained" })
    .where(exactIntentPredicate(intent));
  await enqueueManualReview(
    tx,
    workspaceId,
    mode,
    intent.intentId,
    paymentId,
    snapshotHash,
    detailCode
  );
  await finishDelivery(
    tx,
    workspaceId,
    mode,
    paymentId,
    snapshotHash,
    "credit_payment_manual_review"
  );
}

async function containCreditPaymentAdjustmentAndReview(
  tx: ImageGenTransaction,
  workspaceId: number,
  mode: MollieMode,
  intent: CreditIntent,
  boundary: LockedCreditBoundary,
  ledger: LockedPaymentLedger,
  paymentId: string,
  snapshotHash: string,
  detailCode: string
): Promise<void> {
  await freezeExactAdjustedCreditWallet(
    tx,
    intent,
    boundary,
    ledger,
    paymentId,
    snapshotHash
  );
  await containPaidIntentAndReview(
    tx,
    workspaceId,
    mode,
    intent,
    paymentId,
    snapshotHash,
    detailCode
  );
}

async function freezeExactAdjustedCreditWallet(
  tx: ImageGenTransaction,
  intent: CreditIntent,
  boundary: LockedCreditBoundary,
  ledger: LockedPaymentLedger,
  paymentId: string,
  snapshotHash: string
): Promise<void> {
  const wallet = boundary.wallet;
  if (
    !wallet ||
    wallet.walletId !== intent.creditWalletId ||
    wallet.channelConnectionId !== intent.messengerChannelConnectionId ||
    wallet.bindingEpoch !== intent.messengerBindingEpoch ||
    wallet.privacyEpoch !== intent.messengerPrivacyEpoch ||
    wallet.financialSubjectRef !== intent.creditFinancialSubjectRef ||
    !["active", "frozen", "erased"].includes(wallet.status)
  ) {
    throw new CreditPaymentWebhookStoreError();
  }
  if (wallet.status === "active" && ledger.paidEffectApplied === 1) {
    await freezeCreditWalletForReview(tx, {
      workspaceId: intent.workspaceId,
      mode: intent.mode,
      walletId: wallet.walletId,
      channelConnectionId: wallet.channelConnectionId,
      bindingEpoch: wallet.bindingEpoch,
      privacyEpoch: wallet.privacyEpoch,
      financialSubjectRef: wallet.financialSubjectRef,
      intentId: intent.intentId,
      paymentLedgerId: ledger.id,
      providerPaymentId: paymentId,
      snapshotHash,
    });
  }
}

async function enqueueManualReview(
  tx: ImageGenTransaction,
  workspaceId: number,
  mode: MollieMode,
  intentId: string,
  paymentId: string,
  snapshotHash: string,
  detailCode: string
): Promise<void> {
  const reviewKey = sha256Hex(
    `credit-payment-review-v1\n${mode}\n${intentId}\n${paymentId}\n${snapshotHash}`
  );
  await tx
    .insert(billingOutbox)
    .values({
      workspaceId,
      mode,
      eventType: "manual_review",
      deduplicationKey: `credit_payment_review:${reviewKey}`,
      payload: {
        reason: "payment_mismatch",
        intentId,
        paymentId,
        detailCode,
        creditPurpose: "premium_image_credits",
      },
      status: "pending",
    })
    .onDuplicateKeyUpdate({
      set: { deduplicationKey: sql`deduplication_key` },
    });
}

async function finishDelivery(
  tx: ImageGenTransaction,
  workspaceId: number,
  mode: MollieMode,
  paymentId: string,
  snapshotHash: string,
  result: string
): Promise<void> {
  await tx
    .update(webhookDeliveries)
    .set({ processingResult: result, processedAt: new Date() })
    .where(
      and(
        eq(webhookDeliveries.workspaceId, workspaceId),
        eq(webhookDeliveries.mode, mode),
        eq(webhookDeliveries.mollieResourceId, paymentId),
        eq(webhookDeliveries.snapshotHash, snapshotHash),
        isNull(webhookDeliveries.processedAt)
      )
    );
}

async function setDeliveryPendingGrant(
  tx: ImageGenTransaction,
  workspaceId: number,
  mode: MollieMode,
  paymentId: string,
  snapshotHash: string
): Promise<void> {
  await tx
    .update(webhookDeliveries)
    .set({ processingResult: "credit_grant_pending", processedAt: null })
    .where(
      and(
        eq(webhookDeliveries.workspaceId, workspaceId),
        eq(webhookDeliveries.mode, mode),
        eq(webhookDeliveries.mollieResourceId, paymentId),
        eq(webhookDeliveries.snapshotHash, snapshotHash)
      )
    );
}

async function setDeliveryPendingAdjustment(
  tx: ImageGenTransaction,
  workspaceId: number,
  mode: MollieMode,
  paymentId: string,
  snapshotHash: string
): Promise<void> {
  await tx
    .update(webhookDeliveries)
    .set({ processingResult: "credit_adjustment_pending", processedAt: null })
    .where(
      and(
        eq(webhookDeliveries.workspaceId, workspaceId),
        eq(webhookDeliveries.mode, mode),
        eq(webhookDeliveries.mollieResourceId, paymentId),
        eq(webhookDeliveries.snapshotHash, snapshotHash)
      )
    );
}

async function enqueueCreditPaymentAdjustmentRetry(
  tx: ImageGenTransaction,
  adjustment: CreditPaymentAdjustmentEvidence
): Promise<void> {
  const retryKey = sha256Hex(
    [
      "credit-adjustment-retry-v1",
      adjustment.mode,
      adjustment.webhookPaymentId,
      adjustment.deliverySnapshotHash,
    ].join("\n")
  );
  await tx
    .insert(billingOutbox)
    .values({
      workspaceId: adjustment.workspaceId,
      mode: adjustment.mode,
      eventType: "credit_adjustment_retry",
      deduplicationKey: `credit_adjustment_retry:${retryKey}`,
      payload: {
        reason: "credit_adjustment_pending",
        adjustment,
      },
      status: "pending",
    })
    .onDuplicateKeyUpdate({
      set: { deduplicationKey: sql`deduplication_key` },
    });
}

function completedAdjustmentResult(
  kind: CreditPaymentAdjustmentEvidence["kind"]
): string {
  return kind === "refund_debit"
    ? "credit_refund_debited"
    : kind === "chargeback_debit"
      ? "credit_chargeback_debited"
      : "credit_chargeback_restored_review";
}

function exactIntentPredicate(intent: CreditIntent) {
  return and(
    eq(billingIntents.intentId, intent.intentId),
    eq(billingIntents.workspaceId, intent.workspaceId),
    eq(billingIntents.mode, intent.mode),
    eq(billingIntents.kind, "credit_purchase"),
    eq(billingIntents.authorizationEpoch, intent.authorizationEpoch),
    eq(billingIntents.creditMetadataHash, intent.creditMetadataHash ?? "")
  );
}

function buildGrantEvidence(
  intent: CreditIntent,
  paymentId: string,
  evidenceHash: string,
  deliverySnapshotHash: string
): CreditPaymentGrantEvidence {
  const userKey = intent.messengerSenderUserKey;
  const channelConnectionId = intent.messengerChannelConnectionId;
  const bindingEpoch = intent.messengerBindingEpoch;
  const privacyEpoch = intent.messengerPrivacyEpoch;
  const walletId = intent.creditWalletId;
  const financialSubjectRef = intent.creditFinancialSubjectRef;
  if (
    !userKey ||
    !USER_KEY_PATTERN.test(userKey) ||
    typeof channelConnectionId !== "number" ||
    typeof bindingEpoch !== "number" ||
    typeof privacyEpoch !== "number" ||
    !walletId ||
    !UUID_PATTERN.test(walletId) ||
    !financialSubjectRef ||
    !SHA256_PATTERN.test(financialSubjectRef)
  ) {
    throw new CreditPaymentWebhookStoreError();
  }
  return {
    workspaceId: intent.workspaceId,
    mode: intent.mode,
    channelConnectionId,
    bindingEpoch,
    privacyEpoch,
    userKey,
    walletId,
    financialSubjectRef,
    intentId: intent.intentId,
    authorizationEpoch: intent.authorizationEpoch,
    providerPaymentId: paymentId,
    evidenceHash,
    webhookPaymentId: paymentId,
    deliverySnapshotHash,
  };
}

function buildAdjustmentEvidence(
  intent: CreditIntent,
  ledger: LockedPaymentLedger,
  paymentId: string,
  deliverySnapshotHash: string,
  rootGrantEntryId: string,
  decision: Extract<CreditPaymentAdjustmentDecision, { actionable: true }>
): CreditPaymentAdjustmentEvidence {
  const channelConnectionId = intent.messengerChannelConnectionId;
  const bindingEpoch = intent.messengerBindingEpoch;
  const privacyEpoch = intent.messengerPrivacyEpoch;
  const walletId = intent.creditWalletId;
  const financialSubjectRef = intent.creditFinancialSubjectRef;
  if (
    typeof channelConnectionId !== "number" ||
    typeof bindingEpoch !== "number" ||
    typeof privacyEpoch !== "number" ||
    !walletId ||
    !UUID_PATTERN.test(walletId) ||
    !financialSubjectRef ||
    !SHA256_PATTERN.test(financialSubjectRef) ||
    !UUID_PATTERN.test(rootGrantEntryId) ||
    !SHA256_PATTERN.test(ledger.observedSnapshotHash)
  ) {
    throw new CreditPaymentWebhookStoreError();
  }
  const common = {
    workspaceId: intent.workspaceId,
    mode: intent.mode,
    channelConnectionId,
    bindingEpoch,
    privacyEpoch,
    walletId,
    financialSubjectRef,
    intentId: intent.intentId,
    authorizationEpoch: intent.authorizationEpoch,
    paymentLedgerId: ledger.id,
    providerPaymentId: paymentId,
    rootGrantEntryId,
    evidenceHash: decision.replay?.evidenceHash ?? ledger.observedSnapshotHash,
    ...(decision.replay ? { replayEntryId: decision.replay.entryId } : {}),
    webhookPaymentId: paymentId,
    deliverySnapshotHash,
  } as const;
  return decision.kind === "refund_debit"
    ? {
        ...common,
        kind: "refund_debit",
        providerEffectIds: decision.providerEffectIds,
      }
    : {
        ...common,
        kind: decision.kind,
        providerEffectId: decision.providerEffectId,
      };
}

export function resolveCreditPaymentOccurredAt(
  payment: Pick<
    MolliePayment,
    "status" | "createdAt" | "paidAt" | "failedAt" | "canceledAt" | "expiredAt"
  >
): Date | null {
  const required =
    payment.status === "paid"
      ? payment.paidAt
      : payment.status === "failed"
        ? (payment.failedAt ?? payment.createdAt)
        : payment.status === "canceled"
          ? (payment.canceledAt ?? payment.createdAt)
          : payment.status === "expired"
            ? (payment.expiredAt ?? payment.createdAt)
            : payment.createdAt;
  if (typeof required !== "string") return null;
  const all = [
    payment.createdAt,
    payment.paidAt,
    payment.failedAt,
    payment.canceledAt,
    payment.expiredAt,
  ].filter((value): value is string => value !== undefined);
  const parsed = all.map(value => new Date(value));
  if (parsed.some(value => Number.isNaN(value.getTime()))) return null;
  const occurredAt = new Date(required);
  return Number.isNaN(occurredAt.getTime()) ? null : occurredAt;
}

function resolveRequiredPaidAt(payment: MolliePayment): Date | null {
  if (payment.status !== "paid" || !payment.paidAt) return null;
  const paidAt = new Date(payment.paidAt);
  return Number.isNaN(paidAt.getTime()) ? null : paidAt;
}

export function hasCreditPaymentFinancialAdjustment(
  payment: MolliePayment
): boolean {
  return classifyCreditPaymentFinancialAdjustmentState(payment) !== "none";
}

export type CreditPaymentFinancialAdjustmentState =
  "none" | "pending" | "financial" | "malformed";

/**
 * Separates provider-side refund work from an actual financial effect. Failed
 * or canceled attempts do not freeze an already-granted wallet; queued work
 * blocks a new grant until Mollie sends a terminal snapshot.
 */
export function classifyCreditPaymentFinancialAdjustmentState(
  payment: MolliePayment
): CreditPaymentFinancialAdjustmentState {
  const amountRefunded = payment.amountRefunded;
  let hasRefundedAmount = false;
  if (amountRefunded !== undefined) {
    if (
      amountRefunded.currency !== "EUR" ||
      !/^(?:0|[1-9][0-9]*)[.][0-9]{2}$/.test(amountRefunded.value)
    ) {
      return "malformed";
    }
    hasRefundedAmount = amountRefunded.value !== "0.00";
  }

  let hasCompletedRefund = false;
  let hasPendingRefund = false;
  for (const refund of payment._embedded?.refunds ?? []) {
    if (refund.status === "refunded") {
      hasCompletedRefund = true;
    } else if (
      refund.status === "queued" ||
      refund.status === "pending" ||
      refund.status === "processing"
    ) {
      hasPendingRefund = true;
    } else if (refund.status !== "failed" && refund.status !== "canceled") {
      return "malformed";
    }
  }

  if (
    (payment._embedded?.chargebacks?.length ?? 0) > 0 ||
    hasCompletedRefund ||
    hasRefundedAmount
  ) {
    return "financial";
  }
  return hasPendingRefund ? "pending" : "none";
}

function isEmptyRecord(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertGrantEvidence(input: CreditPaymentGrantEvidence): void {
  if (
    !Number.isSafeInteger(input.workspaceId) ||
    input.workspaceId <= 0 ||
    (input.mode !== "test" && input.mode !== "live") ||
    !Number.isSafeInteger(input.channelConnectionId) ||
    input.channelConnectionId <= 0 ||
    !Number.isSafeInteger(input.bindingEpoch) ||
    input.bindingEpoch <= 0 ||
    !Number.isSafeInteger(input.privacyEpoch) ||
    input.privacyEpoch <= 0 ||
    !USER_KEY_PATTERN.test(input.userKey) ||
    !UUID_PATTERN.test(input.walletId) ||
    !SHA256_PATTERN.test(input.financialSubjectRef) ||
    !UUID_PATTERN.test(input.intentId) ||
    !Number.isSafeInteger(input.authorizationEpoch) ||
    input.authorizationEpoch <= 0 ||
    !PAYMENT_ID_PATTERN.test(input.providerPaymentId) ||
    !PAYMENT_ID_PATTERN.test(input.webhookPaymentId) ||
    !SHA256_PATTERN.test(input.evidenceHash) ||
    !SHA256_PATTERN.test(input.deliverySnapshotHash)
  ) {
    throw new CreditPaymentWebhookStoreError();
  }
}

function assertAdjustmentEvidence(
  input: CreditPaymentAdjustmentEvidence
): void {
  if (
    !Number.isSafeInteger(input.workspaceId) ||
    input.workspaceId <= 0 ||
    (input.mode !== "test" && input.mode !== "live") ||
    !Number.isSafeInteger(input.channelConnectionId) ||
    input.channelConnectionId <= 0 ||
    !Number.isSafeInteger(input.bindingEpoch) ||
    input.bindingEpoch <= 0 ||
    !Number.isSafeInteger(input.privacyEpoch) ||
    input.privacyEpoch <= 0 ||
    !UUID_PATTERN.test(input.walletId) ||
    !SHA256_PATTERN.test(input.financialSubjectRef) ||
    !UUID_PATTERN.test(input.intentId) ||
    !Number.isSafeInteger(input.authorizationEpoch) ||
    input.authorizationEpoch <= 0 ||
    !Number.isSafeInteger(input.paymentLedgerId) ||
    input.paymentLedgerId <= 0 ||
    !PAYMENT_ID_PATTERN.test(input.providerPaymentId) ||
    !UUID_PATTERN.test(input.rootGrantEntryId) ||
    !SHA256_PATTERN.test(input.evidenceHash) ||
    (input.replayEntryId !== undefined &&
      !UUID_PATTERN.test(input.replayEntryId)) ||
    !PAYMENT_ID_PATTERN.test(input.webhookPaymentId) ||
    !SHA256_PATTERN.test(input.deliverySnapshotHash) ||
    (input.kind === "refund_debit"
      ? input.providerEffectIds.length < 1 ||
        new Set(input.providerEffectIds).size !==
          input.providerEffectIds.length ||
        input.providerEffectIds.some(
          value => !/^[A-Za-z0-9_-]{1,64}$/.test(value)
        )
      : !/^[A-Za-z0-9_-]{1,64}$/.test(input.providerEffectId))
  ) {
    throw new CreditPaymentWebhookStoreError();
  }
}

function affectedRows(result: unknown): number {
  const metadata: unknown = Array.isArray(result)
    ? (result as unknown[])[0]
    : result;
  return Number(
    (metadata as { affectedRows?: number } | undefined)?.affectedRows ?? 0
  );
}
