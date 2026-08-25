import { createHash, randomUUID } from "node:crypto";

import { getRedisClient, isRedisEnabled, type RedisLike } from "./redis";
import { safeLog } from "./messengerApi";
import { recordMessengerDuplicateSkip } from "./botRuntimeStats";
import {
  createMessengerGenerationTenantPartition,
  createMessengerGenerationOwnershipPartition,
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
const MESSENGER_GENERATION_V1_PARTITION_INDEX_KEY =
  "messenger-generation-job-partitions:v1";
const MESSENGER_GENERATION_V2_PARTITION_INDEX_KEY =
  "messenger-generation-job-partitions:v2";
const MESSENGER_GENERATION_V1_DRAIN_CURSOR_KEY =
  "messenger-generation-job-drain-cursor:v1";
const MESSENGER_GENERATION_DRAIN_CURSOR_KEY =
  "messenger-generation-job-drain-cursor:v2";
const MESSENGER_GENERATION_SUBJECT_PARTITIONS_PREFIX =
  "messenger-generation-subject-partitions:v1";
const MESSENGER_GENERATION_SUBJECT_ERASED_PREFIX =
  "messenger-generation-subject-erased:v1";
const MESSENGER_GENERATION_PRIVACY_INDEX_VERSION_KEY =
  "messenger-generation-privacy-index-version";
const MESSENGER_GENERATION_PRIVACY_INDEX_VERSION = "v2";
const DEFAULT_JOB_LEASE_BUFFER_SECONDS = 60;
const OPENAI_TIMEOUT_MS_DEFAULT = 180_000;
const OPENAI_TIMEOUT_MS_MAX = 5 * 60_000;
const OPENAI_RETRY_LIMIT_DEFAULT = 1;
const OPENAI_RETRY_BASE_MS_DEFAULT = 500;
const DEFAULT_MAX_JOB_ATTEMPTS = 3;
const DEFAULT_DRAIN_BATCH_SIZE = 10;
const DEFAULT_ACCEPTED_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_DRAIN_RETRY_MS = 1_000;
const MAX_LEASE_HEARTBEAT_INTERVAL_MS = 30_000;
const MIN_LEASE_HEARTBEAT_INTERVAL_MS = 100;
let drainPromise: Promise<void> | null = null;
let drainRequested = false;
let drainRetryTimer: ReturnType<typeof setTimeout> | null = null;
let didWarnLegacyCrossSlot = false;

type MessengerGenerationQueueVersion = "v1" | "v2";

const MESSENGER_GENERATION_QUEUE_VERSIONS: readonly MessengerGenerationQueueVersion[] =
  ["v2", "v1"];

const ATOMIC_PARTITION_ENQUEUE_SCRIPT = `
  local acceptedType = redis.call("TYPE", KEYS[1]).ok
  if acceptedType ~= "none" and acceptedType ~= "string" then
    return redis.error_reply("accepted key is not a string")
  end

  local queueType = redis.call("TYPE", KEYS[2]).ok
  if queueType ~= "none" and queueType ~= "list" then
    return redis.error_reply("queue key is not a list")
  end

  local contentType = redis.call("TYPE", KEYS[3]).ok
  if contentType ~= "none" and contentType ~= "string" then
    return redis.error_reply("content key is not a string")
  end
  local subjectType = redis.call("TYPE", KEYS[4]).ok
  if subjectType ~= "none" and subjectType ~= "set" then
    return redis.error_reply("subject index is not a set")
  end
  local tombstoneType = redis.call("TYPE", KEYS[5]).ok
  if tombstoneType ~= "none" and tombstoneType ~= "string" then
    return redis.error_reply("subject tombstone is not a string")
  end
  local processingType = redis.call("TYPE", KEYS[6]).ok
  if processingType ~= "none" and processingType ~= "list" then
    return redis.error_reply("processing key is not a list")
  end
  local alternateAcceptedType = redis.call("TYPE", KEYS[7]).ok
  if alternateAcceptedType ~= "none" and alternateAcceptedType ~= "string" then
    return redis.error_reply("alternate accepted key is not a string")
  end

  if redis.call("EXISTS", KEYS[5]) == 1 then
    return -4
  end

  -- During the v1 -> v2 bridge rollout, producers may temporarily write to
  -- either namespace. Both accepted markers share this tenant hash slot, so
  -- this check and the marker write below remain atomic across versions.
  if redis.call("EXISTS", KEYS[7]) == 1 then
    return -6
  end

  if redis.call("EXISTS", KEYS[1]) == 1 then
    local queued = redis.call("LPOS", KEYS[2], ARGV[2])
    local processing = redis.call("LPOS", KEYS[6], ARGV[2])
    if redis.call("GET", KEYS[3]) ~= ARGV[4] or
       redis.call("SISMEMBER", KEYS[4], ARGV[2]) ~= 1 or
       (not queued and not processing) then
      return -5
    end
    return 0
  end

  if redis.call("GET", KEYS[3]) == ARGV[4] and
     redis.call("SISMEMBER", KEYS[4], ARGV[2]) == 1 and
     redis.call("LPOS", KEYS[2], ARGV[2]) then
    local reconciled = redis.call("SET", KEYS[1], ARGV[3], "EX", ARGV[1], "NX")
    if reconciled then return 1 end
    return 0
  end

  redis.call("SET", KEYS[3], ARGV[4], "PXAT", ARGV[6])
  redis.call("SADD", KEYS[4], ARGV[2])
  if redis.call("PTTL", KEYS[4]) < 0 then
    redis.call("PEXPIREAT", KEYS[4], ARGV[6])
  else
    redis.call("PEXPIREAT", KEYS[4], ARGV[6], "GT")
  end
  local pushed = redis.pcall("LPUSH", KEYS[2], ARGV[2])
  if type(pushed) == "table" and pushed.err then
    redis.call("DEL", KEYS[3])
    redis.call("SREM", KEYS[4], ARGV[2])
    return redis.error_reply(pushed.err)
  end
  local accepted = redis.call("SET", KEYS[1], ARGV[3], "EX", ARGV[1], "NX")
  if not accepted then
    redis.call("LREM", KEYS[2], 1, ARGV[2])
    redis.call("DEL", KEYS[3])
    redis.call("SREM", KEYS[4], ARGV[2])
    return 0
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

  if redis.call("EXISTS", KEYS[4]) == 1 then
    return -4
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

const ATOMIC_PARTITION_RENEW_LEASE_SCRIPT = `
  local leaseType = redis.call("TYPE", KEYS[1]).ok
  if leaseType ~= "none" and leaseType ~= "string" then
    return redis.error_reply("lease key is not a string")
  end

  local processingType = redis.call("TYPE", KEYS[2]).ok
  if processingType ~= "none" and processingType ~= "list" then
    return redis.error_reply("processing key is not a list")
  end

  if redis.call("GET", KEYS[1]) ~= ARGV[1] then
    return 0
  end
  if not redis.call("LPOS", KEYS[2], ARGV[2]) then
    return -1
  end
  if redis.call("EXPIRE", KEYS[1], ARGV[3]) ~= 1 then
    return 0
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
  if redis.call("EXISTS", KEYS[6]) == 1 then
    redis.call("LREM", KEYS[1], 0, ARGV[1])
    redis.call("DEL", KEYS[2])
    redis.call("DEL", KEYS[4])
    redis.call("SREM", KEYS[5], ARGV[1])
    return -4
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
  redis.call("DEL", KEYS[4])
  redis.call("SREM", KEYS[5], ARGV[1])
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

  if redis.call("EXISTS", KEYS[7]) == 1 then
    redis.call("LREM", KEYS[1], 0, ARGV[1])
    redis.call("DEL", KEYS[2])
    redis.call("DEL", KEYS[5])
    redis.call("SREM", KEYS[6], ARGV[1])
    return -4
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
    redis.call("DEL", KEYS[5])
  else
    redis.call("SET", KEYS[5], ARGV[8], "PXAT", ARGV[11])
    if redis.call("PTTL", KEYS[6]) < 0 then
      redis.call("PEXPIREAT", KEYS[6], ARGV[11])
    else
      redis.call("PEXPIREAT", KEYS[6], ARGV[11], "GT")
    end
  end
  if ARGV[5] == "dead" then
    pushed = redis.pcall("RPUSH", KEYS[3], ARGV[2])
    redis.call("LTRIM", KEYS[3], -1000, -1)
    redis.call("EXPIRE", KEYS[3], ARGV[10])
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
  if string.match(ARGV[1], "^job%-%x+$") == nil then
    redis.call("RPOP", KEYS[1])
    return 2
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

  if string.match(ARGV[1], "^job%-%x+$") ~= nil then
    local pushed = redis.pcall("RPUSH", KEYS[2], ARGV[1])
    if type(pushed) == "table" and pushed.err then
      return redis.error_reply(pushed.err)
    end
  end
  redis.call("LREM", KEYS[1], 1, ARGV[1])
  return 1
`;

const ATOMIC_PARTITION_EMPTY_SCRIPT = `
  local queued = redis.call("LLEN", KEYS[1])
  local processing = redis.call("LLEN", KEYS[2])
  local dead = redis.call("LLEN", KEYS[3])
  if queued == 0 and processing == 0 and dead == 0 then
    return 1
  end
  return 0
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
      queueVersion: MessengerGenerationQueueVersion;
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

type GenerationJobLeaseHeartbeatStatus =
  "owned" | "lost_ownership" | "renewal_failed";

type GenerationJobLeaseHeartbeat = {
  stop(): Promise<GenerationJobLeaseHeartbeatStatus>;
};

const activeGenerationJobLeaseHeartbeats =
  new Set<GenerationJobLeaseHeartbeat>();

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
  tenantPartition: string,
  queueVersion: MessengerGenerationQueueVersion
): PartitionedGenerationQueueScope {
  const baseKeyPrefix = `messenger-generation-jobs:{${tenantPartition}}`;
  const keyPrefix =
    queueVersion === "v1" ? baseKeyPrefix : `${baseKeyPrefix}:v2`;
  return {
    kind: "partition",
    queueVersion,
    tenantPartition,
    queuedKey: `${keyPrefix}:queued`,
    processingKey: `${keyPrefix}:processing`,
    deadLetterKey: `${keyPrefix}:dead`,
  };
}

