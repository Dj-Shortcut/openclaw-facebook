import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  billingOutbox,
  billingCustomers,
  billingExecutionControls,
  billingIntents,
  billingProviderOperations,
  billingSchedulerTenants,
  billingSubscriptions,
  workspaceEntitlements,
  workspaceBillingProfiles,
  type BillingOutboxItem,
  type BillingSubscription,
} from "../../../drizzle/schema";
import { getDatabaseOrThrow } from "../../db";
import {
  advanceBillingHandoffDeliveryFence,
  beginBillingHandoffDelivery,
} from "../../db";
import { safeLog } from "../logger";
import { sendPortalHandoffLink } from "../portalHandoffDelivery";
import {
  getConfiguredBillingMode,
  getMollieConfig,
  type MollieMode,
} from "./config";
import { hashCanonicalSnapshot } from "./ids";
import {
  assertMollieId,
  MollieApiError,
  MollieClient,
  type MollieSubscription,
} from "./mollieClient";
import {
  getWorkspaceBillingSubscription,
  markWorkspaceSubscriptionStoppedIfMatches,
} from "./subscriptionStore";
import { metadataIntentId } from "./providerMetadata";
import {
  BillingNotificationConfigurationError,
  BillingNotificationTransientError,
  deliverBillingNotification,
} from "./billingNotificationDelivery";
import {
  claimNextBillingTenant,
  assertBillingTenantLeaseOwned,
  releaseBillingTenantLease,
  recordBillingSchedulerPoll,
  renewBillingTenantLease,
  type BillingTenantLease,
} from "./billingSchedulerStore";

const OUTBOX_POLL_INTERVAL_MS = 5_000;
const OUTBOX_LEASE_TIMEOUT_MS = 15 * 60 * 1_000;

class RetryableOutboxError extends Error {
  constructor(readonly retryCode: string) {
    super(retryCode);
    this.name = "RetryableOutboxError";
  }
}

class PermanentOutboxError extends Error {
  constructor(readonly errorCode: string) {
    super(errorCode);
    this.name = "PermanentOutboxError";
  }
}

type ClaimedBillingOutboxItem = BillingOutboxItem & { leaseToken: string };

let workerTimer: NodeJS.Timeout | null = null;

export function startBillingOutboxWorker(): void {
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    void runBillingOutboxSchedulerSafely();
  }, OUTBOX_POLL_INTERVAL_MS);
  workerTimer.unref();
  void runBillingOutboxSchedulerSafely();
}

export async function runBillingOutboxSchedulerOnce(
  clientOverride?: MollieClient,
  limit = 25,
  now = new Date()
): Promise<number> {
  const mode = getConfiguredBillingMode();
  await recordBillingSchedulerPoll(mode, "outbox", now);
  let processed = 0;
  const count = Math.max(1, Math.min(100, limit));
  for (let index = 0; index < count; index += 1) {
    const claimNow = index === 0 ? now : new Date();
    const lease = await claimNextBillingTenant(mode, claimNow, "outbox");
    if (!lease) break;
    let failed = false;
    const heartbeat = setInterval(() => {
      void renewBillingTenantLease(lease)
        .then(renewed => {
          if (!renewed) failed = true;
        })
        .catch(() => {
          failed = true;
        });
    }, 30_000);
    heartbeat.unref();
    try {
      await assertBillingTenantLeaseOwned(lease);
      if (
        await runBillingOutboxOnce(lease.workspaceId, clientOverride, lease)
      ) {
        processed += 1;
      }
      await assertBillingTenantLeaseOwned(lease);
    } catch {
      failed = true;
    } finally {
      clearInterval(heartbeat);
      const releaseNow = new Date();
      const nextAt = failed
        ? releaseNow
        : await getNextBillingOutboxDue(
            lease.workspaceId,
            lease.mode,
            releaseNow
          );
      const released = await releaseBillingTenantLease({
        ...lease,
        failed,
        now: releaseNow,
        nextAt,
      });
      if (!released) {
        throw new Error("billing scheduler lease ownership was lost");
      }
    }
  }
  return processed;
}

export async function getNextBillingOutboxDue(
  workspaceId: number,
  mode: MollieMode,
  now: Date
): Promise<Date> {
  const database = await getDatabaseOrThrow();
  const controls = await database
    .select({ commercialEnabled: billingExecutionControls.commercialEnabled })
    .from(billingExecutionControls)
    .where(
      and(
        eq(billingExecutionControls.workspaceId, workspaceId),
        eq(billingExecutionControls.mode, mode)
      )
    )
    .limit(1);
  if (!controls[0]) {
    throw new Error("billing execution control is not provisioned");
  }
  const safetyEventTypes = [
    "cancel_subscription",
    "cancel_payment",
    "payment_warning",
    "manual_review",
  ] as const;
  const rows = await database
    .select({ nextAt: sql<Date | null>`MIN(${billingOutbox.availableAt})` })
    .from(billingOutbox)
    .where(
      and(
        eq(billingOutbox.workspaceId, workspaceId),
        eq(billingOutbox.mode, mode),
        inArray(billingOutbox.status, ["pending", "processing"]),
        ...(controls[0].commercialEnabled
          ? []
          : [inArray(billingOutbox.eventType, safetyEventTypes)])
      )
    );
  const rawNextAt: unknown = rows[0]?.nextAt;
  const parsedNextAt =
    rawNextAt instanceof Date
      ? rawNextAt
      : typeof rawNextAt === "string"
        ? new Date(
            /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(rawNextAt)
              ? `${rawNextAt.replace(" ", "T")}Z`
              : rawNextAt
          )
        : null;
  if (rawNextAt != null && !parsedNextAt) {
    throw new Error("billing outbox due timestamp has an unexpected type");
  }
  if (parsedNextAt && !Number.isFinite(parsedNextAt.getTime())) {
    throw new Error("billing outbox due timestamp is invalid");
  }
  const candidates = parsedNextAt ? [parsedNextAt] : [];
  return candidates.length
    ? new Date(Math.min(...candidates.map(value => value.getTime())))
    : new Date(now.getTime() + 24 * 60 * 60_000);
}

export async function runBillingOutboxOnce(
  workspaceId: number,
  clientOverride?: MollieClient,
  tenantLease?: BillingTenantLease
): Promise<boolean> {
  if (!Number.isSafeInteger(workspaceId) || workspaceId <= 0) {
    throw new Error("invalid billing outbox workspace");
  }
  const mode = getConfiguredBillingMode();
  await releaseStaleBillingLeases(mode, workspaceId);
  const job = await claimBillingOutboxItem(mode, workspaceId);
  if (!job) return false;
  try {
    if (tenantLease) await assertBillingTenantLeaseOwned(tenantLease);
    await processBillingOutboxItem(job, clientOverride, tenantLease);
    if (tenantLease) await assertBillingTenantLeaseOwned(tenantLease);
    await completeBillingOutboxItem(job);
  } catch (error) {
    const retryCode = retryableErrorCode(error);
    if (retryCode) {
      if (job.attemptCount >= job.maxAttempts) {
        if (isCriticalContainmentJob(job)) {
          await rearmCriticalContainmentAfterExhaustion(
            job,
            `${retryCode}_exhausted`
          );
        } else {
          await containExhaustedEnsureAttempt(job, clientOverride);
          await failBillingOutboxItem(job, `${retryCode}_exhausted`);
        }
      } else {
        await rescheduleBillingOutboxItem(job, retryCode);
      }
    } else {
      const code =
        error instanceof PermanentOutboxError
          ? error.errorCode
          : error instanceof Error
            ? error.name
            : "UnknownError";
      await failBillingOutboxItem(job, code);
    }
  }
  return true;
}

export function isCriticalContainmentJob(job: BillingOutboxItem): boolean {
  if (
    job.eventType !== "cancel_subscription" &&
    job.eventType !== "cancel_payment"
  ) {
    return false;
  }
  if (
    !job.payload ||
    typeof job.payload !== "object" ||
    Array.isArray(job.payload)
  ) {
    return false;
  }
  const reason = (job.payload as Record<string, unknown>).reason;
  return [
    "billing_profile_revoked",
    "billing_profile_expired",
    "billing_profile_ineligible_after_provider_response",
    "checkout_provider_response_mismatch",
    "billing_execution_disabled",
  ].includes(String(reason));
}

async function rearmCriticalContainmentAfterExhaustion(
  job: ClaimedBillingOutboxItem,
  errorCode: string
): Promise<void> {
  const database = await getDatabaseOrThrow();
  await database.transaction(async tx => {
    const rows = await tx
      .select({ id: billingOutbox.id })
      .from(billingOutbox)
      .where(
        and(
          eq(billingOutbox.id, job.id),
          eq(billingOutbox.workspaceId, job.workspaceId),
          eq(billingOutbox.mode, job.mode),
          eq(billingOutbox.status, "processing"),
          eq(billingOutbox.leaseToken, job.leaseToken)
        )
      )
      .limit(1)
      .for("update");
    if (!rows[0]) throw new Error("critical containment lease was lost");
    await tx
      .update(billingOutbox)
      .set({
        status: "pending",
        attemptCount: 0,
        availableAt: new Date(Date.now() + 6 * 60 * 60_000),
        lockedAt: null,
        leaseToken: null,
        lastErrorCode: errorCode,
      })
      .where(
        and(
          eq(billingOutbox.id, job.id),
          eq(billingOutbox.workspaceId, job.workspaceId),
          eq(billingOutbox.mode, job.mode),
          eq(billingOutbox.status, "processing"),
          eq(billingOutbox.leaseToken, job.leaseToken)
        )
      );
    await tx
      .insert(billingOutbox)
      .values({
        workspaceId: job.workspaceId,
        mode: job.mode,
        eventType: "manual_review",
        deduplicationKey: `containment_retry_exhausted:${job.deliveryId}`,
        payload: {
          reason: "billing_profile_containment_retry_exhausted",
          sourceDeliveryId: job.deliveryId,
        },
        status: "pending",
      })
      .onDuplicateKeyUpdate({
        set: { deduplicationKey: sql`deduplication_key` },
      });
  });
}

function retryableErrorCode(error: unknown): string | null {
  if (error instanceof PermanentOutboxError) return null;
  if (error instanceof RetryableOutboxError) return error.retryCode;
  if (error instanceof MollieApiError) {
    return error.status === 0 ||
      error.status === 409 ||
      error.status === 429 ||
      error.status >= 500
      ? error.code
      : null;
  }
  // Unknown failures inside a claimed job are commonly database/transport
  // failures. Retry them under the bounded lease instead of abandoning a
  // provider operation whose outcome may be ambiguous.
  return "transient_worker_error";
}

