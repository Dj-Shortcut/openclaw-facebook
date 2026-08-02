import { createHash, randomUUID } from "node:crypto";

import { getRedisClient, isRedisEnabled, type RedisLike } from "./redis";
import { safeLog } from "./messengerApi";
import { recordMessengerDuplicateSkip } from "./botRuntimeStats";
import {
  createMessengerGenerationTenantPartition,
  isMessengerGenerationTenantPartition,
  type MessengerGenerationJob,
} from "./messengerGenerationJob";
import {
  parseReservedGenerationJob,
  type ReservedGenerationJob,
} from "./messengerGenerationJobPayload";

const LEGACY_MESSENGER_GENERATION_QUEUE_KEY = "messenger-generation-jobs";
const LEGACY_MESSENGER_GENERATION_PROCESSING_KEY =
  "messenger-generation-jobs:processing";
const LEGACY_MESSENGER_GENERATION_DEAD_LETTER_KEY =
  "messenger-generation-jobs:dead";
const MESSENGER_GENERATION_PARTITION_INDEX_KEY =
  "messenger-generation-job-partitions:v1";
const DEFAULT_JOB_LEASE_BUFFER_SECONDS = 60;
const OPENAI_TIMEOUT_MS_DEFAULT = 180_000;
const OPENAI_RETRY_LIMIT_DEFAULT = 1;
const OPENAI_RETRY_BASE_MS_DEFAULT = 500;
const DEFAULT_MAX_JOB_ATTEMPTS = 3;
const DEFAULT_DRAIN_BATCH_SIZE = 10;
const DEFAULT_ACCEPTED_TTL_SECONDS = 7 * 24 * 60 * 60;
let drainPromise: Promise<void> | null = null;
let drainRequested = false;
let drainRetryTimer: ReturnType<typeof setTimeout> | null = null;
let didWarnLegacyCrossSlot = false;

const ATOMIC_PARTITION_ENQUEUE_SCRIPT = `
  local acceptedType = redis.call("TYPE", KEYS[1]).ok
  if acceptedType ~= "none" and acceptedType ~= "string" then
    return redis.error_reply("accepted key is not a string")
  end

  local queueType = redis.call("TYPE", KEYS[2]).ok
  if queueType ~= "none" and queueType ~= "list" then
    return redis.error_reply("queue key is not a list")
  end

  if redis.call("EXISTS", KEYS[1]) == 1 then
    return 0
  end

  local accepted = redis.call("SET", KEYS[1], "1", "EX", ARGV[1], "NX")
  if not accepted then
    return 0
  end

  local pushed = redis.pcall("LPUSH", KEYS[2], ARGV[2])
  if type(pushed) == "table" and pushed.err then
    redis.call("DEL", KEYS[1])
    return redis.error_reply(pushed.err)
  end
  return 1
`;

const ATOMIC_PARTITION_RESERVE_SCRIPT = `
  local queueType = redis.call("TYPE", KEYS[1]).ok
  if queueType ~= "none" and queueType ~= "list" then
    return redis.error_reply("queue key is not a list")
  end

  local processingType = redis.call("TYPE", KEYS[2]).ok
  if processingType ~= "none" and processingType ~= "list" then
    return redis.error_reply("processing key is not a list")
  end

  local leaseType = redis.call("TYPE", KEYS[3]).ok
  if leaseType ~= "none" and leaseType ~= "string" then
    return redis.error_reply("lease key is not a string")
  end

  if redis.call("GET", KEYS[3]) == ARGV[2] then
    local processing = redis.call("LRANGE", KEYS[2], 0, -1)
    for i = 1, #processing do
      if processing[i] == ARGV[1] then
        return 2
      end
    end
    return -3
  end

  if redis.call("EXISTS", KEYS[3]) == 1 then
    return -2
  end

  local tail = redis.call("LINDEX", KEYS[1], -1)
  if not tail then
    return 0
  end
  if tail ~= ARGV[1] then
    return -1
  end

  local raw = redis.call("RPOP", KEYS[1])
  local pushed = redis.pcall("LPUSH", KEYS[2], raw)
  if type(pushed) == "table" and pushed.err then
    redis.call("RPUSH", KEYS[1], raw)
    return redis.error_reply(pushed.err)
  end

  local leased = redis.pcall("SET", KEYS[3], ARGV[2], "EX", ARGV[3])
  if type(leased) == "table" and leased.err then
    redis.call("LPOP", KEYS[2])
    redis.call("RPUSH", KEYS[1], raw)
    return redis.error_reply(leased.err)
  end
  return 1
`;

