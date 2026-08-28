import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, lte, or, sql } from "drizzle-orm";
import {
  billingCustomers,
  billingOutbox,
  billingReconciliationAnomalies,
  billingReconciliationRuns,
  billingSubscriptions,
  workspaceEntitlements,
} from "../../../drizzle/schema";
import { getDatabaseOrThrow } from "../../db";
import { safeLog } from "../logger";
import { getMollieConfig, type MollieMode } from "./config";
import { parseAmountMinor } from "./amounts";
import { hashCanonicalSnapshot } from "./ids";
import {
  assertMollieId,
  MollieClient,
  type MolliePayment,
  type MollieSubscription,
} from "./mollieClient";
import { applyMolliePaymentSnapshot } from "./paymentStore";
import { metadataIntentId } from "./providerMetadata";
import {
  claimNextBillingTenant,
  assertBillingTenantLeaseOwned,
  assertBillingTenantLeaseOwnedInTransaction,
  releaseBillingTenantLease,
  recordBillingSchedulerPoll,
  renewBillingTenantLease,
  type BillingTenantLease,
} from "./billingSchedulerStore";
import { expireWorkspaceBillingProfileIfDue } from "./billingProfileStore";
import { resolveDuePaymentProviderOperations } from "./checkoutStore";
import { enqueueDueCustomerlessCreditPaymentRecoveries } from "./creditPaymentRecovery";

const RECONCILIATION_DISPATCH_INTERVAL_MS = 60_000;
const RECONCILIATION_LEASE_MS = 2 * 60 * 60 * 1_000;
const RECONCILIATION_RETRY_MS = 15 * 60 * 1_000;
const NEXT_DAILY_RUN_MS = 24 * 60 * 60 * 1_000;
const INITIAL_RECONCILIATION_DELAY_MS = 30_000;
const RECENT_PAYMENT_WINDOW_MS = 45 * 24 * 60 * 60 * 1_000;
const HISTORICAL_PAYMENT_AUDIT_LIMIT = 25;
const DAY_MS = 24 * 60 * 60 * 1_000;

type BillingTransaction = Parameters<
  Parameters<Awaited<ReturnType<typeof getDatabaseOrThrow>>["transaction"]>[0]
>[0];

let reconciliationTimer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
const busyReconciliationWorkspaces = new Set<number>();

export function startDailyBillingReconciliation(): void {
  if (
    reconciliationTimer ||
    process.env.MOLLIE_RECONCILIATION_ENABLED === "false"
  ) {
    return;
  }
  initialTimer = setTimeout(() => {
    void dispatchDueReconciliations();
  }, INITIAL_RECONCILIATION_DELAY_MS);
  initialTimer.unref();
  reconciliationTimer = setInterval(() => {
    void dispatchDueReconciliations();
  }, RECONCILIATION_DISPATCH_INTERVAL_MS);
  reconciliationTimer.unref();
}

async function dispatchTenantReconciliation(
  tenantLease: BillingTenantLease
): Promise<boolean> {
  const workspaceId = tenantLease.workspaceId;
  if (busyReconciliationWorkspaces.has(workspaceId)) {
    throw new Error("billing reconciliation workspace is already busy");
  }
  busyReconciliationWorkspaces.add(workspaceId);
  try {
    const now = new Date();
    const result = await runDailyBillingReconciliation(
      workspaceId,
      undefined,
      now,
      () => assertBillingTenantLeaseOwned(tenantLease),
      tenantLease
    );
    if (!result.ran) {
      throw new Error("billing reconciliation inner lease was unavailable");
    }
    return true;
  } catch (error) {
    safeLog("billing_reconciliation_dispatch_failed", {
      level: "error",
      errorCode: error instanceof Error ? error.name : "UnknownError",
    });
    throw error;
  } finally {
    busyReconciliationWorkspaces.delete(workspaceId);
  }
}