async function runBillingOutboxSchedulerSafely(): Promise<void> {
  try {
    await runBillingOutboxSchedulerOnce();
  } catch (error) {
    safeLog("billing_outbox_dispatch_failed", {
      level: "error",
      errorCode: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

export async function processBillingOutboxItem(
  job: ClaimedBillingOutboxItem,
  clientOverride?: MollieClient,
  tenantLease?: BillingTenantLease
) {
  if (job.eventType === "ensure_subscription") {
    if (!tenantLease) {
      throw new PermanentOutboxError("subscription_scheduler_lease_required");
    }
    await ensureMollieSubscription(job, clientOverride, tenantLease);
    return;
  }
  if (job.eventType === "cancel_subscription") {
    await cancelMollieSubscription(job, clientOverride);
    return;
  }
  if (job.eventType === "cancel_payment") {
    await cancelContainedMolliePayment(job, clientOverride);
    return;
  }
  if (job.eventType === "send_portal_handoff") {
    await sendPaymentHandoff(job);
    return;
  }

  if (
    job.eventType === "payment_warning" ||
    job.eventType === "manual_review"
  ) {
    try {
      await deliverBillingNotification(job);
      return;
    } catch (error) {
      if (error instanceof BillingNotificationTransientError) {
        throw new RetryableOutboxError(error.message);
      }
      if (error instanceof BillingNotificationConfigurationError) {
        throw new PermanentOutboxError(error.message);
      }
      throw error;
    }
  }

  throw new PermanentOutboxError("unsupported_billing_outbox_event");
}

async function ensureMollieSubscription(
  job: ClaimedBillingOutboxItem,
  clientOverride: MollieClient | undefined,
  tenantLease: BillingTenantLease
) {
  const config = getMollieConfig();
  if (config.mode !== job.mode) {
    throw new PermanentOutboxError("billing_mode_mismatch");
  }
  const subscription = await getWorkspaceBillingSubscription(
    job.workspaceId,
    job.mode
  );
  const sourceIntentId = readSourceIntentId(job.payload);
  if (!sourceIntentId) {
    throw new PermanentOutboxError("source_intent_missing");
  }
  if (!subscription) {
    await recordUnknownSubscriptionOutcome(job, sourceIntentId);
    throw new PermanentOutboxError("billing_subscription_missing");
  }
  if (
    subscription.status !== "provisioning" ||
    subscription.sourceIntentId !== sourceIntentId
  ) {
    if (
      subscription.sourceIntentId === sourceIntentId &&
      subscription.mollieSubscriptionId
    ) {
      return;
    }
    await containRemoteSubscriptionsForIntent(
      job,
      subscription,
      sourceIntentId,
      clientOverride
    );
    return;
  }
  if (!subscription.paidThrough) {
    throw new PermanentOutboxError("missing_paid_through");
  }
  if (
    subscription.currency !== "EUR" ||
    subscription.interval !== "1 month" ||
    !subscription.entitlements ||
    typeof subscription.entitlements !== "object"
  ) {
    throw new PermanentOutboxError("invalid_subscription_snapshot");
  }
  await assertCancellationPrerequisiteCompleted(job);

  const client = clientOverride ?? new MollieClient(config);
  const database = await getDatabaseOrThrow();
  const sourceIntents = await database
    .select({
      paidAt: billingIntents.paidAt,
      status: billingIntents.status,
      billingProfileVersion: billingIntents.billingProfileVersion,
    })
    .from(billingIntents)
    .where(
      and(
        eq(billingIntents.intentId, subscription.sourceIntentId),
        eq(billingIntents.workspaceId, job.workspaceId),
        eq(billingIntents.mode, job.mode)
      )
    )
    .limit(1);
  const sourcePaidAt = sourceIntents[0]?.paidAt;
  if (!sourcePaidAt || sourceIntents[0]?.status !== "paid") {
    throw new PermanentOutboxError("source_payment_time_missing");
  }
  const sourceProfileVersion = sourceIntents[0].billingProfileVersion;
  const profiles = await database
    .select()
    .from(workspaceBillingProfiles)
    .where(eq(workspaceBillingProfiles.workspaceId, job.workspaceId))
    .limit(1);
  if (
    !isEligibleBillingProfileSnapshot(
      profiles[0],
      sourceProfileVersion,
      new Date()
    )
  ) {
    await containRemoteSubscriptionsForIntent(
      job,
      subscription,
      sourceIntentId,
      clientOverride
    );
    throw new PermanentOutboxError("billing_profile_ineligible");
  }
  const mandates = await client.listMandates(subscription.mollieCustomerId);
  const mandateWindowStart = sourcePaidAt.getTime() - 10 * 60 * 1_000;
  const eligibleMandates = mandates
    .filter(mandate => {
      if (mandate.mode !== config.mode) return false;
      if (mandate.method !== "directdebit") return false;
      if (subscription.mollieMandateId) {
        return mandate.id === subscription.mollieMandateId;
      }
      const createdAt = new Date(mandate.createdAt).getTime();
      return Number.isFinite(createdAt) && createdAt >= mandateWindowStart;
    })
    .sort(
      (left, right) =>
        new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
    );
  const validMandate = eligibleMandates.find(
    mandate => mandate.status === "valid"
  );
  if (!validMandate) {
    const pending = eligibleMandates.some(
      mandate => mandate.status === "pending"
    );
    if (pending) {
      throw new RetryableOutboxError("mandate_pending");
    }
    throw new PermanentOutboxError("valid_directdebit_mandate_missing");
  }

  const existingRemote = collectingSubscriptionsForIntent(
    await client.listCustomerSubscriptions(subscription.mollieCustomerId),
    subscription.sourceIntentId
  );
  if (existingRemote.length > 1) {
    for (const duplicate of existingRemote) {
      await recordRemoteSubscriptionContainment(job, subscription, duplicate);
    }
    throw new PermanentOutboxError("duplicate_remote_subscriptions");
  }

  const startDate = formatDateOnly(subscription.paidThrough);
  let remote = existingRemote[0];
  if (!remote) {
    if (config.mode === "live" && !config.liveBillingEnabled) {
      throw new RetryableOutboxError("live_billing_disabled");
    }
    const operation = await reserveSubscriptionProviderOperation({
      job,
      subscription,
      billingProfileVersion: sourceProfileVersion,
    });
    if (!operation) {
      throw new RetryableOutboxError("subscription_create_reconciliation_only");
    }
    if (!(await markSubscriptionProviderOperationStarted(operation))) {
      throw new RetryableOutboxError("subscription_create_fence_lost");
    }
    try {
      if (tenantLease) await assertBillingTenantLeaseOwned(tenantLease);
      remote = await client.createSubscription({
        customerId: subscription.mollieCustomerId,
        mandateId: validMandate.id,
        amount: {
          currency: subscription.currency,
          value: subscription.recurringAmount,
        },
        interval: subscription.interval,
        startDate,
        description: `${subscription.mollieDescription} ${subscription.sourceIntentId.slice(0, 8)}`,
        intentId: subscription.sourceIntentId,
        webhookUrl: config.paymentWebhookUrl,
        idempotencyKey: subscription.idempotencyKey,
      });
    } catch (error) {
      await finalizeSubscriptionProviderOperation(
        operation,
        error instanceof MollieApiError &&
          error.status >= 400 &&
          error.status < 500 &&
          ![408, 409, 425, 429].includes(error.status)
          ? "known_failed"
          : "ambiguous",
        undefined,
        { job, subscription }
      );
      throw error;
    }
    const finalized = await finalizeSubscriptionProviderOperation(
      operation,
      "succeeded",
      remote.id,
      { job, subscription }
    );
    if (!finalized.recorded) {
      throw new PermanentOutboxError("subscription_provider_result_fence_lost");
    }
    if (!finalized.authorized) {
      throw new PermanentOutboxError(
        "subscription_provider_result_authorization_revoked"
      );
    }
  }
  if (remote.status === "pending") {
    throw new RetryableOutboxError("subscription_pending");
  }
  try {
    validateRemoteSubscription(remote, {
      mode: config.mode,
      amount: subscription.recurringAmount,
      interval: subscription.interval,
      intentId: subscription.sourceIntentId,
      mandateId: validMandate.id,
      startDate,
    });
  } catch (error) {
    await recordRemoteSubscriptionContainment(job, subscription, remote);
    throw error;
  }

  await database.transaction(async tx => {
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
    const currentProfiles = await tx
      .select()
      .from(workspaceBillingProfiles)
      .where(eq(workspaceBillingProfiles.workspaceId, job.workspaceId))
      .limit(1)
      .for("update");
    const currentIntents = await tx
      .select({
        status: billingIntents.status,
        billingProfileVersion: billingIntents.billingProfileVersion,
        authorizationEpoch: billingIntents.authorizationEpoch,
      })
      .from(billingIntents)
      .where(
        and(
          eq(billingIntents.intentId, subscription.sourceIntentId),
          eq(billingIntents.workspaceId, job.workspaceId),
          eq(billingIntents.mode, job.mode)
        )
      )
      .limit(1)
      .for("update");
    const schedulerLease = tenantLease
      ? await tx
          .select({ workspaceId: billingSchedulerTenants.workspaceId })
          .from(billingSchedulerTenants)
          .where(
            and(
              eq(billingSchedulerTenants.workspaceId, tenantLease.workspaceId),
              eq(billingSchedulerTenants.mode, tenantLease.mode),
              eq(billingSchedulerTenants.kind, tenantLease.kind),
              eq(billingSchedulerTenants.enabled, true),
              eq(
                billingSchedulerTenants.executionEpoch,
                tenantLease.executionEpoch
              ),
              eq(billingSchedulerTenants.leaseToken, tenantLease.leaseToken),
              gt(billingSchedulerTenants.leaseUntil, new Date())
            )
          )
          .limit(1)
          .for("update")
      : [{ workspaceId: job.workspaceId }];
    const current = await tx
      .select()
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.workspaceId, job.workspaceId),
          eq(billingSubscriptions.mode, job.mode)
        )
      )
      .limit(1)
      .for("update");
    const leases = await tx
      .select({ id: billingOutbox.id })
      .from(billingOutbox)
      .where(
        and(
          eq(billingOutbox.id, job.id),
          eq(billingOutbox.workspaceId, job.workspaceId),
          eq(billingOutbox.mode, job.mode),
          eq(billingOutbox.status, "processing"),
          eq(billingOutbox.leaseToken, job.leaseToken)
        )
      )
      .limit(1)
      .for("update");
    const alreadyLinked =
      current[0]?.status === "active" &&
      current[0].sourceIntentId === subscription.sourceIntentId &&
      current[0].mollieSubscriptionId === remote.id;
    if (alreadyLinked) return;
    if (!schedulerLease[0] || !leases[0]) {
      // A stale worker may observe a result already being applied by the new
      // owner. It must not mutate domain state or enqueue cancellation.
      return;
    }
    const profileStillEligible =
      controls[0]?.commercialEnabled &&
      controls[0].authorizationEpoch ===
        currentIntents[0]?.authorizationEpoch &&
      Boolean(schedulerLease[0]) &&
      currentIntents[0]?.status === "paid" &&
      isEligibleBillingProfileSnapshot(
        currentProfiles[0],
        currentIntents[0].billingProfileVersion,
        new Date()
      );
    if (!profileStillEligible) {
      await tx
        .insert(billingOutbox)
        .values({
          workspaceId: job.workspaceId,
          mode: job.mode,
          eventType: "cancel_subscription",
          deduplicationKey: `profile_containment_cancel:${remote.id}`,
          payload: {
            reason: "billing_profile_ineligible_after_provider_response",
            expectedSourceIntentId: subscription.sourceIntentId,
            targetCustomerId: subscription.mollieCustomerId,
            targetSubscriptionId: remote.id,
          },
          status: "pending",
        })
        .onDuplicateKeyUpdate({
          set: { deduplicationKey: sql`deduplication_key` },
        });
      return;
    }
    const mayStillBeLinkedByCurrentLease =
      current[0]?.status === "provisioning" &&
      current[0].sourceIntentId === subscription.sourceIntentId;
    if (!mayStillBeLinkedByCurrentLease) {
      await tx
        .insert(billingOutbox)
        .values({
          workspaceId: job.workspaceId,
          mode: job.mode,
          eventType: "cancel_subscription",
          deduplicationKey: `orphan_subscription_cancel:${remote.id}`,
          payload: {
            reason: "provisioning_state_changed",
            expectedSourceIntentId: subscription.sourceIntentId,
            targetCustomerId: subscription.mollieCustomerId,
            targetSubscriptionId: remote.id,
          },
          status: "pending",
        })
        .onDuplicateKeyUpdate({
          set: { deduplicationKey: sql`deduplication_key` },
        });
      return;
    }
    await tx
      .update(billingSubscriptions)
      .set({
        mollieSubscriptionId: remote.id,
        mollieMandateId: validMandate.id,
        status: "active",
        nextPaymentDate: parseDateOnly(
          remote.nextPaymentDate ?? remote.startDate
        ),
      })
      .where(
        and(
          eq(billingSubscriptions.workspaceId, job.workspaceId),
          eq(billingSubscriptions.mode, job.mode),
          eq(billingSubscriptions.status, "provisioning"),
          eq(billingSubscriptions.sourceIntentId, subscription.sourceIntentId)
        )
      );
    await tx
      .insert(workspaceEntitlements)
      .values({
        workspaceId: job.workspaceId,
        mode: job.mode,
        planCode: subscription.planCode,
        status: "active",
        quota: subscription.entitlements,
        validUntil: subscription.paidThrough,
        sourceSubscriptionId: remote.id,
      })
      .onDuplicateKeyUpdate({
        set: {
          planCode: subscription.planCode,
          status: "active",
          quota: subscription.entitlements,
          validUntil: subscription.paidThrough,
          sourceSubscriptionId: remote.id,
        },
      });
  });
}

type SubscriptionProviderOperation = {
  operationId: string;
  leaseToken: string;
  authorizationEpoch: number;
  workspaceId: number;
  mode: MollieMode;
  intentId: string;
  customerId: string;
};

export async function reserveSubscriptionProviderOperation(input: {
  job: ClaimedBillingOutboxItem;
  subscription: BillingSubscription;
  billingProfileVersion: number;
}): Promise<SubscriptionProviderOperation | null> {
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const now = new Date();
    const controls = await tx
      .select({
        commercialEnabled: billingExecutionControls.commercialEnabled,
        authorizationEpoch: billingExecutionControls.authorizationEpoch,
      })
      .from(billingExecutionControls)
      .where(
        and(
          eq(billingExecutionControls.workspaceId, input.job.workspaceId),
          eq(billingExecutionControls.mode, input.job.mode)
        )
      )
      .limit(1)
      .for("update");
    if (!controls[0]?.commercialEnabled) return null;
    const authorizationEpoch = controls[0].authorizationEpoch;
    const leaseToken = randomUUID();
    const credentialGenerationId =
      process.env.MOLLIE_CREDENTIAL_GENERATION_ID?.trim() ||
      (process.env.NODE_ENV === "test" ? "test-generation" : "");
    if (!credentialGenerationId) {
      throw new PermanentOutboxError("mollie_credential_generation_missing");
    }
    const requestFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          workspaceId: input.job.workspaceId,
          mode: input.job.mode,
          sourceIntentId: input.subscription.sourceIntentId,
          amount: input.subscription.recurringAmount,
          currency: input.subscription.currency,
          interval: input.subscription.interval,
          paidThrough: input.subscription.paidThrough?.toISOString(),
        })
      )
      .digest("hex");
    const idempotencyKeyHash = createHash("sha256")
      .update(input.subscription.idempotencyKey)
      .digest("hex");
    const existing = await tx
      .select({
        operationId: billingProviderOperations.operationId,
        state: billingProviderOperations.state,
        firstStartedAt: billingProviderOperations.firstStartedAt,
        leaseUntil: billingProviderOperations.leaseUntil,
        requestFingerprint: billingProviderOperations.requestFingerprint,
        billingProfileVersion: billingProviderOperations.billingProfileVersion,
        authorizationEpoch: billingProviderOperations.authorizationEpoch,
        credentialGenerationId:
          billingProviderOperations.credentialGenerationId,
        idempotencyKeyHash: billingProviderOperations.idempotencyKeyHash,
      })
      .from(billingProviderOperations)
      .where(
        and(
          eq(billingProviderOperations.mode, input.job.mode),
          eq(billingProviderOperations.operationType, "create_subscription"),
          eq(
            billingProviderOperations.operationKey,
            input.subscription.sourceIntentId
          )
        )
      )
      .limit(1)
      .for("update");
    if (existing[0]) {
      const operation = existing[0];
      const safelyResumable =
        !operation.firstStartedAt &&
        (operation.state === "known_failed" ||
          (operation.state === "reserved" && operation.leaseUntil <= now)) &&
        operation.requestFingerprint === requestFingerprint &&
        operation.billingProfileVersion === input.billingProfileVersion &&
        operation.authorizationEpoch === authorizationEpoch &&
        operation.credentialGenerationId === credentialGenerationId &&
        operation.idempotencyKeyHash === idempotencyKeyHash;
      if (!safelyResumable) return null;
      const resumed = await tx
        .update(billingProviderOperations)
        .set({
          state: "reserved",
          leaseToken,
          leaseUntil: new Date(now.getTime() + 60_000),
          retryBefore: null,
          resolutionDueAt: new Date(now.getTime() + 5 * 60_000),
          completedAt: null,
        })
        .where(
          and(
            eq(billingProviderOperations.operationId, operation.operationId),
            eq(billingProviderOperations.state, operation.state),
            isNull(billingProviderOperations.firstStartedAt),
            ...(operation.state === "reserved"
              ? [lte(billingProviderOperations.leaseUntil, now)]
              : [])
          )
        );
      if (outboxAffectedRows(resumed) !== 1) return null;
      return {
        operationId: operation.operationId,
        leaseToken,
        authorizationEpoch,
        workspaceId: input.job.workspaceId,
        mode: input.job.mode,
        intentId: input.subscription.sourceIntentId,
        customerId: input.subscription.mollieCustomerId,
      };
    }
    const operationId = randomUUID();
    await tx.insert(billingProviderOperations).values({
      operationId,
      workspaceId: input.job.workspaceId,
      mode: input.job.mode,
      operationType: "create_subscription",
      operationKey: input.subscription.sourceIntentId,
      intentId: input.subscription.sourceIntentId,
      providerCustomerId: input.subscription.mollieCustomerId,
      billingProfileVersion: input.billingProfileVersion,
      authorizationEpoch,
      state: "reserved",
      requestFingerprint,
      idempotencyKeyHash,
      credentialGenerationId,
      leaseToken,
      leaseUntil: new Date(now.getTime() + 60_000),
      resolutionDueAt: new Date(now.getTime() + 5 * 60_000),
    });
    return {
      operationId,
      leaseToken,
      authorizationEpoch,
      workspaceId: input.job.workspaceId,
      mode: input.job.mode,
      intentId: input.subscription.sourceIntentId,
      customerId: input.subscription.mollieCustomerId,
    };
  });
}