const ATOMIC_PARTITION_COMPLETE_SCRIPT = `
  local processingType = redis.call("TYPE", KEYS[1]).ok
  if processingType ~= "none" and processingType ~= "list" then
    return redis.error_reply("processing key is not a list")
  end

  local leaseType = redis.call("TYPE", KEYS[2]).ok
  if leaseType ~= "none" and leaseType ~= "string" then
    return redis.error_reply("lease key is not a string")
  end

  local receiptType = redis.call("TYPE", KEYS[3]).ok
  if receiptType ~= "none" and receiptType ~= "string" then
    return redis.error_reply("receipt key is not a string")
  end

  if redis.call("GET", KEYS[3]) == "completed" then
    return 2
  end
  if redis.call("GET", KEYS[2]) ~= ARGV[2] then
    return 0
  end

  local processing = redis.call("LRANGE", KEYS[1], 0, -1)
  local found = 0
  for i = 1, #processing do
    if processing[i] == ARGV[1] then
      found = 1
      break
    end
  end
  if found == 0 then
    return -1
  end

  redis.call("LREM", KEYS[1], 1, ARGV[1])
  redis.call("DEL", KEYS[2])
  local receipt = redis.pcall("SET", KEYS[3], "completed", "EX", ARGV[3])
  if type(receipt) == "table" and receipt.err then
    return 3
  end
  return 1
`;

const ATOMIC_PARTITION_TRANSITION_SCRIPT = `
  local processingType = redis.call("TYPE", KEYS[1]).ok
  if processingType ~= "none" and processingType ~= "list" then
    return redis.error_reply("processing key is not a list")
  end

  local leaseType = redis.call("TYPE", KEYS[2]).ok
  if leaseType ~= "none" and leaseType ~= "string" then
    return redis.error_reply("lease key is not a string")
  end

  local destinationType = redis.call("TYPE", KEYS[3]).ok
  if destinationType ~= "none" and destinationType ~= "list" then
    return redis.error_reply("destination key is not a list")
  end

  local receiptType = redis.call("TYPE", KEYS[4]).ok
  if receiptType ~= "none" and receiptType ~= "string" then
    return redis.error_reply("receipt key is not a string")
  end

  if redis.call("GET", KEYS[4]) == ARGV[4] then
    return 2
  end

  if ARGV[6] == "owned" then
    if redis.call("GET", KEYS[2]) ~= ARGV[3] then
      return 0
    end
  elseif redis.call("EXISTS", KEYS[2]) == 1 then
    return -2
  end

  local processing = redis.call("LRANGE", KEYS[1], 0, -1)
  local found = 0
  for i = 1, #processing do
    if processing[i] == ARGV[1] then
      found = 1
      break
    end
  end
  if found == 0 then
    return -1
  end

  local pushed
  if ARGV[5] == "dead" then
    pushed = redis.pcall("RPUSH", KEYS[3], ARGV[2])
  else
    pushed = redis.pcall("LPUSH", KEYS[3], ARGV[2])
  end
  if type(pushed) == "table" and pushed.err then
    return redis.error_reply(pushed.err)
  end

  redis.call("LREM", KEYS[1], 1, ARGV[1])
  redis.call("DEL", KEYS[2])
  local receipt = redis.pcall("SET", KEYS[4], ARGV[4], "EX", ARGV[7])
  if type(receipt) == "table" and receipt.err then
    return 3
  end
  return 1
`;

const ATOMIC_PARTITION_INVALID_QUEUED_SCRIPT = `
  local queueType = redis.call("TYPE", KEYS[1]).ok
  if queueType ~= "none" and queueType ~= "list" then
    return redis.error_reply("queue key is not a list")
  end
  local deadType = redis.call("TYPE", KEYS[2]).ok
  if deadType ~= "none" and deadType ~= "list" then
    return redis.error_reply("dead-letter key is not a list")
  end
  if redis.call("LINDEX", KEYS[1], -1) ~= ARGV[1] then
    return 0
  end
  redis.call("RPOPLPUSH", KEYS[1], KEYS[2])
  return 1
`;

