import { processClaimedMessengerPrivacyErasureJob } from "./dataDeletionService";
import { safeLog } from "./logger";
import {
  assertMessengerPrivacyErasureRetryStored,
  assertMessengerPrivacyErasureEncryptionConfig,
  claimDueMessengerPrivacyErasureJobs,
  ensureMessengerPrivacyErasureQueueReadable,
  recordMessengerPrivacyErasureWorkerPollFailure,
  recordMessengerPrivacyErasureWorkerPollSuccess,
  rescheduleMessengerPrivacyErasureJob,
} from "./messengerPrivacyErasureQueue";
import { isRedisEnabled } from "./redis";
import { runDueMessengerGenerationArtifactCleanup } from "./messengerGenerationCompletion";

const POLL_MS = 5_000;
const BATCH_SIZE = 10;

let timer: NodeJS.Timeout | undefined;
let polling = false;

export async function runMessengerPrivacyErasureWorkerOnce(): Promise<number> {
  if (!isRedisEnabled() || polling) return 0;
  polling = true;
  try {
    await runDueMessengerGenerationArtifactCleanup();
    const claims = await claimDueMessengerPrivacyErasureJobs(
      Date.now(),
      BATCH_SIZE
    );
    for (const claim of claims) {
      let outcome: Awaited<
        ReturnType<typeof processClaimedMessengerPrivacyErasureJob>
      >;
      try {
        outcome = await processClaimedMessengerPrivacyErasureJob(claim);
      } catch (error) {
        // The processor normally converts every failure into a durable retry.
        // Keep this per-job guard so an unexpected implementation error cannot
        // starve unrelated subjects later in the same bounded poll.
        try {
          await rescheduleMessengerPrivacyErasureJob({
            claim,
            errorCode:
              error instanceof Error ? error.constructor.name : "UnknownError",
          });
        } catch (rescheduleError) {
          // The pending member and lease remain durable for replica recovery,
          // but this process must not advertise a successful poll when it could
          // not durably record the retry.
          throw new AggregateError(
            [error, rescheduleError],
            "Messenger privacy erasure retry could not be stored"
          );
        }
        safeLog("messenger_privacy_erasure_job_failed", {
          level: "error",
          jobId: claim.job.jobId,
          errorCode:
            error instanceof Error ? error.constructor.name : "UnknownError",
        });
        continue;
      }
      if (outcome.status !== "completed") {
        // The processor owns the normal retry write. Verify it outside its
        // exception handler so a missing write cannot be mistaken for another
        // processor error and "successfully" rescheduled a second time.
        await assertMessengerPrivacyErasureRetryStored(claim);
        safeLog("messenger_privacy_erasure_retry_scheduled", {
          jobId: claim.job.jobId,
          attemptCount: claim.job.attemptCount + 1,
        });
      }
    }
    await recordMessengerPrivacyErasureWorkerPollSuccess(claims.length);
    return claims.length;
  } catch (error) {
    safeLog("messenger_privacy_erasure_worker_failed", {
      level: "error",
      errorCode:
        error instanceof Error ? error.constructor.name : "UnknownError",
    });
    try {
      await recordMessengerPrivacyErasureWorkerPollFailure(error);
    } catch (heartbeatError) {
      throw new AggregateError(
        [error, heartbeatError],
        "Messenger privacy erasure poll and failure heartbeat both failed"
      );
    }
    throw error;
  } finally {
    polling = false;
  }
}

export async function startMessengerPrivacyErasureWorker(): Promise<void> {
  if (!isRedisEnabled() || timer) return;
  assertMessengerPrivacyErasureEncryptionConfig();
  // A worker-only process has no HTTP /readyz surface. Prove that every
  // pending envelope is decryptable before scheduling any destructive work;
  // an old or corrupt key must fail process startup, not become a retry loop.
  await ensureMessengerPrivacyErasureQueueReadable();
  // An initial successful claim/store cycle is the worker-only readiness gate.
  // Do not let the HTTP process or generation-worker-only process boot on a
  // timer that has never proven it can use the durable queue.
  await runMessengerPrivacyErasureWorkerOnce();
  timer = setInterval(() => {
    void runMessengerPrivacyErasureWorkerOnce().catch(() => undefined);
  }, POLL_MS);
  timer.unref?.();
}

export function stopMessengerPrivacyErasureWorkerForTests(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  polling = false;
}