function getGenerationPartitionIndexKey(
  queueVersion: MessengerGenerationQueueVersion
): string {
  return queueVersion === "v1"
    ? MESSENGER_GENERATION_V1_PARTITION_INDEX_KEY
    : MESSENGER_GENERATION_V2_PARTITION_INDEX_KEY;
}

function getMessengerGenerationQueueWriteVersion(): MessengerGenerationQueueVersion {
  const configured = process.env.MESSENGER_GENERATION_QUEUE_WRITE_VERSION;
  if (configured === "v1" || configured === "v2") {
    return configured;
  }
  if (configured !== undefined || process.env.NODE_ENV === "production") {
    throw new Error(
      "MESSENGER_GENERATION_QUEUE_WRITE_VERSION must be exactly v1 or v2"
    );
  }
  return "v2";
}

export function assertMessengerGenerationQueueWriteVersionConfig(): void {
  getMessengerGenerationQueueWriteVersion();
}

async function getGenerationQueueScopes(
  redis: RedisLike
): Promise<GenerationQueueScope[]> {
  const indexedPartitions = await Promise.all(
    MESSENGER_GENERATION_QUEUE_VERSIONS.map(async queueVersion => ({
      queueVersion,
      tenantPartitions: await redis.smembers(
        getGenerationPartitionIndexKey(queueVersion)
      ),
    }))
  );
  return [
    ...indexedPartitions.flatMap(({ queueVersion, tenantPartitions }) =>
      tenantPartitions
        .filter(isMessengerGenerationTenantPartition)
        .sort()
        .map(tenantPartition =>
          getPartitionedGenerationQueueScope(tenantPartition, queueVersion)
        )
    ),
    LEGACY_GENERATION_QUEUE_SCOPE,
  ];
}

async function getFairGenerationQueueScopes(
  redis: RedisLike
): Promise<GenerationQueueScope[]> {
  const scopes = await getGenerationQueueScopes(redis);
  if (scopes.length <= 1) {
    return scopes;
  }

  const cursor = await redis.incr(MESSENGER_GENERATION_DRAIN_CURSOR_KEY);
  const cursorOffset = (Math.max(1, cursor) - 1) % scopes.length;
  const start = cursorOffset;
  return [...scopes.slice(start), ...scopes.slice(0, start)];
}

type GenerationQueueDepths = {
  queued: number;
  processing: number;
  failed: number;
};

async function getGenerationQueueDepths(
  redis: RedisLike,
  scope: GenerationQueueScope
): Promise<GenerationQueueDepths> {
  const [queued, processing, failed] = await Promise.all([
    redis.llen(scope.queuedKey),
    redis.llen(scope.processingKey),
    redis.llen(scope.deadLetterKey),
  ]);
  return { queued, processing, failed };
}

