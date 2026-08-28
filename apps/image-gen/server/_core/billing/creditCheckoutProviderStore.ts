import { createHash, randomUUID } from "node:crypto";

import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";

import {
  billingExecutionControls,
  billingIntents,
  billingOutbox,
  billingProviderOperations,
  billingSchedulerTenants,
  billingWebhookRoutes,
  channelConnections,
  creditWallets,
  messengerPrivacySubjects,
} from "../../../drizzle/schema";
import { getDatabaseOrThrow, type ImageGenTransaction } from "../../db";
import type { MollieMode } from "./config";
import { getCreditOffer, type CreditOffer } from "./creditCatalog";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const USER_KEY_PATTERN =
  /^(?:[0-9a-f]{64}|u2[.]k[1-9][0-9]{0,5}[.][0-9a-f]{64})$/;
const PAYMENT_ID_PATTERN = /^tr_[A-Za-z0-9]{1,60}$/;
const PROVIDER_LEASE_MS = 60_000;
const PROVIDER_RESOLUTION_MS = 5 * 60_000;
const PROVIDER_RETRY_FENCE_MS = 55 * 60_000;

export type CreditCheckoutProviderScope = Readonly<{
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
  sessionNonceHash: string;
  metadataHash: string;
  offerId: string;
  offerVersion: number;
}>;

export type CreditPaymentProviderOutcome =
  | Readonly<{ kind: "known_succeeded"; paymentId: string }>
  | Readonly<{ kind: "known_mismatch"; paymentId: string }>
  | Readonly<{ kind: "known_failed" }>
  | Readonly<{ kind: "ambiguous" }>;

export type CreditPaymentProviderFinalization = Readonly<{
  recorded: boolean;
  authorized: boolean;
  revokedAuthorizationEpoch: number | null;
}>;

export class CreditCheckoutProviderStoreError extends Error {
  readonly code: "invalid_input" | "credential_generation_missing";

  constructor(code: "invalid_input" | "credential_generation_missing") {
    super("Credit checkout provider operation is unavailable");
    this.name = "CreditCheckoutProviderStoreError";
    this.code = code;
  }
}

type Boundary = Readonly<{
  control:
    | Readonly<{ commercialEnabled: boolean; authorizationEpoch: number }>
    | undefined;
  connection:
    | Readonly<{
        channel: string;
        status: string;
        bindingEpoch: number;
      }>
    | undefined;
  privacy: Readonly<{ status: string; privacyEpoch: number }> | undefined;
  wallet:
    | Readonly<{
        channelConnectionId: number;
        bindingEpoch: number;
        privacyEpoch: number;
        currentUserKeyHash: string | null;
        financialSubjectRef: string;
        status: string;
      }>
    | undefined;
  intent: typeof billingIntents.$inferSelect | undefined;
  scheduler: Readonly<{ enabled: boolean; executionEpoch: number }> | undefined;
}>;

type LockedProviderOperation = Pick<
  typeof billingProviderOperations.$inferSelect,
  | "operationId"
  | "operationType"
  | "operationKey"
  | "intentId"
  | "billingProfileVersion"
  | "authorizationEpoch"
  | "state"
  | "requestFingerprint"
  | "idempotencyKeyHash"
  | "credentialGenerationId"
  | "providerResourceId"
  | "providerCustomerId"
  | "leaseToken"
  | "leaseUntil"
  | "firstStartedAt"
>;

export async function claimCreditPaymentCreation(
  input: CreditCheckoutProviderScope,
  now = new Date()
): Promise<
  | Readonly<{ claimed: false }>
  | Readonly<{
      claimed: true;
      operationId: string;
      leaseToken: string;
      recoveryPaymentId?: string;
    }>