export async function runBillingReconciliationSchedulerOnce(
  limit = 25,
  now = new Date()
): Promise<number> {
  const config = getMollieConfig();
  await recordBillingSchedulerPoll(config.mode, "reconciliation", now);
  let processed = 0;
  const count = Math.max(1, Math.min(100, limit));
  for (let index = 0; index < count; index += 1) {
    const claimNow = index === 0 ? now : new Date();
    const lease = await claimNextBillingTenant(
      config.mode,
      claimNow,
      "reconciliation"
    );
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
      const ran = await dispatchTenantReconciliation(lease);
      await assertBillingTenantLeaseOwned(lease);
      if (ran) processed += 1;
    } catch {
      failed = true;
    } finally {
      clearInterval(heartbeat);
      const releaseNow = new Date();
      const nextAt = failed
        ? releaseNow
        : await getNextWorkspaceReconciliationDue(
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
        throw new Error("billing reconciliation lease ownership was lost");
      }
    }
  }
  return processed;
}

async function getNextWorkspaceReconciliationDue(
  workspaceId: number,
  mode: MollieMode,
  now: Date
): Promise<Date> {
  const database = await getDatabaseOrThrow();
  const rows = await database
    .select({
      nextAt: sql<Date | null>`MIN(${billingCustomers.nextReconciliationAt})`,
    })
    .from(billingCustomers)
    .where(
      and(
        eq(billingCustomers.workspaceId, workspaceId),
        eq(billingCustomers.mode, mode)
      )
    );
  return rows[0]?.nextAt instanceof Date
    ? rows[0].nextAt
    : new Date(now.getTime() + NEXT_DAILY_RUN_MS);
}