const ATOMIC_PARTITION_INVALID_PROCESSING_SCRIPT = `
  local processingType = redis.call("TYPE", KEYS[1]).ok
  if processingType ~= "none" and processingType ~= "list" then
    return redis.error_reply("processing key is not a list")
  end
  local deadType = redis.call("TYPE", KEYS[2]).ok
  if deadType ~= "none" and deadType ~= "list" then
    return redis.error_reply("dead-letter key is not a list")
  end
  local leaseType = redis.call("TYPE", KEYS[3]).ok
  if leaseType ~= "none" and leaseType ~= "string" then
    return redis.error_reply("lease key is not a string")
  end
  if redis.call("EXISTS", KEYS[3]) == 1 then
    return -2
  end

  local processing = redis.call("LRANGE", KEYS[1], 0, -1)
  local found = 0
  for i = 1, #processing do
    if processing[i] == ARGV[1] then
      found = 1
      break
    end
  end
  if found == 0 then
    return 0
  end

  local pushed = redis.pcall("RPUSH", KEYS[2], ARGV[1])
  if type(pushed) == "table" and pushed.err then
    return redis.error_reply(pushed.err)
  end
  redis.call("LREM", KEYS[1], 1, ARGV[1])
  return 1
`;

type GenerationQueueScope =
  | {
      kind: "legacy";
      queuedKey: string;
      processingKey: string;
      deadLetterKey: string;
    }
  | {
      kind: "partition";
      tenantPartition: string;
      queuedKey: string;
      processingKey: string;
      deadLetterKey: string;
    };

type PartitionedGenerationQueueScope = Extract<
  GenerationQueueScope,
  { kind: "partition" }
>;

type OwnedReservedGenerationJob = ReservedGenerationJob & {
  leaseToken: string | null;
};

const LEGACY_GENERATION_QUEUE_SCOPE: GenerationQueueScope = {
  kind: "legacy",
  queuedKey: LEGACY_MESSENGER_GENERATION_QUEUE_KEY,
  processingKey: LEGACY_MESSENGER_GENERATION_PROCESSING_KEY,
  deadLetterKey: LEGACY_MESSENGER_GENERATION_DEAD_LETTER_KEY,
};

type GenerationJobProcessor = (job: MessengerGenerationJob) => Promise<unknown>;

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

function getMessengerGenerationPartitionSecret(): string | null {
  return (
    process.env.MESSENGER_GENERATION_PARTITION_SECRET?.trim() ||
    process.env.FB_APP_SECRET?.trim() ||
    null
  );
}

function getPartitionedGenerationQueueScope(
  tenantPartition: string
): PartitionedGenerationQueueScope {
  const keyPrefix = `messenger-generation-jobs:{${tenantPartition}}`;
  return {
    kind: "partition",
    tenantPartition,
    queuedKey: `${keyPrefix}:queued`,
    processingKey: `${keyPrefix}:processing`,
    deadLetterKey: `${keyPrefix}:dead`,
  };
}

async function getGenerationQueueScopes(
  redis: RedisLike
): Promise<GenerationQueueScope[]> {
  const tenantPartitions = await redis.smembers(
    MESSENGER_GENERATION_PARTITION_INDEX_KEY
  );
  return [
    ...tenantPartitions
      .filter(isMessengerGenerationTenantPartition)
      .map(getPartitionedGenerationQueueScope),
    LEGACY_GENERATION_QUEUE_SCOPE,
  ];
}

function getPartitionedJob(job: MessengerGenerationJob): {
  job: MessengerGenerationJob;
  scope: PartitionedGenerationQueueScope;
} {
  const pageId = job.pageId?.trim();
  if (!pageId) {
    throw new Error(
      "Messenger generation queue requires a receiving Page boundary"
    );
  }

  const partitionSecret = getMessengerGenerationPartitionSecret();
  if (!partitionSecret) {
    throw new Error(
      "Messenger generation queue requires a tenant partition secret"
    );
  }

  const tenantPartition = createMessengerGenerationTenantPartition(
    pageId,
    partitionSecret
  );
  return {
    job: {
      ...job,
      pageId,
      tenantPartition,
    },
    scope: getPartitionedGenerationQueueScope(tenantPartition),
  };
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
    throw new Error("MESSENGER_GENERATION_QUEUE_ENABLED=1 requires REDIS_URL");
  }

  if (queueEnabled && !getMessengerGenerationPartitionSecret()) {
    throw new Error(
      "MESSENGER_GENERATION_QUEUE_ENABLED=1 requires MESSENGER_GENERATION_PARTITION_SECRET or FB_APP_SECRET"
    );
  }
}