> {
  const offer = requireScope(input);
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const boundary = await lockCreditProviderBoundary(tx, input);
    if (
      !isActiveBoundary(boundary, input, offer) ||
      !boundary.intent?.checkoutCapabilityConsumedAt ||
      !boundary.intent.checkoutCapabilityExpiresAt ||
      boundary.intent.checkoutCapabilityExpiresAt.getTime() < now.getTime()
    ) {
      return { claimed: false };
    }

    const credentialGenerationId = readCredentialGenerationId();
    const idempotencyKeyHash = sha256Hex(boundary.intent.idempotencyKey);
    const existing = await lockProviderOperationByKey(tx, input);
    const leaseToken = randomUUID();
    if (existing) {
      if (
        isRecoverableSucceededPayment(
          existing,
          boundary.intent,
          input,
          credentialGenerationId,
          idempotencyKeyHash
        ) &&
        existing.leaseUntil.getTime() <= now.getTime()
      ) {
        const recoveryPaymentId = existing.providerResourceId;
        const recovered = await tx
          .update(billingProviderOperations)
          .set({
            leaseToken,
            leaseUntil: new Date(now.getTime() + PROVIDER_LEASE_MS),
            resolutionDueAt: new Date(now.getTime() + PROVIDER_RESOLUTION_MS),
          })
          .where(
            and(
              exactProviderOperationPredicate({
                ...input,
                operationId: existing.operationId,
              }),
              eq(billingProviderOperations.state, "succeeded"),
              eq(
                billingProviderOperations.providerResourceId,
                recoveryPaymentId
              ),
              eq(billingProviderOperations.leaseToken, existing.leaseToken),
              lte(billingProviderOperations.leaseUntil, now),
              isNull(billingProviderOperations.providerCustomerId)
            )
          );
        if (affectedRows(recovered) !== 1) return { claimed: false };
        return {
          claimed: true,
          operationId: existing.operationId,
          leaseToken,
          recoveryPaymentId,
        };
      }
      if (
        boundary.intent.status !== "created" ||
        boundary.intent.molliePaymentId !== null ||
        boundary.intent.urlExposedAt !== null ||
        existing.state !== "known_failed" ||
        existing.firstStartedAt !== null ||
        !isExactProviderOperation(
          existing,
          input,
          credentialGenerationId,
          idempotencyKeyHash
        )
      ) {
        return { claimed: false };
      }
      const resumed = await tx
        .update(billingProviderOperations)
        .set({
          state: "reserved",
          leaseToken,
          leaseUntil: new Date(now.getTime() + PROVIDER_LEASE_MS),
          retryBefore: null,
          resolutionDueAt: new Date(now.getTime() + PROVIDER_RESOLUTION_MS),
        })
        .where(
          and(
            eq(billingProviderOperations.operationId, existing.operationId),
            eq(billingProviderOperations.state, "known_failed"),
            isNull(billingProviderOperations.firstStartedAt)
          )
        );
      if (affectedRows(resumed) !== 1) return { claimed: false };
      await markIntentCreating(tx, input);
      return {
        claimed: true,
        operationId: existing.operationId,
        leaseToken,
      };
    }

    if (
      boundary.intent.status !== "created" ||
      boundary.intent.molliePaymentId !== null ||
      boundary.intent.urlExposedAt !== null
    ) {
      return { claimed: false };
    }

    const operationId = randomUUID();
    await tx.insert(billingProviderOperations).values({
      operationId,
      workspaceId: input.workspaceId,
      mode: input.mode,
      operationType: "create_payment",
      operationKey: input.intentId,
      intentId: input.intentId,
      billingProfileVersion: 0,
      authorizationEpoch: input.authorizationEpoch,
      state: "reserved",
      requestFingerprint: input.metadataHash,
      idempotencyKeyHash,
      credentialGenerationId,
      providerCustomerId: null,
      leaseToken,
      leaseUntil: new Date(now.getTime() + PROVIDER_LEASE_MS),
      resolutionDueAt: new Date(now.getTime() + PROVIDER_RESOLUTION_MS),
    });
    const intentUpdated = await markIntentCreating(tx, input);
    if (affectedRows(intentUpdated) !== 1) {
      throw new Error("Credit checkout intent claim changed concurrently");
    }
    return { claimed: true, operationId, leaseToken };
  });
}

function isRecoverableSucceededPayment(
  operation: LockedProviderOperation,
  intent: typeof billingIntents.$inferSelect,
  input: CreditCheckoutProviderScope,
  credentialGenerationId: string,
  idempotencyKeyHash: string
): operation is LockedProviderOperation &
  Readonly<{ providerResourceId: string }> {
  if (
    operation.state !== "succeeded" ||
    !operation.providerResourceId ||
    !PAYMENT_ID_PATTERN.test(operation.providerResourceId) ||
    !isExactProviderOperation(
      operation,
      input,
      credentialGenerationId,
      idempotencyKeyHash
    )
  ) {
    return false;
  }
  return (
    (intent.status === "creating_payment" &&
      intent.molliePaymentId === null &&
      intent.urlExposedAt === null) ||
    (intent.status === "open" &&
      intent.molliePaymentId === operation.providerResourceId &&
      intent.urlExposedAt !== null)
  );
}