async function dispatchDueReconciliations(): Promise<void> {
  try {
    await runBillingReconciliationSchedulerOnce();
  } catch (error) {
    safeLog("billing_reconciliation_scheduler_failed", {
      level: "error",
      errorCode: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

export async function runDailyBillingReconciliation(
  workspaceId: number,
  clientOverride?: MollieClient,
  now = new Date(),
  assertExecutionFence: () => Promise<void> = () => Promise.resolve(),
  tenantLease?: BillingTenantLease
) {
  if (!Number.isSafeInteger(workspaceId) || workspaceId <= 0) {
    throw new Error("invalid reconciliation workspace");
  }
  const config = getMollieConfig();
  const lease = await claimReconciliationRun(workspaceId, config.mode, now);
  if (!lease) return { ran: false as const };

  const summary = {
    customersChecked: 0,
    subscriptionsChecked: 0,
    paymentsChecked: 0,
    paymentSnapshotsApplied: 0,
    anomalies: 0,
    entitlementsExpired: 0,
  };
  try {
    const database = await getDatabaseOrThrow();
    await assertExecutionFence();
    await resolveDuePaymentProviderOperations(workspaceId, config.mode, now);
    await enqueueDueCustomerlessCreditPaymentRecoveries(
      workspaceId,
      config.mode,
      now,
      tenantLease
    );
    await assertExecutionFence();
    await expireWorkspaceBillingProfileIfDue(workspaceId, now);
    const expiryResult = await database
      .update(workspaceEntitlements)
      .set({ status: "inactive" })
      .where(
        and(
          eq(workspaceEntitlements.workspaceId, workspaceId),
          eq(workspaceEntitlements.mode, config.mode),
          or(
            eq(workspaceEntitlements.status, "active"),
            eq(workspaceEntitlements.status, "grace")
          ),
          lte(workspaceEntitlements.validUntil, now)
        )
      );
    summary.entitlementsExpired = extractAffectedRows(expiryResult);

    const client = clientOverride ?? new MollieClient(config);
    const customers = await database
      .select()
      .from(billingCustomers)
      .where(
        and(
          eq(billingCustomers.workspaceId, workspaceId),
          eq(billingCustomers.mode, config.mode),
          isNotNull(billingCustomers.mollieCustomerId)
        )
      )
      .limit(1);
    const customer = customers[0];
    if (!customer?.mollieCustomerId) {
      await recordAnomaly(
        lease.runId,
        workspaceId,
        "billing_customer_missing",
        tenantLease
      );
      summary.anomalies += 1;
    } else {
      summary.customersChecked = 1;
      await assertExecutionFence();
      const payments = sortPaymentsOldestFirst(
        await client.listCustomerPayments(customer.mollieCustomerId)
      );
      const reconcilablePayments = selectPaymentsForReconciliation(
        payments,
        now
      );
      for (const listedPayment of reconcilablePayments) {
        summary.paymentsChecked += 1;
        await assertExecutionFence();
        const payment = await client.getPayment(listedPayment.id);
        await assertExecutionFence();
        if (payment.mode !== config.mode) {
          await recordAnomaly(
            lease.runId,
            workspaceId,
            "payment_mode_mismatch",
            tenantLease
          );
          summary.anomalies += 1;
          continue;
        }
        const result = await applyMolliePaymentSnapshot(payment, workspaceId, {
          schedulerLease: tenantLease,
        });
        if (result.result === "processed" || result.result === "mismatch") {
          summary.paymentSnapshotsApplied += 1;
        }
      }
    }

    const subscriptions = await database
      .select()
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.workspaceId, workspaceId),
          eq(billingSubscriptions.mode, config.mode)
        )
      )
      .limit(1);
    const subscription = subscriptions[0];
    if (subscription) {
      summary.subscriptionsChecked = 1;
      const hasRemoteSubscription = Boolean(subscription.mollieSubscriptionId);
      const customerBindingAnomaly = hasRemoteSubscription
        ? reconciliationSubscriptionCustomerBindingAnomaly(
            subscription.mollieCustomerId,
            customer?.mollieCustomerId
          )
        : null;
      if (customerBindingAnomaly) {
        await recordAnomaly(
          lease.runId,
          workspaceId,
          customerBindingAnomaly,
          tenantLease
        );
        summary.anomalies += 1;
      }
      const boundCustomerId = customerBindingAnomaly
        ? null
        : (customer?.mollieCustomerId ?? null);
      if (subscription.mollieSubscriptionId && boundCustomerId) {
        await assertExecutionFence();
        const remote = await client.getSubscription(
          boundCustomerId,
          subscription.mollieSubscriptionId
        );
        if (!remoteSubscriptionMatches(remote, subscription, config.mode)) {
          await recordAnomaly(
            lease.runId,
            workspaceId,
            "subscription_mismatch",
            tenantLease
          );
          await recordSubscriptionContainment(
            workspaceId,
            config.mode,
            boundCustomerId,
            remote,
            tenantLease
          );
          summary.anomalies += 1;
        } else {
          const nextPaymentDate = parseOptionalDateOnly(remote.nextPaymentDate);
          if (remote.nextPaymentDate && !nextPaymentDate) {
            await recordAnomaly(
              lease.runId,
              workspaceId,
              "subscription_schedule_invalid",
              tenantLease
            );
            summary.anomalies += 1;
          } else {
            await syncWorkspaceSubscriptionScheduleWithLease(
              workspaceId,
              config.mode,
              subscription.mollieSubscriptionId,
              nextPaymentDate,
              tenantLease
            );
          }

          if (remote.status === "canceled" || remote.status === "completed") {
            await markWorkspaceSubscriptionStoppedWithLease(
              workspaceId,
              config.mode,
              subscription.mollieSubscriptionId,
              tenantLease
            );
          } else if (remote.status === "suspended") {
            await recordAnomaly(
              lease.runId,
              workspaceId,
              "remote_suspended",
              tenantLease
            );
            summary.anomalies += 1;
          }
          if (
            hasRemoteCollectionStateMismatch(subscription.status, remote.status)
          ) {
            await recordAnomaly(
              lease.runId,
              workspaceId,
              "local_stopped_remote_active",
              tenantLease
            );
            await recordSubscriptionContainment(
              workspaceId,
              config.mode,
              boundCustomerId,
              remote,
              tenantLease
            );
            summary.anomalies += 1;
          }
        }
      }
    }

    if (customer?.mollieCustomerId) {
      await assertExecutionFence();
      const remoteSubscriptions = await client.listCustomerSubscriptions(
        customer.mollieCustomerId
      );
      for (const remote of remoteSubscriptions) {
        if (remote.status !== "active" && remote.status !== "pending") {
          continue;
        }
        if (
          shouldPreserveRemoteSubscription(
            subscription,
            remote,
            Boolean(
              subscription &&
              remoteSubscriptionMatches(remote, subscription, config.mode)
            )
          )
        ) {
          continue;
        }
        await recordAnomaly(
          lease.runId,
          workspaceId,
          "unbound_remote_subscription",
          tenantLease
        );
        await recordSubscriptionContainment(
          workspaceId,
          config.mode,
          customer.mollieCustomerId,
          remote,
          tenantLease
        );
        summary.anomalies += 1;
      }
    }

    await completeReconciliationRun(
      lease.runId,
      workspaceId,
      config.mode,
      lease.leaseToken,
      summary,
      new Date(Date.now() + NEXT_DAILY_RUN_MS),
      tenantLease
    );
    safeLog("billing_reconciliation_completed", summary);
    return { ran: true as const, summary };
  } catch (error) {
    await failReconciliationRun(
      lease.runId,
      workspaceId,
      config.mode,
      lease.leaseToken,
      {
        ...summary,
        errorCode: error instanceof Error ? error.name : "UnknownError",
      },
      tenantLease
    );
    await scheduleReconciliationRetry(
      workspaceId,
      config.mode,
      now,
      tenantLease
    );
    safeLog("billing_reconciliation_failed", {
      level: "error",
      errorCode: error instanceof Error ? error.name : "UnknownError",
    });
    throw error;
  }
}

export function sortPaymentsOldestFirst<T extends { createdAt: string }>(
  payments: readonly T[]
): T[] {
  return [...payments].sort((left, right) => {
    const leftTime = Date.parse(left.createdAt);
    const rightTime = Date.parse(right.createdAt);
    if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return 0;
    return leftTime - rightTime;
  });
}

export function needsReconciliation(
  payment: Pick<MolliePayment, "status" | "amountRefunded" | "createdAt">,
  now: Date
): boolean {
  if (["open", "pending", "authorized"].includes(payment.status)) return true;

  if (payment.amountRefunded) {
    try {
      if (parseAmountMinor(payment.amountRefunded) > 0) return true;
    } catch {
      return true;
    }
  }

  const createdAt = Date.parse(payment.createdAt);
  if (!Number.isFinite(createdAt)) return true;
  return createdAt >= now.getTime() - RECENT_PAYMENT_WINDOW_MS;
}

export function selectPaymentsForReconciliation<
  T extends Pick<
    MolliePayment,
    "id" | "status" | "amountRefunded" | "createdAt"
  >,
>(
  payments: readonly T[],
  now: Date,
  historicalAuditLimit = HISTORICAL_PAYMENT_AUDIT_LIMIT
): T[] {
  const selectedIds = new Set(
    payments
      .filter(payment => needsReconciliation(payment, now))
      .map(payment => payment.id)
  );
  const historical = payments.filter(payment => !selectedIds.has(payment.id));
  const limit = Number.isSafeInteger(historicalAuditLimit)
    ? Math.max(0, historicalAuditLimit)
    : 0;
  const auditCount = Math.min(limit, historical.length);
  if (auditCount > 0) {
    const day = Math.floor(now.getTime() / DAY_MS);
    const start =
      (((day * auditCount) % historical.length) + historical.length) %
      historical.length;
    for (let index = 0; index < auditCount; index += 1) {
      selectedIds.add(historical[(start + index) % historical.length].id);
    }
  }
  return payments.filter(payment => selectedIds.has(payment.id));
}

async function scheduleReconciliationRetry(
  workspaceId: number,
  mode: MollieMode,
  now: Date,
  tenantLease?: BillingTenantLease
): Promise<void> {
  const database = await getDatabaseOrThrow();
  await database.transaction(async tx => {
    await assertReconciliationMutationLease(tx, tenantLease);
    await tx
      .update(billingCustomers)
      .set({
        nextReconciliationAt: new Date(now.getTime() + RECONCILIATION_RETRY_MS),
      })
      .where(
        and(
          eq(billingCustomers.workspaceId, workspaceId),
          eq(billingCustomers.mode, mode)
        )
      );
  });
}

async function claimReconciliationRun(
  workspaceId: number,
  mode: MollieMode,
  now: Date
) {
  const database = await getDatabaseOrThrow();
  const periodKey = now.toISOString().slice(0, 10);
  const leaseToken = randomUUID();
  await database
    .insert(billingReconciliationRuns)
    .values({
      workspaceId,
      mode,
      periodKey,
      status: "failed",
      leaseToken: null,
      leaseUntil: new Date("2000-01-01T00:00:00.000Z"),
      summary: null,
    })
    .onDuplicateKeyUpdate({
      set: { periodKey: sql`period_key` },
    });
  await database
    .update(billingReconciliationRuns)
    .set({
      status: "running",
      leaseToken,
      leaseUntil: new Date(now.getTime() + RECONCILIATION_LEASE_MS),
      startedAt: now,
      completedAt: null,
    })
    .where(
      and(
        eq(billingReconciliationRuns.workspaceId, workspaceId),
        eq(billingReconciliationRuns.mode, mode),
        eq(billingReconciliationRuns.periodKey, periodKey),
        or(
          eq(billingReconciliationRuns.status, "failed"),
          and(
            eq(billingReconciliationRuns.status, "running"),
            lte(billingReconciliationRuns.leaseUntil, now)
          )
        )
      )
    );
  const claimed = await database
    .select({ id: billingReconciliationRuns.id })
    .from(billingReconciliationRuns)
    .where(
      and(
        eq(billingReconciliationRuns.workspaceId, workspaceId),
        eq(billingReconciliationRuns.mode, mode),
        eq(billingReconciliationRuns.periodKey, periodKey),
        eq(billingReconciliationRuns.leaseToken, leaseToken)
      )
    )
    .limit(1);
  return claimed[0] ? { runId: claimed[0].id, leaseToken } : null;
}

async function recordAnomaly(
  runId: number,
  workspaceId: number,
  code: string,
  tenantLease?: BillingTenantLease
) {
  const database = await getDatabaseOrThrow();
  const safeCode = code.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  await database.transaction(async tx => {
    await assertReconciliationMutationLease(tx, tenantLease);
    await tx
      .insert(billingReconciliationAnomalies)
      .values({ runId, workspaceId, code: safeCode, metadata: null })
      .onDuplicateKeyUpdate({ set: { code: sql`code` } });
  });
}

async function recordSubscriptionContainment(
  workspaceId: number,
  mode: MollieMode,
  mollieCustomerId: string,
  remote: MollieSubscription,
  tenantLease?: BillingTenantLease
): Promise<void> {
  const containmentKey = hashCanonicalSnapshot({
    mode,
    customerId: mollieCustomerId,
    subscriptionId: remote.id,
  });
  const database = await getDatabaseOrThrow();
  await database.transaction(async tx => {
    await assertReconciliationMutationLease(tx, tenantLease);
    const currentRows = await tx
      .select()
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.workspaceId, workspaceId),
          eq(billingSubscriptions.mode, mode)
        )
      )
      .limit(1)
      .for("update");
    const current = currentRows[0] ?? null;
    if (
      shouldPreserveRemoteSubscription(
        current,
        remote,
        Boolean(current && remoteSubscriptionMatches(remote, current, mode))
      )
    ) {
      return;
    }
    if (
      (remote.status === "active" || remote.status === "pending") &&
      isValidSubscriptionTarget(mollieCustomerId, remote.id)
    ) {
      const cancelDeduplicationKey = `reconciliation_cancel:${containmentKey}`;
      await tx
        .insert(billingOutbox)
        .values({
          workspaceId,
          mode,
          eventType: "cancel_subscription",
          deduplicationKey: cancelDeduplicationKey,
          payload: {
            reason: "reconciliation_subscription_mismatch",
            expectedSourceIntentId: metadataIntentId(remote.metadata),
            targetCustomerId: mollieCustomerId,
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
            eq(billingOutbox.workspaceId, workspaceId),
            eq(billingOutbox.mode, mode),
            eq(billingOutbox.eventType, "cancel_subscription"),
            eq(billingOutbox.deduplicationKey, cancelDeduplicationKey),
            eq(billingOutbox.status, "failed")
          )
        );
    }
    await tx
      .insert(billingOutbox)
      .values({
        workspaceId,
        mode,
        eventType: "manual_review",
        deduplicationKey: `reconciliation_review:${containmentKey}`,
        payload: { reason: "reconciliation_subscription_mismatch" },
        status: "pending",
      })
      .onDuplicateKeyUpdate({
        set: { deduplicationKey: sql`deduplication_key` },
      });
  });
}

