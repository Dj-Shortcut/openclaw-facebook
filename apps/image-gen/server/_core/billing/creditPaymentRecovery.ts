import { createHash } from "node:crypto";

import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";

import {
  billingExecutionControls,
  billingIntents,
  billingOutbox,
  billingProviderOperations,
  billingWebhookRoutes,
  creditWallets,
  type BillingOutboxItem,
} from "../../../drizzle/schema";
import { getDatabaseOrThrow, type ImageGenTransaction } from "../../db";
import type { MollieMode } from "./config";
import { getMollieConfig } from "./config";
import {
  type CreditOffer,
  getCreditOfferForStoredSnapshot,
  listCreditOffers,
} from "./creditCatalog";
import { validateCreditPaymentContract } from "./creditPaymentContract";
import { hashCanonicalSnapshot } from "./ids";
import {
  MollieApiError,
  MollieClient,
  type MolliePayment,
} from "./mollieClient";
import {
  assertBillingTenantLeaseOwnedInTransaction,
  type BillingTenantLease,
} from "./billingSchedulerStore";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PAYMENT_ID_PATTERN = /^tr_[A-Za-z0-9]{1,60}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PROVIDER_CLOCK_SKEW_MS = 5 * 60_000;
const PROVIDER_CREATION_WINDOW_MS = 15 * 60_000;
const RECOVERY_BATCH_LIMIT = 50;

type CreditPaymentRecoveryReason =
  | "billing_execution_disabled"
  | "checkout_provider_response_mismatch"
  | "credit_payment_provider_ambiguous";

type CreditPaymentRecoveryPayload = Readonly<{
  reason: CreditPaymentRecoveryReason;
  intentId: string;
  targetCustomerId: null;
  targetPaymentId: string | null;
  providerOperationId: string;
  sourceProviderOperationId: string | null;
  authorizationEpoch: number;
  creditPurpose: "premium_image_credits";
  creditWalletId: string;
  creditMetadataHash: string;
  channelConnectionId: number;
  bindingEpoch: number;
  privacyEpoch: number;
}>;

export class CreditPaymentRecoveryError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean
  ) {
    super(code);
    this.name = "CreditPaymentRecoveryError";
  }
}

type RecoveryBinding = Readonly<{
  control: Readonly<{
    commercialEnabled: boolean;
    authorizationEpoch: number;
  }>;
  intent: typeof billingIntents.$inferSelect;
  wallet: Pick<
    typeof creditWallets.$inferSelect,
    | "walletId"
    | "workspaceId"
    | "mode"
    | "channelConnectionId"
    | "bindingEpoch"
    | "privacyEpoch"
    | "financialSubjectRef"
  >;
  operation: Pick<
    typeof billingProviderOperations.$inferSelect,
    | "operationId"
    | "workspaceId"
    | "mode"
    | "operationType"
    | "operationKey"
    | "intentId"
    | "billingProfileVersion"
    | "authorizationEpoch"
    | "state"
    | "requestFingerprint"
    | "providerResourceId"
    | "providerCustomerId"
    | "credentialGenerationId"
    | "firstStartedAt"
  >;
  offer: CreditOffer;
}>;

type ClaimedOutboxJob = BillingOutboxItem & { leaseToken: string };

export function isCustomerlessCreditPaymentPayload(payload: unknown): boolean {
  return Boolean(
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    (payload as Record<string, unknown>).creditPurpose ===
      "premium_image_credits"
  );
}

/**
 * Cancels only an exact, locally-bound customerless premium-credit Payment.
 * The database locks remain held across the provider read/delete so a local
 * scope transition cannot turn a verified target into a blind DELETE.
 */
export async function cancelCustomerlessCreditPayment(
  job: ClaimedOutboxJob,
  clientOverride?: MollieClient
): Promise<void> {
  const payload = readCreditPaymentRecoveryPayload(job.payload, "known");
  const paymentId = payload.targetPaymentId;
  if (!paymentId) {
    throw permanent("invalid_credit_payment_cancellation_target");
  }
  const config = getMollieConfig();
  if (config.mode !== job.mode) {
    throw permanent("billing_mode_mismatch");
  }
  const database = await getDatabaseOrThrow();
  const client = clientOverride ?? new MollieClient(config);
  await database.transaction(async tx => {
    const binding = await lockExactRecoveryBinding(
      tx,
      job,
      payload,
      paymentId,
      ["contained"]
    );
    if (
      !binding ||
      !(await hasExactWebhookRoute(tx, job, payload, paymentId))
    ) {
      throw permanent("credit_payment_cancellation_local_scope_mismatch");
    }

    let payment: MolliePayment;
    try {
      payment = await client.getPayment(paymentId);
    } catch (error) {
      // A 404 is idempotent only after the complete local target binding was
      // locked above. A corrupt payload can therefore never turn 404 into a
      // false successful cancellation.
      if (error instanceof MollieApiError && error.status === 404) return;
      throw error;
    }
    const contract = validateCreditPaymentContract(
      payment,
      {
        intentId: payload.intentId,
        mode: job.mode,
        metadataHash: payload.creditMetadataHash,
        offer: binding.offer,
      },
      "creation"
    );
    if (!contract.exact || contract.paymentId !== paymentId) {
      throw permanent("credit_payment_cancellation_provider_scope_mismatch");
    }
    if (["canceled", "expired", "failed"].includes(payment.status)) return;
    if (payment.status !== "open") {
      throw permanent("credit_payment_cancellation_requires_manual_review");
    }
    try {
      await client.cancelPayment(paymentId);
    } catch (error) {
      if (!(error instanceof MollieApiError) || error.status !== 404) {
        throw error;
      }
    }
  });
}