export async function markSubscriptionProviderOperationStarted(
  operation: SubscriptionProviderOperation
): Promise<boolean> {
  const database = await getDatabaseOrThrow();
  const now = new Date();
  return database.transaction(async tx => {
    const controls = await tx
      .select({
        commercialEnabled: billingExecutionControls.commercialEnabled,
        authorizationEpoch: billingExecutionControls.authorizationEpoch,
      })
      .from(billingExecutionControls)
      .where(
        and(
          eq(billingExecutionControls.workspaceId, operation.workspaceId),
          eq(billingExecutionControls.mode, operation.mode)
        )
      )
      .limit(1)
      .for("update");
    if (
      !controls[0]?.commercialEnabled ||
      controls[0].authorizationEpoch !== operation.authorizationEpoch
    ) {
      return false;
    }
    const result = await tx
      .update(billingProviderOperations)
      .set({
        state: "transport_started",
        firstStartedAt: now,
        retryBefore: new Date(now.getTime() + 55 * 60_000),
        resolutionDueAt: new Date(now.getTime() + 5 * 60_000),
        attemptCount: sql`${billingProviderOperations.attemptCount} + 1`,
      })
      .where(
        and(
          eq(billingProviderOperations.operationId, operation.operationId),
          eq(billingProviderOperations.workspaceId, operation.workspaceId),
          eq(billingProviderOperations.mode, operation.mode),
          eq(
            billingProviderOperations.authorizationEpoch,
            operation.authorizationEpoch
          ),
          eq(billingProviderOperations.leaseToken, operation.leaseToken),
          eq(billingProviderOperations.state, "reserved"),
          gt(billingProviderOperations.leaseUntil, now)
        )
      );
    return outboxAffectedRows(result) === 1;
  });
}

export async function finalizeSubscriptionProviderOperation(
  operation: SubscriptionProviderOperation,
  outcome: "succeeded" | "known_failed" | "ambiguous",
  providerResourceId: string | undefined,
  containment: {
    job: BillingOutboxItem;
    subscription: BillingSubscription;
  }
): Promise<{
  recorded: boolean;
  authorized: boolean;
  revokedAuthorizationEpoch: number | null;
}> {
  if (
    containment.job.workspaceId !== operation.workspaceId ||
    containment.job.mode !== operation.mode ||
    containment.subscription.workspaceId !== operation.workspaceId ||
    containment.subscription.mode !== operation.mode ||
    containment.subscription.sourceIntentId !== operation.intentId ||
    containment.subscription.mollieCustomerId !== operation.customerId
  ) {
    throw new PermanentOutboxError(
      "subscription_provider_containment_scope_mismatch"
    );
  }
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
          eq(billingExecutionControls.workspaceId, operation.workspaceId),
          eq(billingExecutionControls.mode, operation.mode)
        )
      )
      .limit(1)
      .for("update");
    const authorized = Boolean(
      controls[0]?.commercialEnabled &&
      controls[0].authorizationEpoch === operation.authorizationEpoch
    );
    const result = await tx
      .update(billingProviderOperations)
      .set({
        state: authorized
          ? outcome
          : providerResourceId
            ? "contained"
            : "reconciliation_only",
        providerResourceId: providerResourceId ?? null,
        completedAt:
          outcome === "succeeded" || outcome === "known_failed"
            ? new Date()
            : null,
        resolutionDueAt: new Date(),
      })
      .where(
        and(
          eq(billingProviderOperations.operationId, operation.operationId),
          eq(billingProviderOperations.workspaceId, operation.workspaceId),
          eq(billingProviderOperations.mode, operation.mode),
          eq(
            billingProviderOperations.authorizationEpoch,
            operation.authorizationEpoch
          ),
          eq(billingProviderOperations.leaseToken, operation.leaseToken),
          eq(billingProviderOperations.state, "transport_started")
        )
      );
    const recorded = outboxAffectedRows(result) === 1;
    if (recorded && !authorized) {
      if (providerResourceId) {
        const containmentKey = hashCanonicalSnapshot({
          workspaceId: operation.workspaceId,
          mode: operation.mode,
          intentId: containment.subscription.sourceIntentId,
          customerId: containment.subscription.mollieCustomerId,
          subscriptionId: providerResourceId,
          authorizationEpoch: operation.authorizationEpoch,
        });
        await tx
          .insert(billingOutbox)
          .values({
            workspaceId: operation.workspaceId,
            mode: operation.mode,
            eventType: "cancel_subscription",
            deduplicationKey: `execution_disabled_subscription:${containmentKey}`,
            payload: {
              reason: "billing_execution_disabled",
              revokedAuthorizationEpoch: operation.authorizationEpoch,
              expectedSourceIntentId: containment.subscription.sourceIntentId,
              targetCustomerId: containment.subscription.mollieCustomerId,
              targetSubscriptionId: providerResourceId,
            },
            status: "pending",
          })
          .onDuplicateKeyUpdate({
            set: { deduplicationKey: sql`deduplication_key` },
          });
      } else if (outcome === "ambiguous") {
        await tx
          .insert(billingOutbox)
          .values({
            workspaceId: operation.workspaceId,
            mode: operation.mode,
            eventType: "cancel_subscription",
            deduplicationKey: `subscription_ambiguous_reconcile:${operation.operationId}`,
            payload: {
              reason: "billing_execution_disabled",
              revokedAuthorizationEpoch: operation.authorizationEpoch,
              expectedSourceIntentId: containment.subscription.sourceIntentId,
              targetCustomerId: containment.subscription.mollieCustomerId,
              targetSubscriptionId: null,
              providerOperationId: operation.operationId,
            },
            status: "pending",
          })
          .onDuplicateKeyUpdate({
            set: { deduplicationKey: sql`deduplication_key` },
          });
        await tx
          .insert(billingOutbox)
          .values({
            workspaceId: operation.workspaceId,
            mode: operation.mode,
            eventType: "manual_review",
            deduplicationKey: `subscription_ambiguous_after_disable:${operation.operationId}`,
            payload: {
              reason: "subscription_provider_ambiguous_after_disable",
              intentId: containment.subscription.sourceIntentId,
            },
            status: "pending",
          })
          .onDuplicateKeyUpdate({
            set: { deduplicationKey: sql`deduplication_key` },
          });
      }
    }
    return {
      recorded,
      authorized: recorded && authorized,
      revokedAuthorizationEpoch:
        recorded && !authorized ? operation.authorizationEpoch : null,
    };
  });
}