async function syncWorkspaceSubscriptionScheduleWithLease(
  workspaceId: number,
  mode: MollieMode,
  mollieSubscriptionId: string,
  nextPaymentDate: Date | null,
  tenantLease?: BillingTenantLease
): Promise<void> {
  const database = await getDatabaseOrThrow();
  await database.transaction(async tx => {
    await assertReconciliationMutationLease(tx, tenantLease);
    await tx
      .update(billingSubscriptions)
      .set({ nextPaymentDate })
      .where(
        and(
          eq(billingSubscriptions.workspaceId, workspaceId),
          eq(billingSubscriptions.mode, mode),
          eq(billingSubscriptions.mollieSubscriptionId, mollieSubscriptionId)
        )
      );
  });
}

async function markWorkspaceSubscriptionStoppedWithLease(
  workspaceId: number,
  mode: MollieMode,
  mollieSubscriptionId: string,
  tenantLease?: BillingTenantLease
): Promise<void> {
  const database = await getDatabaseOrThrow();
  await database.transaction(async tx => {
    await assertReconciliationMutationLease(tx, tenantLease);
    await tx
      .update(billingSubscriptions)
      .set({
        status: "canceled",
        cancelAtPeriodEnd: 1,
        canceledAt: sql`COALESCE(${billingSubscriptions.canceledAt}, ${new Date()})`,
      })
      .where(
        and(
          eq(billingSubscriptions.workspaceId, workspaceId),
          eq(billingSubscriptions.mode, mode),
          eq(billingSubscriptions.mollieSubscriptionId, mollieSubscriptionId)
        )
      );
  });
}