function getGenerationJobLeaseSeconds(): number {
  const derivedMinimum = getDefaultGenerationJobLeaseSeconds();
  const configured = Number(process.env.MESSENGER_GENERATION_JOB_LEASE_SECONDS);
  return Number.isFinite(configured) && configured > 0
    ? Math.max(Math.floor(configured), derivedMinimum)
    : derivedMinimum;
}

function getDefaultGenerationJobLeaseSeconds(): number {
  const configuredOpenAiTimeoutMs = Number(process.env.OPENAI_IMAGE_TIMEOUT_MS);
  const openAiTimeoutMs =
    Number.isFinite(configuredOpenAiTimeoutMs) && configuredOpenAiTimeoutMs > 0
      ? configuredOpenAiTimeoutMs
      : OPENAI_TIMEOUT_MS_DEFAULT;
  const configuredRetryLimit = Number(process.env.OPENAI_IMAGE_MAX_RETRIES);
  const retryLimit =
    Number.isFinite(configuredRetryLimit) && configuredRetryLimit >= 0
      ? Math.floor(configuredRetryLimit)
      : OPENAI_RETRY_LIMIT_DEFAULT;
  const configuredRetryBaseMs = Number(process.env.OPENAI_IMAGE_RETRY_BASE_MS);
  const retryBaseMs =
    Number.isFinite(configuredRetryBaseMs) && configuredRetryBaseMs > 0
      ? configuredRetryBaseMs
      : OPENAI_RETRY_BASE_MS_DEFAULT;
  const retryWaitMs = retryLimit > 0 ? retryBaseMs * (2 ** retryLimit - 1) : 0;
  const maximumProviderMs = openAiTimeoutMs * (retryLimit + 1) + retryWaitMs;

  if (!Number.isSafeInteger(Math.ceil(maximumProviderMs / 1000))) {
    throw new Error(
      "OpenAI image retry configuration requires an explicit safe Messenger generation lease"
    );
  }

  return Math.ceil(maximumProviderMs / 1000) + DEFAULT_JOB_LEASE_BUFFER_SECONDS;
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

function getGenerationJobKeyToken(job: MessengerGenerationJob): string {
  return createHash("sha256").update(job.reqId).digest("hex");
}

function getGenerationJobLeaseKey(
  scope: GenerationQueueScope,
  job: MessengerGenerationJob
): string {
  if (scope.kind === "legacy") {
    return `messenger-generation-job-lease:${job.reqId}`;
  }

  return `messenger-generation-jobs:{${scope.tenantPartition}}:lease:${getGenerationJobKeyToken(job)}`;
}

function getGenerationJobAcceptedKey(
  scope: PartitionedGenerationQueueScope,
  job: MessengerGenerationJob
): string {
  return `messenger-generation-jobs:{${scope.tenantPartition}}:accepted:${getGenerationJobKeyToken(job)}`;
}

function getGenerationJobAcceptedSeconds(): number {
  const minimumSeconds =
    getGenerationJobLeaseSeconds() * getGenerationJobMaxAttempts();
  const configured = Number(
    process.env.MESSENGER_GENERATION_ACCEPTED_TTL_SECONDS
  );
  const requestedSeconds =
    Number.isFinite(configured) && configured > 0
      ? Math.floor(configured)
      : DEFAULT_ACCEPTED_TTL_SECONDS;
  return Math.max(minimumSeconds, requestedSeconds);
}

function getGenerationTransitionReceiptSeconds(): number {
  return Math.max(60, getGenerationJobLeaseSeconds() * 2);
}

function getGenerationTransitionReceiptKey(
  scope: PartitionedGenerationQueueScope,
  leaseToken: string
): string {
  return `messenger-generation-jobs:{${scope.tenantPartition}}:transition:${leaseToken}`;
}

function getPotentialGenerationJobLeaseKey(
  scope: PartitionedGenerationQueueScope,
  raw: string
): string {
  const reserved = parseReservedGenerationJob(raw);
  if (reserved) {
    return getGenerationJobLeaseKey(scope, reserved.job);
  }
  const rawToken = createHash("sha256").update(raw).digest("hex");
  return `messenger-generation-jobs:{${scope.tenantPartition}}:invalid-lease:${rawToken}`;
}

async function evalPartitionScriptWithRetry(
  redis: RedisLike,
  script: string,
  keys: string[],
  args: Array<string | number>
): Promise<number> {
  const evaluate = async () =>
    Number(await redis.eval(script, keys.length, ...keys, ...args));
  try {
    return await evaluate();
  } catch {
    return await evaluate();
  }
}

function logMessengerGenerationQueueTransition(stage: string): void {
  safeLog("messenger_generation_queue_transition", { stage });
}

function isRedisCrossSlotError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /\bCROSSSLOT\b|keys in request.*hash/i.test(error.message)
  );
}

