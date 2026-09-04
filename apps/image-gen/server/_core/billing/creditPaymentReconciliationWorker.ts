import { safeLog } from "../logger";
import {
  assertBillingTenantLeaseOwned,
  claimNextBillingTenant,
  recordBillingSchedulerPoll,
  releaseBillingTenantLease,
  renewBillingTenantLease,
} from "./billingSchedulerStore";
import { getConfiguredBillingMode } from "./config";
import { enqueueDueCustomerlessCreditPaymentRecoveries } from "./creditPaymentRecovery";

const DISPATCH_INTERVAL_MS = 60_000;
const INITIAL_DISPATCH_DELAY_MS = 30_000;
const LEASE_HEARTBEAT_INTERVAL_MS = 30_000;

let initialTimer: NodeJS.Timeout | null = null;
let workerTimer: NodeJS.Timeout | null = null;

/**
 * Retains only the one-off credit-payment reconciliation needed by the active
 * owner-operated product. Legacy customer, subscription and entitlement
 * reconciliation stays retired and is fenced separately at startup.
 */
export function startCreditPaymentReconciliationWorker(): void {
  if (
    initialTimer ||
    workerTimer ||
    process.env.MOLLIE_RECONCILIATION_ENABLED === "false"
  ) {
    return;
  }
  initialTimer = setTimeout(() => {
    initialTimer = null;
    void runCreditPaymentReconciliationSchedulerSafely();
  }, INITIAL_DISPATCH_DELAY_MS);
  initialTimer.unref();
  workerTimer = setInterval(() => {
    void runCreditPaymentReconciliationSchedulerSafely();
  }, DISPATCH_INTERVAL_MS);
  workerTimer.unref();
}

export async function runCreditPaymentReconciliationSchedulerOnce(
  limit = 25,
  now = new Date()
): Promise<number> {
  const mode = getConfiguredBillingMode();
  await recordBillingSchedulerPoll(mode, "reconciliation", now);
  const count = Math.max(1, Math.min(100, limit));
  let enqueued = 0;
  for (let index = 0; index < count; index += 1) {
    const claimNow = index === 0 ? now : new Date();
    const lease = await claimNextBillingTenant(
      mode,
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
    }, LEASE_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();
    try {
      await assertBillingTenantLeaseOwned(lease);
      enqueued += await enqueueDueCustomerlessCreditPaymentRecoveries(
        lease.workspaceId,
        lease.mode,
        claimNow,
        lease
      );
      await assertBillingTenantLeaseOwned(lease);
    } catch (error) {
      failed = true;
      safeLog("credit_payment_reconciliation_tenant_failed", {
        level: "error",
        errorCode: error instanceof Error ? error.name : "UnknownError",
      });
    } finally {
      clearInterval(heartbeat);
      const releaseNow = new Date();
      const released = await releaseBillingTenantLease({
        ...lease,
        failed,
        now: releaseNow,
        nextAt: new Date(releaseNow.getTime() + DISPATCH_INTERVAL_MS),
      });
      if (!released) {
        throw new Error(
          "credit payment reconciliation scheduler lease ownership was lost"
        );
      }
    }
  }
  return enqueued;
}

export async function runCreditPaymentReconciliationSchedulerSafely(): Promise<void> {
  try {
    await runCreditPaymentReconciliationSchedulerOnce();
  } catch (error) {
    safeLog("credit_payment_reconciliation_dispatch_failed", {
      level: "error",
      errorCode: error instanceof Error ? error.name : "UnknownError",
    });
  }
}