async function assertReconciliationMutationLease(
  tx: BillingTransaction,
  tenantLease?: BillingTenantLease
): Promise<void> {
  if (tenantLease) {
    await assertBillingTenantLeaseOwnedInTransaction(tx, tenantLease);
  }
}

export function shouldPreserveRemoteSubscription(
  local:
    | Pick<
        typeof billingSubscriptions.$inferSelect,
        "status" | "sourceIntentId"
      >
    | null
    | undefined,
  remote: Pick<MollieSubscription, "status" | "metadata">,
  contractMatches: boolean
): boolean {
  if (!local) return false;
  if (local.status === "provisioning") {
    return metadataIntentId(remote.metadata) === local.sourceIntentId;
  }
  if (local.status === "manual_review") {
    return (
      contractMatches &&
      (remote.status === "active" || remote.status === "pending")
    );
  }
  return (
    (local.status === "active" || local.status === "past_due") &&
    remote.status === "active" &&
    contractMatches
  );
}

function isValidSubscriptionTarget(
  customerId: string,
  subscriptionId: string
): boolean {
  try {
    assertMollieId(customerId, "cst_");
    assertMollieId(subscriptionId, "sub_");
    return true;
  } catch {
    return false;
  }
}

async function completeReconciliationRun(
  runId: number,
  workspaceId: number,
  mode: MollieMode,
  leaseToken: string,
  summary: Record<string, number>,
  nextReconciliationAt: Date,
  tenantLease?: BillingTenantLease
) {
  const database = await getDatabaseOrThrow();
  await database.transaction(async tx => {
    await assertReconciliationMutationLease(tx, tenantLease);
    const leases = await tx
      .select({ id: billingReconciliationRuns.id })
      .from(billingReconciliationRuns)
      .where(
        and(
          eq(billingReconciliationRuns.id, runId),
          eq(billingReconciliationRuns.workspaceId, workspaceId),
          eq(billingReconciliationRuns.mode, mode),
          eq(billingReconciliationRuns.leaseToken, leaseToken)
        )
      )
      .limit(1)
      .for("update");
    if (!leases[0]) {
      throw new Error("billing reconciliation lease lost");
    }
    await tx
      .update(billingReconciliationRuns)
      .set({
        status: "completed",
        leaseToken: null,
        summary,
        completedAt: new Date(),
      })
      .where(
        and(
          eq(billingReconciliationRuns.id, runId),
          eq(billingReconciliationRuns.workspaceId, workspaceId),
          eq(billingReconciliationRuns.mode, mode),
          eq(billingReconciliationRuns.leaseToken, leaseToken)
        )
      );
    await tx
      .update(billingCustomers)
      .set({ nextReconciliationAt })
      .where(
        and(
          eq(billingCustomers.workspaceId, workspaceId),
          eq(billingCustomers.mode, mode)
        )
      );
  });
}