function isGenerationQueueScopeEmpty(depths: GenerationQueueDepths): boolean {
  return depths.queued === 0 && depths.processing === 0 && depths.failed === 0;
}

async function pruneEmptyGenerationQueueScope(
  redis: RedisLike,
  scope: GenerationQueueScope,
  observedDepths?: GenerationQueueDepths
): Promise<void> {
  if (scope.kind !== "partition") {
    return;
  }

  if (observedDepths && !isGenerationQueueScopeEmpty(observedDepths)) {
    return;
  }

  const isEmpty = async (): Promise<boolean> => {
    const result = await evalPartitionScriptWithRetry(
      redis,
      ATOMIC_PARTITION_EMPTY_SCRIPT,
      [scope.queuedKey, scope.processingKey, scope.deadLetterKey],
      []
    );
    if (result !== 0 && result !== 1) {
      throw new Error(
        "Messenger generation partition cleanup returned an invalid result"
      );
    }
    return result === 1;
  };

  if (!(await isEmpty())) {
    return;
  }

  await redis.srem(
    getGenerationPartitionIndexKey(scope.queueVersion),
    scope.tenantPartition
  );

  // The global discovery index and partition lists intentionally occupy
  // different Redis Cluster slots. Recheck after removal and restore the
  // opaque member if an enqueue raced the empty observation.
  if (!(await isEmpty())) {
    await redis.sadd(
      getGenerationPartitionIndexKey(scope.queueVersion),
      scope.tenantPartition
    );
  }
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

  const hasOwnership =
    Number.isSafeInteger(job.workspaceId) &&
    (job.workspaceId ?? 0) > 0 &&
    Number.isSafeInteger(job.channelConnectionId) &&
    (job.channelConnectionId ?? 0) > 0 &&
    Number.isSafeInteger(job.bindingEpoch) &&
    (job.bindingEpoch ?? 0) > 0 &&
    Number.isSafeInteger(job.privacyEpoch) &&
    (job.privacyEpoch ?? 0) > 0;
  if (
    (job.workspaceId !== undefined ||
      job.channelConnectionId !== undefined ||
      job.bindingEpoch !== undefined ||
      job.privacyEpoch !== undefined) &&
    !hasOwnership
  ) {
    throw new Error("Messenger generation queue ownership is incomplete");
  }
  if (!hasOwnership && process.env.NODE_ENV === "production") {
    throw new Error(
      "Messenger generation queue requires workspace connection ownership"
    );
  }
  const tenantPartition = hasOwnership
    ? createMessengerGenerationOwnershipPartition(
        {
          workspaceId: job.workspaceId!,
          channelConnectionId: job.channelConnectionId!,
          bindingEpoch: job.bindingEpoch!,
          privacyEpoch: job.privacyEpoch!,
          pageId,
        },
        partitionSecret
      )
    : createMessengerGenerationTenantPartition(pageId, partitionSecret);
  // The queue, not an untrusted caller, establishes the retention clock.
  const createdAt = Date.now();
  const expiresAt = createdAt + getGenerationJobContentSeconds() * 1000;
  return {
    job: {
      ...job,
      createdAt,
      expiresAt,
      pageId,
      tenantPartition,
    },
    scope: getPartitionedGenerationQueueScope(
      tenantPartition,
      getMessengerGenerationQueueWriteVersion()
    ),
  };
}

export function assertMessengerGenerationQueueConfig(): void {
  assertMessengerGenerationQueueWriteVersionConfig();
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

const ASSERT_NO_RAW_PARTITION_PAYLOADS_SCRIPT = `
  for keyIndex = 1, #KEYS do
    local keyType = redis.call("TYPE", KEYS[keyIndex]).ok
    if keyType ~= "none" and keyType ~= "list" then
      return redis.error_reply("generation queue metadata key is not a list")
    end
    local cursor = 0
    repeat
      local values = redis.call("LRANGE", KEYS[keyIndex], cursor, cursor + 99)
      for valueIndex = 1, #values do
        if string.match(values[valueIndex], "^job%-%x+$") == nil then
          return 0
        end
      end
      cursor = cursor + #values
    until #values < 100
  end
  return 1
`;

/** Runtime gate: legacy/raw queues must be purged before a production worker starts. */
export async function ensureMessengerGenerationQueueReady(): Promise<void> {
  assertMessengerGenerationQueueConfig();
  if (!isMessengerGenerationQueueEnabled()) return;
  const redis = await getRedisClient();
  const legacyDepths = await getGenerationQueueDepths(
    redis,
    LEGACY_GENERATION_QUEUE_SCOPE
  );
  if (!isGenerationQueueScopeEmpty(legacyDepths)) {
    throw new Error(
      "Legacy Messenger generation queue must be purged before startup"
    );
  }
  const indexedPartitions = await Promise.all(
    MESSENGER_GENERATION_QUEUE_VERSIONS.map(async queueVersion => ({
      queueVersion,
      partitions: await redis.smembers(
        getGenerationPartitionIndexKey(queueVersion)
      ),
    }))
  );
  const partitionCount = indexedPartitions.reduce(
    (total, entry) => total + entry.partitions.length,
    0
  );
  const privacyIndexVersion = await redis.get(
    MESSENGER_GENERATION_PRIVACY_INDEX_VERSION_KEY
  );
  if (privacyIndexVersion === null && partitionCount === 0) {
    await redis.set(
      MESSENGER_GENERATION_PRIVACY_INDEX_VERSION_KEY,
      MESSENGER_GENERATION_PRIVACY_INDEX_VERSION
    );
  } else if (
    privacyIndexVersion !== MESSENGER_GENERATION_PRIVACY_INDEX_VERSION
  ) {
    throw new Error(
      "Messenger generation queues require the privacy-index purge rehearsal"
    );
  }
  for (const { queueVersion, partitions } of indexedPartitions) {
    for (const tenantPartition of partitions) {
      if (!isMessengerGenerationTenantPartition(tenantPartition)) {
        throw new Error("Messenger generation partition index is invalid");
      }
      const scope = getPartitionedGenerationQueueScope(
        tenantPartition,
        queueVersion
      );
      const clean = await evalPartitionScriptWithRetry(
        redis,
        ASSERT_NO_RAW_PARTITION_PAYLOADS_SCRIPT,
        [scope.queuedKey, scope.processingKey, scope.deadLetterKey],
        []
      );
      if (clean !== 1) {
        throw new Error(
          "Raw Messenger generation payloads must be purged before startup"
        );
      }
    }
  }
}

/** Metadata-safe one-time purge; it never reads or requeues stored payloads. */
export async function purgeUnsafeMessengerGenerationQueues(): Promise<void> {
  if (!isMessengerGenerationQueueEnabled()) {
    throw new Error("Messenger generation Redis queue is unavailable");
  }
  const redis = await getRedisClient();
  await redis.del(LEGACY_MESSENGER_GENERATION_QUEUE_KEY);
  await redis.del(LEGACY_MESSENGER_GENERATION_PROCESSING_KEY);
  await redis.del(LEGACY_MESSENGER_GENERATION_DEAD_LETTER_KEY);
  await deleteRedisKeysByPattern(redis, "messenger-generation-jobs:{*}:*");
  await deleteRedisKeysByPattern(
    redis,
    `${MESSENGER_GENERATION_SUBJECT_PARTITIONS_PREFIX}:*`
  );
  await deleteRedisKeysByPattern(
    redis,
    `${MESSENGER_GENERATION_SUBJECT_ERASED_PREFIX}:*`
  );
  await redis.del(MESSENGER_GENERATION_V1_PARTITION_INDEX_KEY);
  await redis.del(MESSENGER_GENERATION_V2_PARTITION_INDEX_KEY);
  await redis.del(MESSENGER_GENERATION_V1_DRAIN_CURSOR_KEY);
  await redis.del(MESSENGER_GENERATION_DRAIN_CURSOR_KEY);
  await redis.set(
    MESSENGER_GENERATION_PRIVACY_INDEX_VERSION_KEY,
    MESSENGER_GENERATION_PRIVACY_INDEX_VERSION
  );
}

/** Backwards-compatible operator entry point; now purges every unsafe shape. */
export const purgeLegacyMessengerGenerationQueues =
  purgeUnsafeMessengerGenerationQueues;

async function deleteRedisKeysByPattern(
  redis: RedisLike,
  pattern: string
): Promise<void> {
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      200
    );
    for (const key of keys) await redis.del(key);
    cursor = next;
  } while (cursor !== "0");
}