/**
 * Resolves an ambiguous customerless create-payment operation through the
 * bounded account Payment listing. Every match must satisfy the complete
 * one-off credit contract and a tight provider-creation window.
 */
export async function reconcileCustomerlessCreditPayment(
  job: ClaimedOutboxJob,
  clientOverride?: MollieClient,
  now = new Date()
): Promise<void> {
  const payload = readCreditPaymentRecoveryPayload(job.payload, "unknown");
  const config = getMollieConfig();
  if (config.mode !== job.mode) {
    throw permanent("billing_mode_mismatch");
  }
  const database = await getDatabaseOrThrow();
  const snapshot = await readCreditReconciliationSnapshot(
    database,
    job,
    payload
  );

  // A known finalizer or an earlier reconciliation always persists its exact
  // cancel job in the same transaction that contains this operation. A stale
  // null-target job therefore has nothing left to discover or enqueue.
  if (snapshot.alreadyResolved) return;

  const client = clientOverride ?? new MollieClient(config);
  const matches = findExactCreditPayments(
    await client.listPayments(),
    job,
    payload,
    snapshot
  );
  if (matches.length === 0) {
    throw retryable("credit_payment_reconciliation_not_visible");
  }
  if (
    matches.some(payment => ["pending", "authorized"].includes(payment.status))
  ) {
    throw retryable("credit_payment_reconciliation_not_terminal");
  }

  await applyCreditPaymentReconciliation(database, job, payload, matches, now);
}

type CreditReconciliationSnapshot = Readonly<{
  alreadyResolved: boolean;
  firstStartedAt: Date;
  offer: CreditOffer;
}>;

async function readCreditReconciliationSnapshot(
  database: Awaited<ReturnType<typeof getDatabaseOrThrow>>,
  job: ClaimedOutboxJob,
  payload: CreditPaymentRecoveryPayload
): Promise<CreditReconciliationSnapshot> {
  return database.transaction(async tx => {
    const binding = await lockExactRecoveryBinding(tx, job, payload, null, [
      "succeeded",
      "transport_started",
      "ambiguous",
      "reconciliation_only",
      "contained",
    ]);
    if (!binding || !binding.operation.firstStartedAt) {
      throw permanent("credit_payment_reconciliation_scope_mismatch");
    }
    if (!matchesRecoveryAuthorization(binding, payload)) {
      throw permanent("credit_payment_reconciliation_authorization_mismatch");
    }
    return {
      alreadyResolved:
        binding.operation.state === "contained" &&
        binding.operation.providerResourceId !== null,
      firstStartedAt: binding.operation.firstStartedAt,
      offer: binding.offer,
    };
  });
}

function findExactCreditPayments(
  payments: readonly MolliePayment[],
  job: Pick<BillingOutboxItem, "mode">,
  payload: CreditPaymentRecoveryPayload,
  snapshot: CreditReconciliationSnapshot
): MolliePayment[] {
  const earliest = snapshot.firstStartedAt.getTime() - PROVIDER_CLOCK_SKEW_MS;
  const latest =
    snapshot.firstStartedAt.getTime() + PROVIDER_CREATION_WINDOW_MS;
  return payments.filter(payment => {
    const createdAt = Date.parse(payment.createdAt);
    const contract = validateCreditPaymentContract(
      payment,
      {
        intentId: payload.intentId,
        mode: job.mode,
        metadataHash: payload.creditMetadataHash,
        offer: snapshot.offer,
      },
      "creation"
    );
    return (
      contract.exact &&
      Number.isFinite(createdAt) &&
      createdAt >= earliest &&
      createdAt <= latest
    );
  });
}

async function applyCreditPaymentReconciliation(
  database: Awaited<ReturnType<typeof getDatabaseOrThrow>>,
  job: ClaimedOutboxJob,
  payload: CreditPaymentRecoveryPayload,
  matches: readonly MolliePayment[],
  now: Date
): Promise<void> {
  await database.transaction(tx =>
    applyCreditPaymentReconciliationInTransaction(
      tx,
      job,
      payload,
      matches,
      now
    )
  );
}

async function applyCreditPaymentReconciliationInTransaction(
  tx: ImageGenTransaction,
  job: ClaimedOutboxJob,
  payload: CreditPaymentRecoveryPayload,
  matches: readonly MolliePayment[],
  now: Date
): Promise<void> {
  const binding = await lockExactRecoveryBinding(tx, job, payload, null, [
    "succeeded",
    "transport_started",
    "ambiguous",
    "reconciliation_only",
    "contained",
  ]);
  if (!binding || !matchesRecoveryAuthorization(binding, payload)) {
    throw permanent("credit_payment_reconciliation_scope_mismatch");
  }
  const actionable = matches.filter(payment => payment.status === "open");
  const routeConflict = await enqueueExactCreditPaymentCancellations(
    tx,
    job,
    payload,
    binding,
    actionable,
    now
  );
  const providerResourceId = matches.length === 1 ? matches[0].id : null;
  await containReconciledCreditOperation(
    tx,
    job,
    payload,
    binding,
    providerResourceId,
    now
  );
  if (providerResourceId && actionable.length === 1 && !routeConflict) {
    await bindReconciledCreditIntent(tx, job, payload, providerResourceId);
  }
  if (requiresCreditReconciliationReview(matches, routeConflict)) {
    await enqueueCreditReconciliationReview(tx, job, payload);
  }
}