export async function markCreditPaymentTransportStarted(
  input: CreditCheckoutProviderScope &
    Readonly<{ operationId: string; leaseToken: string }>,
  now = new Date()
): Promise<boolean> {
  const offer = requireScope(input);
  requireUuid(input.operationId);
  requireUuid(input.leaseToken);
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const boundary = await lockCreditProviderBoundary(tx, input);
    const operation = await lockProviderOperationById(tx, input);
    if (
      !isActiveBoundary(boundary, input, offer) ||
      boundary.intent?.status !== "creating_payment" ||
      !operation ||
      operation.state !== "reserved" ||
      operation.leaseToken !== input.leaseToken ||
      operation.leaseUntil.getTime() <= now.getTime() ||
      !isExactProviderOperation(
        operation,
        input,
        operation.credentialGenerationId,
        sha256Hex(boundary.intent.idempotencyKey)
      )
    ) {
      return false;
    }
    const result = await tx
      .update(billingProviderOperations)
      .set({
        state: "transport_started",
        firstStartedAt: now,
        retryBefore: new Date(now.getTime() + PROVIDER_RETRY_FENCE_MS),
        resolutionDueAt: new Date(now.getTime() + PROVIDER_RESOLUTION_MS),
        attemptCount: sql`${billingProviderOperations.attemptCount} + 1`,
      })
      .where(
        and(
          exactProviderOperationPredicate(input),
          eq(billingProviderOperations.leaseToken, input.leaseToken),
          eq(billingProviderOperations.state, "reserved"),
          gt(billingProviderOperations.leaseUntil, now),
          isNull(billingProviderOperations.providerCustomerId)
        )
      );
    return affectedRows(result) === 1;
  });
}

export async function finalizeCreditPaymentProviderOperation(
  input: CreditCheckoutProviderScope &
    Readonly<{
      operationId: string;
      leaseToken: string;
      outcome: CreditPaymentProviderOutcome;
    }>,
  now = new Date()
): Promise<CreditPaymentProviderFinalization> {
  const offer = requireScope(input);
  requireUuid(input.operationId);
  requireUuid(input.leaseToken);
  requireOutcome(input.outcome);
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const boundary = await lockCreditProviderBoundary(tx, input);
    const operation = await lockProviderOperationById(tx, input);
    if (
      !boundary.intent ||
      !isStructuralCreditIntent(boundary.intent, input, offer) ||
      !operation ||
      operation.state !== "transport_started" ||
      operation.leaseToken !== input.leaseToken ||
      !isExactProviderOperation(
        operation,
        input,
        operation.credentialGenerationId,
        sha256Hex(boundary.intent.idempotencyKey)
      )
    ) {
      return notRecorded();
    }

    const authorized = isActiveBoundary(boundary, input, offer);
    const providerResourceId = paymentIdFromOutcome(input.outcome);
    const state = providerOutcomeState(input.outcome, authorized);

    // Provider evidence is the first write. Every subsequent binding,
    // containment and outbox insert is committed atomically with it.
    const operationResult = await tx
      .update(billingProviderOperations)
      .set({
        state,
        providerResourceId,
        completedAt:
          input.outcome.kind === "known_succeeded" ||
          input.outcome.kind === "known_mismatch"
            ? now
            : null,
        resolutionDueAt: now,
      })
      .where(
        and(
          exactProviderOperationPredicate(input),
          eq(billingProviderOperations.leaseToken, input.leaseToken),
          eq(billingProviderOperations.state, "transport_started"),
          isNull(billingProviderOperations.providerCustomerId)
        )
      );
    if (affectedRows(operationResult) !== 1) return notRecorded();

    if (input.outcome.kind === "known_failed") {
      await setIntentStatus(tx, input, authorized ? "created" : "contained");
    } else if (input.outcome.kind === "ambiguous") {
      await setIntentStatus(
        tx,
        input,
        authorized ? "api_unknown" : "contained"
      );
      if (!authorized) {
        await enqueueCreditContainment(tx, input, {
          reason: "billing_execution_disabled",
          operationId: input.operationId,
          paymentId: null,
          reviewReason: "payment_provider_ambiguous_after_disable",
        });
      }
    } else if (input.outcome.kind === "known_mismatch" || !authorized) {
      const routeBound = await bindWebhookRoute(
        tx,
        input,
        input.outcome.paymentId
      );
      if (routeBound) {
        await bindIntentPayment(
          tx,
          input,
          input.outcome.paymentId,
          input.outcome.kind === "known_mismatch" ? "mismatch" : "contained",
          null
        );
        await enqueueCreditContainment(tx, input, {
          reason:
            input.outcome.kind === "known_mismatch"
              ? "checkout_provider_response_mismatch"
              : "billing_execution_disabled",
          operationId: input.operationId,
          paymentId: input.outcome.paymentId,
          reviewReason:
            input.outcome.kind === "known_mismatch"
              ? "checkout_provider_response_mismatch"
              : "provider_payment_created_after_checkout_superseded",
        });
      } else {
        await enqueueManualReview(tx, input, {
          deduplicationKey: `credit_payment_route_conflict:${input.operationId}`,
          reason: "payment_mismatch",
          operationId: input.operationId,
          paymentId: input.outcome.paymentId,
        });
      }
    }

    return {
      recorded: true,
      authorized,
      revokedAuthorizationEpoch: authorized ? null : input.authorizationEpoch,
    };
  });
}

