import {
  drainMessengerGenerationQueue,
  isMessengerGenerationQueueEnabled,
  reclaimReservedMessengerGenerationJobs,
} from "./messengerGenerationQueue";
import {
  processMessengerGenerationJob,
  processMessengerGenerationJobDeadLetter,
} from "./messengerWebhook";

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
    console.warn("[messenger generation worker] queue disabled; worker idle");
    return;
  }

  let running = false;
  const runOnce = async () => {
    if (running) {
      return;
    }

    running = true;
    try {
      const reclaimed = await reclaimReservedMessengerGenerationJobs();
      if (reclaimed > 0) {
        console.warn("[messenger generation worker] reclaimed reserved jobs", {
          reclaimed,
        });
      }
      await drainMessengerGenerationQueue(processMessengerGenerationJob, {
        onDeadLetter: processMessengerGenerationJobDeadLetter,
      });
    } catch (error) {
      console.error("[messenger generation worker] drain failed", {
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
  console.info("[messenger generation worker] started");
}
