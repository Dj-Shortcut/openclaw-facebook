import {
  drainMessengerGenerationQueue,
  isMessengerGenerationQueueEnabled,
  reclaimReservedMessengerGenerationJobs,
} from "./messengerGenerationQueue";
import {
  processMessengerGenerationJob,
  processMessengerGenerationJobDeadLetter,
} from "./messengerWebhook";
import { safeLog } from "./logger";

const DEFAULT_WORKER_POLL_MS = 1_000;

function getWorkerPollMs(): number {
  const configured = Number(process.env.MESSENGER_GENERATION_WORKER_POLL_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_WORKER_POLL_MS;
}

export function startMessengerGenerationWorker(options: {
  keepAlive?: boolean;
} = {}): void {
  if (!isMessengerGenerationQueueEnabled()) {
    safeLog("messenger_generation_worker_queue_disabled", { level: "warn" });
    return;
  }

  let running = false;
  const runOnce = async () => {
    if (running) {
      return;
    }

    running = true;
    try {
      const reclaimed = await reclaimReservedMessengerGenerationJobs({
        onDeadLetter: processMessengerGenerationJobDeadLetter,
      });
      if (reclaimed > 0) {
        safeLog("messenger_generation_worker_reclaimed_reserved_jobs", {
          level: "warn",
          reclaimed,
        });
      }
      await drainMessengerGenerationQueue(processMessengerGenerationJob, {
        onDeadLetter: processMessengerGenerationJobDeadLetter,
      });
    } catch (error) {
      safeLog("messenger_generation_worker_drain_failed", {
        level: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      running = false;
    }
  };

  void runOnce();
  const timer = setInterval(() => {
    void runOnce();
  }, getWorkerPollMs());
  if (!options.keepAlive) {
    timer.unref();
  }
  safeLog("messenger_generation_worker_started");
}