/**
 * Attaches the exact known Payment and marks its checkout URL exposed in one
 * transaction. The URL itself is deliberately not persisted.
 */
export async function exposeCreditPaymentCheckout(
  input: CreditCheckoutProviderScope &
    Readonly<{
      operationId: string;
      leaseToken: string;
      paymentId: string;
    }>,
  now = new Date()
): Promise<boolean> {
  const offer = requireScope(input);
  requireUuid(input.operationId);
  requireUuid(input.leaseToken);
  requirePaymentId(input.paymentId);
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const boundary = await lockCreditProviderBoundary(tx, input);
    const operation = await lockProviderOperationById(tx, input);
    if (
      !boundary.intent ||
      !operation ||
      operation.leaseToken !== input.leaseToken ||
      operation.state !== "succeeded" ||
      operation.providerResourceId !== input.paymentId ||
      !isExactProviderOperation(
        operation,
        input,
        operation.credentialGenerationId,
        sha256Hex(boundary.intent.idempotencyKey)
      )
    ) {
      return false;
    }

    const alreadyExposed =
      boundary.intent.status === "open" &&
      boundary.intent.molliePaymentId === input.paymentId &&
      boundary.intent.urlExposedAt !== null;
    if (alreadyExposed) {
      return readExactWebhookRoute(tx, input, input.paymentId);
    }

    // An expired lease may still record the known response, but it must never
    // expose or contain a checkout. Recovery must first obtain a fresh lease.
    if (operation.leaseUntil.getTime() <= now.getTime()) return false;

    const active = isActiveBoundary(boundary, input, offer);
    const attachable =
      active &&
      inAllowedExposureState(boundary.intent.status) &&
      (boundary.intent.molliePaymentId === null ||
        boundary.intent.molliePaymentId === input.paymentId);
    if (!attachable) {
      const contained = await containSucceededOperation(tx, input);
      if (!contained) return false;
      const routeBound = await bindWebhookRoute(tx, input, input.paymentId);
      if (routeBound) {
        await bindIntentPayment(tx, input, input.paymentId, "contained", null);
        await enqueueCreditContainment(tx, input, {
          reason: "billing_execution_disabled",
          operationId: input.operationId,
          paymentId: input.paymentId,
          reviewReason: "provider_payment_created_after_checkout_superseded",
        });
      } else {
        await enqueueManualReview(tx, input, {
          deduplicationKey: `credit_payment_route_conflict:${input.operationId}`,
          reason: "payment_mismatch",
          operationId: input.operationId,
          paymentId: input.paymentId,
        });
      }
      return false;
    }

    if (!(await bindWebhookRoute(tx, input, input.paymentId))) {
      const contained = await containSucceededOperation(tx, input);
      if (contained) {
        await enqueueManualReview(tx, input, {
          deduplicationKey: `credit_payment_route_conflict:${input.operationId}`,
          reason: "payment_mismatch",
          operationId: input.operationId,
          paymentId: input.paymentId,
        });
      }
      return false;
    }
    const attached = await bindIntentPayment(
      tx,
      input,
      input.paymentId,
      "open",
      now
    );
    return affectedRows(attached) === 1;
  });
}