function outboxAffectedRows(result: unknown): number {
  const metadata: unknown = Array.isArray(result)
    ? (result as unknown[])[0]
    : result;
  return Number(
    (metadata as { affectedRows?: number } | undefined)?.affectedRows ?? 0
  );
}

function isEligibleBillingProfileSnapshot(
  profile: typeof workspaceBillingProfiles.$inferSelect | undefined,
  expectedVersion: number | null,
  now: Date
): boolean {
  return Boolean(
    profile &&
    expectedVersion &&
    profile.eligibilityVersion === expectedVersion &&
    profile.verificationStatus === "verified" &&
    profile.countryCode === "BE" &&
    profile.customerType === "consumer" &&
    !profile.peppolReady &&
    profile.verifiedAt &&
    profile.verifiedAt <= now &&
    profile.verificationExpiresAt &&
    profile.verificationExpiresAt > now &&
    !profile.revokedAt
  );
}

async function cancelMollieSubscription(
  job: ClaimedBillingOutboxItem,
  clientOverride?: MollieClient
) {
  const target = readCancellationTarget(job.payload);
  if (!target) {
    await reconcileExecutionDisabledSubscription(job, clientOverride);
    return;
  }
  const config = getMollieConfig();
  if (config.mode !== job.mode) {
    throw new PermanentOutboxError("billing_mode_mismatch");
  }
  if (!(await hasExactSubscriptionCancellationBinding(job, target))) {
    await recordSubscriptionCancellationReview(
      job,
      "subscription_cancellation_local_scope_mismatch"
    );
    throw new PermanentOutboxError(
      "subscription_cancellation_local_scope_mismatch"
    );
  }
  const client = clientOverride ?? new MollieClient(config);
  if (isContainmentCancellation(job.payload)) {
    const result = await cancelContainedMollieSubscription(job, target, client);
    if (result === "skipped_current") return;
    await rearmFailedEnsureJobsWaitingForCancellation(job);
    return;
  }
  let remote: MollieSubscription | null = null;
  try {
    remote = await client.getSubscription(
      target.customerId,
      target.subscriptionId
    );
  } catch (error) {
    if (error instanceof MollieApiError && error.status === 404) return;
    throw error;
  }
  if (
    remote.id !== target.subscriptionId ||
    remote.mode !== job.mode ||
    metadataIntentId(remote.metadata) !== target.sourceIntentId
  ) {
    await recordSubscriptionCancellationReview(
      job,
      "subscription_cancellation_provider_scope_mismatch"
    );
    throw new PermanentOutboxError(
      "subscription_cancellation_provider_scope_mismatch"
    );
  }
  try {
    await client.cancelSubscription(target.customerId, target.subscriptionId);
  } catch (error) {
    if (!(error instanceof MollieApiError) || error.status !== 404) throw error;
  }
  await markWorkspaceSubscriptionStoppedIfMatches(
    job.workspaceId,
    job.mode,
    target.subscriptionId
  );
  await rearmFailedEnsureJobsWaitingForCancellation(job);
}

export async function reconcileExecutionDisabledSubscription(
  job: ClaimedBillingOutboxItem,
  clientOverride?: MollieClient
): Promise<void> {
  if (
    !job.payload ||
    typeof job.payload !== "object" ||
    Array.isArray(job.payload)
  ) {
    throw new PermanentOutboxError(
      "invalid_subscription_reconciliation_target"
    );
  }
  const payload = job.payload as Record<string, unknown>;
  const operationId = payload.providerOperationId;
  const customerId = payload.targetCustomerId;
  const sourceIntentId =
    payload.expectedSourceIntentId ?? payload.sourceIntentId;
  const revokedAuthorizationEpoch = readExecutionDisabledEpoch(job.payload);
  if (
    typeof operationId !== "string" ||
    typeof customerId !== "string" ||
    typeof sourceIntentId !== "string" ||
    revokedAuthorizationEpoch === null
  ) {
    throw new PermanentOutboxError(
      "invalid_subscription_reconciliation_target"
    );
  }
  const config = getMollieConfig();
  if (config.mode !== job.mode) {
    throw new PermanentOutboxError("billing_mode_mismatch");
  }
  const database = await getDatabaseOrThrow();
  const operations = await database
    .select({
      operationId: billingProviderOperations.operationId,
      billingProfileVersion: billingProviderOperations.billingProfileVersion,
      credentialGenerationId: billingProviderOperations.credentialGenerationId,
    })
    .from(billingProviderOperations)
    .where(
      and(
        eq(billingProviderOperations.operationId, operationId),
        eq(billingProviderOperations.workspaceId, job.workspaceId),
        eq(billingProviderOperations.mode, job.mode),
        eq(billingProviderOperations.operationType, "create_subscription"),
        eq(billingProviderOperations.intentId, sourceIntentId),
        eq(billingProviderOperations.providerCustomerId, customerId),
        eq(
          billingProviderOperations.authorizationEpoch,
          revokedAuthorizationEpoch
        ),
        inArray(billingProviderOperations.state, [
          "transport_started",
          "ambiguous",
          "reconciliation_only",
        ])
      )
    )
    .limit(1);
  if (!operations[0]) {
    throw new PermanentOutboxError(
      "subscription_reconciliation_scope_mismatch"
    );
  }
  const client = clientOverride ?? new MollieClient(config);
  const matches = collectingSubscriptionsForIntent(
    await client.listCustomerSubscriptions(customerId),
    sourceIntentId
  ).filter(remote => remote.mode === job.mode);
  if (matches.length === 0) {
    throw new RetryableOutboxError("subscription_reconciliation_not_visible");
  }
  const now = new Date();
  await database.transaction(async tx => {
    const updated = await tx
      .update(billingProviderOperations)
      .set({
        state: "contained",
        providerResourceId: matches.length === 1 ? matches[0]!.id : null,
        completedAt: now,
        resolutionDueAt: now,
      })
      .where(
        and(
          eq(billingProviderOperations.operationId, operationId),
          eq(billingProviderOperations.workspaceId, job.workspaceId),
          eq(billingProviderOperations.mode, job.mode),
          inArray(billingProviderOperations.state, [
            "transport_started",
            "ambiguous",
            "reconciliation_only",
          ])
        )
      );
    if (outboxAffectedRows(updated) !== 1) {
      throw new Error("subscription reconciliation fence was lost");
    }
    for (const remote of matches) {
      const containmentFingerprint = hashCanonicalSnapshot({
        operationId,
        workspaceId: job.workspaceId,
        mode: job.mode,
        sourceIntentId,
        customerId,
        subscriptionId: remote.id,
        revokedAuthorizationEpoch,
      });
      await tx
        .insert(billingProviderOperations)
        .values({
          operationId: randomUUID(),
          workspaceId: job.workspaceId,
          mode: job.mode,
          operationType: "cancel_subscription",
          operationKey: `execution-disabled:${operationId}:${remote.id}`,
          intentId: sourceIntentId,
          billingProfileVersion: operations[0].billingProfileVersion,
          authorizationEpoch: revokedAuthorizationEpoch,
          state: "contained",
          requestFingerprint: containmentFingerprint,
          idempotencyKeyHash: containmentFingerprint,
          credentialGenerationId: operations[0].credentialGenerationId,
          providerResourceId: remote.id,
          providerCustomerId: customerId,
          leaseToken: randomUUID(),
          leaseUntil: now,
          resolutionDueAt: now,
          completedAt: now,
        })
        .onDuplicateKeyUpdate({
          set: { operationKey: sql`operation_key` },
        });
      await tx
        .insert(billingOutbox)
        .values({
          workspaceId: job.workspaceId,
          mode: job.mode,
          eventType: "cancel_subscription",
          deduplicationKey: `execution_disabled_subscription:${remote.id}`,
          payload: {
            reason: "billing_execution_disabled",
            revokedAuthorizationEpoch,
            expectedSourceIntentId: sourceIntentId,
            targetCustomerId: customerId,
            targetSubscriptionId: remote.id,
          },
          status: "pending",
        })
        .onDuplicateKeyUpdate({
          set: { deduplicationKey: sql`deduplication_key` },
        });
    }
    if (matches.length > 1) {
      await tx
        .insert(billingOutbox)
        .values({
          workspaceId: job.workspaceId,
          mode: job.mode,
          eventType: "manual_review",
          deduplicationKey: `subscription_reconciliation_multiple:${operationId}`,
          payload: {
            reason: "subscription_provider_ambiguous_after_disable",
            intentId: sourceIntentId,
          },
          status: "pending",
        })
        .onDuplicateKeyUpdate({
          set: { deduplicationKey: sql`deduplication_key` },
        });
    }
  });
}

export async function cancelContainedMolliePayment(
  job: ClaimedBillingOutboxItem,
  clientOverride?: MollieClient
): Promise<void> {
  const record =
    job.payload &&
    typeof job.payload === "object" &&
    !Array.isArray(job.payload)
      ? (job.payload as Record<string, unknown>)
      : null;
  const paymentId = record?.targetPaymentId;
  const intentId = record?.intentId;
  const payloadCustomerId = record?.targetCustomerId;
  if (paymentId === null) {
    await reconcileExecutionDisabledPayment(job, clientOverride);
    return;
  }
  if (
    typeof paymentId !== "string" ||
    typeof intentId !== "string" ||
    (payloadCustomerId !== undefined && typeof payloadCustomerId !== "string")
  ) {
    throw new PermanentOutboxError("invalid_payment_cancellation_target");
  }
  const config = getMollieConfig();
  if (config.mode !== job.mode) {
    throw new PermanentOutboxError("billing_mode_mismatch");
  }
  const database = await getDatabaseOrThrow();
  const customerRows = await database
    .select({ mollieCustomerId: billingCustomers.mollieCustomerId })
    .from(billingCustomers)
    .where(
      and(
        eq(billingCustomers.workspaceId, job.workspaceId),
        eq(billingCustomers.mode, job.mode)
      )
    )
    .limit(1);
  const customerId = customerRows[0]?.mollieCustomerId;
  if (!customerId || (payloadCustomerId && payloadCustomerId !== customerId)) {
    throw new PermanentOutboxError(
      "payment_cancellation_customer_scope_mismatch"
    );
  }
  const localTargets = await database
    .select({ molliePaymentId: billingIntents.molliePaymentId })
    .from(billingIntents)
    .where(
      and(
        eq(billingIntents.intentId, intentId),
        eq(billingIntents.workspaceId, job.workspaceId),
        eq(billingIntents.mode, job.mode),
        eq(billingIntents.molliePaymentId, paymentId),
        inArray(billingIntents.status, [
          "contained",
          "canceled",
          "expired",
          "mismatch",
        ])
      )
    )
    .limit(1);
  if (!localTargets[0]) {
    const revokedAuthorizationEpoch = readExecutionDisabledEpoch(job.payload);
    const operationTargets = await database
      .select({ operationId: billingProviderOperations.operationId })
      .from(billingProviderOperations)
      .where(
        and(
          eq(billingProviderOperations.workspaceId, job.workspaceId),
          eq(billingProviderOperations.mode, job.mode),
          inArray(billingProviderOperations.operationType, [
            "create_payment",
            "cancel_payment",
          ]),
          eq(billingProviderOperations.intentId, intentId),
          eq(billingProviderOperations.providerResourceId, paymentId),
          eq(billingProviderOperations.providerCustomerId, customerId),
          eq(billingProviderOperations.state, "contained"),
          ...(revokedAuthorizationEpoch !== null
            ? [
                eq(
                  billingProviderOperations.authorizationEpoch,
                  revokedAuthorizationEpoch
                ),
              ]
            : [])
        )
      )
      .limit(1);
    if (!operationTargets[0]) {
      throw new PermanentOutboxError(
        "payment_cancellation_local_scope_mismatch"
      );
    }
  }
  const client = clientOverride ?? new MollieClient(config);
  let payment;
  try {
    payment = await client.getPayment(paymentId);
  } catch (error) {
    if (error instanceof MollieApiError && error.status === 404) return;
    throw error;
  }
  if (
    payment.id !== paymentId ||
    payment.mode !== job.mode ||
    payment.customerId !== customerId ||
    metadataIntentId(payment.metadata) !== intentId
  ) {
    throw new PermanentOutboxError("payment_cancellation_target_mismatch");
  }
  if (["canceled", "expired", "failed"].includes(payment.status)) return;
  if (payment.status !== "open") {
    throw new PermanentOutboxError(
      "payment_cancellation_requires_manual_review"
    );
  }
  try {
    await client.cancelPayment(paymentId);
  } catch (error) {
    if (!(error instanceof MollieApiError) || error.status !== 404) throw error;
  }
}