async function failReconciliationRun(
  runId: number,
  workspaceId: number,
  mode: MollieMode,
  leaseToken: string,
  summary: Record<string, unknown>,
  tenantLease?: BillingTenantLease
) {
  const database = await getDatabaseOrThrow();
  await database.transaction(async tx => {
    await assertReconciliationMutationLease(tx, tenantLease);
    await tx
      .update(billingReconciliationRuns)
      .set({
        status: "failed",
        leaseToken: null,
        summary,
        completedAt: new Date(),
      })
      .where(
        and(
          eq(billingReconciliationRuns.id, runId),
          eq(billingReconciliationRuns.workspaceId, workspaceId),
          eq(billingReconciliationRuns.mode, mode),
          eq(billingReconciliationRuns.leaseToken, leaseToken)
        )
      );
  });
}

function remoteSubscriptionMatches(
  remote: MollieSubscription,
  local: typeof billingSubscriptions.$inferSelect,
  mode: MollieMode
): boolean {
  return (
    remote.id === local.mollieSubscriptionId &&
    remote.mode === mode &&
    remote.amount.currency === "EUR" &&
    remote.amount.value === local.recurringAmount &&
    remote.interval === local.interval &&
    remote.mandateId === local.mollieMandateId &&
    metadataIntentId(remote.metadata) === local.sourceIntentId
  );
}