async function lockCreditProviderBoundary(
  tx: ImageGenTransaction,
  input: CreditCheckoutProviderScope
): Promise<Boundary> {
  // Canonical order: control -> connection -> privacy -> wallet -> intent ->
  // scheduler -> provider operation -> route/outbox.
  const controls = await tx
    .select({
      commercialEnabled: billingExecutionControls.commercialEnabled,
      authorizationEpoch: billingExecutionControls.authorizationEpoch,
    })
    .from(billingExecutionControls)
    .where(
      and(
        eq(billingExecutionControls.workspaceId, input.workspaceId),
        eq(billingExecutionControls.mode, input.mode)
      )
    )
    .limit(1)
    .for("update");
  const connections = await tx
    .select({
      channel: channelConnections.channel,
      status: channelConnections.status,
      bindingEpoch: channelConnections.bindingEpoch,
    })
    .from(channelConnections)
    .where(
      and(
        eq(channelConnections.id, input.channelConnectionId),
        eq(channelConnections.workspaceId, input.workspaceId)
      )
    )
    .limit(1)
    .for("update");
  const privacy = await tx
    .select({
      status: messengerPrivacySubjects.status,
      privacyEpoch: messengerPrivacySubjects.privacyEpoch,
    })
    .from(messengerPrivacySubjects)
    .where(
      and(
        eq(messengerPrivacySubjects.workspaceId, input.workspaceId),
        eq(
          messengerPrivacySubjects.channelConnectionId,
          input.channelConnectionId
        ),
        eq(messengerPrivacySubjects.userKey, input.userKey),
        eq(messengerPrivacySubjects.privacyEpoch, input.privacyEpoch)
      )
    )
    .limit(1)
    .for("update");
  const wallets = await tx
    .select({
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
        eq(creditWallets.walletId, input.walletId),
        eq(creditWallets.workspaceId, input.workspaceId),
        eq(creditWallets.mode, input.mode)
      )
    )
    .limit(1)
    .for("update");
  const intents = await tx
    .select()
    .from(billingIntents)
    .where(
      and(
        eq(billingIntents.intentId, input.intentId),
        eq(billingIntents.workspaceId, input.workspaceId),
        eq(billingIntents.mode, input.mode)
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
        eq(billingSchedulerTenants.workspaceId, input.workspaceId),
        eq(billingSchedulerTenants.mode, input.mode),
        eq(billingSchedulerTenants.kind, "outbox")
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
  };
}

function isActiveBoundary(
  boundary: Boundary,
  input: CreditCheckoutProviderScope,
  offer: CreditOffer
): boolean {
  return Boolean(
    boundary.control?.commercialEnabled &&
    boundary.control.authorizationEpoch === input.authorizationEpoch &&
    boundary.connection?.channel === "facebook_messenger" &&
    boundary.connection.status === "connected" &&
    boundary.connection.bindingEpoch === input.bindingEpoch &&
    boundary.privacy?.status === "active" &&
    boundary.privacy.privacyEpoch === input.privacyEpoch &&
    boundary.wallet?.status === "active" &&
    boundary.wallet.channelConnectionId === input.channelConnectionId &&
    boundary.wallet.bindingEpoch === input.bindingEpoch &&
    boundary.wallet.privacyEpoch === input.privacyEpoch &&
    boundary.wallet.currentUserKeyHash === input.userKey &&
    boundary.wallet.financialSubjectRef === input.financialSubjectRef &&
    boundary.intent &&
    isStructuralCreditIntent(boundary.intent, input, offer) &&
    boundary.intent.creditIdentityErasedAt === null &&
    boundary.intent.messengerSenderUserKey === input.userKey &&
    boundary.intent.checkoutCapabilityConsumedAt !== null &&
    boundary.intent.checkoutCapabilitySessionNonceHash ===
      input.sessionNonceHash &&
    boundary.scheduler?.enabled &&
    boundary.scheduler.executionEpoch === input.authorizationEpoch
  );
}

function isStructuralCreditIntent(
  intent: typeof billingIntents.$inferSelect,
  input: CreditCheckoutProviderScope,
  offer: CreditOffer
): boolean {
  return (
    intent.kind === "credit_purchase" &&
    intent.workspaceId === input.workspaceId &&
    intent.mode === input.mode &&
    intent.intentId === input.intentId &&
    intent.planCode === offer.offerId &&
    intent.expectedAmount === offer.amount.value &&
    intent.currency === offer.amount.currency &&
    intent.interval === "oneoff" &&
    isEmptyRecord(intent.entitlements) &&
    intent.mollieDescription === offer.mollieDescription &&
    intent.billingProfileVersion === 0 &&
    intent.authorizationEpoch === input.authorizationEpoch &&
    intent.messengerChannelConnectionId === input.channelConnectionId &&
    intent.messengerBindingEpoch === input.bindingEpoch &&
    intent.messengerPrivacyEpoch === input.privacyEpoch &&
    intent.creditWalletId === input.walletId &&
    intent.creditFinancialSubjectRef === input.financialSubjectRef &&
    intent.creditCount === offer.creditCount &&
    intent.creditMetadataHash === input.metadataHash &&
    intent.idempotencyKey === `credit-payment:${input.intentId}`
  );
}

function isExactProviderOperation(
  operation: LockedProviderOperation,
  input: CreditCheckoutProviderScope,
  credentialGenerationId: string,
  idempotencyKeyHash: string
): boolean {
  return (
    operation.operationType === "create_payment" &&
    operation.operationKey === input.intentId &&
    operation.intentId === input.intentId &&
    operation.billingProfileVersion === 0 &&
    operation.authorizationEpoch === input.authorizationEpoch &&
    operation.requestFingerprint === input.metadataHash &&
    operation.idempotencyKeyHash === idempotencyKeyHash &&
    operation.credentialGenerationId === credentialGenerationId &&
    operation.providerCustomerId === null
  );
}

async function lockProviderOperationByKey(
  tx: ImageGenTransaction,
  input: CreditCheckoutProviderScope
): Promise<LockedProviderOperation | undefined> {
  const rows = await tx
    .select(providerOperationSelection())
    .from(billingProviderOperations)
    .where(
      and(
        eq(billingProviderOperations.workspaceId, input.workspaceId),
        eq(billingProviderOperations.mode, input.mode),
        eq(billingProviderOperations.operationType, "create_payment"),
        eq(billingProviderOperations.operationKey, input.intentId)
      )
    )
    .limit(1)
    .for("update");
  return rows[0];
}

async function lockProviderOperationById(
  tx: ImageGenTransaction,
  input: CreditCheckoutProviderScope & Readonly<{ operationId: string }>
): Promise<LockedProviderOperation | undefined> {
  const rows = await tx
    .select(providerOperationSelection())
    .from(billingProviderOperations)
    .where(
      and(
        eq(billingProviderOperations.operationId, input.operationId),
        eq(billingProviderOperations.workspaceId, input.workspaceId),
        eq(billingProviderOperations.mode, input.mode)
      )
    )
    .limit(1)
    .for("update");
  return rows[0];
}

function providerOperationSelection() {
  return {
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
    leaseToken: billingProviderOperations.leaseToken,
    leaseUntil: billingProviderOperations.leaseUntil,
    firstStartedAt: billingProviderOperations.firstStartedAt,
  };
}

function exactProviderOperationPredicate(
  input: CreditCheckoutProviderScope & Readonly<{ operationId: string }>
) {
  return and(
    eq(billingProviderOperations.operationId, input.operationId),
    eq(billingProviderOperations.workspaceId, input.workspaceId),
    eq(billingProviderOperations.mode, input.mode),
    eq(billingProviderOperations.operationType, "create_payment"),
    eq(billingProviderOperations.operationKey, input.intentId),
    eq(billingProviderOperations.intentId, input.intentId),
    eq(billingProviderOperations.billingProfileVersion, 0),
    eq(billingProviderOperations.authorizationEpoch, input.authorizationEpoch),
    eq(billingProviderOperations.requestFingerprint, input.metadataHash)
  );
}

async function markIntentCreating(
  tx: ImageGenTransaction,
  input: CreditCheckoutProviderScope
) {
  return tx
    .update(billingIntents)
    .set({ status: "creating_payment" })
    .where(
      and(
        eq(billingIntents.intentId, input.intentId),
        eq(billingIntents.workspaceId, input.workspaceId),
        eq(billingIntents.mode, input.mode),
        eq(billingIntents.kind, "credit_purchase"),
        eq(billingIntents.billingProfileVersion, 0),
        eq(billingIntents.authorizationEpoch, input.authorizationEpoch),
        eq(billingIntents.creditMetadataHash, input.metadataHash),
        eq(billingIntents.status, "created")
      )
    );
}

async function setIntentStatus(
  tx: ImageGenTransaction,
  input: CreditCheckoutProviderScope,
  status: "created" | "api_unknown" | "contained"
) {
  return tx
    .update(billingIntents)
    .set({ status })
    .where(
      and(
        eq(billingIntents.intentId, input.intentId),
        eq(billingIntents.workspaceId, input.workspaceId),
        eq(billingIntents.mode, input.mode),
        eq(billingIntents.kind, "credit_purchase"),
        eq(billingIntents.authorizationEpoch, input.authorizationEpoch),
        eq(billingIntents.creditMetadataHash, input.metadataHash),
        inArray(billingIntents.status, ["creating_payment", "api_unknown"])
      )
    );
}

async function bindIntentPayment(
  tx: ImageGenTransaction,
  input: CreditCheckoutProviderScope,
  paymentId: string,
  status: "open" | "mismatch" | "contained",
  urlExposedAt: Date | null
) {
  return tx
    .update(billingIntents)
    .set({
      molliePaymentId: paymentId,
      status,
      ...(urlExposedAt ? { urlExposedAt } : {}),
    })
    .where(
      and(
        eq(billingIntents.intentId, input.intentId),
        eq(billingIntents.workspaceId, input.workspaceId),
        eq(billingIntents.mode, input.mode),
        eq(billingIntents.kind, "credit_purchase"),
        eq(billingIntents.billingProfileVersion, 0),
        eq(billingIntents.authorizationEpoch, input.authorizationEpoch),
        eq(billingIntents.creditMetadataHash, input.metadataHash),
        or(
          isNull(billingIntents.molliePaymentId),
          eq(billingIntents.molliePaymentId, paymentId)
        ),
        inArray(billingIntents.status, [
          "creating_payment",
          "open",
          "api_unknown",
          "mismatch",
          "contained",
        ])
      )
    );
}

async function containSucceededOperation(
  tx: ImageGenTransaction,
  input: CreditCheckoutProviderScope &
    Readonly<{ operationId: string; leaseToken: string }>
): Promise<boolean> {
  const result = await tx
    .update(billingProviderOperations)
    .set({ state: "contained", resolutionDueAt: new Date() })
    .where(
      and(
        exactProviderOperationPredicate(input),
        eq(billingProviderOperations.leaseToken, input.leaseToken),
        eq(billingProviderOperations.state, "succeeded"),
        isNull(billingProviderOperations.providerCustomerId)
      )
    );
  return affectedRows(result) === 1;
}

async function bindWebhookRoute(
  tx: ImageGenTransaction,
  input: CreditCheckoutProviderScope,
  paymentId: string
): Promise<boolean> {
  await tx
    .insert(billingWebhookRoutes)
    .values({
      mode: input.mode,
      molliePaymentId: paymentId,
      workspaceId: input.workspaceId,
      intentId: input.intentId,
    })
    .onDuplicateKeyUpdate({
      set: { molliePaymentId: sql`mollie_payment_id` },
    });
  return readExactWebhookRoute(tx, input, paymentId);
}

async function readExactWebhookRoute(
  tx: ImageGenTransaction,
  input: CreditCheckoutProviderScope,
  paymentId: string
): Promise<boolean> {
  const rows = await tx
    .select({
      workspaceId: billingWebhookRoutes.workspaceId,
      intentId: billingWebhookRoutes.intentId,
    })
    .from(billingWebhookRoutes)
    .where(
      and(
        eq(billingWebhookRoutes.mode, input.mode),
        eq(billingWebhookRoutes.molliePaymentId, paymentId)
      )
    )
    .limit(1)
    .for("update");
  return (
    rows[0]?.workspaceId === input.workspaceId &&
    rows[0]?.intentId === input.intentId
  );
}

async function enqueueCreditContainment(
  tx: ImageGenTransaction,
  input: CreditCheckoutProviderScope,
  containment: Readonly<{
    reason:
      "billing_execution_disabled" | "checkout_provider_response_mismatch";
    operationId: string;
    paymentId: string | null;
    reviewReason:
      | "checkout_provider_response_mismatch"
      | "payment_provider_ambiguous_after_disable"
      | "provider_payment_created_after_checkout_superseded";
  }>
): Promise<void> {
  await insertOutbox(tx, {
    workspaceId: input.workspaceId,
    mode: input.mode,
    eventType: "cancel_payment",
    deduplicationKey: `credit_payment_containment:${containment.operationId}:${containment.paymentId ?? "unknown"}`,
    payload: {
      reason: containment.reason,
      intentId: input.intentId,
      targetCustomerId: null,
      targetPaymentId: containment.paymentId,
      providerOperationId: containment.operationId,
      revokedAuthorizationEpoch: input.authorizationEpoch,
      creditPurpose: "premium_image_credits",
      creditWalletId: input.walletId,
      creditMetadataHash: input.metadataHash,
      channelConnectionId: input.channelConnectionId,
      bindingEpoch: input.bindingEpoch,
      privacyEpoch: input.privacyEpoch,
    },
  });
  await enqueueManualReview(tx, input, {
    deduplicationKey: `credit_payment_review:${containment.operationId}:${containment.paymentId ?? "unknown"}`,
    reason: containment.reviewReason,
    operationId: containment.operationId,
    paymentId: containment.paymentId,
  });
}

async function enqueueManualReview(
  tx: ImageGenTransaction,
  input: CreditCheckoutProviderScope,
  review: Readonly<{
    deduplicationKey: string;
    reason:
      | "checkout_provider_response_mismatch"
      | "payment_mismatch"
      | "payment_provider_ambiguous_after_disable"
      | "provider_payment_created_after_checkout_superseded";
    operationId: string;
    paymentId: string | null;
  }>
): Promise<void> {
  await insertOutbox(tx, {
    workspaceId: input.workspaceId,
    mode: input.mode,
    eventType: "manual_review",
    deduplicationKey: review.deduplicationKey,
    payload: {
      reason: review.reason,
      intentId: input.intentId,
      providerOperationId: review.operationId,
      targetPaymentId: review.paymentId,
      creditPurpose: "premium_image_credits",
      creditWalletId: input.walletId,
    },
  });
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

function providerOutcomeState(
  outcome: CreditPaymentProviderOutcome,
  authorized: boolean
): typeof billingProviderOperations.$inferSelect.state {
  if (outcome.kind === "known_failed") return "known_failed";
  if (outcome.kind === "ambiguous") {
    return authorized ? "ambiguous" : "reconciliation_only";
  }
  if (outcome.kind === "known_mismatch" || !authorized) return "contained";
  return "succeeded";
}

function paymentIdFromOutcome(
  outcome: CreditPaymentProviderOutcome
): string | null {
  return outcome.kind === "known_succeeded" || outcome.kind === "known_mismatch"
    ? outcome.paymentId
    : null;
}

function notRecorded(): CreditPaymentProviderFinalization {
  return {
    recorded: false,
    authorized: false,
    revokedAuthorizationEpoch: null,
  };
}

function inAllowedExposureState(status: string): boolean {
  return status === "creating_payment" || status === "open";
}

function requireOutcome(outcome: CreditPaymentProviderOutcome): void {
  if (outcome.kind === "known_succeeded" || outcome.kind === "known_mismatch") {
    requirePaymentId(outcome.paymentId);
    return;
  }
  if (outcome.kind !== "known_failed" && outcome.kind !== "ambiguous") {
    throw new CreditCheckoutProviderStoreError("invalid_input");
  }
}

function requireScope(input: CreditCheckoutProviderScope): CreditOffer {
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
    !SHA256_PATTERN.test(input.sessionNonceHash) ||
    !SHA256_PATTERN.test(input.metadataHash) ||
    typeof input.offerId !== "string" ||
    !Number.isSafeInteger(input.offerVersion)
  ) {
    throw new CreditCheckoutProviderStoreError("invalid_input");
  }
  const offer = getCreditOffer(input.offerId, input.offerVersion);
  if (!offer) throw new CreditCheckoutProviderStoreError("invalid_input");
  return offer;
}

function requireUuid(value: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new CreditCheckoutProviderStoreError("invalid_input");
  }
}

function requirePaymentId(value: string): void {
  if (!PAYMENT_ID_PATTERN.test(value)) {
    throw new CreditCheckoutProviderStoreError("invalid_input");
  }
}

function readCredentialGenerationId(): string {
  const value =
    process.env.MOLLIE_CREDENTIAL_GENERATION_ID?.trim() ||
    (process.env.NODE_ENV === "test" ? "test-generation" : "");
  if (!value || value.length > 64) {
    throw new CreditCheckoutProviderStoreError("credential_generation_missing");
  }
  return value;
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

function affectedRows(result: unknown): number {
  const metadata: unknown = Array.isArray(result)
    ? (result as unknown[])[0]
    : result;
  return Number(
    (metadata as { affectedRows?: number } | undefined)?.affectedRows ?? 0
  );
}