export async function reconcileExecutionDisabledPayment(
  job: ClaimedBillingOutboxItem,
  clientOverride?: MollieClient
): Promise<void> {
  if (
    !job.payload ||
    typeof job.payload !== "object" ||
    Array.isArray(job.payload)
  ) {
    throw new PermanentOutboxError("invalid_payment_reconciliation_target");
  }
  const payload = job.payload as Record<string, unknown>;
  const operationId = payload.providerOperationId;
  const customerId = payload.targetCustomerId;
  const intentId = payload.intentId;
  const revokedAuthorizationEpoch = readPaymentReconciliationEpoch(job.payload);
  if (
    typeof operationId !== "string" ||
    typeof customerId !== "string" ||
    typeof intentId !== "string" ||
    revokedAuthorizationEpoch === null
  ) {
    throw new PermanentOutboxError("invalid_payment_reconciliation_target");
  }
  const config = getMollieConfig();
  if (config.mode !== job.mode) {
    throw new PermanentOutboxError("billing_mode_mismatch");
  }
  const database = await getDatabaseOrThrow();
  const operations = await database
    .select({
      operationId: billingProviderOperations.operationId,
      billingProfileVersion: billingProviderOperations.billingProfileVersion,
      credentialGenerationId: billingProviderOperations.credentialGenerationId,
      firstStartedAt: billingProviderOperations.firstStartedAt,
    })
    .from(billingProviderOperations)
    .where(
      and(
        eq(billingProviderOperations.operationId, operationId),
        eq(billingProviderOperations.workspaceId, job.workspaceId),
        eq(billingProviderOperations.mode, job.mode),
        eq(billingProviderOperations.operationType, "create_payment"),
        eq(billingProviderOperations.intentId, intentId),
        eq(billingProviderOperations.providerCustomerId, customerId),
        eq(
          billingProviderOperations.authorizationEpoch,
          revokedAuthorizationEpoch
        ),
        inArray(billingProviderOperations.state, [
          "transport_started",
          "ambiguous",
          "reconciliation_only",
        ])
      )
    )
    .limit(1);
  if (!operations[0]) {
    throw new PermanentOutboxError("payment_reconciliation_scope_mismatch");
  }
  const intents = await database
    .select({
      expectedAmount: billingIntents.expectedAmount,
      currency: billingIntents.currency,
      mollieDescription: billingIntents.mollieDescription,
    })
    .from(billingIntents)
    .where(
      and(
        eq(billingIntents.intentId, intentId),
        eq(billingIntents.workspaceId, job.workspaceId),
        eq(billingIntents.mode, job.mode),
        eq(billingIntents.authorizationEpoch, revokedAuthorizationEpoch)
      )
    )
    .limit(1);
  const intent = intents[0];
  if (!intent || !operations[0].firstStartedAt) {
    throw new PermanentOutboxError("payment_reconciliation_scope_mismatch");
  }
  const earliestProviderCreatedAt =
    operations[0].firstStartedAt.getTime() - 5 * 60_000;
  const client = clientOverride ?? new MollieClient(config);
  const matches = (await client.listCustomerPayments(customerId)).filter(
    payment => {
      const providerCreatedAt = Date.parse(payment.createdAt);
      return (
        payment.mode === job.mode &&
        payment.customerId === customerId &&
        !payment.subscriptionId &&
        metadataIntentId(payment.metadata) === intentId &&
        payment.amount.currency === intent.currency &&
        payment.amount.value === String(intent.expectedAmount) &&
        payment.description === intent.mollieDescription &&
        Number.isFinite(providerCreatedAt) &&
        providerCreatedAt >= earliestProviderCreatedAt
      );
    }
  );
  if (matches.length === 0) {
    throw new RetryableOutboxError("payment_reconciliation_not_visible");
  }
  const now = new Date();
  await database.transaction(async tx => {
    const updated = await tx
      .update(billingProviderOperations)
      .set({
        state: "contained",
        providerResourceId: matches.length === 1 ? matches[0]!.id : null,
        completedAt: now,
        resolutionDueAt: now,
      })
      .where(
        and(
          eq(billingProviderOperations.operationId, operationId),
          eq(billingProviderOperations.workspaceId, job.workspaceId),
          eq(billingProviderOperations.mode, job.mode),
          inArray(billingProviderOperations.state, [
            "transport_started",
            "ambiguous",
            "reconciliation_only",
          ])
        )
      );
    if (outboxAffectedRows(updated) !== 1) {
      throw new Error("payment reconciliation fence was lost");
    }
    for (const payment of matches) {
      const containmentFingerprint = hashCanonicalSnapshot({
        operationId,
        workspaceId: job.workspaceId,
        mode: job.mode,
        intentId,
        customerId,
        paymentId: payment.id,
        revokedAuthorizationEpoch,
      });
      await tx
        .insert(billingProviderOperations)
        .values({
          operationId: randomUUID(),
          workspaceId: job.workspaceId,
          mode: job.mode,
          operationType: "cancel_payment",
          operationKey: `execution-disabled:${operationId}:${payment.id}`,
          intentId,
          billingProfileVersion: operations[0].billingProfileVersion,
          authorizationEpoch: revokedAuthorizationEpoch,
          state: "contained",
          requestFingerprint: containmentFingerprint,
          idempotencyKeyHash: containmentFingerprint,
          credentialGenerationId: operations[0].credentialGenerationId,
          providerResourceId: payment.id,
          providerCustomerId: customerId,
          leaseToken: randomUUID(),
          leaseUntil: now,
          resolutionDueAt: now,
          completedAt: now,
        })
        .onDuplicateKeyUpdate({
          set: { operationKey: sql`operation_key` },
        });
      await tx
        .insert(billingOutbox)
        .values({
          workspaceId: job.workspaceId,
          mode: job.mode,
          eventType: "cancel_payment",
          deduplicationKey: `execution_disabled_payment:${payment.id}`,
          payload: {
            reason: "billing_execution_disabled",
            intentId,
            targetCustomerId: customerId,
            targetPaymentId: payment.id,
            revokedAuthorizationEpoch,
          },
          status: "pending",
        })
        .onDuplicateKeyUpdate({
          set: { deduplicationKey: sql`deduplication_key` },
        });
    }
    if (matches.length > 1) {
      await tx
        .insert(billingOutbox)
        .values({
          workspaceId: job.workspaceId,
          mode: job.mode,
          eventType: "manual_review",
          deduplicationKey: `payment_reconciliation_multiple:${operationId}`,
          payload: {
            reason: "payment_provider_ambiguous_after_disable",
            intentId,
          },
          status: "pending",
        })
        .onDuplicateKeyUpdate({
          set: { deduplicationKey: sql`deduplication_key` },
        });
    }
  });
}

export async function cancelContainedMollieSubscription(
  job: BillingOutboxItem,
  target: { customerId: string; subscriptionId: string },
  client: MollieClient
): Promise<"canceled" | "skipped_current"> {
  const boundTarget = readCancellationTarget(job.payload);
  if (
    !boundTarget ||
    boundTarget.customerId !== target.customerId ||
    boundTarget.subscriptionId !== target.subscriptionId
  ) {
    await recordSubscriptionCancellationReview(
      job,
      "subscription_cancellation_local_scope_mismatch"
    );
    throw new PermanentOutboxError(
      "subscription_cancellation_local_scope_mismatch"
    );
  }
  const database = await getDatabaseOrThrow();
  const initial = await database.transaction(async tx => {
    const rows = await tx
      .select()
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.workspaceId, job.workspaceId),
          eq(billingSubscriptions.mode, job.mode)
        )
      )
      .limit(1)
      .for("update");
    return rows[0] ?? null;
  });
  if (
    !(await hasExactSubscriptionCancellationBinding(job, boundTarget, initial))
  ) {
    await recordSubscriptionCancellationReview(
      job,
      "subscription_cancellation_local_scope_mismatch"
    );
    throw new PermanentOutboxError(
      "subscription_cancellation_local_scope_mismatch"
    );
  }
  const executionDisabledEpoch = readExecutionDisabledEpoch(job.payload);
  let executionIntentMatches = false;
  if (executionDisabledEpoch !== null) {
    const intents = await database
      .select({ intentId: billingIntents.intentId })
      .from(billingIntents)
      .where(
        and(
          eq(billingIntents.intentId, boundTarget.sourceIntentId),
          eq(billingIntents.workspaceId, job.workspaceId),
          eq(billingIntents.mode, job.mode),
          eq(billingIntents.authorizationEpoch, executionDisabledEpoch),
          inArray(billingIntents.status, ["paid", "contained"])
        )
      )
      .limit(1);
    executionIntentMatches = Boolean(intents[0]);
  }

  let remote: MollieSubscription | null = null;
  try {
    remote = await client.getSubscription(
      target.customerId,
      target.subscriptionId
    );
  } catch (error) {
    if (!(error instanceof MollieApiError) || error.status !== 404) {
      throw error;
    }
  }

  if (executionDisabledEpoch !== null) {
    if (!executionIntentMatches) {
      await recordSubscriptionCancellationReview(
        job,
        "subscription_cancellation_local_scope_mismatch"
      );
      throw new PermanentOutboxError(
        "subscription_cancellation_local_scope_mismatch"
      );
    }
    // An exact local/provider-operation binding was established above. A 404
    // for that immutable target is therefore an idempotent already-absent
    // result. Any returned resource must still match every provider boundary.
    if (!remote) return "skipped_current";
    if (
      remote.id !== target.subscriptionId ||
      remote.mode !== job.mode ||
      metadataIntentId(remote.metadata) !== boundTarget.sourceIntentId
    ) {
      await recordSubscriptionCancellationReview(
        job,
        "subscription_cancellation_provider_scope_mismatch"
      );
      throw new PermanentOutboxError(
        "subscription_cancellation_provider_scope_mismatch"
      );
    }
  }

  let matchingProvisioningRemoteIds: string[] | null = null;
  if (
    executionDisabledEpoch === null &&
    remote &&
    initial?.status === "provisioning" &&
    isPotentiallyCurrentContainmentTarget(initial, job.payload, target) &&
    remoteMatchesCurrentSubscription(remote, initial)
  ) {
    matchingProvisioningRemoteIds = collectingSubscriptionsForIntent(
      await client.listCustomerSubscriptions(target.customerId),
      initial.sourceIntentId
    ).map(candidate => candidate.id);
    if (matchingProvisioningRemoteIds.length === 0) {
      throw new RetryableOutboxError("containment_remote_list_inconsistent");
    }
  }

  const decision = await database.transaction(async tx => {
    const rows = await tx
      .select()
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.workspaceId, job.workspaceId),
          eq(billingSubscriptions.mode, job.mode)
        )
      )
      .limit(1)
      .for("update");
    const current = rows[0] ?? null;
    if (executionDisabledEpoch !== null) {
      // The execution-disabled scope and provider resource were validated
      // before entering this transaction. Only the established current remote
      // may be preserved; every other exact revoked-epoch target is canceled.
      if (
        current &&
        (current.status === "active" || current.status === "past_due") &&
        current.sourceIntentId === boundTarget.sourceIntentId &&
        current.mollieCustomerId === target.customerId &&
        current.mollieSubscriptionId === target.subscriptionId
      ) {
        return "skipped_current" as const;
      }
      return "cancel" as const;
    }
    if (
      current &&
      isPotentiallyCurrentContainmentTarget(current, job.payload, target) &&
      remote &&
      remoteMatchesCurrentSubscription(remote, current)
    ) {
      if (!isProfileRevocationContainment(job.payload)) {
        if (current.status !== "provisioning") {
          return "skipped_current" as const;
        }
        if (
          !matchingProvisioningRemoteIds ||
          initial?.sourceIntentId !== current.sourceIntentId
        ) {
          throw new RetryableOutboxError("containment_state_changed");
        }
        if (
          matchingProvisioningRemoteIds.length === 1 &&
          matchingProvisioningRemoteIds[0] === target.subscriptionId
        ) {
          return "skipped_current" as const;
        }
      }
    }

    if (
      current &&
      (current.status === "active" || current.status === "past_due") &&
      isPotentiallyCurrentContainmentTarget(current, job.payload, target)
    ) {
      await tx
        .update(billingSubscriptions)
        .set({ status: "manual_review" })
        .where(
          and(
            eq(billingSubscriptions.workspaceId, job.workspaceId),
            eq(billingSubscriptions.mode, job.mode),
            eq(
              billingSubscriptions.mollieSubscriptionId,
              target.subscriptionId
            ),
            inArray(billingSubscriptions.status, ["active", "past_due"])
          )
        );
      await tx
        .update(workspaceEntitlements)
        .set({ status: "manual_review" })
        .where(
          and(
            eq(workspaceEntitlements.workspaceId, job.workspaceId),
            eq(workspaceEntitlements.mode, job.mode)
          )
        );
    }
    return "cancel" as const;
  });

  if (decision === "skipped_current") {
    return decision;
  }

  if (remote) {
    try {
      await client.cancelSubscription(target.customerId, target.subscriptionId);
    } catch (error) {
      if (!(error instanceof MollieApiError) || error.status !== 404) {
        throw error;
      }
    }
  }

  await database.transaction(async tx => {
    await tx
      .select({ id: billingSubscriptions.id })
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.workspaceId, job.workspaceId),
          eq(billingSubscriptions.mode, job.mode)
        )
      )
      .limit(1)
      .for("update");
    await tx
      .update(billingSubscriptions)
      .set({
        status: "canceled",
        cancelAtPeriodEnd: 1,
        canceledAt: sql`COALESCE(${billingSubscriptions.canceledAt}, ${new Date()})`,
      })
      .where(
        and(
          eq(billingSubscriptions.workspaceId, job.workspaceId),
          eq(billingSubscriptions.mode, job.mode),
          eq(billingSubscriptions.mollieCustomerId, target.customerId),
          eq(billingSubscriptions.mollieSubscriptionId, target.subscriptionId)
        )
      );
  });
  return "canceled";
}

