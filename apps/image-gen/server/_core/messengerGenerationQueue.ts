import { getRedisClient, isRedisEnabled, type RedisLike } from "./redis";
import { safeLog } from "./messengerApi";
import type { MessengerGenerationJob } from "./messengerGenerationJob";

const MESSENGER_GENERATION_QUEUE_KEY = "messenger-generation-jobs";
const MESSENGER_GENERATION_PROCESSING_KEY =
  "messenger-generation-jobs:processing";
const MESSENGER_GENERATION_DEAD_LETTER_KEY =
  "messenger-generation-jobs:dead";
const DEFAULT_JOB_LEASE_BUFFER_SECONDS = 60;
const OPENAI_TIMEOUT_MS_DEFAULT = 180_000;
const DEFAULT_MAX_JOB_ATTEMPTS = 3;
const DEFAULT_DRAIN_BATCH_SIZE = 10;
const MESSENGER_GENERATION_LANGS = new Set(["nl", "en"]);
const MESSENGER_GENERATION_KINDS = new Set([
  "text_to_image",
  "source_image_edit",
]);
const LEGACY_MESSENGER_GENERATION_KINDS = new Set(["style_restyle"]);
let drainPromise: Promise<void> | null = null;

type GenerationJobProcessor = (
  job: MessengerGenerationJob
) => Promise<unknown>;

type GenerationQueueDrainOptions = {
  onDeadLetter?: (
    job: MessengerGenerationJob,
    error: unknown
  ) => Promise<unknown>;
};

export type MessengerGenerationQueueStats = {
  enabled: boolean;
  queued: number;
  processing: number;
  failed: number;
};

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

export function assertMessengerGenerationQueueConfig(): void {
  const queueRequested = isExplicitlyEnabled(
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED
  );
  const queueEnabled = isMessengerGenerationQueueEnabled();
  const workerRequested =
    isMessengerGenerationWorkerMode() || isMessengerGenerationWorkerOnlyMode();

  if (workerRequested && !queueEnabled) {
    throw new Error(
      "MESSENGER_GENERATION_QUEUE_ENABLED=1 and REDIS_URL are required for Messenger generation worker mode"
    );
  }

  if (!isMessengerGenerationInlineFallbackEnabled() && !queueEnabled) {
    throw new Error(
      "MESSENGER_GENERATION_INLINE_FALLBACK=0 requires MESSENGER_GENERATION_QUEUE_ENABLED=1 and REDIS_URL"
    );
  }

  if (queueRequested && !queueEnabled) {
    throw new Error(
      "MESSENGER_GENERATION_QUEUE_ENABLED=1 requires REDIS_URL"
    );
  }
}