function warnLegacyCrossSlotOnce(): void {
  if (didWarnLegacyCrossSlot) {
    return;
  }
  didWarnLegacyCrossSlot = true;
  safeLog("messenger_generation_legacy_queue_cross_slot_skipped", {
    level: "warn",
  });
}

export async function enqueueMessengerGenerationJob(
  job: MessengerGenerationJob
): Promise<boolean> {
  const partitioned = getPartitionedJob(job);
  const redis = await getRedisClient();
  await redis.sadd(
    MESSENGER_GENERATION_PARTITION_INDEX_KEY,
    partitioned.scope.tenantPartition
  );
  const accepted = await evalPartitionScriptWithRetry(
    redis,
    ATOMIC_PARTITION_ENQUEUE_SCRIPT,
    [
      getGenerationJobAcceptedKey(partitioned.scope, partitioned.job),
      partitioned.scope.queuedKey,
    ],
    [getGenerationJobAcceptedSeconds(), JSON.stringify(partitioned.job)]
  );
  if (accepted === 0) {
    recordMessengerDuplicateSkip();
    safeLog("messenger_generation_job_duplicate_enqueue_ignored", {
      reqId: job.reqId,
      generationKind: job.generationKind ?? null,
    });
    return false;
  }
  if (accepted !== 1) {
    throw new Error("Messenger generation enqueue returned an invalid result");
  }

  logMessengerGenerationQueueTransition("enqueue");
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
  const scopes = await getGenerationQueueScopes(redis);
  const scopeStats = await Promise.all(
    scopes.map(async scope => {
      const [queued, processing, failed] = await Promise.all([
        redis.llen(scope.queuedKey),
        redis.llen(scope.processingKey),
        redis.llen(scope.deadLetterKey),
      ]);
      return { queued, processing, failed };
    })
  );

  return {
    enabled: true,
    queued: scopeStats.reduce((total, stats) => total + stats.queued, 0),
    processing: scopeStats.reduce(
      (total, stats) => total + stats.processing,
      0
    ),
    failed: scopeStats.reduce((total, stats) => total + stats.failed, 0),
  };
}

type InvalidReservedGenerationJob = {
  raw: string;
  invalid: true;
  deadLettered: boolean;
};

class MessengerGenerationJobLeaseExpiredError extends Error {
  constructor() {
    super("Messenger generation job lease expired");
    this.name = "MessengerGenerationJobLeaseExpiredError";
  }
}

async function reserveMessengerGenerationJobFrom(
  redis: RedisLike,
  scope: GenerationQueueScope
): Promise<OwnedReservedGenerationJob | InvalidReservedGenerationJob | null> {
  if (scope.kind === "legacy") {
    let raw: string | null;
    try {
      raw = await redis.rpoplpush(scope.queuedKey, scope.processingKey);
    } catch (error) {
      if (!isRedisCrossSlotError(error)) {
        throw error;
      }
      warnLegacyCrossSlotOnce();
      return null;
    }
    if (!raw) {
      return null;
    }

    const reserved = parseReservedGenerationJobForScope(raw, scope);
    if (!reserved) {
      return { raw, invalid: true, deadLettered: false };
    }
    await redis.set(
      getGenerationJobLeaseKey(scope, reserved.job),
      "1",
      "EX",
      getGenerationJobLeaseSeconds()
    );
    return { ...reserved, leaseToken: null };
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [raw] = await redis.lrange(scope.queuedKey, -1, -1);
    if (!raw) {
      return null;
    }

    const reserved = parseReservedGenerationJobForScope(raw, scope);
    if (!reserved) {
      const moved = await evalPartitionScriptWithRetry(
        redis,
        ATOMIC_PARTITION_INVALID_QUEUED_SCRIPT,
        [scope.queuedKey, scope.deadLetterKey],
        [raw]
      );
      if (moved === 1) {
        return { raw, invalid: true, deadLettered: true };
      }
      if (moved === 0) {
        continue;
      }
      throw new Error(
        "Messenger generation invalid-job transition returned an invalid result"
      );
    }

    const leaseToken = randomUUID();
    const result = await evalPartitionScriptWithRetry(
      redis,
      ATOMIC_PARTITION_RESERVE_SCRIPT,
      [
        scope.queuedKey,
        scope.processingKey,
        getGenerationJobLeaseKey(scope, reserved.job),
      ],
      [raw, leaseToken, getGenerationJobLeaseSeconds()]
    );
    if (result === 1 || result === 2) {
      return { ...reserved, leaseToken };
    }
    if (result === 0) {
      return null;
    }
    if (result === -1) {
      continue;
    }
    if (result === -2) {
      return null;
    }
    throw new Error("Messenger generation reserve returned an invalid result");
  }

  return null;
}