function isContainmentCancellation(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const reason = (payload as Record<string, unknown>).reason;
  return (
    reason === "provisioning_state_changed" ||
    reason === "remote_subscription_mismatch" ||
    reason === "reconciliation_subscription_mismatch" ||
    reason === "billing_profile_revoked" ||
    reason === "billing_profile_expired" ||
    reason === "billing_profile_ineligible_after_provider_response" ||
    reason === "checkout_provider_response_mismatch" ||
    reason === "billing_execution_disabled"
  );
}

function readExecutionDisabledEpoch(payload: unknown): number | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (record.reason !== "billing_execution_disabled") return null;
  const epoch = record.revokedAuthorizationEpoch;
  return Number.isSafeInteger(epoch) && Number(epoch) > 0
    ? Number(epoch)
    : null;
}

function readPaymentReconciliationEpoch(payload: unknown): number | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (
    record.reason !== "billing_execution_disabled" &&
    record.reason !== "checkout_provider_response_mismatch"
  ) {
    return null;
  }
  const epoch = record.revokedAuthorizationEpoch;
  return Number.isSafeInteger(epoch) && Number(epoch) > 0
    ? Number(epoch)
    : null;
}

function isProfileRevocationContainment(payload: unknown): boolean {
  return Boolean(
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    [
      "billing_profile_revoked",
      "billing_profile_expired",
      "billing_profile_ineligible_after_provider_response",
    ].includes(String((payload as Record<string, unknown>).reason))
  );
}

function isPotentiallyCurrentContainmentTarget(
  current: BillingSubscription,
  payload: unknown,
  target: { customerId: string; subscriptionId: string }
): boolean {
  if (current.mollieCustomerId !== target.customerId) return false;
  if (
    (current.status === "active" ||
      current.status === "past_due" ||
      current.status === "manual_review") &&
    current.mollieSubscriptionId === target.subscriptionId
  ) {
    return true;
  }
  if (current.status !== "provisioning") return false;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const expectedSourceIntentId = (payload as Record<string, unknown>)
    .expectedSourceIntentId;
  return (
    typeof expectedSourceIntentId === "string" &&
    expectedSourceIntentId === current.sourceIntentId
  );
}

function remoteMatchesCurrentSubscription(
  remote: MollieSubscription,
  current: BillingSubscription
): boolean {
  const statusMatches =
    current.status === "provisioning" || current.status === "manual_review"
      ? remote.status === "pending" || remote.status === "active"
      : remote.status === "active";
  const startDateMatches =
    current.status !== "provisioning" ||
    Boolean(
      current.paidThrough &&
      remote.startDate === formatDateOnly(current.paidThrough)
    );
  return (
    (remote.id === current.mollieSubscriptionId ||
      current.status === "provisioning") &&
    remote.mode === current.mode &&
    statusMatches &&
    startDateMatches &&
    remote.amount.currency === current.currency &&
    remote.amount.value === current.recurringAmount &&
    remote.interval === current.interval &&
    mandateMatchesCurrentSubscription(
      remote.mandateId,
      current.mollieMandateId,
      current.status === "provisioning"
    ) &&
    metadataIntentId(remote.metadata) === current.sourceIntentId
  );
}

export function mandateMatchesCurrentSubscription(
  remoteMandateId: string | null | undefined,
  localMandateId: string | null,
  provisioning: boolean
): boolean {
  if (provisioning && !localMandateId) {
    return Boolean(remoteMandateId && isValidMollieId(remoteMandateId, "mdt_"));
  }
  return Boolean(localMandateId && remoteMandateId === localMandateId);
}

export function collectingSubscriptionsForIntent(
  remotes: readonly MollieSubscription[],
  sourceIntentId: string
): MollieSubscription[] {
  return remotes.filter(
    remote =>
      (remote.status === "active" || remote.status === "pending") &&
      metadataIntentId(remote.metadata) === sourceIntentId
  );
}

async function rearmFailedEnsureJobsWaitingForCancellation(
  cancellationJob: BillingOutboxItem
): Promise<void> {
  const database = await getDatabaseOrThrow();
  let completedTarget: ReturnType<typeof readCancellationTarget> = null;
  try {
    completedTarget = readCancellationTarget(cancellationJob.payload);
  } catch {
    // The cancellation already ran through target validation. Keep this
    // recovery helper defensive if it is ever called independently.
  }
  const failedEnsureJobs = await database
    .select({ id: billingOutbox.id, payload: billingOutbox.payload })
    .from(billingOutbox)
    .where(
      and(
        eq(billingOutbox.workspaceId, cancellationJob.workspaceId),
        eq(billingOutbox.mode, cancellationJob.mode),
        eq(billingOutbox.eventType, "ensure_subscription"),
        eq(billingOutbox.status, "failed")
      )
    )
    .limit(100);
  for (const ensureJob of failedEnsureJobs) {
    let prerequisite: string | null = null;
    try {
      prerequisite = readCancellationPrerequisite(ensureJob.payload);
    } catch {
      continue;
    }
    if (!prerequisite) continue;
    let matchesCompletedCancellation =
      prerequisite === cancellationJob.deduplicationKey;
    if (!matchesCompletedCancellation && completedTarget) {
      const prerequisiteJobs = await database
        .select({ payload: billingOutbox.payload })
        .from(billingOutbox)
        .where(
          and(
            eq(billingOutbox.workspaceId, cancellationJob.workspaceId),
            eq(billingOutbox.mode, cancellationJob.mode),
            eq(billingOutbox.eventType, "cancel_subscription"),
            eq(billingOutbox.deduplicationKey, prerequisite)
          )
        )
        .limit(1);
      try {
        const prerequisiteTarget = prerequisiteJobs[0]
          ? readCancellationTarget(prerequisiteJobs[0].payload)
          : null;
        matchesCompletedCancellation = Boolean(
          prerequisiteTarget &&
          prerequisiteTarget.customerId === completedTarget.customerId &&
          prerequisiteTarget.subscriptionId === completedTarget.subscriptionId
        );
      } catch {
        matchesCompletedCancellation = false;
      }
    }
    if (!matchesCompletedCancellation) continue;
    await database
      .update(billingOutbox)
      .set({
        status: "pending",
        attemptCount: 0,
        availableAt: new Date(),
        lockedAt: null,
        leaseToken: null,
        lastErrorCode: null,
      })
      .where(
        and(
          eq(billingOutbox.id, ensureJob.id),
          eq(billingOutbox.workspaceId, cancellationJob.workspaceId),
          eq(billingOutbox.mode, cancellationJob.mode),
          eq(billingOutbox.status, "failed")
        )
      );
  }
}

export async function sendPaymentHandoff(
  job: ClaimedBillingOutboxItem
): Promise<void> {
  const target = readPortalHandoffTarget(job.payload);
  const fence = await beginBillingHandoffDelivery({
    outboxId: job.id,
    workspaceId: job.workspaceId,
    mode: job.mode,
    leaseToken: job.leaseToken,
    intentId: target.intentId,
    messengerSenderUserKey: target.messengerSenderUserKey,
    messengerPageId: target.messengerPageId,
  });
  let result;
  let transportStarted = false;
  try {
    result = await sendPortalHandoffLink({
      workspaceId: job.workspaceId,
      messengerSenderUserKey: target.messengerSenderUserKey,
      expectedFacebookPageId: target.messengerPageId,
      createdByUserId: null,
      deliveryIdempotencyKey: target.intentId,
      beforeCapabilityCreate: () =>
        advanceBillingHandoffDeliveryFence(fence, "preparing"),
      beforeTransport: async () => {
        const started = await advanceBillingHandoffDeliveryFence(
          fence,
          "transport_started"
        );
        transportStarted = started;
        return started;
      },
    });
  } catch (error) {
    await advanceBillingHandoffDeliveryFence(
      fence,
      transportStarted ? "ambiguous" : "idle"
    );
    if (transportStarted) {
      throw new PermanentOutboxError("portal_handoff_transport_ambiguous");
    }
    throw error;
  }

  if (result.ok) {
    await advanceBillingHandoffDeliveryFence(fence, "transport_succeeded");
    return;
  }
  await advanceBillingHandoffDeliveryFence(fence, "idle");
  if (result.reason === "send_failed") {
    throw new RetryableOutboxError("portal_handoff_send_failed");
  }
  throw new PermanentOutboxError(`portal_handoff_${result.reason}`);
}

function readPortalHandoffTarget(payload: unknown): {
  intentId: string;
  messengerSenderUserKey: string;
  messengerPageId: string;
} {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new PermanentOutboxError("invalid_portal_handoff_target");
  }
  const record = payload as Record<string, unknown>;
  const messengerSenderUserKey = record.messengerSenderUserKey;
  const messengerPageId = record.messengerPageId;
  const intentId = record.intentId;
  if (
    typeof intentId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(intentId) ||
    typeof messengerSenderUserKey !== "string" ||
    !/^[a-f0-9]{64}$/.test(messengerSenderUserKey) ||
    typeof messengerPageId !== "string" ||
    messengerPageId.trim().length === 0 ||
    messengerPageId.length > 160
  ) {
    throw new PermanentOutboxError("invalid_portal_handoff_target");
  }
  return {
    intentId,
    messengerSenderUserKey,
    messengerPageId: messengerPageId.trim(),
  };
}