async function enqueueExactCreditPaymentCancellations(
  tx: ImageGenTransaction,
  job: ClaimedOutboxJob,
  payload: CreditPaymentRecoveryPayload,
  binding: RecoveryBinding,
  payments: readonly MolliePayment[],
  now: Date
): Promise<boolean> {
  let routeConflict = false;
  for (const payment of payments) {
    if (!(await bindExactWebhookRoute(tx, job, payload, payment.id))) {
      routeConflict = true;
      continue;
    }
    await enqueueExactCreditPaymentCancellation(
      tx,
      job,
      payload,
      binding,
      payment.id,
      now
    );
  }
  return routeConflict;
}

async function enqueueExactCreditPaymentCancellation(
  tx: ImageGenTransaction,
  job: ClaimedOutboxJob,
  payload: CreditPaymentRecoveryPayload,
  binding: RecoveryBinding,
  paymentId: string,
  now: Date
): Promise<void> {
  const operationId = deterministicUuid([
    "credit-payment-containment-v1",
    payload.providerOperationId,
    paymentId,
  ]);
  const fingerprint = hashCanonicalSnapshot({
    purpose: "premium_image_credits",
    workspaceId: job.workspaceId,
    mode: job.mode,
    intentId: payload.intentId,
    walletId: payload.creditWalletId,
    metadataHash: payload.creditMetadataHash,
    sourceProviderOperationId: payload.providerOperationId,
    paymentId,
    authorizationEpoch: payload.authorizationEpoch,
  });
  await tx
    .insert(billingProviderOperations)
    .values({
      operationId,
      workspaceId: job.workspaceId,
      mode: job.mode,
      operationType: "cancel_payment",
      operationKey: `credit-containment:${payload.providerOperationId}:${paymentId}`,
      intentId: payload.intentId,
      billingProfileVersion: 0,
      authorizationEpoch: payload.authorizationEpoch,
      state: "contained",
      requestFingerprint: payload.creditMetadataHash,
      idempotencyKeyHash: fingerprint,
      credentialGenerationId: binding.operation.credentialGenerationId,
      providerResourceId: paymentId,
      providerCustomerId: null,
      leaseToken: operationId,
      leaseUntil: now,
      resolutionDueAt: now,
      completedAt: now,
    })
    .onDuplicateKeyUpdate({ set: { operationKey: sql`operation_key` } });
  await insertOutbox(tx, {
    workspaceId: job.workspaceId,
    mode: job.mode,
    eventType: "cancel_payment",
    deduplicationKey: `credit_payment_containment:${operationId}`,
    payload: exactCreditCancellationPayload(payload, operationId, paymentId),
  });
}

function exactCreditCancellationPayload(
  payload: CreditPaymentRecoveryPayload,
  operationId: string,
  paymentId: string
): Record<string, unknown> {
  const epoch =
    payload.reason === "credit_payment_provider_ambiguous"
      ? { authorizationEpoch: payload.authorizationEpoch }
      : { revokedAuthorizationEpoch: payload.authorizationEpoch };
  return {
    reason: payload.reason,
    intentId: payload.intentId,
    targetCustomerId: null,
    targetPaymentId: paymentId,
    providerOperationId: operationId,
    sourceProviderOperationId: payload.providerOperationId,
    ...epoch,
    creditPurpose: "premium_image_credits",
    creditWalletId: payload.creditWalletId,
    creditMetadataHash: payload.creditMetadataHash,
    channelConnectionId: payload.channelConnectionId,
    bindingEpoch: payload.bindingEpoch,
    privacyEpoch: payload.privacyEpoch,
  };
}

async function containReconciledCreditOperation(
  tx: ImageGenTransaction,
  job: ClaimedOutboxJob,
  payload: CreditPaymentRecoveryPayload,
  binding: RecoveryBinding,
  providerResourceId: string | null,
  now: Date
): Promise<void> {
  if (binding.operation.state === "contained") return;
  const result = await tx
    .update(billingProviderOperations)
    .set({
      state: "contained",
      providerResourceId,
      completedAt: now,
      resolutionDueAt: now,
    })
    .where(
      and(
        eq(billingProviderOperations.operationId, payload.providerOperationId),
        eq(billingProviderOperations.workspaceId, job.workspaceId),
        eq(billingProviderOperations.mode, job.mode),
        eq(billingProviderOperations.operationType, "create_payment"),
        eq(billingProviderOperations.intentId, payload.intentId),
        eq(
          billingProviderOperations.authorizationEpoch,
          payload.authorizationEpoch
        ),
        eq(
          billingProviderOperations.requestFingerprint,
          payload.creditMetadataHash
        ),
        isNull(billingProviderOperations.providerCustomerId),
        inArray(billingProviderOperations.state, [
          "succeeded",
          "transport_started",
          "ambiguous",
          "reconciliation_only",
        ])
      )
    );
  if (affectedRows(result) !== 1) {
    throw new Error("credit payment reconciliation fence was lost");
  }
}