export function getMessengerGenerationJobLeaseSeconds(): number {
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
      ? Math.min(configuredOpenAiTimeoutMs, OPENAI_TIMEOUT_MS_MAX)
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
  return createHash("sha256")
    .update(`${job.userId}\0${job.privacyEpoch ?? 0}\0${job.reqId}`)
    .digest("hex");
}

function getGenerationJobReference(job: MessengerGenerationJob): string {
  return `job-${getGenerationJobKeyToken(job)}`;
}

function getGenerationQueueKeyPrefix(
  scope: PartitionedGenerationQueueScope
): string {
  return scope.queueVersion === "v1"
    ? `messenger-generation-jobs:{${scope.tenantPartition}}`
    : `messenger-generation-jobs:{${scope.tenantPartition}}:v2`;
}

function getGenerationJobContentKey(
  scope: PartitionedGenerationQueueScope,
  job: MessengerGenerationJob
): string {
  return `${getGenerationQueueKeyPrefix(scope)}:content:${getGenerationJobKeyToken(job)}`;
}

function getGenerationSubjectIndexKey(
  scope: PartitionedGenerationQueueScope,
  userKey: string
): string {
  const digest = createHash("sha256").update(userKey).digest("hex");
  return `${getGenerationQueueKeyPrefix(scope)}:subject:${digest}`;
}

function getGenerationSubjectDigest(input: {
  workspaceId?: number;
  channelConnectionId?: number;
  userKey: string;
}): string {
  return createHash("sha256")
    .update(
      `${input.workspaceId ?? 0}\0${input.channelConnectionId ?? 0}\0${input.userKey}`
    )
    .digest("hex");
}

function getGenerationSubjectPartitionsKey(input: {
  workspaceId?: number;
  channelConnectionId?: number;
  userKey: string;
}): string {
  return `${MESSENGER_GENERATION_SUBJECT_PARTITIONS_PREFIX}:${getGenerationSubjectDigest(input)}`;
}

function getGenerationSubjectErasedKey(input: {
  workspaceId?: number;
  channelConnectionId?: number;
  userKey: string;
}): string {
  return `${MESSENGER_GENERATION_SUBJECT_ERASED_PREFIX}:${getGenerationSubjectDigest(input)}`;
}

function parseErasedPrivacyEpoch(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const epoch = Number(value);
  return Number.isSafeInteger(epoch) && epoch > 0 ? epoch : null;
}

async function isGenerationJobSubjectErased(
  redis: RedisLike,
  job: MessengerGenerationJob
): Promise<boolean> {
  const erasedEpoch = parseErasedPrivacyEpoch(
    await redis.get(
      getGenerationSubjectErasedKey({
        workspaceId: job.workspaceId,
        channelConnectionId: job.channelConnectionId,
        userKey: job.userId,
      })
    )
  );
  return erasedEpoch !== null && erasedEpoch >= (job.privacyEpoch ?? 0);
}

function getGenerationSubjectTombstoneKey(
  scope: PartitionedGenerationQueueScope,
  userKey: string
): string {
  return `${getGenerationQueueKeyPrefix(scope)}:erased:${createHash("sha256").update(userKey).digest("hex")}`;
}

function getGenerationJobLeaseKey(
  scope: GenerationQueueScope,
  job: MessengerGenerationJob
): string {
  if (scope.kind === "legacy") {
    return `messenger-generation-job-lease:${job.reqId}`;
  }

  return `${getGenerationQueueKeyPrefix(scope)}:lease:${getGenerationJobKeyToken(job)}`;
}

function getGenerationJobAcceptedKey(
  scope: PartitionedGenerationQueueScope,
  job: MessengerGenerationJob
): string {
  return `${getGenerationQueueKeyPrefix(scope)}:accepted:${getGenerationJobKeyToken(job)}`;
}

function getAlternateGenerationJobAcceptedKey(
  scope: PartitionedGenerationQueueScope,
  job: MessengerGenerationJob
): string {
  const alternateVersion = scope.queueVersion === "v1" ? "v2" : "v1";
  return getGenerationJobAcceptedKey(
    getPartitionedGenerationQueueScope(scope.tenantPartition, alternateVersion),
    job
  );
}

function getGenerationJobAcceptedSeconds(): number {
  const minimumSeconds =
    getMessengerGenerationJobLeaseSeconds() * getGenerationJobMaxAttempts();
  const configured = Number(
    process.env.MESSENGER_GENERATION_ACCEPTED_TTL_SECONDS
  );
  const requestedSeconds =
    Number.isFinite(configured) && configured > 0
      ? Math.floor(configured)
      : DEFAULT_ACCEPTED_TTL_SECONDS;
  return Math.max(minimumSeconds, requestedSeconds);
}

