import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import {
  billingOutbox,
  billingIntents,
  billingSubscriptions,
  workspaces,
  workspaceEntitlements,
  type BillingOutboxItem,
  type BillingSubscription,
} from "../../../drizzle/schema";
import { getDatabaseOrThrow } from "../../db";
import { safeLog } from "../logger";
import { sendPortalHandoffLink } from "../portalHandoffDelivery";
import {
  getMollieConfig,
  getTenantBillingWorkerWorkspaceId,
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
let workerBusy = false;

export function startBillingOutboxWorker(): void {
  if (workerTimer) return;
  const workspaceId = getTenantBillingWorkerWorkspaceId();
  if (!workspaceId) {
    safeLog("billing_outbox_worker_disabled", {
      reason: "tenant_workspace_not_configured",
    });
    return;
  }
  workerTimer = setInterval(() => {
    void runBillingOutboxSafely(workspaceId);
  }, OUTBOX_POLL_INTERVAL_MS);
  workerTimer.unref();
  void runBillingOutboxSafely(workspaceId);
}

export async function runBillingOutboxOnce(
  workspaceId: number,
  clientOverride?: MollieClient
): Promise<boolean> {
  if (!Number.isSafeInteger(workspaceId) || workspaceId <= 0) {
    throw new Error("invalid billing outbox workspace");
  }
  if (workerBusy) return false;
  workerBusy = true;
  try {
    const config = getMollieConfig();
    await releaseStaleBillingLeases(config.mode, workspaceId);
    const job = await claimBillingOutboxItem(config.mode, workspaceId);
    if (!job) return false;
    try {
      await processBillingOutboxItem(job, clientOverride);
      await completeBillingOutboxItem(job);
    } catch (error) {
      const retryCode = retryableErrorCode(error);
      if (retryCode) {
        if (job.attemptCount >= job.maxAttempts) {
          await containExhaustedEnsureAttempt(job, clientOverride);
          await failBillingOutboxItem(job, `${retryCode}_exhausted`);
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
  } finally {
    workerBusy = false;
  }
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

async function runBillingOutboxSafely(workspaceId: number): Promise<void> {
  try {
    await runBillingOutboxOnce(workspaceId);
  } catch (error) {
    safeLog("billing_outbox_dispatch_failed", {
      level: "error",
      errorCode: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

async function processBillingOutboxItem(
  job: ClaimedBillingOutboxItem,
  clientOverride?: MollieClient
) {
  if (job.eventType === "ensure_subscription") {
    await ensureMollieSubscription(job, clientOverride);
    return;
  }
  if (job.eventType === "cancel_subscription") {
    await cancelMollieSubscription(job, clientOverride);
    return;
  }
  if (job.eventType === "send_portal_handoff") {
    await sendPaymentHandoff(job);
    return;
  }

  safeLog("billing_outbox_operator_action_required", {
    level: job.eventType === "manual_review" ? "error" : "warn",
    eventType: job.eventType,
    attempt: job.attemptCount,
  });
  throw new PermanentOutboxError(
    job.eventType === "payment_warning"
      ? "customer_notification_not_configured"
      : "operator_notification_not_configured"
  );
}

async function ensureMollieSubscription(
  job: ClaimedBillingOutboxItem,
  clientOverride?: MollieClient
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
    .select({ paidAt: billingIntents.paidAt })
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
  if (!sourcePaidAt) {
    throw new PermanentOutboxError("source_payment_time_missing");
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
    if (alreadyLinked) {
      return;
    }
    const mayStillBeLinkedByCurrentLease =
      current[0]?.status === "provisioning" &&
      current[0].sourceIntentId === subscription.sourceIntentId;
    if (!leases[0] && mayStillBeLinkedByCurrentLease) {
      // Another worker now owns the job. Its idempotent provider result is
      // allowed to finish; the stale worker must neither link nor cancel it.
      return;
    }
    if (!leases[0] || !mayStillBeLinkedByCurrentLease) {
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

async function cancelMollieSubscription(
  job: ClaimedBillingOutboxItem,
  clientOverride?: MollieClient
) {
  const target = readCancellationTarget(job.payload);
  if (!target) return;
  const config = getMollieConfig();
  if (config.mode !== job.mode) {
    throw new PermanentOutboxError("billing_mode_mismatch");
  }
  const client = clientOverride ?? new MollieClient(config);
  if (isContainmentCancellation(job.payload)) {
    const result = await cancelContainedMollieSubscription(job, target, client);
    if (result === "skipped_current") return;
    await rearmFailedEnsureJobsWaitingForCancellation(job);
    return;
  }
  try {
    await client.cancelSubscription(target.customerId, target.subscriptionId);
  } catch (error) {
    if (!(error instanceof MollieApiError) || error.status !== 404) {
      throw error;
    }
  }
  await markWorkspaceSubscriptionStoppedIfMatches(
    job.workspaceId,
    job.mode,
    target.subscriptionId
  );
  await rearmFailedEnsureJobsWaitingForCancellation(job);
}

export async function cancelContainedMollieSubscription(
  job: BillingOutboxItem,
  target: { customerId: string; subscriptionId: string },
  client: MollieClient
): Promise<"canceled" | "skipped_current"> {
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

  let matchingProvisioningRemoteIds: string[] | null = null;
  if (
    remote &&
    initial?.status === "provisioning" &&
    isPotentiallyCurrentContainmentTarget(initial, job.payload, target) &&
    remoteMatchesCurrentSubscription(remote, initial)
  ) {
    matchingProvisioningRemoteIds = collectingSubscriptionsForIntent(
      await client.listCustomerSubscriptions(target.customerId),
      initial.sourceIntentId
    )
      .map(candidate => candidate.id);
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
    if (
      current &&
      isPotentiallyCurrentContainmentTarget(current, job.payload, target) &&
      remote &&
      remoteMatchesCurrentSubscription(remote, current)
    ) {
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
    reason === "reconciliation_subscription_mismatch"
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

export async function sendPaymentHandoff(job: ClaimedBillingOutboxItem): Promise<void> {
  const target = readPortalHandoffTarget(job.payload);
  const result = await sendPortalHandoffLink({
    workspaceId: job.workspaceId,
    messengerSenderUserKey: target.messengerSenderUserKey,
    expectedFacebookPageId: target.messengerPageId,
    createdByUserId: null,
    deliveryIdempotencyKey: target.intentId,
  });

  if (result.ok) return;
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
    typeof intentId !== "string" || !/^[0-9a-f-]{36}$/i.test(intentId) ||
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

function readCancellationTarget(payload: unknown): {
  customerId: string;
  subscriptionId: string;
} | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new PermanentOutboxError("invalid_cancel_target");
  }
  const record = payload as Record<string, unknown>;
  if (record.targetSubscriptionId === null) return null;
  if (
    typeof record.targetCustomerId !== "string" ||
    typeof record.targetSubscriptionId !== "string"
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
  sourceIntentId = local.sourceIntentId
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
      const cancelDeduplicationKey = `remote_mismatch_cancel:${containmentKey}`;
      await tx
        .insert(billingOutbox)
        .values({
          workspaceId: job.workspaceId,
          mode: job.mode,
          eventType: "cancel_subscription",
          deduplicationKey: cancelDeduplicationKey,
          payload: {
            reason: "remote_subscription_mismatch",
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
        deduplicationKey: `remote_mismatch_review:${containmentKey}`,
        payload: {
          reason: "remote_subscription_mismatch",
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
    const workspaceRows = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1)
      .for("update");
    if (!workspaceRows[0]) return null;
    const activeJobs = await tx
      .select({ id: billingOutbox.id })
      .from(billingOutbox)
      .where(
        and(
          eq(billingOutbox.workspaceId, workspaceId),
          eq(billingOutbox.mode, mode),
          eq(billingOutbox.status, "processing")
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
          lte(billingOutbox.availableAt, new Date())
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
  await database
    .update(billingOutbox)
    .set({
      status: "completed",
      lockedAt: null,
      leaseToken: null,
      lastErrorCode: null,
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

async function failBillingOutboxItem(
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
    if (job.eventType === "cancel_subscription") {
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