async function hasExactSubscriptionCancellationBinding(
  job: BillingOutboxItem,
  target: {
    customerId: string;
    subscriptionId: string;
    sourceIntentId: string;
  },
  knownLocal?: BillingSubscription | null
): Promise<boolean> {
  if (
    knownLocal?.sourceIntentId === target.sourceIntentId &&
    knownLocal.mollieCustomerId === target.customerId &&
    knownLocal.mollieSubscriptionId === target.subscriptionId
  ) {
    return true;
  }
  const database = await getDatabaseOrThrow();
  const localRows = knownLocal
    ? []
    : await database
        .select({ id: billingSubscriptions.id })
        .from(billingSubscriptions)
        .where(
          and(
            eq(billingSubscriptions.workspaceId, job.workspaceId),
            eq(billingSubscriptions.mode, job.mode),
            eq(billingSubscriptions.sourceIntentId, target.sourceIntentId),
            eq(billingSubscriptions.mollieCustomerId, target.customerId),
            eq(billingSubscriptions.mollieSubscriptionId, target.subscriptionId)
          )
        )
        .limit(1);
  if (localRows[0]) return true;
  const revokedAuthorizationEpoch = readExecutionDisabledEpoch(job.payload);
  const operationRows = await database
    .select({ operationId: billingProviderOperations.operationId })
    .from(billingProviderOperations)
    .where(
      and(
        eq(billingProviderOperations.workspaceId, job.workspaceId),
        eq(billingProviderOperations.mode, job.mode),
        inArray(billingProviderOperations.operationType, [
          "create_subscription",
          "cancel_subscription",
        ]),
        eq(billingProviderOperations.intentId, target.sourceIntentId),
        eq(billingProviderOperations.providerResourceId, target.subscriptionId),
        eq(billingProviderOperations.providerCustomerId, target.customerId),
        inArray(billingProviderOperations.state, ["succeeded", "contained"]),
        ...(revokedAuthorizationEpoch !== null
          ? [
              eq(
                billingProviderOperations.authorizationEpoch,
                revokedAuthorizationEpoch
              ),
            ]
          : [])
      )
    )
    .limit(1);
  return Boolean(operationRows[0]);
}

async function recordSubscriptionCancellationReview(
  job: BillingOutboxItem,
  reason:
    | "subscription_cancellation_local_scope_mismatch"
    | "subscription_cancellation_provider_scope_mismatch"
): Promise<void> {
  const database = await getDatabaseOrThrow();
  await database
    .insert(billingOutbox)
    .values({
      workspaceId: job.workspaceId,
      mode: job.mode,
      eventType: "manual_review",
      deduplicationKey: `subscription_cancel_scope_review:${job.deliveryId}`,
      payload: { reason },
      status: "pending",
    })
    .onDuplicateKeyUpdate({
      set: { deduplicationKey: sql`deduplication_key` },
    });
}

function readCancellationTarget(payload: unknown): {
  customerId: string;
  subscriptionId: string;
  sourceIntentId: string;
} | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new PermanentOutboxError("invalid_cancel_target");
  }
  const record = payload as Record<string, unknown>;
  if (record.targetSubscriptionId === null) return null;
  const expectedSourceIntentId =
    record.expectedSourceIntentId ?? record.sourceIntentId;
  if (
    typeof record.targetCustomerId !== "string" ||
    typeof record.targetSubscriptionId !== "string" ||
    typeof expectedSourceIntentId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(expectedSourceIntentId) ||
    (typeof record.expectedSourceIntentId === "string" &&
      typeof record.sourceIntentId === "string" &&
      record.expectedSourceIntentId !== record.sourceIntentId)
  ) {
    throw new PermanentOutboxError("invalid_cancel_target");
  }
  try {
    assertMollieId(record.targetCustomerId, "cst_");
    assertMollieId(record.targetSubscriptionId, "sub_");
  } catch {
    throw new PermanentOutboxError("invalid_cancel_target");
  }
  return {
    customerId: record.targetCustomerId,
    subscriptionId: record.targetSubscriptionId,
    sourceIntentId: expectedSourceIntentId,
  };
}

async function assertCancellationPrerequisiteCompleted(
  job: BillingOutboxItem
): Promise<void> {
  const deduplicationKey = readCancellationPrerequisite(job.payload);
  if (!deduplicationKey) return;
  const database = await getDatabaseOrThrow();
  const rows = await database
    .select({
      id: billingOutbox.id,
      status: billingOutbox.status,
      eventType: billingOutbox.eventType,
    })
    .from(billingOutbox)
    .where(
      and(
        eq(billingOutbox.workspaceId, job.workspaceId),
        eq(billingOutbox.mode, job.mode),
        eq(billingOutbox.deduplicationKey, deduplicationKey)
      )
    )
    .limit(1);
  const prerequisite = rows[0];
  if (!prerequisite || prerequisite.eventType !== "cancel_subscription") {
    throw new PermanentOutboxError("replacement_cancel_missing");
  }
  if (prerequisite.status === "completed") return;
  if (prerequisite.status === "failed") {
    await database
      .update(billingOutbox)
      .set({
        status: "pending",
        attemptCount: 0,
        availableAt: new Date(),
        lockedAt: null,
        leaseToken: null,
        lastErrorCode: null,
      })
      .where(
        and(
          eq(billingOutbox.id, prerequisite.id),
          eq(billingOutbox.workspaceId, job.workspaceId),
          eq(billingOutbox.mode, job.mode),
          eq(billingOutbox.eventType, "cancel_subscription"),
          eq(billingOutbox.status, "failed")
        )
      );
    throw new RetryableOutboxError("replacement_cancel_rearmed");
  }
  throw new RetryableOutboxError("replacement_cancel_pending");
}

function readCancellationPrerequisite(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const value = (payload as Record<string, unknown>).cancellationPrerequisite;
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "string" ||
    value.length > 160 ||
    !/^[A-Za-z0-9:_-]+$/.test(value)
  ) {
    throw new PermanentOutboxError("invalid_replacement_cancel_reference");
  }
  return value;
}

async function recordRemoteSubscriptionContainment(
  job: BillingOutboxItem,
  local: BillingSubscription,
  remote: MollieSubscription,
  sourceIntentId = local.sourceIntentId,
  options: {
    reason?: "remote_subscription_mismatch" | "billing_execution_disabled";
    revokedAuthorizationEpoch?: number;
  } = {}
): Promise<void> {
  const database = await getDatabaseOrThrow();
  const containmentKey = hashCanonicalSnapshot({
    mode: job.mode,
    customerId: local.mollieCustomerId,
    subscriptionId: remote.id,
  });
  await database.transaction(async tx => {
    const currentRows = await tx
      .select({
        status: billingSubscriptions.status,
        sourceIntentId: billingSubscriptions.sourceIntentId,
        mollieSubscriptionId: billingSubscriptions.mollieSubscriptionId,
      })
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.workspaceId, job.workspaceId),
          eq(billingSubscriptions.mode, job.mode)
        )
      )
      .limit(1)
      .for("update");
    const current = currentRows[0];
    if (
      current &&
      (current.status === "active" || current.status === "past_due") &&
      current.sourceIntentId === sourceIntentId &&
      current.mollieSubscriptionId === remote.id
    ) {
      return;
    }
    if (
      (remote.status === "active" || remote.status === "pending") &&
      isValidMollieId(local.mollieCustomerId, "cst_") &&
      isValidMollieId(remote.id, "sub_")
    ) {
      const reason = options.reason ?? "remote_subscription_mismatch";
      const cancelDeduplicationKey = `${reason}_cancel:${containmentKey}`;
      await tx
        .insert(billingOutbox)
        .values({
          workspaceId: job.workspaceId,
          mode: job.mode,
          eventType: "cancel_subscription",
          deduplicationKey: cancelDeduplicationKey,
          payload: {
            reason,
            ...(options.revokedAuthorizationEpoch
              ? {
                  revokedAuthorizationEpoch: options.revokedAuthorizationEpoch,
                }
              : {}),
            expectedSourceIntentId: sourceIntentId,
            targetCustomerId: local.mollieCustomerId,
            targetSubscriptionId: remote.id,
          },
          status: "pending",
        })
        .onDuplicateKeyUpdate({
          set: { deduplicationKey: sql`deduplication_key` },
        });
      await tx
        .update(billingOutbox)
        .set({
          status: "pending",
          attemptCount: 0,
          availableAt: new Date(),
          lockedAt: null,
          leaseToken: null,
          lastErrorCode: null,
        })
        .where(
          and(
            eq(billingOutbox.workspaceId, job.workspaceId),
            eq(billingOutbox.mode, job.mode),
            eq(billingOutbox.eventType, "cancel_subscription"),
            eq(billingOutbox.deduplicationKey, cancelDeduplicationKey),
            eq(billingOutbox.status, "failed")
          )
        );
    }
    await tx
      .insert(billingOutbox)
      .values({
        workspaceId: job.workspaceId,
        mode: job.mode,
        eventType: "manual_review",
        deduplicationKey: `${options.reason ?? "remote_subscription_mismatch"}_review:${containmentKey}`,
        payload: {
          reason: options.reason ?? "remote_subscription_mismatch",
          intentId: sourceIntentId,
        },
        status: "pending",
      })
      .onDuplicateKeyUpdate({
        set: { deduplicationKey: sql`deduplication_key` },
      });
  });
}

async function containRemoteSubscriptionsForIntent(
  job: BillingOutboxItem,
  subscription: BillingSubscription,
  sourceIntentId: string,
  clientOverride?: MollieClient
): Promise<void> {
  const config = getMollieConfig();
  if (config.mode !== job.mode) {
    throw new PermanentOutboxError("billing_mode_mismatch");
  }
  const client = clientOverride ?? new MollieClient(config);
  const remotes = collectingSubscriptionsForIntent(
    await client.listCustomerSubscriptions(subscription.mollieCustomerId),
    sourceIntentId
  );
  if (remotes.length === 0) {
    // A create call may have timed out after Mollie accepted it. Keep checking
    // under the bounded outbox policy instead of treating an empty first list
    // response as proof that no remote subscription can appear.
    throw new RetryableOutboxError("remote_subscription_lookup_empty");
  }
  for (const remote of remotes) {
    if (
      subscription.status === "active" &&
      subscription.sourceIntentId === sourceIntentId &&
      subscription.mollieSubscriptionId === remote.id
    ) {
      continue;
    }
    await recordRemoteSubscriptionContainment(
      job,
      subscription,
      remote,
      sourceIntentId
    );
  }
}

async function containExhaustedEnsureAttempt(
  job: ClaimedBillingOutboxItem,
  clientOverride?: MollieClient
): Promise<void> {
  if (job.eventType !== "ensure_subscription") return;
  const sourceIntentId = readSourceIntentId(job.payload);
  if (!sourceIntentId) return;

  const subscription = await getWorkspaceBillingSubscription(
    job.workspaceId,
    job.mode
  );
  if (!subscription) {
    await recordUnknownSubscriptionOutcome(job, sourceIntentId);
    return;
  }
  if (
    subscription.status === "active" &&
    subscription.sourceIntentId === sourceIntentId &&
    subscription.mollieSubscriptionId
  ) {
    return;
  }

  try {
    await containRemoteSubscriptionsForIntent(
      job,
      subscription,
      sourceIntentId,
      clientOverride
    );
  } catch {
    // A final transport/API failure leaves the provider outcome ambiguous.
    // Persist a tenant-scoped review signal; never assume that no remote
    // subscription was created.
    await recordUnknownSubscriptionOutcome(job, sourceIntentId);
  }
}

