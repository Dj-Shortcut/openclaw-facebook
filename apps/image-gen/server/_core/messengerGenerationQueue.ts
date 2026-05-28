import { getRedisClient, isRedisEnabled, type RedisLike } from "./redis";
import { safeLog } from "./messengerApi";
import type { MessengerGenerationJob } from "./messengerGenerationJob";

export const MESSENGER_GENERATION_QUEUE_KEY = "messenger-generation-jobs";
export const MESSENGER_GENERATION_PROCESSING_KEY =
  "messenger-generation-jobs:processing";
const DEFAULT_JOB_LEASE_SECONDS = 15 * 60;
let drainPromise: Promise<void> | null = null;

type GenerationJobProcessor = (
  job: MessengerGenerationJob
) => Promise<unknown>;

function isExplicitlyEnabled(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

export function isMessengerGenerationQueueEnabled(): boolean {
  return (
    isExplicitlyEnabled(process.env.MESSENGER_GENERATION_QUEUE_ENABLED) &&
    isRedisEnabled()
  );
}

export function isMessengerGenerationWorkerMode(): boolean {
  return isExplicitlyEnabled(process.env.MESSENGER_GENERATION_WORKER);
}

export function isMessengerGenerationWorkerOnlyMode(): boolean {
  return isExplicitlyEnabled(process.env.MESSENGER_GENERATION_WORKER_ONLY);
}

export function isMessengerGenerationInlineFallbackEnabled(): boolean {
  return process.env.MESSENGER_GENERATION_INLINE_FALLBACK !== "0";
}

function getGenerationJobLeaseSeconds(): number {
  const configured = Number(process.env.MESSENGER_GENERATION_JOB_LEASE_SECONDS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_JOB_LEASE_SECONDS;
}

function getGenerationJobLeaseKey(job: MessengerGenerationJob): string {
  return `messenger-generation-job-lease:${job.reqId}`;
}

export async function enqueueMessengerGenerationJob(
  job: MessengerGenerationJob
): Promise<void> {
  const redis = await getRedisClient();
  await redis.lpush(MESSENGER_GENERATION_QUEUE_KEY, JSON.stringify(job));
}

type ReservedGenerationJob = {
  raw: string;
  job: MessengerGenerationJob;
};

async function reserveMessengerGenerationJobFrom(
  redis: RedisLike
): Promise<ReservedGenerationJob | null> {
  const raw = await redis.rpoplpush(
    MESSENGER_GENERATION_QUEUE_KEY,
    MESSENGER_GENERATION_PROCESSING_KEY
  );
  if (!raw) {
    return null;
  }

  return {
    raw,
    job: JSON.parse(raw) as MessengerGenerationJob,
  };
}

async function markMessengerGenerationJobReserved(
  redis: RedisLike,
  reserved: ReservedGenerationJob
): Promise<void> {
  await redis.set(
    getGenerationJobLeaseKey(reserved.job),
    "1",
    "EX",
    getGenerationJobLeaseSeconds()
  );
}

async function completeMessengerGenerationJob(
  redis: RedisLike,
  reserved: ReservedGenerationJob
): Promise<void> {
  await redis.lrem(MESSENGER_GENERATION_PROCESSING_KEY, 1, reserved.raw);
  await redis.del(getGenerationJobLeaseKey(reserved.job));
}

async function releaseMessengerGenerationJob(
  redis: RedisLike,
  reserved: ReservedGenerationJob
): Promise<void> {
  await completeMessengerGenerationJob(redis, reserved);
  await redis.lpush(MESSENGER_GENERATION_QUEUE_KEY, reserved.raw);
}

export async function reclaimReservedMessengerGenerationJobs(): Promise<number> {
  if (!isMessengerGenerationQueueEnabled()) {
    return 0;
  }

  const redis = await getRedisClient();
  const reservedJobs = await redis.lrange(
    MESSENGER_GENERATION_PROCESSING_KEY,
    0,
    -1
  );

  let reclaimed = 0;
  for (const raw of reservedJobs) {
    if (await hasActiveMessengerGenerationJobLease(redis, raw)) {
      continue;
    }

    await redis.lrem(MESSENGER_GENERATION_PROCESSING_KEY, 1, raw);
    await redis.lpush(MESSENGER_GENERATION_QUEUE_KEY, raw);
    reclaimed += 1;
  }

  return reclaimed;
}

async function hasActiveMessengerGenerationJobLease(
  redis: RedisLike,
  rawJob: string
): Promise<boolean> {
  try {
    const job = JSON.parse(rawJob) as MessengerGenerationJob;
    return (await redis.get(getGenerationJobLeaseKey(job))) !== null;
  } catch {
    return false;
  }
}

export async function drainMessengerGenerationQueue(
  processor: GenerationJobProcessor
): Promise<void> {
  if (!isMessengerGenerationQueueEnabled()) {
    return;
  }

  const redis = await getRedisClient();
  while (true) {
    const reserved = await reserveMessengerGenerationJobFrom(redis);
    if (!reserved) {
      return;
    }

    try {
      await markMessengerGenerationJobReserved(redis, reserved);
      await processor(reserved.job);
      await completeMessengerGenerationJob(redis, reserved);
    } catch (error) {
      safeLog("messenger_generation_job_failed", {
        reqId: reserved.job.reqId,
        style: reserved.job.style,
        errorCode: error instanceof Error ? error.constructor.name : "UnknownError",
      });
      await releaseMessengerGenerationJob(redis, reserved);
    }
  }
}

export function scheduleMessengerGenerationQueueDrain(
  processor: GenerationJobProcessor
): void {
  if (!isMessengerGenerationQueueEnabled() || drainPromise) {
    return;
  }

  drainPromise = drainMessengerGenerationQueue(processor).finally(() => {
    drainPromise = null;
  });
}

export async function enqueueOrRunMessengerGenerationJob(
  job: MessengerGenerationJob,
  processor: GenerationJobProcessor
): Promise<{ mode: "queued" } | { mode: "inline"; outcome: unknown }> {
  if (!isMessengerGenerationQueueEnabled()) {
    const outcome = await processor(job);
    return { mode: "inline", outcome };
  }

  await enqueueMessengerGenerationJob(job);
  if (
    isMessengerGenerationInlineFallbackEnabled() &&
    !isMessengerGenerationWorkerMode()
  ) {
    scheduleMessengerGenerationQueueDrain(processor);
  }
  return { mode: "queued" };
}

export function resetMessengerGenerationQueueForTests(): void {
  drainPromise = null;
}
