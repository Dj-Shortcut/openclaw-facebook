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
  finalizeStaleAiAnswerReservationsForWorkspace,
  getNextAiAnswerFinalizationDue,
} from "./entitlementUsageStore";

const POLL_INTERVAL_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
let timer: NodeJS.Timeout | null = null;
let running = false;

export function startAiAnswerFinalizationWorker(): void {
  if (timer) return;
  timer = setInterval(() => void runSafely(), POLL_INTERVAL_MS);
  timer.unref();
  void runSafely();
}

async function runSafely(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runAiAnswerFinalizationSchedulerOnce();
  } catch (error) {
    safeLog("ai_answer_finalization_scheduler_failed", {
      level: "error",
      errorCode: error instanceof Error ? error.name : "UnknownError",
    });
  } finally {
    running = false;
  }
}

export async function runAiAnswerFinalizationSchedulerOnce(
  limit = 25,
  now = new Date()
): Promise<number> {
  const mode = getConfiguredBillingMode();
  await recordBillingSchedulerPoll(mode, "ai_finalization", now);
  let processed = 0;
  for (let index = 0; index < Math.max(1, Math.min(100, limit)); index += 1) {
    const claimNow = index === 0 ? now : new Date();
    const lease = await claimNextBillingTenant(
      mode,
      claimNow,
      "ai_finalization"
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
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();
    let failed = false;
    try {
      if (leaseLost) throw new Error("AI finalization lease was lost");
      await assertBillingTenantLeaseOwned(lease);
      processed += await finalizeStaleAiAnswerReservationsForWorkspace({
        workspaceId: lease.workspaceId,
        mode,
        now: claimNow,
      });
      if (leaseLost) throw new Error("AI finalization lease was lost");
      await assertBillingTenantLeaseOwned(lease);
    } catch {
      failed = true;
    } finally {
      clearInterval(heartbeat);
      const releaseNow = new Date();
      const nextAt = failed
        ? releaseNow
        : await getNextAiAnswerFinalizationDue({
            workspaceId: lease.workspaceId,
            mode,
            now: releaseNow,
          });
      if (
        !(await releaseBillingTenantLease({
          ...lease,
          failed,
          now: releaseNow,
          nextAt,
        }))
      ) {
        throw new Error("AI finalization lease ownership was lost");
      }
    }
  }
  return processed;
}