async function bindReconciledCreditIntent(
  tx: ImageGenTransaction,
  job: ClaimedOutboxJob,
  payload: CreditPaymentRecoveryPayload,
  providerResourceId: string
): Promise<void> {
  await tx
    .update(billingIntents)
    .set({ molliePaymentId: providerResourceId, status: "contained" })
    .where(
      and(
        eq(billingIntents.intentId, payload.intentId),
        eq(billingIntents.workspaceId, job.workspaceId),
        eq(billingIntents.mode, job.mode),
        eq(billingIntents.kind, "credit_purchase"),
        eq(billingIntents.authorizationEpoch, payload.authorizationEpoch),
        eq(billingIntents.creditWalletId, payload.creditWalletId),
        eq(billingIntents.creditMetadataHash, payload.creditMetadataHash),
        or(
          isNull(billingIntents.molliePaymentId),
          eq(billingIntents.molliePaymentId, providerResourceId)
        )
      )
    );
}

function requiresCreditReconciliationReview(
  matches: readonly MolliePayment[],
  routeConflict: boolean
): boolean {
  return (
    matches.length > 1 ||
    routeConflict ||
    matches.some(payment => payment.status === "paid")
  );
}

async function enqueueCreditReconciliationReview(
  tx: ImageGenTransaction,
  job: ClaimedOutboxJob,
  payload: CreditPaymentRecoveryPayload
): Promise<void> {
  await insertOutbox(tx, {
    workspaceId: job.workspaceId,
    mode: job.mode,
    eventType: "manual_review",
    deduplicationKey: `credit_payment_reconciliation_review:${payload.providerOperationId}`,
    payload: {
      reason: "payment_provider_ambiguous_after_disable",
      intentId: payload.intentId,
      providerOperationId: payload.providerOperationId,
      creditPurpose: "premium_image_credits",
    },
  });
}

/**
 * Converts due authorized customerless provider operations into bounded
 * safety-reconciliation work. The generic resolver changes transport evidence
 * to reconciliation_only first; this function never overwrites that evidence.
 */
export async function enqueueDueCustomerlessCreditPaymentRecoveries(
  workspaceId: number,
  mode: MollieMode,
  now: Date,
  tenantLease?: BillingTenantLease
): Promise<number> {
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const controls = await tx
      .select({
        commercialEnabled: billingExecutionControls.commercialEnabled,
        authorizationEpoch: billingExecutionControls.authorizationEpoch,
      })
      .from(billingExecutionControls)
      .where(
        and(
          eq(billingExecutionControls.workspaceId, workspaceId),
          eq(billingExecutionControls.mode, mode)
        )
      )
      .limit(1)
      .for("update");
    const control = controls[0];
    if (!control?.commercialEnabled) return 0;
    const offers = listCreditOffers();
    if (offers.length === 0) {
      throw new Error("premium credit recovery offer is unavailable");
    }

    // Discover only exact joined pairs before applying the batch limit. This
    // read intentionally takes no row lock: locking the join would let the
    // MySQL optimizer acquire provider-operation locks before intent locks and
    // invert the billing-wide canonical order.
    const candidateKeys = await tx
      .select({
        operationId: billingProviderOperations.operationId,
        intentId: billingProviderOperations.intentId,
      })
      .from(billingIntents)
      .innerJoin(billingProviderOperations, dueCreditRecoveryJoinPredicate())
      .where(
        and(
          dueCreditRecoveryIntentPredicate(
            workspaceId,
            mode,
            control.authorizationEpoch,
            offers
          ),
          dueCreditRecoveryOperationPredicate(
            workspaceId,
            mode,
            control.authorizationEpoch,
            now
          )
        )
      )
      .orderBy(asc(billingProviderOperations.operationId))
      .limit(RECOVERY_BATCH_LIMIT);

    // Re-read and lock the discovered rows in canonical order, repeating all
    // authorization and due predicates. A concurrent transition can only
    // remove a candidate; it cannot turn stale discovery into an enqueue.
    const intentIds = [...new Set(candidateKeys.map(row => row.intentId))];
    const intents =
      intentIds.length === 0
        ? []
        : await tx
            .select()
            .from(billingIntents)
            .where(
              and(
                dueCreditRecoveryIntentPredicate(
                  workspaceId,
                  mode,
                  control.authorizationEpoch,
                  offers
                ),
                inArray(billingIntents.intentId, intentIds)
              )
            )
            .orderBy(asc(billingIntents.intentId))
            .for("update");
    if (tenantLease) {
      await assertBillingTenantLeaseOwnedInTransaction(tx, tenantLease);
    }
    const operationIds = candidateKeys.map(row => row.operationId);
    const operations =
      operationIds.length === 0
        ? []
        : await tx
            .select({
              operationId: billingProviderOperations.operationId,
              intentId: billingProviderOperations.intentId,
              authorizationEpoch: billingProviderOperations.authorizationEpoch,
              requestFingerprint: billingProviderOperations.requestFingerprint,
              providerCustomerId: billingProviderOperations.providerCustomerId,
            })
            .from(billingProviderOperations)
            .where(
              and(
                dueCreditRecoveryOperationPredicate(
                  workspaceId,
                  mode,
                  control.authorizationEpoch,
                  now
                ),
                inArray(billingProviderOperations.operationId, operationIds)
              )
            )
            .orderBy(asc(billingProviderOperations.operationId))
            .for("update");
    return enqueueDueCreditRecoveryJobs(
      tx,
      workspaceId,
      mode,
      candidateKeys,
      intents,
      operations
    );
  });
}

