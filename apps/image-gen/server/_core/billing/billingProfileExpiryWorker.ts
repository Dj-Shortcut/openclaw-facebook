import { safeLog } from "../logger";
import {
  claimNextBillingTenant,
  assertBillingTenantLeaseOwned,
  releaseBillingTenantLease,
  recordBillingSchedulerPoll,
  renewBillingTenantLease,
} from "./billingSchedulerStore";
import { getConfiguredBillingMode } from "./config";
import {
  expireWorkspaceBillingProfileIfDue,
  getWorkspaceBillingProfileExpiryDue,
} from "./billingProfileStore";

const POLL_INTERVAL_MS = 30_000;
let timer: NodeJS.Timeout | null = null;
let running = false;

export function startBillingProfileExpiryWorker(): void {
  if (timer) return;
  timer = setInterval(() => void runSafely(), POLL_INTERVAL_MS);
  timer.unref();
  void runSafely();
}

async function runSafely(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runBillingProfileExpirySchedulerOnce();
  } catch (error) {
    safeLog("billing_profile_expiry_scheduler_failed", {
      level: "error",
      errorCode: error instanceof Error ? error.name : "UnknownError",
    });
  } finally {
    running = false;
  }
}

export async function runBillingProfileExpirySchedulerOnce(
  limit = 25,
  now = new Date()
): Promise<number> {
  const mode = getConfiguredBillingMode();
  await recordBillingSchedulerPoll(mode, "profile_expiry", now);
  let processed = 0;
  for (let index = 0; index < Math.max(1, Math.min(100, limit)); index += 1) {
    const claimNow = index === 0 ? now : new Date();
    const lease = await claimNextBillingTenant(
      mode,
      claimNow,
      "profile_expiry"
    );
    if (!lease) break;
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      void renewBillingTenantLease(lease)
        .then(renewed => {
          if (!renewed) leaseLost = true;
        })
        .catch(() => {
          leaseLost = true;
        });
    }, 30_000);
    heartbeat.unref();
    let failed = false;
    try {
      if (leaseLost) throw new Error("billing profile expiry lease was lost");
      await assertBillingTenantLeaseOwned(lease);
      if (
        await expireWorkspaceBillingProfileIfDue(lease.workspaceId, claimNow)
      ) {
        processed += 1;
      }
      if (leaseLost) throw new Error("billing profile expiry lease was lost");
      await assertBillingTenantLeaseOwned(lease);
    } catch {
      failed = true;
    } finally {
      clearInterval(heartbeat);
      const releaseNow = new Date();
      const nextAt = failed
        ? releaseNow
        : await getWorkspaceBillingProfileExpiryDue(
            lease.workspaceId,
            releaseNow
          );
      if (
        !(await releaseBillingTenantLease({
          ...lease,
          failed,
          now: releaseNow,
          nextAt,
        }))
      ) {
        throw new Error("billing profile expiry lease ownership was lost");
      }
    }
  }
  return processed;
}