function getGenerationJobLeaseSeconds(): number {
  const configured = Number(process.env.MESSENGER_GENERATION_JOB_LEASE_SECONDS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : getDefaultGenerationJobLeaseSeconds();
}

function getDefaultGenerationJobLeaseSeconds(): number {
  const configuredOpenAiTimeoutMs = Number(process.env.OPENAI_IMAGE_TIMEOUT_MS);
  const openAiTimeoutMs =
    Number.isFinite(configuredOpenAiTimeoutMs) && configuredOpenAiTimeoutMs > 0
      ? configuredOpenAiTimeoutMs
      : OPENAI_TIMEOUT_MS_DEFAULT;

  return Math.ceil(openAiTimeoutMs / 1000) + DEFAULT_JOB_LEASE_BUFFER_SECONDS;
}

function getGenerationJobMaxAttempts(): number {
  const configured = Number(process.env.MESSENGER_GENERATION_MAX_ATTEMPTS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_MAX_JOB_ATTEMPTS;
}

function getGenerationDrainBatchSize(): number {
  const configured = Number(process.env.MESSENGER_GENERATION_DRAIN_BATCH_SIZE);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_DRAIN_BATCH_SIZE;
}

function getGenerationJobLeaseKey(job: MessengerGenerationJob): string {
  return `messenger-generation-job-lease:${job.reqId}`;
}

function getGenerationJobAcceptedKey(job: MessengerGenerationJob): string {
  return `messenger-generation-job-accepted:${job.reqId}`;
}

function getGenerationJobAcceptedSeconds(): number {
  return getGenerationJobLeaseSeconds() * getGenerationJobMaxAttempts();
}

export async function enqueueMessengerGenerationJob(
  job: MessengerGenerationJob
): Promise<boolean> {
  const redis = await getRedisClient();
  const accepted = await redis.set(
    getGenerationJobAcceptedKey(job),
    "1",
    "EX",
    getGenerationJobAcceptedSeconds(),
    "NX"
  );
  if (accepted !== "OK") {
    safeLog("messenger_generation_job_duplicate_enqueue_ignored", {
      reqId: job.reqId,
      generationKind: job.generationKind ?? null,
    });
    return false;
  }

  await redis.lpush(MESSENGER_GENERATION_QUEUE_KEY, JSON.stringify(job));
  await logMessengerGenerationQueueStats("enqueue", redis);
  return true;
}

export async function getMessengerGenerationQueueStats(): Promise<MessengerGenerationQueueStats> {
  if (!isMessengerGenerationQueueEnabled()) {
    return {
      enabled: false,
      queued: 0,
      processing: 0,
      failed: 0,
    };
  }

  const redis = await getRedisClient();
  return getMessengerGenerationQueueStatsFrom(redis);
}

async function getMessengerGenerationQueueStatsFrom(
  redis: RedisLike
): Promise<MessengerGenerationQueueStats> {
  const [queued, processing, failed] = await Promise.all([
    redis.llen(MESSENGER_GENERATION_QUEUE_KEY),
    redis.llen(MESSENGER_GENERATION_PROCESSING_KEY),
    redis.llen(MESSENGER_GENERATION_DEAD_LETTER_KEY),
  ]);

  return {
    enabled: true,
    queued,
    processing,
    failed,
  };
}

async function logMessengerGenerationQueueStats(
  stage: string,
  redis: RedisLike
): Promise<void> {
  const stats = await getMessengerGenerationQueueStatsFrom(redis);
  safeLog("messenger_generation_queue_stats", {
    stage,
    queued: stats.queued,
    processing: stats.processing,
    failed: stats.failed,
  });
}

type ReservedGenerationJob = {
  raw: string;
  job: MessengerGenerationJob;
};

type InvalidReservedGenerationJob = {
  raw: string;
  invalid: true;
};

class MessengerGenerationJobLeaseExpiredError extends Error {
  constructor() {
    super("Messenger generation job lease expired");
    this.name = "MessengerGenerationJobLeaseExpiredError";
  }
}

async function reserveMessengerGenerationJobFrom(
  redis: RedisLike
): Promise<ReservedGenerationJob | InvalidReservedGenerationJob | null> {
  const raw = await redis.rpoplpush(
    MESSENGER_GENERATION_QUEUE_KEY,
    MESSENGER_GENERATION_PROCESSING_KEY
  );
  if (!raw) {
    return null;
  }

  return parseReservedGenerationJob(raw) ?? { raw, invalid: true };
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
  reserved: ReservedGenerationJob,
  error: unknown
): Promise<"requeued" | "dead_lettered"> {
  const nextAttempt = (reserved.job.attempts ?? 0) + 1;
  const retryJob: MessengerGenerationJob = {
    ...reserved.job,
    attempts: nextAttempt,
  };

  await completeMessengerGenerationJob(redis, reserved);
  if (nextAttempt >= getGenerationJobMaxAttempts()) {
    await redis.rpush(
      MESSENGER_GENERATION_DEAD_LETTER_KEY,
      JSON.stringify(retryJob)
    );
    safeLog("messenger_generation_job_dead_lettered", {
      reqId: reserved.job.reqId,
      generationKind: reserved.job.generationKind ?? null,
      attempts: nextAttempt,
      errorCode:
        error instanceof Error ? error.constructor.name : "UnknownError",
    });
    return "dead_lettered";
  }

  await redis.lpush(MESSENGER_GENERATION_QUEUE_KEY, JSON.stringify(retryJob));
  return "requeued";
}

async function deadLetterInvalidGenerationJob(
  redis: RedisLike,
  raw: string
): Promise<void> {
  await redis.lrem(MESSENGER_GENERATION_PROCESSING_KEY, 1, raw);
  await redis.rpush(MESSENGER_GENERATION_DEAD_LETTER_KEY, raw);
  safeLog("messenger_generation_job_dead_lettered", {
    reqId: null,
    generationKind: null,
    attempts: null,
    errorCode: "InvalidGenerationJobPayload",
  });
}

export async function reclaimReservedMessengerGenerationJobs(
  options: GenerationQueueDrainOptions = {}
): Promise<number> {
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

    const reserved = parseReservedGenerationJob(raw);
    if (!reserved) {
      await deadLetterInvalidGenerationJob(redis, raw);
      reclaimed += 1;
      continue;
    }

    const leaseExpiredError = new MessengerGenerationJobLeaseExpiredError();
    const releaseStatus = await releaseMessengerGenerationJob(
      redis,
      reserved,
      leaseExpiredError
    );
    if (releaseStatus === "dead_lettered" && options.onDeadLetter) {
      try {
        await options.onDeadLetter(reserved.job, leaseExpiredError);
      } catch (deadLetterError) {
        safeLog("messenger_generation_dead_letter_callback_failed", {
          reqId: reserved.job.reqId,
          generationKind: reserved.job.generationKind ?? null,
          errorCode:
            deadLetterError instanceof Error
              ? deadLetterError.constructor.name
              : "UnknownError",
        });
      }
    }
    reclaimed += 1;
  }

  if (reclaimed > 0) {
    await logMessengerGenerationQueueStats("reclaim", redis);
  }

  return reclaimed;
}

async function hasActiveMessengerGenerationJobLease(
  redis: RedisLike,
  rawJob: string
): Promise<boolean> {
  const reserved = parseReservedGenerationJob(rawJob);
  if (!reserved) {
    return false;
  }

  return (await redis.get(getGenerationJobLeaseKey(reserved.job))) !== null;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalGenerationKind(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" &&
      (MESSENGER_GENERATION_KINDS.has(value) ||
        LEGACY_MESSENGER_GENERATION_KINDS.has(value)))
  );
}