function parseReservedGenerationJobForScope(
  raw: string,
  scope: GenerationQueueScope
): ReservedGenerationJob | null {
  const reserved = parseReservedGenerationJob(raw);
  if (!reserved) {
    return null;
  }

  if (scope.kind === "legacy") {
    return reserved.job.tenantPartition === undefined ? reserved : null;
  }

  const pageId = reserved.job.pageId?.trim();
  const partitionSecret = getMessengerGenerationPartitionSecret();
  if (!pageId || !partitionSecret) {
    return null;
  }
  const expectedPartition = createMessengerGenerationTenantPartition(
    pageId,
    partitionSecret
  );
  return reserved.job.tenantPartition === scope.tenantPartition &&
    expectedPartition === scope.tenantPartition
    ? reserved
    : null;
}

async function completeMessengerGenerationJob(
  redis: RedisLike,
  scope: GenerationQueueScope,
  reserved: OwnedReservedGenerationJob
): Promise<boolean> {
  if (scope.kind === "legacy") {
    const removed = await redis.lrem(scope.processingKey, 1, reserved.raw);
    await redis.del(getGenerationJobLeaseKey(scope, reserved.job));
    return removed === 1;
  }
  if (!reserved.leaseToken) {
    return false;
  }

  const result = await evalPartitionScriptWithRetry(
    redis,
    ATOMIC_PARTITION_COMPLETE_SCRIPT,
    [
      scope.processingKey,
      getGenerationJobLeaseKey(scope, reserved.job),
      getGenerationTransitionReceiptKey(scope, reserved.leaseToken),
    ],
    [reserved.raw, reserved.leaseToken, getGenerationTransitionReceiptSeconds()]
  );
  if (result === 1 || result === 2 || result === 3) {
    return true;
  }
  if (result === 0 || result === -1) {
    return false;
  }
  throw new Error("Messenger generation completion returned an invalid result");
}