type DueCreditRecoveryOperation = Readonly<{
  operationId: string;
  intentId: string;
  authorizationEpoch: number;
  requestFingerprint: string;
  providerCustomerId: string | null;
}>;

type DueCreditRecoveryCandidateKey = Readonly<{
  operationId: string;
  intentId: string;
}>;

function dueCreditRecoveryJoinPredicate() {
  return and(
    eq(billingProviderOperations.intentId, billingIntents.intentId),
    eq(billingProviderOperations.workspaceId, billingIntents.workspaceId),
    eq(billingProviderOperations.mode, billingIntents.mode),
    eq(
      billingProviderOperations.billingProfileVersion,
      billingIntents.billingProfileVersion
    ),
    eq(
      billingProviderOperations.authorizationEpoch,
      billingIntents.authorizationEpoch
    ),
    eq(
      billingProviderOperations.requestFingerprint,
      billingIntents.creditMetadataHash
    )
  );
}

function dueCreditRecoveryIntentPredicate(
  workspaceId: number,
  mode: MollieMode,
  authorizationEpoch: number,
  offers: readonly CreditOffer[]
) {
  return and(
    eq(billingIntents.workspaceId, workspaceId),
    eq(billingIntents.mode, mode),
    eq(billingIntents.kind, "credit_purchase"),
    eq(billingIntents.authorizationEpoch, authorizationEpoch),
    eq(billingIntents.status, "api_unknown"),
    eq(billingIntents.billingProfileVersion, 0),
    eq(billingIntents.interval, "oneoff"),
    or(
      ...offers.map(offer =>
        and(
          eq(billingIntents.planCode, offer.offerId),
          eq(billingIntents.expectedAmount, offer.amount.value),
          eq(billingIntents.currency, offer.amount.currency),
          eq(billingIntents.mollieDescription, offer.mollieDescription),
          eq(billingIntents.creditCount, offer.creditCount)
        )
      )
    ),
    isNotNull(billingIntents.creditWalletId),
    isNotNull(billingIntents.creditFinancialSubjectRef),
    isNotNull(billingIntents.creditMetadataHash),
    isNotNull(billingIntents.messengerChannelConnectionId),
    isNotNull(billingIntents.messengerBindingEpoch),
    isNotNull(billingIntents.messengerPrivacyEpoch)
  );
}

function dueCreditRecoveryOperationPredicate(
  workspaceId: number,
  mode: MollieMode,
  authorizationEpoch: number,
  now: Date
) {
  return and(
    eq(billingProviderOperations.workspaceId, workspaceId),
    eq(billingProviderOperations.mode, mode),
    eq(billingProviderOperations.operationType, "create_payment"),
    eq(billingProviderOperations.billingProfileVersion, 0),
    eq(billingProviderOperations.authorizationEpoch, authorizationEpoch),
    eq(billingProviderOperations.state, "reconciliation_only"),
    isNull(billingProviderOperations.providerCustomerId),
    lte(billingProviderOperations.resolutionDueAt, now)
  );
}

async function enqueueDueCreditRecoveryJobs(
  tx: ImageGenTransaction,
  workspaceId: number,
  mode: MollieMode,
  candidateKeys: readonly DueCreditRecoveryCandidateKey[],
  intents: readonly (typeof billingIntents.$inferSelect)[],
  operations: readonly DueCreditRecoveryOperation[]
): Promise<number> {
  const discoveredIntentByOperationId = new Map(
    candidateKeys.map(candidate => [candidate.operationId, candidate.intentId])
  );
  const intentsById = new Map(intents.map(intent => [intent.intentId, intent]));
  let enqueued = 0;
  for (const operation of operations) {
    const discoveredIntentId = discoveredIntentByOperationId.get(
      operation.operationId
    );
    const intent = discoveredIntentId
      ? intentsById.get(discoveredIntentId)
      : undefined;
    if (
      !intent ||
      operation.intentId !== discoveredIntentId ||
      !isExactDueCreditRecovery(intent, operation)
    ) {
      continue;
    }
    await insertOutbox(tx, {
      workspaceId,
      mode,
      eventType: "cancel_payment",
      deduplicationKey: `credit_payment_ambiguous_reconcile:${operation.operationId}`,
      payload: dueCreditRecoveryPayload(intent, operation),
    });
    await insertOutbox(tx, {
      workspaceId,
      mode,
      eventType: "manual_review",
      deduplicationKey: `credit_payment_ambiguous_review:${operation.operationId}`,
      payload: {
        reason: "payment_provider_ambiguous_after_disable",
        intentId: intent.intentId,
        providerOperationId: operation.operationId,
        creditPurpose: "premium_image_credits",
      },
    });
    enqueued += 1;
  }
  return enqueued;
}