function isOptionalAttempts(value: unknown): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isInteger(value) && value >= 0)
  );
}

function parseMessengerGenerationJob(
  value: unknown
): MessengerGenerationJob | null {
  if (!isObjectRecord(value)) {
    return null;
  }

  if (
    typeof value.psid !== "string" ||
    typeof value.userId !== "string" ||
    typeof value.reqId !== "string" ||
    typeof value.lang !== "string" ||
    !MESSENGER_GENERATION_LANGS.has(value.lang) ||
    !isOptionalGenerationKind(value.generationKind) ||
    !isOptionalString(value.sourceImageUrl) ||
    !isOptionalString(value.promptHint) ||
    !isOptionalAttempts(value.attempts)
  ) {
    return null;
  }

  return {
    psid: value.psid,
    userId: value.userId,
    reqId: value.reqId,
    lang: value.lang,
    sourceImageUrl: value.sourceImageUrl,
    promptHint: value.promptHint,
    attempts: value.attempts,
    generationKind:
      value.generationKind === "style_restyle"
        ? "source_image_edit"
        : value.generationKind,
  } as MessengerGenerationJob;
}

function parseReservedGenerationJob(raw: string): ReservedGenerationJob | null {
  try {
    const job = parseMessengerGenerationJob(JSON.parse(raw));
    if (!job) {
      return null;
    }

    return {
      raw,
      job,
    };
  } catch {
    return null;
  }
}

export async function drainMessengerGenerationQueue(
  processor: GenerationJobProcessor,
  options: GenerationQueueDrainOptions = {}
): Promise<void> {
  if (!isMessengerGenerationQueueEnabled()) {
    return;
  }

  const redis = await getRedisClient();
  let drained = 0;
  const maxBatchSize = getGenerationDrainBatchSize();
  while (true) {
    if (drained >= maxBatchSize) {
      await logMessengerGenerationQueueStats("batch_limit", redis);
      return;
    }

    const reserved = await reserveMessengerGenerationJobFrom(redis);
    if (!reserved) {
      return;
    }
    drained += 1;

    if ("invalid" in reserved) {
      await deadLetterInvalidGenerationJob(redis, reserved.raw);
      await logMessengerGenerationQueueStats("invalid", redis);
      continue;
    }

    try {
      await markMessengerGenerationJobReserved(redis, reserved);
      await processor(reserved.job);
      await completeMessengerGenerationJob(redis, reserved);
      await logMessengerGenerationQueueStats("complete", redis);
    } catch (error) {
      safeLog("messenger_generation_job_failed", {
        reqId: reserved.job.reqId,
        generationKind: reserved.job.generationKind ?? null,
        attempts: (reserved.job.attempts ?? 0) + 1,
        errorCode: error instanceof Error ? error.constructor.name : "UnknownError",
      });
      const releaseStatus = await releaseMessengerGenerationJob(
        redis,
        reserved,
        error
      );
      if (releaseStatus === "dead_lettered" && options.onDeadLetter) {
        try {
          await options.onDeadLetter(reserved.job, error);
        } catch (deadLetterError) {
          safeLog("messenger_generation_dead_letter_callback_failed", {
            reqId: reserved.job.reqId,
            generationKind: reserved.job.generationKind ?? null,
            errorCode:
              deadLetterError instanceof Error
                ? deadLetterError.constructor.name
                : "UnknownError",
          });
        }
      }
      await logMessengerGenerationQueueStats("release", redis);
      return;
    }
  }
}

export function scheduleMessengerGenerationQueueDrain(
  processor: GenerationJobProcessor,
  options: GenerationQueueDrainOptions = {}
): void {
  if (!isMessengerGenerationQueueEnabled() || drainPromise) {
    return;
  }

  drainPromise = (async () => {
    await reclaimReservedMessengerGenerationJobs(options);
    await drainMessengerGenerationQueue(processor, options);
  })().finally(() => {
    drainPromise = null;
  });
}

export async function enqueueOrRunMessengerGenerationJob(
  job: MessengerGenerationJob,
  processor: GenerationJobProcessor,
  options: GenerationQueueDrainOptions = {}
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
    scheduleMessengerGenerationQueueDrain(processor, options);
  }
  return { mode: "queued" };
}

export function resetMessengerGenerationQueueForTests(): void {
  drainPromise = null;
}