async function releaseMessengerGenerationJob(
  redis: RedisLike,
  scope: GenerationQueueScope,
  reserved: OwnedReservedGenerationJob,
  error: unknown,
  ownership: "owned" | "expired" = "owned"
): Promise<"requeued" | "dead_lettered" | "active" | "lost_ownership"> {
  const nextAttempt = (reserved.job.attempts ?? 0) + 1;
  const retryJob: MessengerGenerationJob = {
    ...reserved.job,
    attempts: nextAttempt,
  };

  const isDeadLetter = nextAttempt >= getGenerationJobMaxAttempts();
  if (scope.kind === "legacy") {
    if (ownership === "expired") {
      const lease = await redis.get(
        getGenerationJobLeaseKey(scope, reserved.job)
      );
      if (lease !== null) {
        return "active";
      }
    }
    const removed = await redis.lrem(scope.processingKey, 1, reserved.raw);
    if (removed !== 1) {
      return "lost_ownership";
    }
    await redis.del(getGenerationJobLeaseKey(scope, reserved.job));
    if (isDeadLetter) {
      await redis.rpush(scope.deadLetterKey, JSON.stringify(retryJob));
    } else {
      await redis.lpush(scope.queuedKey, JSON.stringify(retryJob));
    }
  } else {
    if (ownership === "owned" && !reserved.leaseToken) {
      return "lost_ownership";
    }
    const transitionName = isDeadLetter ? "dead_lettered" : "requeued";
    const receiptToken =
      ownership === "owned" ? reserved.leaseToken! : randomUUID();
    const result = await evalPartitionScriptWithRetry(
      redis,
      ATOMIC_PARTITION_TRANSITION_SCRIPT,
      [
        scope.processingKey,
        getGenerationJobLeaseKey(scope, reserved.job),
        isDeadLetter ? scope.deadLetterKey : scope.queuedKey,
        getGenerationTransitionReceiptKey(scope, receiptToken),
      ],
      [
        reserved.raw,
        JSON.stringify(retryJob),
        reserved.leaseToken ?? "",
        transitionName,
        isDeadLetter ? "dead" : "retry",
        ownership,
        getGenerationTransitionReceiptSeconds(),
      ]
    );
    if (result === -2) {
      return "active";
    }
    if (result === 0 || result === -1) {
      return "lost_ownership";
    }
    if (result !== 1 && result !== 2 && result !== 3) {
      throw new Error(
        "Messenger generation retry transition returned an invalid result"
      );
    }
  }

  if (isDeadLetter) {
    safeLog("messenger_generation_job_dead_lettered", {
      reqId: reserved.job.reqId,
      generationKind: reserved.job.generationKind ?? null,
      attempts: nextAttempt,
      errorCode:
        error instanceof Error ? error.constructor.name : "UnknownError",
    });
    return "dead_lettered";
  }
  return "requeued";
}

async function deadLetterInvalidGenerationJob(
  redis: RedisLike,
  scope: GenerationQueueScope,
  raw: string,
  alreadyDeadLettered = false
): Promise<boolean> {
  if (!alreadyDeadLettered) {
    if (scope.kind === "partition") {
      const result = await evalPartitionScriptWithRetry(
        redis,
        ATOMIC_PARTITION_INVALID_PROCESSING_SCRIPT,
        [
          scope.processingKey,
          scope.deadLetterKey,
          getPotentialGenerationJobLeaseKey(scope, raw),
        ],
        [raw]
      );
      if (result === -2) {
        return false;
      }
      if (result !== 0 && result !== 1) {
        throw new Error(
          "Messenger generation invalid-processing transition returned an invalid result"
        );
      }
      if (result === 0) {
        return false;
      }
    } else {
      const removed = await redis.lrem(scope.processingKey, 1, raw);
      if (removed !== 1) {
        return false;
      }
      await redis.rpush(scope.deadLetterKey, raw);
    }
  }
  safeLog("messenger_generation_job_dead_lettered", {
    reqId: null,
    generationKind: null,
    attempts: null,
    errorCode: "InvalidGenerationJobPayload",
  });
  return true;
}

