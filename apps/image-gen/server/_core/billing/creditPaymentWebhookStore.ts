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

export type CreditPaymentPersistenceResult =
  | Readonly<{ result: "unknown" }>
  | Readonly<{ result: "mismatch" | "processed" | "duplicate" }>
  | Readonly<{
      result: "grant_pending";
      duplicateSnapshot: boolean;
      grant: CreditPaymentGrantEvidence;
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

    if (input.payment.status !== "paid") {
      await applyNonPaidIntentStatus(tx, intent, input.payment.status);
      await finishDelivery(
        tx,
        candidate.workspaceId,
        input.expectedMode,
        input.webhookPaymentId,
        `credit_${input.payment.status}`
      );
      return {
        result: existingDelivery?.processedAt ? "duplicate" : "processed",
      };
    }

    if (hasCreditPaymentFinancialAdjustment(input.payment)) {
      await containCreditPaymentAdjustmentAndReview(
        tx,
        candidate.workspaceId,
        input.expectedMode,
        intent,
        boundary,
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

    const paidAt = resolveRequiredPaidAt(input.payment);
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
    await setDeliveryPendingGrant(
      tx,
      candidate.workspaceId,
      input.expectedMode,
      input.webhookPaymentId,
      observed.snapshotHash
    );
    return {
      result: "grant_pending",
      duplicateSnapshot: Boolean(existingDelivery),
      grant: buildGrantEvidence(
        intent,
        input.webhookPaymentId,
        ledger.observedSnapshotHash,
        observed.snapshotHash
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
    const updated = await tx
      .update(webhookDeliveries)
      .set({ processingResult: "credit_granted", processedAt: new Date() })
      .where(
        and(
          eq(webhookDeliveries.workspaceId, input.workspaceId),
          eq(webhookDeliveries.mode, input.mode),
          eq(webhookDeliveries.mollieResourceId, input.webhookPaymentId),
          isNull(webhookDeliveries.processedAt)
        )
      );
    if (affectedRows(updated) < 1) {
      throw new CreditPaymentWebhookStoreError();
    }
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
  const intents = await database
    .select()
    .from(billingIntents)
    .where(
      and(
        eq(billingIntents.intentId, route.intentId),
        eq(billingIntents.workspaceId, route.workspaceId),
        eq(billingIntents.mode, mode)
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

function hasPersistedCreditPaymentAdjustment(
  existing: Pick<LockedPaymentLedger, "refunds" | "chargebacks">
): boolean {
  return (
    (Array.isArray(existing.refunds) && existing.refunds.length > 0) ||
    (Array.isArray(existing.chargebacks) && existing.chargebacks.length > 0)
  );
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
    "credit_payment_manual_review"
  );
}

async function containCreditPaymentAdjustmentAndReview(
  tx: ImageGenTransaction,
  workspaceId: number,
  mode: MollieMode,
  intent: CreditIntent,
  boundary: LockedCreditBoundary,
  paymentId: string,
  snapshotHash: string,
  detailCode: string
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
  if (wallet.status === "active") {
    const frozen = await tx
      .update(creditWallets)
      .set({ status: "frozen" })
      .where(
        and(
          eq(creditWallets.walletId, wallet.walletId),
          eq(creditWallets.workspaceId, workspaceId),
          eq(creditWallets.mode, mode),
          eq(creditWallets.channelConnectionId, wallet.channelConnectionId),
          eq(creditWallets.bindingEpoch, wallet.bindingEpoch),
          eq(creditWallets.privacyEpoch, wallet.privacyEpoch),
          eq(creditWallets.financialSubjectRef, wallet.financialSubjectRef),
          eq(creditWallets.status, "active")
        )
      );
    if (affectedRows(frozen) !== 1) {
      throw new CreditPaymentWebhookStoreError();
    }
  }
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
  const amountRefunded = payment.amountRefunded;
  const hasRefundedAmount =
    amountRefunded !== undefined &&
    (amountRefunded.currency !== "EUR" ||
      !/^(?:0|[1-9][0-9]*)[.][0-9]{2}$/.test(amountRefunded.value) ||
      amountRefunded.value !== "0.00");
  return (
    (payment._embedded?.refunds?.length ?? 0) > 0 ||
    (payment._embedded?.chargebacks?.length ?? 0) > 0 ||
    hasRefundedAmount
  );
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

function affectedRows(result: unknown): number {
  const metadata: unknown = Array.isArray(result)
    ? (result as unknown[])[0]
    : result;
  return Number(
    (metadata as { affectedRows?: number } | undefined)?.affectedRows ?? 0
  );
}