export function hasRemoteCollectionStateMismatch(
  localStatus: (typeof billingSubscriptions.$inferSelect)["status"],
  remoteStatus: MollieSubscription["status"]
): boolean {
  return (
    (remoteStatus === "active" || remoteStatus === "pending") &&
    ["canceled", "completed", "suspended"].includes(localStatus)
  );
}

export function isValidReconciliationSubscriptionCustomerId(
  customerId: string
): boolean {
  if (customerId.length <= "cst_".length) return false;
  try {
    assertMollieId(customerId, "cst_");
    return true;
  } catch {
    return false;
  }
}

function reconciliationSubscriptionCustomerBindingAnomaly(
  subscriptionCustomerId: string,
  workspaceCustomerId: string | null | undefined
):
  | "subscription_customer_binding_missing"
  | "subscription_customer_id_invalid"
  | "subscription_customer_id_mismatch"
  | null {
  if (!workspaceCustomerId) return "subscription_customer_binding_missing";
  if (!isValidReconciliationSubscriptionCustomerId(subscriptionCustomerId)) {
    return "subscription_customer_id_invalid";
  }
  if (subscriptionCustomerId !== workspaceCustomerId) {
    return "subscription_customer_id_mismatch";
  }
  return null;
}

function parseOptionalDateOnly(value: string | null | undefined): Date | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    return null;
  }
  return parsed;
}

function extractAffectedRows(result: unknown): number {
  if (Array.isArray(result)) {
    for (const value of result) {
      const count = extractAffectedRows(value);
      if (count > 0) return count;
    }
    return 0;
  }
  if (result && typeof result === "object" && "affectedRows" in result) {
    const value = (result as { affectedRows?: unknown }).affectedRows;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  }
  return 0;
}