function getGenerationJobContentSeconds(): number {
  const maximumSeconds = 24 * 60 * 60;
  const minimumSeconds =
    getMessengerGenerationJobLeaseSeconds() * getGenerationJobMaxAttempts();
  if (minimumSeconds > maximumSeconds) {
    throw new Error(
      "Messenger generation operation deadline exceeds the 24h content retention cap"
    );
  }
  const configured = Number(
    process.env.MESSENGER_GENERATION_CONTENT_TTL_SECONDS
  );
  const requested =
    Number.isFinite(configured) && configured > 0
      ? Math.floor(configured)
      : maximumSeconds;
  if (requested < minimumSeconds || requested > maximumSeconds) {
    throw new Error(
      "MESSENGER_GENERATION_CONTENT_TTL_SECONDS must cover the operation deadline and be at most 24h"
    );
  }
  return requested;
}

function getGenerationJobRemainingContentSeconds(
  job: MessengerGenerationJob
): number {
  if (!job.expiresAt) return getGenerationJobContentSeconds();
  return Math.max(0, Math.ceil((job.expiresAt - Date.now()) / 1000));
}

function getGenerationTransitionReceiptSeconds(): number {
  return Math.max(60, getMessengerGenerationJobLeaseSeconds() * 2);
}

function getGenerationTransitionReceiptKey(
  scope: PartitionedGenerationQueueScope,
  leaseToken: string
): string {
  return `${getGenerationQueueKeyPrefix(scope)}:transition:${leaseToken}`;
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
  return `${getGenerationQueueKeyPrefix(scope)}:invalid-lease:${rawToken}`;
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
  } catch (error) {
    safeLog("messenger_generation_queue_script_retry", {
      level: "warn",
      errorCode:
        error instanceof Error ? error.constructor.name : "UnknownError",
    });
    return await evaluate();
  }
}

function getGenerationJobLeaseHeartbeatIntervalMs(): number {
  const leaseMs = getMessengerGenerationJobLeaseSeconds() * 1000;
  const maximumSafeInterval = Math.max(
    MIN_LEASE_HEARTBEAT_INTERVAL_MS,
    Math.floor(leaseMs / 3)
  );
  const configured = Number(
    process.env.MESSENGER_GENERATION_LEASE_HEARTBEAT_MS
  );
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(
      MIN_LEASE_HEARTBEAT_INTERVAL_MS,
      Math.min(Math.floor(configured), maximumSafeInterval)
    );
  }
  return Math.min(MAX_LEASE_HEARTBEAT_INTERVAL_MS, maximumSafeInterval);
}

function startGenerationJobLeaseHeartbeat(
  redis: RedisLike,
  scope: GenerationQueueScope,
  reserved: OwnedReservedGenerationJob
): GenerationJobLeaseHeartbeat | null {
  if (scope.kind !== "partition" || !reserved.leaseToken) {
    return null;
  }

  const intervalMs = getGenerationJobLeaseHeartbeatIntervalMs();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  let status: GenerationJobLeaseHeartbeatStatus = "owned";
  let consecutiveFailures = 0;

  const schedule = (delayMs: number): void => {
    if (stopped || status === "lost_ownership") return;
    timer = setTimeout(() => {
      timer = null;
      inFlight = renew().finally(() => {
        inFlight = null;
      });
    }, delayMs);
    timer.unref?.();
  };

  const renew = async (): Promise<void> => {
    if (stopped) return;
    try {
      const result = await evalPartitionScriptWithRetry(
        redis,
        ATOMIC_PARTITION_RENEW_LEASE_SCRIPT,
        [getGenerationJobLeaseKey(scope, reserved.job), scope.processingKey],
        [
          reserved.leaseToken!,
          reserved.raw,
          getMessengerGenerationJobLeaseSeconds(),
        ]
      );
      if (result !== 1) {
        status = "lost_ownership";
        safeLog("messenger_generation_job_heartbeat_ownership_lost", {
          level: "warn",
          reqId: reserved.job.reqId,
          generationKind: reserved.job.generationKind ?? null,
          queueVersion: scope.queueVersion,
        });
        return;
      }
      if (consecutiveFailures > 0) {
        safeLog("messenger_generation_job_heartbeat_recovered", {
          reqId: reserved.job.reqId,
          generationKind: reserved.job.generationKind ?? null,
          queueVersion: scope.queueVersion,
        });
      }
      consecutiveFailures = 0;
      status = "owned";
      schedule(intervalMs);
    } catch (error) {
      consecutiveFailures += 1;
      status = "renewal_failed";
      safeLog("messenger_generation_job_heartbeat_failed", {
        level: "error",
        reqId: reserved.job.reqId,
        generationKind: reserved.job.generationKind ?? null,
        queueVersion: scope.queueVersion,
        consecutiveFailures,
        errorCode:
          error instanceof Error ? error.constructor.name : "UnknownError",
      });
      schedule(Math.min(intervalMs, 1_000));
    }
  };

  const heartbeat: GenerationJobLeaseHeartbeat = {
    async stop() {
      if (!stopped) {
        stopped = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      }
      await inFlight;
      activeGenerationJobLeaseHeartbeats.delete(heartbeat);
      return status;
    },
  };
  activeGenerationJobLeaseHeartbeats.add(heartbeat);
  schedule(intervalMs);
  return heartbeat;
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
  const subjectScope = {
    workspaceId: partitioned.job.workspaceId,
    channelConnectionId: partitioned.job.channelConnectionId,
    userKey: partitioned.job.userId,
  };
  const subjectPartitionsKey = getGenerationSubjectPartitionsKey(subjectScope);
  const subjectErasedKey = getGenerationSubjectErasedKey(subjectScope);
  const subjectPartitionMember = `${partitioned.job.privacyEpoch ?? 0}:${partitioned.scope.tenantPartition}`;
  // Add discovery metadata before checking the durable erasure epoch. This
  // ordering guarantees that a concurrent erase either discovers this
  // partition or is observed below by the producer.
  await redis.sadd(subjectPartitionsKey, subjectPartitionMember);
  const erasedEpoch = parseErasedPrivacyEpoch(
    await redis.get(subjectErasedKey)
  );
  if (
    erasedEpoch !== null &&
    erasedEpoch >= (partitioned.job.privacyEpoch ?? 0)
  ) {
    throw new Error("Messenger generation subject epoch is erased");
  }
  const acceptedKey = getGenerationJobAcceptedKey(
    partitioned.scope,
    partitioned.job
  );
  const enqueueAttemptToken = randomUUID();
  await redis.sadd(
    getGenerationPartitionIndexKey(partitioned.scope.queueVersion),
    partitioned.scope.tenantPartition
  );
  let accepted: number;
  try {
    try {
      accepted = await evalPartitionScriptWithRetry(
        redis,
        ATOMIC_PARTITION_ENQUEUE_SCRIPT,
        [
          acceptedKey,
          partitioned.scope.queuedKey,
          getGenerationJobContentKey(partitioned.scope, partitioned.job),
          getGenerationSubjectIndexKey(
            partitioned.scope,
            partitioned.job.userId
          ),
          getGenerationSubjectTombstoneKey(
            partitioned.scope,
            partitioned.job.userId
          ),
          partitioned.scope.processingKey,
          getAlternateGenerationJobAcceptedKey(
            partitioned.scope,
            partitioned.job
          ),
        ],
        [
          getGenerationJobAcceptedSeconds(),
          getGenerationJobReference(partitioned.job),
          enqueueAttemptToken,
          JSON.stringify(partitioned.job),
          Math.max(1, getGenerationJobRemainingContentSeconds(partitioned.job)),
          partitioned.job.expiresAt!,
        ]
      );
    } catch (error) {
      let storedAttemptToken: string | null;
      try {
        storedAttemptToken = await redis.get(acceptedKey);
      } catch {
        throw error;
      }
      if (storedAttemptToken !== enqueueAttemptToken) {
        throw error;
      }
      accepted = 1;
    }
  } finally {
    // Fence a concurrent empty-scope prune that may have removed the member
    // after the pre-enqueue SADD but before the partition push committed.
    await redis.sadd(
      getGenerationPartitionIndexKey(partitioned.scope.queueVersion),
      partitioned.scope.tenantPartition
    );
  }
  if (accepted === 0) {
    let storedAttemptToken: string | null = null;
    try {
      storedAttemptToken = await redis.get(acceptedKey);
    } catch {
      // The script reported an existing accepted marker, so this attempt did
      // not push another job. A transient reconciliation read must not trigger
      // an inline fallback that could execute the already queued request twice.
    }
    if (storedAttemptToken === enqueueAttemptToken) {
      logMessengerGenerationQueueTransition("enqueue");
      return true;
    }
    recordMessengerDuplicateSkip();
    safeLog("messenger_generation_job_duplicate_enqueue_ignored", {
      reqId: job.reqId,
      generationKind: job.generationKind ?? null,
    });
    return false;
  }
  if (accepted === -4) {
    throw new Error("Messenger generation subject epoch is erased");
  }
  if (accepted === -5) {
    throw new Error("Messenger generation accepted marker is inconsistent");
  }
  if (accepted === -6) {
    recordMessengerDuplicateSkip();
    safeLog("messenger_generation_job_cross_version_duplicate_ignored", {
      reqId: job.reqId,
      generationKind: job.generationKind ?? null,
      writeVersion: partitioned.scope.queueVersion,
    });
    return false;
  }
  if (accepted !== 1) {
    throw new Error("Messenger generation enqueue returned an invalid result");
  }

  const erasedAfterCommit = parseErasedPrivacyEpoch(
    await redis.get(subjectErasedKey)
  );
  if (
    erasedAfterCommit !== null &&
    erasedAfterCommit >= (partitioned.job.privacyEpoch ?? 0)
  ) {
    await scrubGenerationPartitionSubject(
      redis,
      partitioned.scope,
      partitioned.job.userId
    );
    throw new Error(
      "Messenger generation subject epoch was erased during enqueue"
    );
  }

  logMessengerGenerationQueueTransition("enqueue");
  return true;
}