async function recordUnknownSubscriptionOutcome(
  job: BillingOutboxItem,
  sourceIntentId: string
): Promise<void> {
  const database = await getDatabaseOrThrow();
  await database
    .insert(billingOutbox)
    .values({
      workspaceId: job.workspaceId,
      mode: job.mode,
      eventType: "manual_review",
      deduplicationKey: `subscription_outcome_unknown:${sourceIntentId}`,
      payload: {
        reason: "subscription_creation_outcome_unknown",
        intentId: sourceIntentId,
      },
      status: "pending",
    })
    .onDuplicateKeyUpdate({
      set: { deduplicationKey: sql`deduplication_key` },
    });
}

function isValidMollieId(
  value: string,
  prefix: "cst_" | "mdt_" | "sub_"
): boolean {
  try {
    assertMollieId(value, prefix);
    return true;
  } catch {
    return false;
  }
}

export async function claimBillingOutboxItem(
  mode: MollieMode,
  workspaceId: number
): Promise<ClaimedBillingOutboxItem | null> {
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const controls = await tx
      .select({ commercialEnabled: billingExecutionControls.commercialEnabled })
      .from(billingExecutionControls)
      .where(
        and(
          eq(billingExecutionControls.workspaceId, workspaceId),
          eq(billingExecutionControls.mode, mode)
        )
      )
      .limit(1)
      .for("update");
    if (!controls[0]) return null;
    const allowedEventTypes = controls[0].commercialEnabled
      ? undefined
      : ([
          "cancel_subscription",
          "cancel_payment",
          "payment_warning",
          "manual_review",
        ] as const);
    const activeJobs = await tx
      .select({ id: billingOutbox.id })
      .from(billingOutbox)
      .where(
        and(
          eq(billingOutbox.workspaceId, workspaceId),
          eq(billingOutbox.mode, mode),
          eq(billingOutbox.status, "processing"),
          ...(allowedEventTypes
            ? [inArray(billingOutbox.eventType, allowedEventTypes)]
            : [])
        )
      )
      .limit(1);
    if (activeJobs[0]) return null;
    const jobs = await tx
      .select()
      .from(billingOutbox)
      .where(
        and(
          eq(billingOutbox.workspaceId, workspaceId),
          eq(billingOutbox.mode, mode),
          eq(billingOutbox.status, "pending"),
          lte(billingOutbox.availableAt, new Date()),
          ...(allowedEventTypes
            ? [inArray(billingOutbox.eventType, allowedEventTypes)]
            : [])
        )
      )
      .orderBy(asc(billingOutbox.id))
      .limit(1)
      .for("update");
    const job = jobs[0];
    if (!job) return null;
    const attemptCount = job.attemptCount + 1;
    const leaseToken = randomUUID();
    await tx
      .update(billingOutbox)
      .set({
        status: "processing",
        lockedAt: new Date(),
        leaseToken,
        attemptCount,
      })
      .where(
        and(
          eq(billingOutbox.id, job.id),
          eq(billingOutbox.workspaceId, workspaceId),
          eq(billingOutbox.mode, mode),
          eq(billingOutbox.status, "pending")
        )
      );
    return {
      ...job,
      status: "processing" as const,
      leaseToken,
      attemptCount,
    };
  });
}

async function releaseStaleBillingLeases(
  mode: MollieMode,
  workspaceId: number
) {
  const database = await getDatabaseOrThrow();
  const staleBefore = new Date(Date.now() - OUTBOX_LEASE_TIMEOUT_MS);
  await database
    .update(billingOutbox)
    .set({
      status: "pending",
      lockedAt: null,
      leaseToken: null,
      lastErrorCode: "stale_lease",
    })
    .where(
      and(
        eq(billingOutbox.workspaceId, workspaceId),
        eq(billingOutbox.mode, mode),
        eq(billingOutbox.status, "processing"),
        lte(billingOutbox.lockedAt, staleBefore)
      )
    );
}

async function completeBillingOutboxItem(job: ClaimedBillingOutboxItem) {
  const database = await getDatabaseOrThrow();
  const completedAt = new Date();
  const completedPayload = appendHandoffRecoverySuccess(
    job.eventType,
    job.payload,
    job.attemptCount,
    completedAt
  );
  const result = await database
    .update(billingOutbox)
    .set({
      status: "completed",
      lockedAt: null,
      leaseToken: null,
      lastErrorCode: null,
      ...(completedPayload ? { payload: completedPayload } : {}),
    })
    .where(
      and(
        eq(billingOutbox.id, job.id),
        eq(billingOutbox.workspaceId, job.workspaceId),
        eq(billingOutbox.mode, job.mode),
        eq(billingOutbox.status, "processing"),
        eq(billingOutbox.leaseToken, job.leaseToken)
      )
    );
  const metadata = Array.isArray(result) ? result[0] : result;
  if (
    Number((metadata as { affectedRows?: number })?.affectedRows ?? 0) !== 1
  ) {
    throw new Error("billing outbox completion lease was lost");
  }
}

function appendHandoffRecoverySuccess(
  eventType: ClaimedBillingOutboxItem["eventType"],
  payload: unknown,
  attemptCount: number,
  completedAt: Date
): Record<string, unknown> | null {
  if (
    eventType !== "send_portal_handoff" ||
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.recoveryHistory)) return null;
  return {
    ...record,
    recoveryHistory: [
      ...(record.recoveryHistory as unknown[]).slice(-19),
      {
        kind: "delivered",
        attemptCount,
        recordedAt: completedAt.toISOString(),
      },
    ],
  };
}

async function rescheduleBillingOutboxItem(
  job: ClaimedBillingOutboxItem,
  errorCode: string
) {
  const delayMinutes = Math.min(
    360,
    5 * 2 ** Math.max(0, job.attemptCount - 1)
  );
  const database = await getDatabaseOrThrow();
  await database
    .update(billingOutbox)
    .set({
      status: "pending",
      lockedAt: null,
      leaseToken: null,
      availableAt: new Date(Date.now() + delayMinutes * 60_000),
      lastErrorCode: errorCode,
    })
    .where(
      and(
        eq(billingOutbox.id, job.id),
        eq(billingOutbox.workspaceId, job.workspaceId),
        eq(billingOutbox.mode, job.mode),
        eq(billingOutbox.status, "processing"),
        eq(billingOutbox.leaseToken, job.leaseToken)
      )
    );
}

export async function failBillingOutboxItem(
  job: ClaimedBillingOutboxItem,
  errorCode: string
) {
  const database = await getDatabaseOrThrow();
  await database.transaction(async tx => {
    const leases = await tx
      .select({ id: billingOutbox.id })
      .from(billingOutbox)
      .where(
        and(
          eq(billingOutbox.id, job.id),
          eq(billingOutbox.workspaceId, job.workspaceId),
          eq(billingOutbox.mode, job.mode),
          eq(billingOutbox.status, "processing"),
          eq(billingOutbox.leaseToken, job.leaseToken)
        )
      )
      .limit(1)
      .for("update");
    if (!leases[0]) return;
    await tx
      .update(billingOutbox)
      .set({
        status: "failed",
        lockedAt: null,
        leaseToken: null,
        lastErrorCode: errorCode,
      })
      .where(
        and(
          eq(billingOutbox.id, job.id),
          eq(billingOutbox.workspaceId, job.workspaceId),
          eq(billingOutbox.mode, job.mode),
          eq(billingOutbox.leaseToken, job.leaseToken)
        )
      );
    if (job.eventType === "ensure_subscription") {
      const sourceIntentId = readSourceIntentId(job.payload);
      if (!sourceIntentId) return;
      const subscriptions = await tx
        .select({
          sourceIntentId: billingSubscriptions.sourceIntentId,
          status: billingSubscriptions.status,
        })
        .from(billingSubscriptions)
        .where(
          and(
            eq(billingSubscriptions.workspaceId, job.workspaceId),
            eq(billingSubscriptions.mode, job.mode)
          )
        )
        .limit(1)
        .for("update");
      if (
        subscriptions[0]?.sourceIntentId !== sourceIntentId ||
        subscriptions[0].status !== "provisioning"
      ) {
        return;
      }
      await tx
        .update(billingSubscriptions)
        .set({ status: "manual_review" })
        .where(
          and(
            eq(billingSubscriptions.workspaceId, job.workspaceId),
            eq(billingSubscriptions.mode, job.mode),
            eq(billingSubscriptions.sourceIntentId, sourceIntentId)
          )
        );
      await tx
        .update(workspaceEntitlements)
        .set({ status: "manual_review" })
        .where(
          and(
            eq(workspaceEntitlements.workspaceId, job.workspaceId),
            eq(workspaceEntitlements.mode, job.mode)
          )
        );
      await tx
        .insert(billingOutbox)
        .values({
          workspaceId: job.workspaceId,
          mode: job.mode,
          eventType: "manual_review",
          deduplicationKey: `ensure_failed_review:${sourceIntentId}`,
          payload: {
            reason: "subscription_provisioning_failed",
            intentId: sourceIntentId,
          },
          status: "pending",
        })
        .onDuplicateKeyUpdate({
          set: { deduplicationKey: sql`deduplication_key` },
        });
    }
    if (
      job.eventType === "cancel_subscription" &&
      errorCode !== "subscription_cancellation_local_scope_mismatch" &&
      errorCode !== "subscription_cancellation_provider_scope_mismatch"
    ) {
      await tx
        .insert(billingOutbox)
        .values({
          workspaceId: job.workspaceId,
          mode: job.mode,
          eventType: "manual_review",
          deduplicationKey: `cancel_exhausted_review:${job.id}`,
          payload: { reason: "subscription_cancellation_exhausted" },
          status: "pending",
        })
        .onDuplicateKeyUpdate({
          set: { deduplicationKey: sql`deduplication_key` },
        });
    }
    if (job.eventType === "cancel_payment") {
      await tx
        .insert(billingOutbox)
        .values({
          workspaceId: job.workspaceId,
          mode: job.mode,
          eventType: "manual_review",
          deduplicationKey: `payment_cancel_failed_review:${job.deliveryId}`,
          payload: {
            reason: "payment_cancellation_failed",
            failedDeliveryId: job.deliveryId,
          },
          status: "pending",
        })
        .onDuplicateKeyUpdate({
          set: { deduplicationKey: sql`deduplication_key` },
        });
    }
    if (job.eventType === "payment_warning") {
      await tx
        .insert(billingOutbox)
        .values({
          workspaceId: job.workspaceId,
          mode: job.mode,
          eventType: "manual_review",
          deduplicationKey: `customer_notification_failed:${job.deliveryId}`,
          payload: {
            reason: "customer_notification_delivery_failed",
            failedDeliveryId: job.deliveryId,
          },
          status: "pending",
        })
        .onDuplicateKeyUpdate({
          set: { deduplicationKey: sql`deduplication_key` },
        });
    }
  });
  safeLog("billing_outbox_failed", {
    level: "error",
    eventType: job.eventType,
    errorCode,
    attempt: job.attemptCount,
  });
}

function readSourceIntentId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  const value = (payload as Record<string, unknown>).intentId;
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value)
    ? value
    : null;
}

function validateRemoteSubscription(
  subscription: MollieSubscription,
  expected: {
    mode: "test" | "live";
    amount: string;
    interval: string;
    intentId: string;
    mandateId: string;
    startDate: string;
  }
) {
  if (
    !subscription.id.startsWith("sub_") ||
    subscription.mode !== expected.mode ||
    subscription.amount.currency !== "EUR" ||
    subscription.amount.value !== expected.amount ||
    subscription.status !== "active" ||
    subscription.interval !== expected.interval ||
    subscription.startDate !== expected.startDate ||
    subscription.mandateId !== expected.mandateId ||
    metadataIntentId(subscription.metadata) !== expected.intentId
  ) {
    throw new PermanentOutboxError("subscription_response_mismatch");
  }
}

function formatDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function parseDateOnly(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new PermanentOutboxError("invalid_subscription_date");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || formatDateOnly(parsed) !== value) {
    throw new PermanentOutboxError("invalid_subscription_date");
  }
  return parsed;
}