export async function reclaimReservedMessengerGenerationJobs(
  options: GenerationQueueDrainOptions = {}
): Promise<number> {
  if (!isMessengerGenerationQueueEnabled()) {
    return 0;
  }

  const redis = await getRedisClient();
  const scopes = await getGenerationQueueScopes(redis);

  let reclaimed = 0;
  for (const scope of scopes) {
    const reservedJobs = await redis.lrange(scope.processingKey, 0, -1);
    for (const raw of reservedJobs) {
      const reserved = parseReservedGenerationJobForScope(raw, scope);
      if (!reserved) {
        const deadLettered = await deadLetterInvalidGenerationJob(
          redis,
          scope,
          raw
        );
        if (deadLettered) {
          reclaimed += 1;
        }
        continue;
      }

      const ownedReserved: OwnedReservedGenerationJob = {
        ...reserved,
        leaseToken: null,
      };
      const leaseExpiredError = new MessengerGenerationJobLeaseExpiredError();
      const releaseStatus = await releaseMessengerGenerationJob(
        redis,
        scope,
        ownedReserved,
        leaseExpiredError,
        "expired"
      );
      if (releaseStatus === "active" || releaseStatus === "lost_ownership") {
        continue;
      }
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
  }

  if (reclaimed > 0) {
    logMessengerGenerationQueueTransition("reclaim");
  }

  return reclaimed;
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
  const scopes = await getGenerationQueueScopes(redis);
  while (true) {
    if (drained >= maxBatchSize) {
      logMessengerGenerationQueueTransition("batch_limit");
      return;
    }

    let reservedInRound = false;
    for (const scope of scopes) {
      if (drained >= maxBatchSize) {
        break;
      }

      const reserved = await reserveMessengerGenerationJobFrom(redis, scope);
      if (!reserved) {
        continue;
      }
      reservedInRound = true;
      drained += 1;

      if ("invalid" in reserved) {
        await deadLetterInvalidGenerationJob(
          redis,
          scope,
          reserved.raw,
          reserved.deadLettered
        );
        logMessengerGenerationQueueTransition("invalid");
        continue;
      }

      let processorError: unknown = null;
      try {
        await processor(reserved.job);
      } catch (error) {
        processorError = error;
      }

      if (processorError === null) {
        const completed = await completeMessengerGenerationJob(
          redis,
          scope,
          reserved
        );
        if (!completed) {
          safeLog("messenger_generation_job_completion_ownership_lost", {
            level: "warn",
            reqId: reserved.job.reqId,
            generationKind: reserved.job.generationKind ?? null,
          });
        }
        logMessengerGenerationQueueTransition("complete");
        continue;
      }

      {
        safeLog("messenger_generation_job_failed", {
          reqId: reserved.job.reqId,
          generationKind: reserved.job.generationKind ?? null,
          attempts: (reserved.job.attempts ?? 0) + 1,
          errorCode:
            processorError instanceof Error
              ? processorError.constructor.name
              : "UnknownError",
        });
        const releaseStatus = await releaseMessengerGenerationJob(
          redis,
          scope,
          reserved,
          processorError
        );
        if (releaseStatus === "dead_lettered" && options.onDeadLetter) {
          try {
            await options.onDeadLetter(reserved.job, processorError);
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
        if (releaseStatus === "lost_ownership" || releaseStatus === "active") {
          safeLog("messenger_generation_job_release_ownership_lost", {
            level: "warn",
            reqId: reserved.job.reqId,
            generationKind: reserved.job.generationKind ?? null,
          });
        }
        logMessengerGenerationQueueTransition("release");
        return;
      }
    }

    if (!reservedInRound) {
      return;
    }
  }
}

export function scheduleMessengerGenerationQueueDrain(
  processor: GenerationJobProcessor,
  options: GenerationQueueDrainOptions = {}
): void {
  if (!isMessengerGenerationQueueEnabled()) {
    return;
  }

  drainRequested = true;
  if (drainPromise || drainRetryTimer) {
    return;
  }

  drainPromise = (async () => {
    while (drainRequested) {
      drainRequested = false;
      await reclaimReservedMessengerGenerationJobs(options);
      await drainMessengerGenerationQueue(processor, options);
    }
  })()
    .catch(error => {
      safeLog("messenger_generation_queue_drain_failed", {
        level: "error",
        errorCode:
          error instanceof Error ? error.constructor.name : "UnknownError",
      });
      drainRequested = true;
      if (!drainRetryTimer) {
        drainRetryTimer = setTimeout(() => {
          drainRetryTimer = null;
          if (drainRequested) {
            scheduleMessengerGenerationQueueDrain(processor, options);
          }
        }, 1_000);
        drainRetryTimer.unref?.();
      }
    })
    .finally(() => {
      drainPromise = null;
      if (drainRequested && !drainRetryTimer) {
        scheduleMessengerGenerationQueueDrain(processor, options);
      }
    });
}

export async function enqueueOrRunMessengerGenerationJob(
  job: MessengerGenerationJob,
  processor: GenerationJobProcessor,
  options: GenerationQueueDrainOptions = {}
): Promise<
  | { mode: "queued" }
  | { mode: "duplicate" }
  | { mode: "inline"; outcome: unknown }
> {
  if (!isMessengerGenerationQueueEnabled()) {
    const outcome = await processor(job);
    return { mode: "inline", outcome };
  }

  const enqueued = await enqueueMessengerGenerationJob(job);
  if (
    isMessengerGenerationInlineFallbackEnabled() &&
    !isMessengerGenerationWorkerMode()
  ) {
    scheduleMessengerGenerationQueueDrain(processor, options);
  }
  return { mode: enqueued ? "queued" : "duplicate" };
}

export function resetMessengerGenerationQueueForTests(): void {
  drainPromise = null;
  drainRequested = false;
  if (drainRetryTimer) {
    clearTimeout(drainRetryTimer);
    drainRetryTimer = null;
  }
  didWarnLegacyCrossSlot = false;
}