export async function eraseMessengerGenerationJobsForSubject(input: {
  workspaceId: number;
  channelConnectionId: number;
  bindingEpoch: number;
  privacyEpoch: number;
  pageId: string;
  userKey: string;
}): Promise<number> {
  if (!isMessengerGenerationQueueEnabled()) {
    throw new Error(
      "Messenger generation queue must be available for privacy erasure"
    );
  }
  const secret = getMessengerGenerationPartitionSecret();
  if (!secret)
    throw new Error("Messenger generation partition secret is required");
  const redis = await getRedisClient();
  const subjectScope = {
    workspaceId: input.workspaceId,
    channelConnectionId: input.channelConnectionId,
    userKey: input.userKey,
  };
  const erasedKey = getGenerationSubjectErasedKey(subjectScope);
  const storedErasedEpoch = Number(
    await redis.eval(
      `
        local current = tonumber(redis.call("GET", KEYS[1]) or "0")
        local requested = tonumber(ARGV[1])
        if current < requested then
          redis.call("SET", KEYS[1], ARGV[1])
          return requested
        end
        return current
      `,
      1,
      erasedKey,
      input.privacyEpoch
    )
  );
  if (
    !Number.isSafeInteger(storedErasedEpoch) ||
    storedErasedEpoch < input.privacyEpoch
  ) {
    throw new Error("Messenger generation erasure epoch update failed");
  }
  const indexedPartitions = await redis.smembers(
    getGenerationSubjectPartitionsKey(subjectScope)
  );
  const currentPartition = createMessengerGenerationOwnershipPartition(
    input,
    secret
  );
  const partitions = new Set<string>([currentPartition]);
  for (const indexed of indexedPartitions) {
    const separator = indexed.indexOf(":");
    const epoch = Number(indexed.slice(0, separator));
    const partition = indexed.slice(separator + 1);
    if (
      separator > 0 &&
      Number.isSafeInteger(epoch) &&
      epoch <= input.privacyEpoch &&
      isMessengerGenerationTenantPartition(partition)
    ) {
      partitions.add(partition);
    }
  }
  const scopes = [...partitions].flatMap(tenantPartition =>
    MESSENGER_GENERATION_QUEUE_VERSIONS.map(queueVersion =>
      getPartitionedGenerationQueueScope(tenantPartition, queueVersion)
    )
  );
  // Fence every historical partition and both queue versions before scrubbing
  // any one of them. A
  // claimed job may still run local validation, but cannot cross its provider
  // privacy boundary once this phase completes.
  for (const scope of scopes) {
    await redis.set(
      getGenerationSubjectTombstoneKey(scope, input.userKey),
      "erased"
    );
  }
  let total = 0;
  for (const scope of scopes) {
    total += await scrubGenerationPartitionSubject(redis, scope, input.userKey);
  }
  return total;
}