function isExactDueCreditRecovery(
  intent: typeof billingIntents.$inferSelect,
  operation: DueCreditRecoveryOperation
): boolean {
  return Boolean(
    exactCreditIntentOffer(intent) &&
    operation.providerCustomerId === null &&
    operation.requestFingerprint === intent.creditMetadataHash &&
    intent.creditWalletId &&
    intent.creditMetadataHash &&
    intent.messengerChannelConnectionId &&
    intent.messengerBindingEpoch &&
    intent.messengerPrivacyEpoch
  );
}

function dueCreditRecoveryPayload(
  intent: typeof billingIntents.$inferSelect,
  operation: DueCreditRecoveryOperation
): Record<string, unknown> {
  return {
    reason: "credit_payment_provider_ambiguous",
    intentId: intent.intentId,
    targetCustomerId: null,
    targetPaymentId: null,
    providerOperationId: operation.operationId,
    authorizationEpoch: operation.authorizationEpoch,
    creditPurpose: "premium_image_credits",
    creditWalletId: intent.creditWalletId,
    creditMetadataHash: intent.creditMetadataHash,
    channelConnectionId: intent.messengerChannelConnectionId,
    bindingEpoch: intent.messengerBindingEpoch,
    privacyEpoch: intent.messengerPrivacyEpoch,
  };
}