async function scrubGenerationPartitionSubject(
  redis: RedisLike,
  scope: PartitionedGenerationQueueScope,
  userKey: string
): Promise<number> {
  const subjectKey = getGenerationSubjectIndexKey(scope, userKey);
  let total = 0;
  let cursor = "0";
  let iterations = 0;
  do {
    iterations += 1;
    if (iterations > 10_000) {
      throw new Error("Messenger generation subject scrub did not converge");
    }
    const result = await redis.eval(
      `
          local subjectType = redis.call("TYPE", KEYS[4]).ok
          if subjectType ~= "none" and subjectType ~= "set" then
            redis.call("SET", KEYS[5], "corrupt")
            return redis.error_reply("subject index is not a set")
          end
          redis.call("SET", KEYS[5], "erased")
          local scan = redis.call("SSCAN", KEYS[4], ARGV[4], "COUNT", 100)
          local ids = scan[2]
          for i = 1, #ids do
            local ref = ids[i]
            if string.match(ref, "^job%-%x+$") == nil then
              redis.call("SET", KEYS[5], "corrupt")
              return redis.error_reply("subject index contains an invalid job reference")
            end
            local digest = string.gsub(ref, "^job%-", "")
            redis.call("LREM", KEYS[1], 0, ref)
            redis.call("LREM", KEYS[2], 0, ref)
            redis.call("LREM", KEYS[3], 0, ref)
            redis.call("DEL", ARGV[1] .. digest)
            redis.call("DEL", ARGV[2] .. digest)
            redis.call("DEL", ARGV[3] .. digest)
            redis.call("SREM", KEYS[4], ref)
          end
          if redis.call("SCARD", KEYS[4]) == 0 then redis.call("DEL", KEYS[4]) end
          return {scan[1], #ids, redis.call("SCARD", KEYS[4])}
      `,
      5,
      scope.queuedKey,
      scope.processingKey,
      scope.deadLetterKey,
      subjectKey,
      getGenerationSubjectTombstoneKey(scope, userKey),
      `${getGenerationQueueKeyPrefix(scope)}:content:`,
      `${getGenerationQueueKeyPrefix(scope)}:lease:`,
      `${getGenerationQueueKeyPrefix(scope)}:accepted:`,
      cursor
    );
    if (!Array.isArray(result) || result.length !== 3) {
      throw new Error(
        "Messenger generation subject scrub returned invalid progress"
      );
    }
    cursor = String(result[0]);
    total += Number(result[1]);
    const remaining = Number(result[2]);
    if (cursor === "0" && remaining > 0) cursor = "0";
    else if (cursor === "0") return total;
  } while (true);
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
      const depths = await getGenerationQueueDepths(redis, scope);
      return { scope, ...depths };
    })
  );

  await Promise.all(
    scopeStats.map(({ scope, queued, processing, failed }) =>
      pruneEmptyGenerationQueueScope(redis, scope, {
        queued,
        processing,
        failed,
      })
    )
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
    if (process.env.NODE_ENV === "production") {
      const legacyDepths = await getGenerationQueueDepths(redis, scope);
      if (!isGenerationQueueScopeEmpty(legacyDepths)) {
        throw new Error(
          "Legacy Messenger generation queue is blocked in production"
        );
      }
      return null;
    }
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
      getMessengerGenerationJobLeaseSeconds()
    );
    return { ...reserved, leaseToken: null };
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [raw] = await redis.lrange(scope.queuedKey, -1, -1);
    if (!raw) {
      return null;
    }

    const serialized =
      raw.startsWith("{") && process.env.NODE_ENV === "test"
        ? raw
        : await redis.get(
            `${getGenerationQueueKeyPrefix(scope)}:content:${raw.replace(/^job-/, "")}`
          );
    const parsed = serialized
      ? parseReservedGenerationJobForScope(serialized, scope)
      : null;
    const reserved = parsed ? { ...parsed, raw } : null;
    if (!reserved) {
      const moved = await evalPartitionScriptWithRetry(
        redis,
        ATOMIC_PARTITION_INVALID_QUEUED_SCRIPT,
        [scope.queuedKey, scope.deadLetterKey],
        [raw]
      );
      if (moved === 1 || moved === 2) {
        return { raw, invalid: true, deadLettered: true };
      }
      if (moved === 0) {
        continue;
      }
      throw new Error(
        "Messenger generation invalid-job transition returned an invalid result"
      );
    }

    if (await isGenerationJobSubjectErased(redis, reserved.job)) {
      await scrubGenerationPartitionSubject(redis, scope, reserved.job.userId);
      return null;
    }

    const leaseToken = randomUUID();
    const result = await evalPartitionScriptWithRetry(
      redis,
      ATOMIC_PARTITION_RESERVE_SCRIPT,
      [
        scope.queuedKey,
        scope.processingKey,
        getGenerationJobLeaseKey(scope, reserved.job),
        getGenerationSubjectTombstoneKey(scope, reserved.job.userId),
      ],
      [raw, leaseToken, getMessengerGenerationJobLeaseSeconds()]
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
    if (result === -4) {
      await scrubGenerationPartitionSubject(redis, scope, reserved.job.userId);
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
  const hasOwnership =
    Number.isSafeInteger(reserved.job.workspaceId) &&
    (reserved.job.workspaceId ?? 0) > 0 &&
    Number.isSafeInteger(reserved.job.channelConnectionId) &&
    (reserved.job.channelConnectionId ?? 0) > 0 &&
    Number.isSafeInteger(reserved.job.bindingEpoch) &&
    (reserved.job.bindingEpoch ?? 0) > 0 &&
    Number.isSafeInteger(reserved.job.privacyEpoch) &&
    (reserved.job.privacyEpoch ?? 0) > 0;
  if (!hasOwnership && process.env.NODE_ENV === "production") return null;
  const expectedPartition = hasOwnership
    ? createMessengerGenerationOwnershipPartition(
        {
          workspaceId: reserved.job.workspaceId!,
          channelConnectionId: reserved.job.channelConnectionId!,
          bindingEpoch: reserved.job.bindingEpoch!,
          privacyEpoch: reserved.job.privacyEpoch!,
          pageId,
        },
        partitionSecret
      )
    : createMessengerGenerationTenantPartition(pageId, partitionSecret);
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
  if (await isGenerationJobSubjectErased(redis, reserved.job)) {
    await scrubGenerationPartitionSubject(redis, scope, reserved.job.userId);
    return false;
  }

  const result = await evalPartitionScriptWithRetry(
    redis,
    ATOMIC_PARTITION_COMPLETE_SCRIPT,
    [
      scope.processingKey,
      getGenerationJobLeaseKey(scope, reserved.job),
      getGenerationTransitionReceiptKey(scope, reserved.leaseToken),
      getGenerationJobContentKey(scope, reserved.job),
      getGenerationSubjectIndexKey(scope, reserved.job.userId),
      getGenerationSubjectTombstoneKey(scope, reserved.job.userId),
    ],
    [reserved.raw, reserved.leaseToken, getGenerationTransitionReceiptSeconds()]
  );
  if (result === 1 || result === 2 || result === 3) {
    return true;
  }
  if (result === 0 || result === -1 || result === -4) {
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

  const remainingContentSeconds =
    getGenerationJobRemainingContentSeconds(retryJob);
  // A paid admission rollback is compensation for a database acknowledgement
  // lost before provider transport. Keep that exact recovery out of the
  // ordinary three-attempt budget, but never extend the queue's existing 24h
  // privacy/content deadline.
  const hasPendingPaidAdmissionRecovery = Boolean(
    retryJob.startpilotAdmissionRecovery
  );
  const isDeadLetter =
    remainingContentSeconds === 0 ||
    (!hasPendingPaidAdmissionRecovery &&
      nextAttempt >= getGenerationJobMaxAttempts());
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
    if (await isGenerationJobSubjectErased(redis, reserved.job)) {
      await scrubGenerationPartitionSubject(redis, scope, reserved.job.userId);
      return "lost_ownership";
    }
    const transitionName = isDeadLetter ? "dead_lettered" : "requeued";
    const nextReference =
      reserved.raw.startsWith("{") && process.env.NODE_ENV === "test"
        ? JSON.stringify(retryJob)
        : reserved.raw;
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
        getGenerationJobContentKey(scope, reserved.job),
        getGenerationSubjectIndexKey(scope, reserved.job.userId),
        getGenerationSubjectTombstoneKey(scope, reserved.job.userId),
      ],
      [
        reserved.raw,
        nextReference,
        reserved.leaseToken ?? "",
        transitionName,
        isDeadLetter ? "dead" : "retry",
        ownership,
        getGenerationTransitionReceiptSeconds(),
        JSON.stringify(retryJob),
        Math.max(1, remainingContentSeconds),
        Math.max(60, remainingContentSeconds),
        retryJob.expiresAt!,
      ]
    );
    if (result === -2) {
      return "active";
    }
    if (result === 0 || result === -1 || result === -4) {
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
      const serialized =
        scope.kind === "partition"
          ? raw.startsWith("{") && process.env.NODE_ENV === "test"
            ? raw
            : await redis.get(
                `${getGenerationQueueKeyPrefix(scope)}:content:${raw.replace(/^job-/, "")}`
              )
          : raw;
      const parsed = serialized
        ? parseReservedGenerationJobForScope(serialized, scope)
        : null;
      const reserved = parsed ? { ...parsed, raw } : null;
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

type MessengerGenerationDrainResult = {
  needsPacedFollowUp: boolean;
};

async function drainMessengerGenerationQueueWithResult(
  processor: GenerationJobProcessor,
  options: GenerationQueueDrainOptions = {}
): Promise<MessengerGenerationDrainResult> {
  if (!isMessengerGenerationQueueEnabled()) {
    return { needsPacedFollowUp: false };
  }

  const redis = await getRedisClient();
  let drained = 0;
  const maxBatchSize = getGenerationDrainBatchSize();
  const scopes = await getFairGenerationQueueScopes(redis);
  const deferredScopes = new Set<string>();
  const pruneCheckedScopes = new Set<string>();
  let needsPacedFollowUp = false;
  while (true) {
    if (drained >= maxBatchSize) {
      logMessengerGenerationQueueTransition("batch_limit");
      return { needsPacedFollowUp: true };
    }

    let reservedInRound = false;
    for (const scope of scopes) {
      if (drained >= maxBatchSize) {
        break;
      }
      if (deferredScopes.has(scope.queuedKey)) {
        continue;
      }

      const reserved = await reserveMessengerGenerationJobFrom(redis, scope);
      if (!reserved) {
        if (!pruneCheckedScopes.has(scope.queuedKey)) {
          await pruneEmptyGenerationQueueScope(redis, scope);
          pruneCheckedScopes.add(scope.queuedKey);
        }
        continue;
      }
      pruneCheckedScopes.delete(scope.queuedKey);
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

      const leaseHeartbeat = startGenerationJobLeaseHeartbeat(
        redis,
        scope,
        reserved
      );
      let processorError: unknown = null;
      try {
        await processor(reserved.job);
      } catch (error) {
        processorError = error;
      }
      const heartbeatStatus = await leaseHeartbeat?.stop();
      if (
        heartbeatStatus === "lost_ownership" ||
        heartbeatStatus === "renewal_failed"
      ) {
        safeLog("messenger_generation_job_heartbeat_stopped_unhealthy", {
          level: "warn",
          reqId: reserved.job.reqId,
          generationKind: reserved.job.generationKind ?? null,
          heartbeatStatus,
        });
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
        deferredScopes.add(scope.queuedKey);
        needsPacedFollowUp = true;
        continue;
      }
    }

    if (!reservedInRound) {
      return { needsPacedFollowUp };
    }
  }
}

export async function drainMessengerGenerationQueue(
  processor: GenerationJobProcessor,
  options: GenerationQueueDrainOptions = {}
): Promise<void> {
  await drainMessengerGenerationQueueWithResult(processor, options);
}

function armMessengerGenerationQueueDrainRetry(
  processor: GenerationJobProcessor,
  options: GenerationQueueDrainOptions
): void {
  drainRequested = true;
  if (drainRetryTimer) {
    return;
  }

  drainRetryTimer = setTimeout(() => {
    drainRetryTimer = null;
    if (drainRequested) {
      scheduleMessengerGenerationQueueDrain(processor, options);
    }
  }, DEFAULT_DRAIN_RETRY_MS);
  drainRetryTimer.unref?.();
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
      const result = await drainMessengerGenerationQueueWithResult(
        processor,
        options
      );
      if (result.needsPacedFollowUp) {
        armMessengerGenerationQueueDrainRetry(processor, options);
        break;
      }
    }
  })()
    .catch(error => {
      safeLog("messenger_generation_queue_drain_failed", {
        level: "error",
        errorCode:
          error instanceof Error ? error.constructor.name : "UnknownError",
      });
      armMessengerGenerationQueueDrainRetry(processor, options);
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
  for (const heartbeat of activeGenerationJobLeaseHeartbeats) {
    void heartbeat.stop();
  }
  activeGenerationJobLeaseHeartbeats.clear();
  drainPromise = null;
  drainRequested = false;
  if (drainRetryTimer) {
    clearTimeout(drainRetryTimer);
    drainRetryTimer = null;
  }
  didWarnLegacyCrossSlot = false;
}