function readCreditPaymentRecoveryPayload(
  value: unknown,
  target: "known" | "unknown"
): CreditPaymentRecoveryPayload {
  const record = asPlainRecord(value);
  const reasonBinding = record ? parseRecoveryReason(record) : null;
  const ids = record ? parseRecoveryIds(record) : null;
  const creditBinding = record ? parseCreditBinding(record) : null;
  const targetPaymentId = record
    ? parseRecoveryPaymentTarget(record.targetPaymentId, target)
    : undefined;
  if (
    !reasonBinding ||
    !ids ||
    !creditBinding ||
    targetPaymentId === undefined
  ) {
    throw permanent("invalid_credit_payment_recovery_target");
  }
  return {
    reason: reasonBinding.reason,
    intentId: ids.intentId,
    targetCustomerId: null,
    targetPaymentId,
    providerOperationId: ids.providerOperationId,
    sourceProviderOperationId: ids.sourceProviderOperationId,
    authorizationEpoch: reasonBinding.authorizationEpoch,
    creditPurpose: "premium_image_credits",
    ...creditBinding,
  };
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseRecoveryReason(record: Record<string, unknown>): Readonly<{
  reason: CreditPaymentRecoveryReason;
  authorizationEpoch: number;
}> | null {
  const reason = record.reason;
  if (
    reason !== "billing_execution_disabled" &&
    reason !== "checkout_provider_response_mismatch" &&
    reason !== "credit_payment_provider_ambiguous"
  ) {
    return null;
  }
  const value =
    reason === "credit_payment_provider_ambiguous"
      ? record.authorizationEpoch
      : record.revokedAuthorizationEpoch;
  return isPositiveInteger(value)
    ? { reason, authorizationEpoch: value }
    : null;
}

function parseRecoveryIds(record: Record<string, unknown>): Readonly<{
  intentId: string;
  providerOperationId: string;
  sourceProviderOperationId: string | null;
}> | null {
  if (!isUuid(record.intentId) || !isUuid(record.providerOperationId)) {
    return null;
  }
  const source = record.sourceProviderOperationId;
  if (source !== undefined && !isUuid(source)) return null;
  return {
    intentId: record.intentId,
    providerOperationId: record.providerOperationId,
    sourceProviderOperationId: source ?? null,
  };
}

function parseCreditBinding(
  record: Record<string, unknown>
): Pick<
  CreditPaymentRecoveryPayload,
  | "creditWalletId"
  | "creditMetadataHash"
  | "channelConnectionId"
  | "bindingEpoch"
  | "privacyEpoch"
> | null {
  if (
    record.creditPurpose !== "premium_image_credits" ||
    record.targetCustomerId !== null ||
    !isUuid(record.creditWalletId) ||
    !isSha256(record.creditMetadataHash)
  ) {
    return null;
  }
  const epochs = [
    record.channelConnectionId,
    record.bindingEpoch,
    record.privacyEpoch,
  ];
  if (!epochs.every(isPositiveInteger)) return null;
  return {
    creditWalletId: record.creditWalletId,
    creditMetadataHash: record.creditMetadataHash,
    channelConnectionId: Number(record.channelConnectionId),
    bindingEpoch: Number(record.bindingEpoch),
    privacyEpoch: Number(record.privacyEpoch),
  };
}

function parseRecoveryPaymentTarget(
  value: unknown,
  target: "known" | "unknown"
): string | null | undefined {
  if (target === "unknown") return value === null ? null : undefined;
  return typeof value === "string" && PAYMENT_ID_PATTERN.test(value)
    ? value
    : undefined;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

async function lockExactRecoveryBinding(
  tx: ImageGenTransaction,
  job: Pick<BillingOutboxItem, "workspaceId" | "mode">,
  payload: CreditPaymentRecoveryPayload,
  paymentId: string | null,
  allowedStates: readonly (typeof billingProviderOperations.$inferSelect.state)[]
): Promise<RecoveryBinding | null> {
  const controls = await tx
    .select({
      commercialEnabled: billingExecutionControls.commercialEnabled,
      authorizationEpoch: billingExecutionControls.authorizationEpoch,
    })
    .from(billingExecutionControls)
    .where(
      and(
        eq(billingExecutionControls.workspaceId, job.workspaceId),
        eq(billingExecutionControls.mode, job.mode)
      )
    )
    .limit(1)
    .for("update");
  const wallets = await tx
    .select({
      walletId: creditWallets.walletId,
      workspaceId: creditWallets.workspaceId,
      mode: creditWallets.mode,
      channelConnectionId: creditWallets.channelConnectionId,
      bindingEpoch: creditWallets.bindingEpoch,
      privacyEpoch: creditWallets.privacyEpoch,
      financialSubjectRef: creditWallets.financialSubjectRef,
    })
    .from(creditWallets)
    .where(
      and(
        eq(creditWallets.walletId, payload.creditWalletId),
        eq(creditWallets.workspaceId, job.workspaceId),
        eq(creditWallets.mode, job.mode)
      )
    )
    .limit(1)
    .for("update");
  const intents = await tx
    .select()
    .from(billingIntents)
    .where(
      and(
        eq(billingIntents.intentId, payload.intentId),
        eq(billingIntents.workspaceId, job.workspaceId),
        eq(billingIntents.mode, job.mode)
      )
    )
    .limit(1)
    .for("update");
  const operations = await tx
    .select({
      operationId: billingProviderOperations.operationId,
      workspaceId: billingProviderOperations.workspaceId,
      mode: billingProviderOperations.mode,
      operationType: billingProviderOperations.operationType,
      operationKey: billingProviderOperations.operationKey,
      intentId: billingProviderOperations.intentId,
      billingProfileVersion: billingProviderOperations.billingProfileVersion,
      authorizationEpoch: billingProviderOperations.authorizationEpoch,
      state: billingProviderOperations.state,
      requestFingerprint: billingProviderOperations.requestFingerprint,
      providerResourceId: billingProviderOperations.providerResourceId,
      providerCustomerId: billingProviderOperations.providerCustomerId,
      credentialGenerationId: billingProviderOperations.credentialGenerationId,
      firstStartedAt: billingProviderOperations.firstStartedAt,
    })
    .from(billingProviderOperations)
    .where(
      and(
        eq(billingProviderOperations.operationId, payload.providerOperationId),
        eq(billingProviderOperations.workspaceId, job.workspaceId),
        eq(billingProviderOperations.mode, job.mode)
      )
    )
    .limit(1)
    .for("update");
  const control = controls[0];
  const wallet = wallets[0];
  const intent = intents[0];
  const operation = operations[0];
  const offer = intent ? exactCreditIntentOffer(intent) : null;
  if (!control || !wallet || !intent || !operation || !offer) {
    return null;
  }
  if (!isExactRecoveryIntent(intent, job, payload, paymentId)) return null;
  if (!isExactRecoveryWallet(wallet, intent, job, payload)) return null;
  if (
    !isExactRecoveryOperation(operation, job, payload, paymentId, allowedStates)
  ) {
    return null;
  }
  return { control, wallet, intent, operation, offer };
}

function isExactRecoveryIntent(
  intent: RecoveryBinding["intent"],
  job: Pick<BillingOutboxItem, "workspaceId" | "mode">,
  payload: CreditPaymentRecoveryPayload,
  paymentId: string | null
): boolean {
  const paymentMatches =
    paymentId === null ||
    intent.molliePaymentId === null ||
    intent.molliePaymentId === paymentId;
  return (
    paymentMatches &&
    intent.intentId === payload.intentId &&
    intent.workspaceId === job.workspaceId &&
    intent.mode === job.mode &&
    intent.authorizationEpoch === payload.authorizationEpoch &&
    intent.creditWalletId === payload.creditWalletId &&
    intent.creditMetadataHash === payload.creditMetadataHash &&
    intent.messengerChannelConnectionId === payload.channelConnectionId &&
    intent.messengerBindingEpoch === payload.bindingEpoch &&
    intent.messengerPrivacyEpoch === payload.privacyEpoch
  );
}

function isExactRecoveryWallet(
  wallet: RecoveryBinding["wallet"],
  intent: RecoveryBinding["intent"],
  job: Pick<BillingOutboxItem, "workspaceId" | "mode">,
  payload: CreditPaymentRecoveryPayload
): boolean {
  return (
    wallet.walletId === payload.creditWalletId &&
    wallet.workspaceId === job.workspaceId &&
    wallet.mode === job.mode &&
    wallet.channelConnectionId === payload.channelConnectionId &&
    wallet.bindingEpoch === payload.bindingEpoch &&
    wallet.privacyEpoch === payload.privacyEpoch &&
    wallet.financialSubjectRef === intent.creditFinancialSubjectRef
  );
}

function isExactRecoveryOperation(
  operation: RecoveryBinding["operation"],
  job: Pick<BillingOutboxItem, "workspaceId" | "mode">,
  payload: CreditPaymentRecoveryPayload,
  paymentId: string | null,
  allowedStates: readonly (typeof billingProviderOperations.$inferSelect.state)[]
): boolean {
  const targetMatches =
    paymentId === null
      ? operation.operationType === "create_payment" &&
        operation.operationKey === payload.intentId &&
        (operation.providerResourceId === null ||
          operation.state === "contained")
      : isExactKnownOperation(operation, payload, paymentId);
  return (
    targetMatches &&
    allowedStates.includes(operation.state) &&
    operation.operationId === payload.providerOperationId &&
    operation.workspaceId === job.workspaceId &&
    operation.mode === job.mode &&
    operation.intentId === payload.intentId &&
    operation.billingProfileVersion === 0 &&
    operation.authorizationEpoch === payload.authorizationEpoch &&
    operation.requestFingerprint === payload.creditMetadataHash &&
    operation.providerCustomerId === null
  );
}

function isExactKnownOperation(
  operation: RecoveryBinding["operation"],
  payload: CreditPaymentRecoveryPayload,
  paymentId: string
): boolean {
  if (
    operation.providerResourceId !== paymentId ||
    operation.state !== "contained"
  ) {
    return false;
  }
  if (operation.operationType === "create_payment") {
    return operation.operationKey === payload.intentId;
  }
  return (
    operation.operationType === "cancel_payment" &&
    payload.sourceProviderOperationId !== null &&
    operation.operationKey ===
      `credit-containment:${payload.sourceProviderOperationId}:${paymentId}`
  );
}

function exactCreditIntentOffer(
  intent: typeof billingIntents.$inferSelect
): CreditOffer | null {
  const offer = getCreditOfferForStoredSnapshot(intent);
  if (
    !offer ||
    intent.kind !== "credit_purchase" ||
    intent.billingProfileVersion !== 0 ||
    intent.interval !== "oneoff" ||
    intent.expectedAmount !== offer.amount.value ||
    intent.currency !== offer.amount.currency ||
    intent.mollieDescription !== offer.mollieDescription ||
    intent.creditCount !== offer.creditCount ||
    !intent.creditWalletId ||
    !intent.creditFinancialSubjectRef ||
    !SHA256_PATTERN.test(intent.creditFinancialSubjectRef) ||
    !intent.creditMetadataHash ||
    !SHA256_PATTERN.test(intent.creditMetadataHash)
  ) {
    return null;
  }
  return offer;
}

function matchesRecoveryAuthorization(
  binding: RecoveryBinding,
  payload: CreditPaymentRecoveryPayload
): boolean {
  if (payload.reason === "credit_payment_provider_ambiguous") {
    return (
      binding.control.commercialEnabled &&
      binding.control.authorizationEpoch === payload.authorizationEpoch
    );
  }
  return (
    !binding.control.commercialEnabled &&
    binding.control.authorizationEpoch > payload.authorizationEpoch
  );
}

async function bindExactWebhookRoute(
  tx: ImageGenTransaction,
  job: Pick<BillingOutboxItem, "workspaceId" | "mode">,
  payload: CreditPaymentRecoveryPayload,
  paymentId: string
): Promise<boolean> {
  await tx
    .insert(billingWebhookRoutes)
    .values({
      mode: job.mode,
      molliePaymentId: paymentId,
      workspaceId: job.workspaceId,
      intentId: payload.intentId,
    })
    .onDuplicateKeyUpdate({
      set: { molliePaymentId: sql`mollie_payment_id` },
    });
  return hasExactWebhookRoute(tx, job, payload, paymentId);
}

async function hasExactWebhookRoute(
  tx: ImageGenTransaction,
  job: Pick<BillingOutboxItem, "workspaceId" | "mode">,
  payload: CreditPaymentRecoveryPayload,
  paymentId: string
): Promise<boolean> {
  const routes = await tx
    .select({
      workspaceId: billingWebhookRoutes.workspaceId,
      intentId: billingWebhookRoutes.intentId,
    })
    .from(billingWebhookRoutes)
    .where(
      and(
        eq(billingWebhookRoutes.mode, job.mode),
        eq(billingWebhookRoutes.molliePaymentId, paymentId)
      )
    )
    .limit(1)
    .for("update");
  return (
    routes[0]?.workspaceId === job.workspaceId &&
    routes[0]?.intentId === payload.intentId
  );
}

async function insertOutbox(
  tx: ImageGenTransaction,
  value: Readonly<{
    workspaceId: number;
    mode: MollieMode;
    eventType: "cancel_payment" | "manual_review";
    deduplicationKey: string;
    payload: Record<string, unknown>;
  }>
): Promise<void> {
  await tx
    .insert(billingOutbox)
    .values({ ...value, status: "pending" })
    .onDuplicateKeyUpdate({
      set: { deduplicationKey: sql`deduplication_key` },
    });
}

function deterministicUuid(parts: readonly string[]): string {
  const hex = createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "8";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function affectedRows(result: unknown): number {
  const metadata: unknown = Array.isArray(result)
    ? (result as unknown[])[0]
    : result;
  return Number(
    (metadata as { affectedRows?: number } | undefined)?.affectedRows ?? 0
  );
}

function permanent(code: string): CreditPaymentRecoveryError {
  return new CreditPaymentRecoveryError(code, false);
}

function retryable(code: string): CreditPaymentRecoveryError {
  return new CreditPaymentRecoveryError(code, true);
}
