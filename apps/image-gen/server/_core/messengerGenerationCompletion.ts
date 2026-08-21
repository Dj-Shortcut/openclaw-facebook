import { createHash, randomUUID } from "node:crypto";
import { storageDelete, storageKeyFromPublicUrl } from "../storage";
import {
  deleteScopedState,
  deleteEphemeralKeyIfValue,
  readScopedState,
  setEphemeralKeyIfAbsent,
  writeScopedState,
} from "./stateStore";
import { assertMessengerPrivacySubject } from "./messengerPrivacySubject";
import { registerMessengerPrivacyOwnership } from "./messengerPrivacyOwnershipHistory";
import { getRedisClient, isRedisEnabled } from "./redis";
import { assertMessengerGenerationOwnership } from "./workspaceEntitlementRuntime";

const GENERATION_COMPLETION_SCOPE = "messenger-generation-completion";
const GENERATION_COMPLETION_USER_INDEX_SCOPE =
  "messenger-generation-completion:user";
const GENERATION_COMPLETION_TTL_SECONDS = 7 * 24 * 60 * 60;
const GENERATION_OBJECT_INVENTORY_TTL_SECONDS = 31 * 24 * 60 * 60;
// Storage POSTs abort within 60 seconds. Keep an additional settle window so
// a response-loss/backend-finalization race cannot let erasure delete a 404
// and finish before the object becomes visible.
const GENERATION_OBJECT_UPLOAD_SETTLE_MS = 5 * 60_000;
const GENERATION_ARTIFACT_CLEANUP_SCOPE =
  "messenger-generation-artifact-cleanup";
const GENERATION_ARTIFACT_CLEANUP_GLOBAL_TAG = "{mgc-cleanup}";
const GENERATION_ARTIFACT_CLEANUP_LEASE_MS = 30_000;
const GENERATION_ARTIFACT_CLEANUP_MAX_ATTEMPTS = 8;
const GENERATION_ARTIFACT_CLEANUP_BATCH_SIZE = 10;
const GENERATION_ARTIFACT_CLEANUP_READINESS_MAX_JOBS = 500;
const GENERATION_ARTIFACT_CLEANUP_MAX_BACKOFF_MS = 60 * 60 * 1_000;
const COMPLETION_ERASURE_BATCH_SIZE = 100;
const COMPLETION_ERASURE_MAX_BATCHES_PER_RUN = 10;
const COMPLETION_ERASURE_MAX_ITEMS_PER_BATCH = 500;
const USER_INDEX_LOCK_TTL_SECONDS = 5;
const USER_INDEX_LOCK_MAX_ATTEMPTS = 20;

export type MessengerGenerationCompletion = {
  reqId: string;
  imageUrl: string;
  completedAt: number;
  deliveryStatus?:
    "pending" | "cleanup_pending" | "cleanup_started" | "delivered";
  deliveredAt?: number;
  userKey?: string;
  workspaceId?: number;
  channelConnectionId?: number;
  bindingEpoch?: number;
  privacyEpoch?: number;
  pageId?: string;
  channel?: "facebook_messenger" | "whatsapp";
  expiresAt?: number;
};

export type MessengerGenerationArtifactCleanupReason =
  "pre_transport_rejected" | "privacy_tombstone" | "ownership_rejected";

type MessengerGenerationArtifactCleanupJob = {
  version: 1;
  jobId: string;
  reqId: string;
  imageUrl: string;
  objectKey: string;
  fence: MessengerGenerationCompletionFence;
  reason: MessengerGenerationArtifactCleanupReason;
  guardsCompletion: boolean;
  status: "pending" | "processing" | "dead";
  attemptCount: number;
  nextAttemptAt: number;
  leaseToken: string | null;
  leaseUntil: number | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  lastErrorCode: string | null;
};

export type MessengerGenerationCompletionFence = Readonly<{
  workspaceId: number;
  channelConnectionId: number;
  bindingEpoch: number;
  privacyEpoch: number;
  userKey: string;
  pageId: string;
  channel?: "facebook_messenger" | "whatsapp";
}>;

const WRITE_COMPLETION_SCRIPT = `
if redis.call('exists', KEYS[3]) == 1 then return {'erased'} end
local existing = redis.call('get', KEYS[1])
if ARGV[4] == 'create' then
  if existing then return {'exists', existing} end
  redis.call('set', KEYS[1], ARGV[1], 'PXAT', ARGV[3])
elseif ARGV[4] == 'deliver' then
  if not existing then return {'missing'} end
  local decoded = cjson.decode(existing)
  local incoming = cjson.decode(ARGV[1])
  if decoded.imageUrl ~= incoming.imageUrl then return {'conflict', existing} end
  if decoded.deliveryStatus == 'cleanup_started' then
    return {'cleanup_started', existing}
  end
  if decoded.deliveryStatus ~= 'delivered' then
    decoded.deliveryStatus = 'delivered'
    decoded.deliveredAt = incoming.deliveredAt
    redis.call('set', KEYS[1], cjson.encode(decoded), 'PXAT', decoded.expiresAt)
  end
  ARGV[3] = tostring(decoded.expiresAt)
else
  return redis.error_reply('invalid completion write mode')
end
redis.call('sadd', KEYS[2], KEYS[1])
local indexTtl = redis.call('pttl', KEYS[2])
if indexTtl < 0 then
  redis.call('pexpireat', KEYS[2], ARGV[3])
else
  redis.call('pexpireat', KEYS[2], ARGV[3], 'GT')
end
if ARGV[5] ~= '' then
  redis.call('sadd', KEYS[4], ARGV[5])
  local objectIndexTtl = redis.call('pttl', KEYS[4])
  if objectIndexTtl < 0 then
    redis.call('pexpireat', KEYS[4], ARGV[6])
  else
    redis.call('pexpireat', KEYS[4], ARGV[6], 'GT')
  end
end
return {'stored'}
`;

const SCHEDULE_ARTIFACT_CLEANUP_SCRIPT = `
local existing = redis.call('get', KEYS[1])
local owned = redis.call('sismember', KEYS[2], ARGV[2]) == 1
  or redis.call('exists', KEYS[5]) == 1
  or ARGV[8] == 'ownership_rejected'
local incoming = cjson.decode(ARGV[1])
if existing then
  local decoded = cjson.decode(existing)
  if decoded.imageUrl == ARGV[3] then
    if decoded.deliveryStatus == 'delivered' then return {'delivered'} end
    if decoded.deliveryStatus ~= 'cleanup_started' then
      decoded.deliveryStatus = 'cleanup_pending'
      redis.call('set', KEYS[1], cjson.encode(decoded), 'PXAT', decoded.expiresAt)
    end
    incoming.guardsCompletion = true
  end
  owned = true
end
if not owned then return {'unowned'} end

local queued = redis.call('get', KEYS[3])
local dueAt = tonumber(ARGV[5])
if queued then
  local decoded = cjson.decode(queued)
  if decoded.objectKey ~= ARGV[2] or decoded.reqId ~= ARGV[4] then
    return {'conflict'}
  end
  if decoded.status == 'processing' and decoded.leaseUntil then
    dueAt = tonumber(decoded.leaseUntil)
  elseif decoded.nextAttemptAt then
    dueAt = tonumber(decoded.nextAttemptAt)
  end
else
  redis.call('set', KEYS[3], cjson.encode(incoming), 'PXAT', ARGV[6])
end
redis.call('zadd', KEYS[4], dueAt, ARGV[7])
local dueTtl = redis.call('pttl', KEYS[4])
if dueTtl < 0 then
  redis.call('pexpireat', KEYS[4], ARGV[6])
else
  redis.call('pexpireat', KEYS[4], ARGV[6], 'GT')
end
return {'scheduled'}
`;

const CLAIM_ARTIFACT_CLEANUP_SCRIPT = `
local serialized = redis.call('get', KEYS[1])
if not serialized then
  redis.call('zrem', KEYS[2], ARGV[1])
  return {'missing'}
end
local job = cjson.decode(serialized)
if job.status == 'dead' then
  redis.call('zrem', KEYS[2], ARGV[1])
  return {'dead'}
end
if job.status == 'processing' and job.leaseUntil and job.leaseUntil > tonumber(ARGV[2]) then
  return {'busy', tostring(job.leaseUntil)}
end
if job.nextAttemptAt > tonumber(ARGV[2]) then
  return {'not_due', tostring(job.nextAttemptAt)}
end

local completion = redis.call('get', KEYS[3])
if job.guardsCompletion and completion then
  local decoded = cjson.decode(completion)
  if decoded.imageUrl ~= job.imageUrl then return {'conflict'} end
  if decoded.deliveryStatus == 'delivered' then
    redis.call('del', KEYS[1])
    redis.call('zrem', KEYS[2], ARGV[1])
    return {'delivered'}
  end
  decoded.deliveryStatus = 'cleanup_started'
  redis.call('set', KEYS[3], cjson.encode(decoded), 'PXAT', decoded.expiresAt)
end

job.status = 'processing'
job.attemptCount = job.attemptCount + 1
job.leaseToken = ARGV[3]
job.leaseUntil = tonumber(ARGV[4])
job.updatedAt = tonumber(ARGV[2])
redis.call('set', KEYS[1], cjson.encode(job), 'PXAT', job.expiresAt)
redis.call('zadd', KEYS[2], job.leaseUntil, ARGV[1])
return {'claimed', cjson.encode(job)}
`;

const COMPLETE_ARTIFACT_CLEANUP_SCRIPT = `
local serialized = redis.call('get', KEYS[1])
if not serialized then return {'missing'} end
local job = cjson.decode(serialized)
if job.status ~= 'processing' or job.leaseToken ~= ARGV[2] then
  return {'lost_lease'}
end
local completion = redis.call('get', KEYS[3])
if job.guardsCompletion and completion then
  local decoded = cjson.decode(completion)
  if decoded.deliveryStatus == 'delivered' then return {'delivered'} end
  if decoded.imageUrl ~= job.imageUrl then return {'conflict'} end
  redis.call('del', KEYS[3])
  redis.call('srem', KEYS[4], KEYS[3])
end
redis.call('srem', KEYS[5], job.objectKey)
redis.call('del', KEYS[1])
redis.call('zrem', KEYS[2], ARGV[1])
redis.call('zrem', KEYS[6], ARGV[1])
return {'completed'}
`;

const FAIL_ARTIFACT_CLEANUP_SCRIPT = `
local serialized = redis.call('get', KEYS[1])
if not serialized then return {'missing'} end
local job = cjson.decode(serialized)
if job.status ~= 'processing' or job.leaseToken ~= ARGV[2] then
  return {'lost_lease'}
end
local completion = redis.call('get', KEYS[3])
if job.guardsCompletion and completion then
  local decoded = cjson.decode(completion)
  if decoded.deliveryStatus == 'delivered' then return {'delivered'} end
  if decoded.imageUrl ~= job.imageUrl then return {'conflict'} end
  decoded.deliveryStatus = 'cleanup_pending'
  redis.call('set', KEYS[3], cjson.encode(decoded), 'PXAT', decoded.expiresAt)
end
job.leaseToken = cjson.null
job.leaseUntil = cjson.null
job.updatedAt = tonumber(ARGV[3])
job.lastErrorCode = ARGV[4]
if job.attemptCount >= tonumber(ARGV[6]) then
  job.status = 'dead'
  redis.call('set', KEYS[1], cjson.encode(job), 'PXAT', job.expiresAt)
  redis.call('zrem', KEYS[2], ARGV[1])
  redis.call('zadd', KEYS[4], ARGV[3], ARGV[1])
  local deadTtl = redis.call('pttl', KEYS[4])
  if deadTtl < 0 then
    redis.call('pexpireat', KEYS[4], job.expiresAt)
  else
    redis.call('pexpireat', KEYS[4], job.expiresAt, 'GT')
  end
  return {'dead'}
end
job.status = 'pending'
job.nextAttemptAt = tonumber(ARGV[5])
redis.call('set', KEYS[1], cjson.encode(job), 'PXAT', job.expiresAt)
redis.call('zadd', KEYS[2], job.nextAttemptAt, ARGV[1])
return {'retry', tostring(job.nextAttemptAt)}
`;

const BEGIN_ERASE_COMPLETIONS_SCRIPT = `
local rootType = redis.call('type', KEYS[1]).ok
local objectType = redis.call('type', KEYS[3]).ok
local tombstoneType = redis.call('type', KEYS[2]).ok
local uploadType = redis.call('type', KEYS[4]).ok
if (rootType ~= 'none' and rootType ~= 'set')
  or (objectType ~= 'none' and objectType ~= 'set')
  or (tombstoneType ~= 'none' and tombstoneType ~= 'string')
  or (uploadType ~= 'none' and uploadType ~= 'zset') then
  return redis.error_reply('messenger completion privacy index is inconsistent')
end
redis.call('set', KEYS[2], ARGV[1])
return 1
`;

const READ_COMPLETION_ERASURE_BATCH_SCRIPT = `
local scan = redis.call('sscan', KEYS[1], ARGV[1], 'COUNT', ARGV[2])
local values = {}
for _, key in ipairs(scan[2]) do
  table.insert(values, key)
  table.insert(values, redis.call('get', key) or '')
end
return {scan[1], values}
`;

const COMMIT_COMPLETION_ERASURE_BATCH_SCRIPT = `
for index = 1, #ARGV, 3 do
  local current = redis.call('get', ARGV[index]) or ''
  if current ~= ARGV[index + 1] then return 0 end
end
for index = 1, #ARGV, 3 do
  redis.call('del', ARGV[index])
  redis.call('srem', KEYS[1], ARGV[index])
  if ARGV[index + 2] ~= '' then
    redis.call('srem', KEYS[2], ARGV[index + 2])
  end
end
return #ARGV / 3
`;

const READ_OBJECT_ERASURE_BATCH_SCRIPT = `
local scan = redis.call('sscan', KEYS[1], ARGV[1], 'COUNT', ARGV[2])
local values = {}
for _, objectKey in ipairs(scan[2]) do
  table.insert(values, objectKey)
  table.insert(values, redis.call('zscore', KEYS[2], objectKey) or '')
end
return {scan[1], values}
`;

const COMMIT_OBJECT_ERASURE_BATCH_SCRIPT = `
for index = 1, #ARGV do
  redis.call('srem', KEYS[1], ARGV[index])
  redis.call('zrem', KEYS[2], ARGV[index])
end
return #ARGV
`;

const FINALIZE_ERASE_COMPLETIONS_SCRIPT = `
if redis.call('exists', KEYS[2]) == 0 then return 0 end
if redis.call('scard', KEYS[1]) ~= 0
  or redis.call('scard', KEYS[3]) ~= 0
  or redis.call('zcard', KEYS[4]) ~= 0
  or redis.call('zcard', KEYS[5]) ~= 0
  or redis.call('zcard', KEYS[6]) ~= 0 then
  return -1
end
redis.call('del', KEYS[1])
redis.call('del', KEYS[3])
redis.call('del', KEYS[4])
redis.call('del', KEYS[5])
redis.call('del', KEYS[6])
return 1
`;

const DELETE_EXACT_COMPLETION_SCRIPT = `
local stored = redis.call('get', KEYS[1])
if not stored then return 0 end
local decoded = cjson.decode(stored)
if decoded.imageUrl ~= ARGV[1] or tostring(decoded.completedAt) ~= ARGV[2] then
  return 0
end
redis.call('del', KEYS[1])
redis.call('srem', KEYS[2], KEYS[1])
return 1
`;

export async function getMessengerGenerationCompletion(
  reqId: string,
  expectedFence?: MessengerGenerationCompletionFence
): Promise<MessengerGenerationCompletion | null> {
  const storageId = expectedFence
    ? completionStorageId(reqId, expectedFence)
    : reqId;
  const completion = await Promise.resolve(
    readScopedState<MessengerGenerationCompletion>(
      GENERATION_COMPLETION_SCOPE,
      storageId
    )
  );
  if (!completion) return null;
  if (expectedFence) {
    if (!matchesFence(completion, expectedFence)) return null;
    await assertMessengerPrivacySubject(expectedFence);
    await assertMessengerGenerationOwnership({
      ...expectedFence,
      channel: expectedFence.channel ?? "facebook_messenger",
    });
  } else if (process.env.NODE_ENV === "production") {
    return null;
  }
  return completion;
}

export async function ensureMessengerGenerationCompletionReady(): Promise<void> {
  if (!isRedisEnabled()) return;
  const redis = await getRedisClient();
  if ((await findLegacyCompletionKeys(redis, 1)).length > 0) {
    throw new Error(
      "Legacy Messenger completion metadata must be purged before startup"
    );
  }
  await reconcileArtifactCleanupGlobalIndex(redis);
  if ((await redisZcard(redis, artifactCleanupGlobalDeadKey())) > 0) {
    throw new Error(
      "Messenger generation artifact cleanup has dead-letter work"
    );
  }
}

/** Metadata-only deploy operation: values are never read or logged. */
export async function purgeLegacyMessengerGenerationCompletions(): Promise<number> {
  if (!isRedisEnabled()) {
    throw new Error("Messenger completion Redis store is unavailable");
  }
  const redis = await getRedisClient();
  const unsafe = await findLegacyCompletionKeys(redis);
  for (const key of unsafe) await redis.del(key);
  return unsafe.length;
}

async function findLegacyCompletionKeys(
  redis: Awaited<ReturnType<typeof getRedisClient>>,
  limit = Number.POSITIVE_INFINITY
): Promise<string[]> {
  const unsafe: string[] = [];
  for (const prefix of [
    GENERATION_COMPLETION_SCOPE,
    GENERATION_COMPLETION_USER_INDEX_SCOPE,
  ]) {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(
        cursor,
        "MATCH",
        `${prefix}:*`,
        "COUNT",
        200
      );
      for (const key of keys) {
        if (
          prefix === GENERATION_COMPLETION_SCOPE &&
          key.startsWith(`${GENERATION_COMPLETION_USER_INDEX_SCOPE}:`)
        ) {
          continue;
        }
        if (!key.startsWith(`${prefix}:{mgc:`)) unsafe.push(key);
        if (unsafe.length >= limit) return unsafe;
      }
      cursor = next;
    } while (cursor !== "0");
  }
  return unsafe;
}

async function reconcileArtifactCleanupGlobalIndex(
  redis: Awaited<ReturnType<typeof getRedisClient>>
): Promise<void> {
  let hasDeadLetter = false;
  let validatedDueJobs = 0;
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(
      cursor,
      "MATCH",
      `${GENERATION_ARTIFACT_CLEANUP_SCOPE}:{mgc:*}:due`,
      "COUNT",
      200
    );
    for (const key of keys) {
      const matched = key.match(/:(\{mgc:[a-f0-9]{64}\}):due$/);
      const tag = matched?.[1];
      if (!tag) {
        throw new Error(
          "Messenger generation artifact cleanup due index is invalid"
        );
      }
      const dueCount = await redisZcard(redis, key);
      validatedDueJobs += dueCount;
      if (
        !Number.isSafeInteger(dueCount) ||
        dueCount < 0 ||
        validatedDueJobs > GENERATION_ARTIFACT_CLEANUP_READINESS_MAX_JOBS
      ) {
        throw new Error(
          "Messenger generation artifact cleanup readiness backlog exceeded"
        );
      }
      const queuedEntries =
        dueCount === 0
          ? []
          : await redisZrange(redis, key, 0, dueCount - 1, true);
      if (queuedEntries.length !== dueCount * 2) {
        throw new Error(
          "Messenger generation artifact cleanup due snapshot is invalid"
        );
      }
      for (let index = 0; index < queuedEntries.length; index += 2) {
        const jobId = queuedEntries[index];
        const rawScore = queuedEntries[index + 1];
        const serialized = await redis.get(
          artifactCleanupPayloadKey(tag, jobId)
        );
        const queued = serialized ? parseArtifactCleanupJob(serialized) : null;
        const expectedScore =
          queued?.status === "processing"
            ? queued.leaseUntil
            : queued?.nextAttemptAt;
        if (
          !queued ||
          queued.jobId !== jobId ||
          subjectTag(queued.fence) !== tag ||
          expectedScore === null ||
          Number(rawScore) !== expectedScore
        ) {
          throw new Error(
            "Messenger generation artifact cleanup pending payload is invalid"
          );
        }
      }
      await refreshArtifactCleanupGlobalDue(redis, tag);
    }
    cursor = next;
  } while (cursor !== "0");

  cursor = "0";
  do {
    const [next, keys] = await redis.scan(
      cursor,
      "MATCH",
      `${GENERATION_ARTIFACT_CLEANUP_SCOPE}:{mgc:*}:dead`,
      "COUNT",
      200
    );
    for (const key of keys) {
      const matched = key.match(/:(\{mgc:[a-f0-9]{64}\}):dead$/);
      const tag = matched?.[1];
      if (!tag) {
        throw new Error(
          "Messenger generation artifact cleanup dead index is invalid"
        );
      }
      const deadCount = await redisZcard(redis, key);
      if (deadCount > 0) {
        const [jobId] = await redisZrange(redis, key, 0, 0);
        if (!jobId || !/^[a-f0-9]{64}$/.test(jobId)) {
          throw new Error(
            "Messenger generation artifact cleanup dead member is invalid"
          );
        }
        hasDeadLetter = true;
        await redisZadd(
          redis,
          artifactCleanupGlobalDeadKey(),
          Date.now(),
          jobId
        );
      }
    }
    cursor = next;
  } while (cursor !== "0");

  if (!hasDeadLetter) {
    await redis.del(artifactCleanupGlobalDeadKey());
  }
}

function completionSubjectKey(
  userKey: string,
  fence?: MessengerGenerationCompletionFence
): string {
  return fence
    ? `${fence.workspaceId}:${fence.channelConnectionId}:${fence.bindingEpoch}:${fence.privacyEpoch}:${userKey}`
    : userKey;
}

function subjectTag(fence: MessengerGenerationCompletionFence): string {
  const digest = createHash("sha256")
    .update(String(fence.workspaceId))
    .update("\0")
    .update(String(fence.channelConnectionId))
    .update("\0")
    .update(fence.userKey);
  if (fence.channel === "whatsapp") {
    digest.update("\0whatsapp");
  }
  const subjectDigest = digest.digest("hex");
  return `{mgc:${subjectDigest}}`;
}

function completionStorageId(
  reqId: string,
  fence: MessengerGenerationCompletionFence
): string {
  const digest = createHash("sha256")
    .update(String(fence.workspaceId))
    .update("\0")
    .update(String(fence.channelConnectionId))
    .update("\0")
    .update(String(fence.bindingEpoch))
    .update("\0")
    .update(String(fence.privacyEpoch))
    .update("\0")
    .update(fence.userKey)
    .update("\0")
    .update(reqId);
  if (fence.channel === "whatsapp") {
    digest.update("\0whatsapp");
  }
  const identity = digest.digest("hex");
  return `${subjectTag(fence)}:${identity}`;
}

function rootIndexStorageId(fence: MessengerGenerationCompletionFence): string {
  return `${subjectTag(fence)}:index`;
}

function tombstoneStorageId(fence: MessengerGenerationCompletionFence): string {
  return `${subjectTag(fence)}:erased`;
}

function objectIndexStorageId(
  fence: MessengerGenerationCompletionFence
): string {
  return `${subjectTag(fence)}:objects`;
}

function objectUploadIndexStorageId(
  fence: MessengerGenerationCompletionFence
): string {
  return `${subjectTag(fence)}:uploads`;
}

function artifactCleanupJobId(input: {
  reqId: string;
  imageUrl: string;
  fence: MessengerGenerationCompletionFence;
  reason: MessengerGenerationArtifactCleanupReason;
}): string {
  return createHash("sha256")
    .update(String(input.fence.workspaceId))
    .update("\0")
    .update(String(input.fence.channelConnectionId))
    .update("\0")
    .update(String(input.fence.bindingEpoch))
    .update("\0")
    .update(String(input.fence.privacyEpoch))
    .update("\0")
    .update(input.fence.channel ?? "facebook_messenger")
    .update("\0")
    .update(input.fence.userKey)
    .update("\0")
    .update(input.reqId)
    .update("\0")
    .update(input.imageUrl)
    .update("\0")
    .update(input.reason)
    .digest("hex");
}

function artifactCleanupPayloadKey(tag: string, jobId: string): string {
  return `${GENERATION_ARTIFACT_CLEANUP_SCOPE}:${tag}:job:${jobId}`;
}

function artifactCleanupDueKey(tag: string): string {
  return `${GENERATION_ARTIFACT_CLEANUP_SCOPE}:${tag}:due`;
}

function artifactCleanupDeadKey(tag: string): string {
  return `${GENERATION_ARTIFACT_CLEANUP_SCOPE}:${tag}:dead`;
}

function artifactCleanupGlobalDueKey(): string {
  return `${GENERATION_ARTIFACT_CLEANUP_SCOPE}:${GENERATION_ARTIFACT_CLEANUP_GLOBAL_TAG}:subjects`;
}

function artifactCleanupGlobalDeadKey(): string {
  return `${GENERATION_ARTIFACT_CLEANUP_SCOPE}:${GENERATION_ARTIFACT_CLEANUP_GLOBAL_TAG}:dead`;
}

function isArtifactCleanupSubjectTag(value: string): boolean {
  return /^\{mgc:[a-f0-9]{64}\}$/.test(value);
}

function artifactCleanupBackoffMs(attemptCount: number): number {
  return Math.min(
    GENERATION_ARTIFACT_CLEANUP_MAX_BACKOFF_MS,
    1_000 * 2 ** Math.max(0, attemptCount - 1)
  );
}

function userIndexLockKey(subjectKey: string): string {
  return `lock:${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${subjectKey}`;
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

async function withUserIndexLock(
  subjectKey: string,
  action: () => Promise<void>
): Promise<void> {
  const lockKey = userIndexLockKey(subjectKey);
  const token = randomUUID();

  for (let attempt = 0; attempt < USER_INDEX_LOCK_MAX_ATTEMPTS; attempt += 1) {
    if (
      await setEphemeralKeyIfAbsent(lockKey, token, USER_INDEX_LOCK_TTL_SECONDS)
    ) {
      try {
        await action();
        return;
      } finally {
        await deleteEphemeralKeyIfValue(lockKey, token);
      }
    }

    await wait(10);
  }

  throw new Error(
    "Timed out waiting for messenger generation completion index lock"
  );
}

export function markMessengerGenerationCompleted(
  reqId: string,
  imageUrl: string,
  userKey?: string,
  now = Date.now(),
  fence?: MessengerGenerationCompletionFence
): Promise<void> {
  return writeMessengerGenerationCompletion(
    {
      reqId,
      imageUrl,
      completedAt: now,
      deliveryStatus: "pending",
      userKey,
      ...fence,
      expiresAt: now + GENERATION_COMPLETION_TTL_SECONDS * 1_000,
    },
    fence,
    "create"
  );
}

export async function markMessengerGenerationDelivered(
  reqId: string,
  imageUrl: string,
  userKey?: string,
  now = Date.now(),
  fence?: MessengerGenerationCompletionFence
): Promise<void> {
  await writeMessengerGenerationCompletion(
    {
      reqId,
      imageUrl,
      completedAt: now,
      deliveryStatus: "delivered",
      deliveredAt: now,
      userKey,
      ...fence,
      expiresAt: now + GENERATION_COMPLETION_TTL_SECONDS * 1_000,
    },
    fence,
    "deliver"
  );
}

export type MessengerGenerationPublishHooks = Readonly<{
  beforeStore: (objectKey: string) => Promise<void>;
  afterStoreSuccess: (objectKey: string, imageUrl: string) => Promise<void>;
  afterStoreFailure: (objectKey: string) => Promise<void>;
}>;

/**
 * Inventories the exact tenant-owned object key before any storage write. A
 * process crash after storagePut can therefore never leave an object outside
 * the GDPR subject inventory.
 */
export function createMessengerGenerationPublishHooks(
  fence: MessengerGenerationCompletionFence
): MessengerGenerationPublishHooks {
  return {
    beforeStore: async objectKey => {
      if (!isRedisEnabled()) {
        if (process.env.NODE_ENV === "production") {
          throw new Error(
            "Messenger generation object inventory requires Redis"
          );
        }
        return;
      }
      await registerMessengerPrivacyOwnership({
        pageId: fence.pageId,
        userKey: fence.userKey,
        workspaceId: fence.workspaceId,
        channelConnectionId: fence.channelConnectionId,
        bindingEpoch: fence.bindingEpoch,
        privacyEpoch: fence.privacyEpoch,
        channel: fence.channel ?? "facebook_messenger",
      });
      await assertMessengerPrivacySubject(fence);
      await assertMessengerGenerationOwnership({
        ...fence,
        channel: fence.channel ?? "facebook_messenger",
      });
      if (!(await beginObjectUploadForPrivacyCleanup(objectKey, fence))) {
        throw new Error("Messenger completion subject is erased");
      }
    },
    afterStoreSuccess: async objectKey => {
      if (!isRedisEnabled()) return;
      const active = await finishObjectUploadForPrivacyCleanup(
        objectKey,
        fence
      );
      if (!active) {
        throw new Error(
          "Messenger completion subject was erased during upload"
        );
      }
    },
    // Once the storage request starts, a timeout or response loss is
    // ambiguous. Keep both the subject inventory and upload-settle marker so
    // erasure retries after the bounded settle window instead of orphaning a
    // provider-accepted object.
    afterStoreFailure: async () => undefined,
  };
}

export async function scheduleMessengerGenerationArtifactCleanup(input: {
  reqId: string;
  imageUrl: string;
  userKey: string;
  fence: MessengerGenerationCompletionFence;
  reason: MessengerGenerationArtifactCleanupReason;
  now?: number;
}): Promise<"scheduled" | "delivered"> {
  if (!isRedisEnabled()) {
    throw new Error(
      "Messenger generation artifact cleanup requires the durable Redis store"
    );
  }
  if (input.userKey !== input.fence.userKey) {
    throw new Error("Messenger generation artifact cleanup user mismatch");
  }
  const objectKey = storageKeyFromPublicUrl(input.imageUrl);
  if (!objectKey) {
    throw new Error("Messenger generation artifact cleanup object is invalid");
  }
  const now = input.now ?? Date.now();
  const expiresAt = now + GENERATION_OBJECT_INVENTORY_TTL_SECONDS * 1_000;
  const tag = subjectTag(input.fence);
  const jobId = artifactCleanupJobId(input);
  const job: MessengerGenerationArtifactCleanupJob = {
    version: 1,
    jobId,
    reqId: input.reqId,
    imageUrl: input.imageUrl,
    objectKey,
    fence: input.fence,
    reason: input.reason,
    guardsCompletion: false,
    status: "pending",
    attemptCount: 0,
    nextAttemptAt: now,
    leaseToken: null,
    leaseUntil: null,
    createdAt: now,
    updatedAt: now,
    expiresAt,
    lastErrorCode: null,
  };
  const redis = await getRedisClient();
  const result = await redis.eval(
    SCHEDULE_ARTIFACT_CLEANUP_SCRIPT,
    5,
    `${GENERATION_COMPLETION_SCOPE}:${completionStorageId(input.reqId, input.fence)}`,
    `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${objectIndexStorageId(input.fence)}`,
    artifactCleanupPayloadKey(tag, jobId),
    artifactCleanupDueKey(tag),
    `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${tombstoneStorageId(input.fence)}`,
    JSON.stringify(job),
    objectKey,
    input.imageUrl,
    input.reqId,
    now,
    expiresAt,
    jobId,
    input.reason
  );
  const resultCode = Array.isArray(result) ? String(result[0]) : "unknown";
  if (resultCode === "delivered") return "delivered";
  if (resultCode !== "scheduled") {
    throw new Error(`Messenger generation artifact cleanup ${resultCode}`);
  }

  // The subject queue commit above is authoritative. This global index is
  // metadata-only and can be reconstructed at startup after a crash between
  // the two hash slots.
  await refreshArtifactCleanupGlobalDue(redis, tag);
  return "scheduled";
}

export async function runDueMessengerGenerationArtifactCleanup(
  now = Date.now(),
  limit = GENERATION_ARTIFACT_CLEANUP_BATCH_SIZE
): Promise<number> {
  if (!isRedisEnabled()) return 0;
  const redis = await getRedisClient();
  const subjects = await redisZrangeByScore(
    redis,
    artifactCleanupGlobalDueKey(),
    now,
    Math.max(1, limit)
  );
  let claimedCount = 0;
  let deadLetterCreated = false;

  for (const tag of subjects) {
    if (!isArtifactCleanupSubjectTag(tag)) {
      throw new Error(
        "Messenger generation artifact cleanup subject index is invalid"
      );
    }
    const dueKey = artifactCleanupDueKey(tag);
    const jobIds = await redisZrangeByScore(
      redis,
      dueKey,
      now,
      Math.max(1, limit - claimedCount)
    );

    for (const jobId of jobIds) {
      if (!/^[a-f0-9]{64}$/.test(jobId)) {
        throw new Error(
          "Messenger generation artifact cleanup member is invalid"
        );
      }
      const payloadKey = artifactCleanupPayloadKey(tag, jobId);
      const serialized = await redis.get(payloadKey);
      const queued = serialized ? parseArtifactCleanupJob(serialized) : null;
      if (
        !queued ||
        subjectTag(queued.fence) !== tag ||
        queued.jobId !== jobId
      ) {
        await redisZadd(redis, artifactCleanupGlobalDeadKey(), now, jobId);
        throw new Error(
          "Messenger generation artifact cleanup payload is invalid"
        );
      }
      const leaseToken = randomUUID();
      const leaseUntil = now + GENERATION_ARTIFACT_CLEANUP_LEASE_MS;
      const claim = await redis.eval(
        CLAIM_ARTIFACT_CLEANUP_SCRIPT,
        3,
        payloadKey,
        dueKey,
        `${GENERATION_COMPLETION_SCOPE}:${completionStorageId(queued.reqId, queued.fence)}`,
        jobId,
        now,
        leaseToken,
        leaseUntil
      );
      const claimCode = Array.isArray(claim) ? String(claim[0]) : "unknown";
      if (claimCode !== "claimed") continue;
      const claimed =
        Array.isArray(claim) && claim[1]
          ? parseArtifactCleanupJob(String(claim[1]))
          : null;
      if (!claimed || claimed.leaseToken !== leaseToken) {
        throw new Error(
          "Messenger generation artifact cleanup claim is invalid"
        );
      }
      claimedCount += 1;

      try {
        // storageDelete treats a provider 404 as idempotent success.
        await storageDelete(claimed.objectKey);
        const completed = await redis.eval(
          COMPLETE_ARTIFACT_CLEANUP_SCRIPT,
          6,
          payloadKey,
          dueKey,
          `${GENERATION_COMPLETION_SCOPE}:${completionStorageId(claimed.reqId, claimed.fence)}`,
          `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${rootIndexStorageId(claimed.fence)}`,
          `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${objectIndexStorageId(claimed.fence)}`,
          artifactCleanupDeadKey(tag),
          jobId,
          leaseToken
        );
        const completedCode = Array.isArray(completed)
          ? String(completed[0])
          : "unknown";
        if (completedCode !== "completed") {
          throw new Error(
            `Messenger generation artifact cleanup ${completedCode}`
          );
        }
        await redisZrem(redis, artifactCleanupGlobalDeadKey(), jobId);
      } catch (error) {
        const nextAttemptAt =
          now + artifactCleanupBackoffMs(claimed.attemptCount);
        const failed = await redis.eval(
          FAIL_ARTIFACT_CLEANUP_SCRIPT,
          4,
          payloadKey,
          dueKey,
          `${GENERATION_COMPLETION_SCOPE}:${completionStorageId(claimed.reqId, claimed.fence)}`,
          artifactCleanupDeadKey(tag),
          jobId,
          leaseToken,
          now,
          cleanupErrorCode(error),
          nextAttemptAt,
          GENERATION_ARTIFACT_CLEANUP_MAX_ATTEMPTS
        );
        const failedCode = Array.isArray(failed)
          ? String(failed[0])
          : "unknown";
        if (failedCode === "dead") {
          await redisZadd(redis, artifactCleanupGlobalDeadKey(), now, jobId);
          deadLetterCreated = true;
        } else if (failedCode !== "retry") {
          throw new AggregateError(
            [error],
            `Messenger generation artifact cleanup failure ${failedCode}`
          );
        }
      }
    }
    await refreshArtifactCleanupGlobalDue(redis, tag);
    if (claimedCount >= limit) break;
  }

  if (deadLetterCreated) {
    throw new Error(
      "Messenger generation artifact cleanup reached dead-letter"
    );
  }
  return claimedCount;
}

function writeMessengerGenerationCompletion(
  completion: MessengerGenerationCompletion,
  fence: MessengerGenerationCompletionFence | undefined,
  mode: "create" | "deliver"
): Promise<void> {
  return Promise.resolve().then(async () => {
    if (mode === "create" && fence && isRedisEnabled()) {
      try {
        await registerMessengerPrivacyOwnership({
          pageId: fence.pageId,
          userKey: fence.userKey,
          workspaceId: fence.workspaceId,
          channelConnectionId: fence.channelConnectionId,
          bindingEpoch: fence.bindingEpoch,
          privacyEpoch: fence.privacyEpoch,
          channel: fence.channel ?? "facebook_messenger",
        });
      } catch (error) {
        await cleanupCompletionObjectWithDurableFallback(
          completion,
          fence,
          "ownership_rejected",
          error
        );
        throw error;
      }
      let inventoried: boolean;
      try {
        inventoried = await indexCompletionObjectForPrivacyCleanup(
          completion,
          fence
        );
      } catch (error) {
        await cleanupCompletionObjectWithDurableFallback(
          completion,
          fence,
          "ownership_rejected",
          error
        );
        throw error;
      }
      if (!inventoried) {
        const error = new Error("Messenger completion subject is erased");
        await cleanupCompletionObjectWithDurableFallback(
          completion,
          fence,
          "privacy_tombstone",
          error
        );
        throw error;
      }
    }
    if (fence) {
      try {
        await assertMessengerPrivacySubject(fence);
      } catch (error) {
        if (mode === "create") {
          await cleanupCompletionObjectWithDurableFallback(
            completion,
            fence,
            "privacy_tombstone",
            error
          );
        }
        throw error;
      }
      try {
        await assertMessengerGenerationOwnership({
          ...fence,
          channel: fence.channel ?? "facebook_messenger",
        });
      } catch (error) {
        // The generated object already exists before the completion commit.
        // If deletion/rebind wins at this first fence, no durable inventory
        // exists yet to scrub it later.
        if (mode === "create") {
          await cleanupCompletionObjectWithDurableFallback(
            completion,
            fence,
            "ownership_rejected",
            error
          );
        }
        throw error;
      }
    } else if (process.env.NODE_ENV === "production") {
      throw new Error("Messenger completion privacy fence is required");
    }
    if (fence && isRedisEnabled()) {
      const redis = await getRedisClient();
      const expiresAt = completion.expiresAt;
      if (!expiresAt || expiresAt <= Date.now()) {
        throw new Error("Messenger completion retention expired");
      }
      const result = await redis.eval(
        WRITE_COMPLETION_SCRIPT,
        4,
        `${GENERATION_COMPLETION_SCOPE}:${completionStorageId(completion.reqId, fence)}`,
        `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${rootIndexStorageId(fence)}`,
        `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${tombstoneStorageId(fence)}`,
        `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${objectIndexStorageId(fence)}`,
        JSON.stringify(completion),
        completion.deliveryStatus ?? "pending",
        expiresAt,
        mode,
        storageKeyFromPublicUrl(completion.imageUrl) ?? "",
        Date.now() + GENERATION_OBJECT_INVENTORY_TTL_SECONDS * 1_000
      );
      const resultCode = Array.isArray(result) ? String(result[0]) : "unknown";
      if (resultCode === "stored") {
        try {
          await assertMessengerPrivacySubject(fence);
        } catch (error) {
          await deleteCompletionIfExact(redis, completion, fence);
          await cleanupCompletionObjectWithDurableFallback(
            completion,
            fence,
            "privacy_tombstone",
            error
          );
          throw error;
        }
        try {
          await assertMessengerGenerationOwnership({
            ...fence,
            channel: fence.channel ?? "facebook_messenger",
          });
        } catch (error) {
          await deleteCompletionIfExact(redis, completion, fence);
          await cleanupCompletionObjectWithDurableFallback(
            completion,
            fence,
            "ownership_rejected",
            error
          );
          throw error;
        }
        return;
      }
      const retained =
        Array.isArray(result) && result[1]
          ? parseCompletion(String(result[1]))
          : null;
      if (
        mode === "create" &&
        (!retained || retained.imageUrl !== completion.imageUrl)
      ) {
        await cleanupCompletionObjectWithDurableFallback(
          completion,
          fence,
          resultCode === "erased"
            ? "privacy_tombstone"
            : "pre_transport_rejected",
          new Error(`Messenger completion ${resultCode}`)
        );
      }
      if (resultCode === "exists") return;
      if (resultCode === "erased") {
        throw new Error("Messenger completion subject is erased");
      }
      throw new Error(`Messenger completion ${resultCode}`);
    }
    const storageId = fence
      ? completionStorageId(completion.reqId, fence)
      : completion.reqId;
    const existing = await Promise.resolve(
      readScopedState<MessengerGenerationCompletion>(
        GENERATION_COMPLETION_SCOPE,
        storageId
      )
    );
    if (mode === "deliver" && !existing) {
      throw new Error("Messenger completion missing");
    }
    if (existing) {
      if (existing.imageUrl !== completion.imageUrl) {
        if (mode === "create") {
          await cleanupCompletionObject(JSON.stringify(completion));
          return;
        }
        throw new Error("Messenger completion conflict");
      }
      if (mode === "deliver" && existing.deliveryStatus === "cleanup_started") {
        throw new Error("Messenger completion cleanup_started");
      }
      if (mode === "create" || existing.deliveryStatus === "delivered") return;
      completion = {
        ...existing,
        deliveryStatus: "delivered",
        deliveredAt: completion.deliveredAt,
      };
    }
    const expiresAt =
      completion.expiresAt ??
      Date.now() + GENERATION_COMPLETION_TTL_SECONDS * 1_000;
    const ttlSeconds = Math.max(1, Math.ceil((expiresAt - Date.now()) / 1_000));
    await Promise.resolve(
      writeScopedState<MessengerGenerationCompletion>(
        GENERATION_COMPLETION_SCOPE,
        storageId,
        completion,
        ttlSeconds
      )
    );
    if (fence) {
      try {
        await assertMessengerPrivacySubject(fence);
        await assertMessengerGenerationOwnership({
          ...fence,
          channel: fence.channel ?? "facebook_messenger",
        });
      } catch (error) {
        await Promise.resolve(
          deleteScopedState(GENERATION_COMPLETION_SCOPE, storageId)
        );
        throw error;
      }
    }
    const userKey = completion.userKey;
    if (!userKey) {
      return;
    }

    const subjectKey = fence
      ? rootIndexStorageId(fence)
      : completionSubjectKey(userKey, fence);
    await withUserIndexLock(subjectKey, async () => {
      const currentIndex =
        (await Promise.resolve(
          readScopedState<string[]>(
            GENERATION_COMPLETION_USER_INDEX_SCOPE,
            subjectKey
          )
        )) ?? [];
      const nextIndex = Array.from(new Set([...currentIndex, storageId]));
      await Promise.resolve(
        writeScopedState(
          GENERATION_COMPLETION_USER_INDEX_SCOPE,
          subjectKey,
          nextIndex,
          ttlSeconds
        )
      );
    });
  });
}

async function indexCompletionObjectForPrivacyCleanup(
  completion: MessengerGenerationCompletion,
  fence: MessengerGenerationCompletionFence
): Promise<boolean> {
  const objectKey = storageKeyFromPublicUrl(completion.imageUrl);
  if (!objectKey) return true;
  return await indexObjectKeyForPrivacyCleanup(objectKey, fence);
}

async function beginObjectUploadForPrivacyCleanup(
  objectKey: string,
  fence: MessengerGenerationCompletionFence
): Promise<boolean> {
  validateGenerationObjectKey(objectKey);
  const redis = await getRedisClient();
  const now = Date.now();
  const inventoryExpiresAt =
    now + GENERATION_OBJECT_INVENTORY_TTL_SECONDS * 1_000;
  const settleAt = now + GENERATION_OBJECT_UPLOAD_SETTLE_MS;
  const result = Number(
    await redis.eval(
      `
        if redis.call('exists', KEYS[2]) == 1 then return 0 end
        redis.call('sadd', KEYS[1], ARGV[1])
        redis.call('zadd', KEYS[3], ARGV[2], ARGV[1])
        for _, key in ipairs({KEYS[1], KEYS[3]}) do
          local ttl = redis.call('pttl', key)
          if ttl < 0 then
            redis.call('pexpireat', key, ARGV[3])
          else
            redis.call('pexpireat', key, ARGV[3], 'GT')
          end
        end
        return 1
      `,
      3,
      `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${objectIndexStorageId(fence)}`,
      `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${tombstoneStorageId(fence)}`,
      `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${objectUploadIndexStorageId(fence)}`,
      objectKey,
      settleAt,
      inventoryExpiresAt
    )
  );
  return result === 1;
}

async function finishObjectUploadForPrivacyCleanup(
  objectKey: string,
  fence: MessengerGenerationCompletionFence
): Promise<boolean> {
  validateGenerationObjectKey(objectKey);
  const redis = await getRedisClient();
  const result = Number(
    await redis.eval(
      `
        if redis.call('zscore', KEYS[2], ARGV[1]) == false then return -1 end
        local erased = redis.call('exists', KEYS[1])
        redis.call('zrem', KEYS[2], ARGV[1])
        if erased == 1 then return 0 end
        return 1
      `,
      2,
      `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${tombstoneStorageId(fence)}`,
      `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${objectUploadIndexStorageId(fence)}`,
      objectKey
    )
  );
  if (result === -1) {
    throw new Error("Messenger generation upload inventory is missing");
  }
  return result === 1;
}

function validateGenerationObjectKey(objectKey: string): void {
  if (
    !objectKey.startsWith("generated/") ||
    objectKey.length > 1_024 ||
    /[\u0000-\u001f\u007f]/.test(objectKey)
  ) {
    throw new Error("Messenger generation object key is invalid");
  }
}

async function indexObjectKeyForPrivacyCleanup(
  objectKey: string,
  fence: MessengerGenerationCompletionFence
): Promise<boolean> {
  validateGenerationObjectKey(objectKey);
  const redis = await getRedisClient();
  const result = Number(
    await redis.eval(
      `
        if redis.call('exists', KEYS[2]) == 1 then return 0 end
        redis.call('sadd', KEYS[1], ARGV[1])
        local ttl = redis.call('pttl', KEYS[1])
        if ttl < 0 then
          redis.call('pexpireat', KEYS[1], ARGV[2])
        else
          redis.call('pexpireat', KEYS[1], ARGV[2], 'GT')
        end
        return 1
      `,
      2,
      `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${objectIndexStorageId(fence)}`,
      `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${tombstoneStorageId(fence)}`,
      objectKey,
      Date.now() + GENERATION_OBJECT_INVENTORY_TTL_SECONDS * 1_000
    )
  );
  return result === 1;
}

async function deleteCompletionIfExact(
  redis: Awaited<ReturnType<typeof getRedisClient>>,
  completion: MessengerGenerationCompletion,
  fence: MessengerGenerationCompletionFence
): Promise<void> {
  const key = `${GENERATION_COMPLETION_SCOPE}:${completionStorageId(completion.reqId, fence)}`;
  await redis.eval(
    DELETE_EXACT_COMPLETION_SCRIPT,
    2,
    key,
    `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${rootIndexStorageId(fence)}`,
    completion.imageUrl,
    String(completion.completedAt)
  );
}

export async function deleteMessengerGenerationCompletionsForUser(
  userKey: string,
  fence?: MessengerGenerationCompletionFence
): Promise<void> {
  if (fence && isRedisEnabled()) {
    const redis = await getRedisClient();
    const rootKey = `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${rootIndexStorageId(fence)}`;
    const tombstoneKey = `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${tombstoneStorageId(fence)}`;
    const objectIndexKey = `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${objectIndexStorageId(fence)}`;
    const objectUploadIndexKey = `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${objectUploadIndexStorageId(fence)}`;
    const cleanupDueKey = artifactCleanupDueKey(subjectTag(fence));
    const cleanupDeadKey = artifactCleanupDeadKey(subjectTag(fence));
    await redis.eval(
      BEGIN_ERASE_COMPLETIONS_SCRIPT,
      4,
      rootKey,
      tombstoneKey,
      objectIndexKey,
      objectUploadIndexKey,
      String(fence.privacyEpoch)
    );

    await eraseCompletionMetadataInBoundedBatches(
      redis,
      rootKey,
      objectIndexKey
    );
    await eraseCompletionObjectsInBoundedBatches(
      redis,
      objectIndexKey,
      objectUploadIndexKey
    );

    const finalized = Number(
      await redis.eval(
        FINALIZE_ERASE_COMPLETIONS_SCRIPT,
        6,
        rootKey,
        tombstoneKey,
        objectIndexKey,
        cleanupDueKey,
        cleanupDeadKey,
        objectUploadIndexKey
      )
    );
    if (finalized !== 1) {
      throw new Error(
        finalized < 0
          ? "Messenger generation privacy cleanup is still pending"
          : "Messenger generation privacy cleanup lost its tombstone"
      );
    }
    return;
  }
  const subjectKey = fence
    ? rootIndexStorageId(fence)
    : completionSubjectKey(userKey, fence);
  const completionReqIds =
    (await Promise.resolve(
      readScopedState<string[]>(
        GENERATION_COMPLETION_USER_INDEX_SCOPE,
        subjectKey
      )
    )) ?? [];

  await Promise.all(
    completionReqIds.map(async storageId => {
      const completion = await Promise.resolve(
        readScopedState<MessengerGenerationCompletion>(
          GENERATION_COMPLETION_SCOPE,
          storageId
        )
      );
      if (completion) await cleanupCompletionObject(JSON.stringify(completion));
      await Promise.resolve(
        deleteScopedState(GENERATION_COMPLETION_SCOPE, storageId)
      );
    })
  );
  await Promise.resolve(
    deleteScopedState(GENERATION_COMPLETION_USER_INDEX_SCOPE, subjectKey)
  );
}

async function eraseCompletionMetadataInBoundedBatches(
  redis: Awaited<ReturnType<typeof getRedisClient>>,
  rootKey: string,
  objectIndexKey: string
): Promise<void> {
  let cursor = "0";
  let batches = 0;
  let visited = new Set<string>();
  while (batches < COMPLETION_ERASURE_MAX_BATCHES_PER_RUN) {
    if (visited.has(cursor)) {
      throw new Error("Messenger completion privacy scan did not progress");
    }
    visited.add(cursor);
    const result = await redis.eval(
      READ_COMPLETION_ERASURE_BATCH_SCRIPT,
      1,
      rootKey,
      cursor,
      COMPLETION_ERASURE_BATCH_SIZE
    );
    if (
      !Array.isArray(result) ||
      result.length !== 2 ||
      !Array.isArray(result[1])
    ) {
      throw new Error("Messenger completion privacy scan is invalid");
    }
    const nextCursor = String(result[0]);
    const values = result[1].map(String);
    if (
      values.length % 2 !== 0 ||
      values.length / 2 > COMPLETION_ERASURE_MAX_ITEMS_PER_BATCH
    ) {
      throw new Error("Messenger completion privacy batch is invalid");
    }
    const entries = new Map<string, string>();
    for (let index = 0; index < values.length; index += 2) {
      const previous = entries.get(values[index]);
      if (previous !== undefined && previous !== values[index + 1]) {
        throw new Error("Messenger completion privacy batch changed");
      }
      entries.set(values[index], values[index + 1]);
    }
    const serialized: string[] = [];
    for (const [key, value] of entries) {
      const completion = value ? parseCompletion(value) : null;
      serialized.push(
        key,
        value,
        completion ? (storageKeyFromPublicUrl(completion.imageUrl) ?? "") : ""
      );
      if (value) await cleanupCompletionObject(value);
    }
    if (serialized.length > 0) {
      const committed = Number(
        await redis.eval(
          COMMIT_COMPLETION_ERASURE_BATCH_SCRIPT,
          2,
          rootKey,
          objectIndexKey,
          ...serialized
        )
      );
      if (committed !== entries.size) {
        throw new Error("Messenger completion privacy batch CAS failed");
      }
    }
    batches += 1;
    cursor = nextCursor;
    if (cursor === "0") {
      const remaining = Number(
        await redis.eval("return redis.call('scard', KEYS[1])", 1, rootKey)
      );
      if (remaining === 0) return;
      visited = new Set<string>();
    }
  }
  throw new Error("Messenger completion privacy scrub needs another pass");
}

async function eraseCompletionObjectsInBoundedBatches(
  redis: Awaited<ReturnType<typeof getRedisClient>>,
  objectIndexKey: string,
  objectUploadIndexKey: string
): Promise<void> {
  let cursor = "0";
  let batches = 0;
  let visited = new Set<string>();
  while (batches < COMPLETION_ERASURE_MAX_BATCHES_PER_RUN) {
    if (visited.has(cursor)) {
      throw new Error("Messenger completion object scan did not progress");
    }
    visited.add(cursor);
    const result = await redis.eval(
      READ_OBJECT_ERASURE_BATCH_SCRIPT,
      2,
      objectIndexKey,
      objectUploadIndexKey,
      cursor,
      COMPLETION_ERASURE_BATCH_SIZE
    );
    if (
      !Array.isArray(result) ||
      result.length !== 2 ||
      !Array.isArray(result[1])
    ) {
      throw new Error("Messenger completion object scan is invalid");
    }
    const nextCursor = String(result[0]);
    const values = result[1].map(String);
    if (values.length % 2 !== 0) {
      throw new Error("Messenger completion object batch is invalid");
    }
    const objectKeys: string[] = [];
    const now = Date.now();
    for (let index = 0; index < values.length; index += 2) {
      const objectKey = values[index];
      const rawSettleAt = values[index + 1];
      validateGenerationObjectKey(objectKey);
      if (rawSettleAt) {
        const settleAt = Number(rawSettleAt);
        if (!Number.isSafeInteger(settleAt) || settleAt <= 0) {
          throw new Error("Messenger completion upload marker is invalid");
        }
        if (settleAt > now) {
          throw new Error("Messenger generation upload is still settling");
        }
      }
      if (!objectKeys.includes(objectKey)) objectKeys.push(objectKey);
    }
    if (objectKeys.length > COMPLETION_ERASURE_MAX_ITEMS_PER_BATCH) {
      throw new Error("Messenger completion object batch is invalid");
    }
    for (const objectKey of objectKeys) await storageDelete(objectKey);
    if (objectKeys.length > 0) {
      const committed = Number(
        await redis.eval(
          COMMIT_OBJECT_ERASURE_BATCH_SCRIPT,
          2,
          objectIndexKey,
          objectUploadIndexKey,
          ...objectKeys
        )
      );
      if (committed !== objectKeys.length) {
        throw new Error("Messenger completion object batch commit failed");
      }
    }
    batches += 1;
    cursor = nextCursor;
    if (cursor === "0") {
      const remaining = Number(
        await redis.eval(
          "return redis.call('scard', KEYS[1])",
          1,
          objectIndexKey
        )
      );
      if (remaining === 0) return;
      visited = new Set<string>();
    }
  }
  throw new Error(
    "Messenger completion object scrub needs another bounded pass"
  );
}

function parseArtifactCleanupJob(
  serialized: string
): MessengerGenerationArtifactCleanupJob | null {
  try {
    const raw = JSON.parse(serialized) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const job = raw as Partial<MessengerGenerationArtifactCleanupJob>;
    const reason = String(job.reason);
    const channel = job.fence?.channel ?? "facebook_messenger";
    if (
      job.version !== 1 ||
      typeof job.jobId !== "string" ||
      !/^[a-f0-9]{64}$/.test(job.jobId) ||
      typeof job.reqId !== "string" ||
      !job.reqId.trim() ||
      job.reqId.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(job.reqId) ||
      typeof job.imageUrl !== "string" ||
      typeof job.objectKey !== "string" ||
      !job.fence ||
      !Number.isSafeInteger(job.fence.workspaceId) ||
      job.fence.workspaceId <= 0 ||
      !Number.isSafeInteger(job.fence.channelConnectionId) ||
      job.fence.channelConnectionId <= 0 ||
      !Number.isSafeInteger(job.fence.bindingEpoch) ||
      job.fence.bindingEpoch <= 0 ||
      !Number.isSafeInteger(job.fence.privacyEpoch) ||
      job.fence.privacyEpoch <= 0 ||
      typeof job.fence.userKey !== "string" ||
      !job.fence.userKey.trim() ||
      job.fence.userKey.length > 256 ||
      typeof job.fence.pageId !== "string" ||
      !job.fence.pageId.trim() ||
      job.fence.pageId.length > 256 ||
      (channel !== "facebook_messenger" && channel !== "whatsapp") ||
      ![
        "pre_transport_rejected",
        "privacy_tombstone",
        "ownership_rejected",
      ].includes(reason) ||
      typeof job.guardsCompletion !== "boolean" ||
      !["pending", "processing", "dead"].includes(String(job.status)) ||
      typeof job.attemptCount !== "number" ||
      !Number.isSafeInteger(job.attemptCount) ||
      job.attemptCount < 0 ||
      typeof job.nextAttemptAt !== "number" ||
      typeof job.createdAt !== "number" ||
      typeof job.updatedAt !== "number" ||
      typeof job.expiresAt !== "number" ||
      !Number.isSafeInteger(job.nextAttemptAt) ||
      !Number.isSafeInteger(job.createdAt) ||
      !Number.isSafeInteger(job.updatedAt) ||
      !Number.isSafeInteger(job.expiresAt) ||
      job.createdAt < 0 ||
      job.updatedAt < job.createdAt ||
      job.nextAttemptAt < job.createdAt ||
      job.expiresAt <= job.createdAt ||
      job.updatedAt > job.expiresAt ||
      job.nextAttemptAt > job.expiresAt ||
      (job.status === "processing"
        ? typeof job.leaseToken !== "string" ||
          !/^[0-9a-f-]{36}$/i.test(job.leaseToken) ||
          typeof job.leaseUntil !== "number" ||
          !Number.isSafeInteger(job.leaseUntil) ||
          job.leaseUntil <= job.updatedAt
        : job.leaseToken !== null || job.leaseUntil !== null) ||
      (job.lastErrorCode !== null &&
        (typeof job.lastErrorCode !== "string" ||
          !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(job.lastErrorCode)))
    ) {
      return null;
    }
    const parsed = job as MessengerGenerationArtifactCleanupJob;
    validateGenerationObjectKey(parsed.objectKey);
    if (storageKeyFromPublicUrl(parsed.imageUrl) !== parsed.objectKey) {
      return null;
    }
    if (artifactCleanupJobId(parsed) !== parsed.jobId) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function refreshArtifactCleanupGlobalDue(
  redis: Awaited<ReturnType<typeof getRedisClient>>,
  tag: string
): Promise<void> {
  const next = await redisZrange(redis, artifactCleanupDueKey(tag), 0, 0, true);
  if (next.length >= 2) {
    const score = Number(next[1]);
    if (!Number.isFinite(score)) {
      throw new Error(
        "Messenger generation artifact cleanup due score is invalid"
      );
    }
    await redisZadd(redis, artifactCleanupGlobalDueKey(), score, tag);
    return;
  }
  await redisZrem(redis, artifactCleanupGlobalDueKey(), tag);
}

async function redisZadd(
  redis: Awaited<ReturnType<typeof getRedisClient>>,
  key: string,
  score: number,
  member: string
): Promise<number> {
  return Number(
    await redis.eval(
      "return redis.call('zadd', KEYS[1], ARGV[1], ARGV[2])",
      1,
      key,
      score,
      member
    )
  );
}

async function redisZrem(
  redis: Awaited<ReturnType<typeof getRedisClient>>,
  key: string,
  member: string
): Promise<number> {
  return Number(
    await redis.eval(
      "return redis.call('zrem', KEYS[1], ARGV[1])",
      1,
      key,
      member
    )
  );
}

async function redisZcard(
  redis: Awaited<ReturnType<typeof getRedisClient>>,
  key: string
): Promise<number> {
  return Number(
    await redis.eval("return redis.call('zcard', KEYS[1])", 1, key)
  );
}

async function redisZrange(
  redis: Awaited<ReturnType<typeof getRedisClient>>,
  key: string,
  start: number,
  stop: number,
  withScores = false
): Promise<string[]> {
  const result = await redis.eval(
    withScores
      ? "return redis.call('zrange', KEYS[1], ARGV[1], ARGV[2], 'WITHSCORES')"
      : "return redis.call('zrange', KEYS[1], ARGV[1], ARGV[2])",
    1,
    key,
    start,
    stop
  );
  return Array.isArray(result) ? result.map(String) : [];
}

async function redisZrangeByScore(
  redis: Awaited<ReturnType<typeof getRedisClient>>,
  key: string,
  maxScore: number,
  limit: number
): Promise<string[]> {
  const result = await redis.eval(
    "return redis.call('zrangebyscore', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])",
    1,
    key,
    maxScore,
    limit
  );
  return Array.isArray(result) ? result.map(String) : [];
}

function cleanupErrorCode(error: unknown): string {
  if (error instanceof Error && error.constructor.name) {
    return error.constructor.name.slice(0, 64);
  }
  return "UnknownError";
}

function parseCompletion(
  serialized: string
): MessengerGenerationCompletion | null {
  try {
    return JSON.parse(serialized) as MessengerGenerationCompletion;
  } catch {
    return null;
  }
}

async function cleanupCompletionObject(serialized: string): Promise<void> {
  let completion: MessengerGenerationCompletion;
  try {
    completion = JSON.parse(serialized) as MessengerGenerationCompletion;
  } catch {
    return;
  }
  const key = storageKeyFromPublicUrl(completion.imageUrl);
  if (key) await storageDelete(key);
}

async function cleanupCompletionObjectWithDurableFallback(
  completion: MessengerGenerationCompletion,
  fence: MessengerGenerationCompletionFence,
  reason: MessengerGenerationArtifactCleanupReason,
  primaryError: unknown
): Promise<void> {
  if (isRedisEnabled()) {
    try {
      // The atomic schedule CAS checks an existing delivered completion before
      // any object delete can occur. A stale ownership/tombstone replay must
      // never erase an artifact that Graph already accepted.
      await scheduleMessengerGenerationArtifactCleanup({
        reqId: completion.reqId,
        imageUrl: completion.imageUrl,
        userKey: fence.userKey,
        fence,
        reason,
      });
      return;
    } catch (scheduleError) {
      throw new AggregateError(
        [primaryError, scheduleError],
        "Messenger generation object cleanup could not be scheduled"
      );
    }
  }
  try {
    await cleanupCompletionObject(JSON.stringify(completion));
    await removeCompletionObjectFromInventory(completion, fence);
  } catch (cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "Messenger generation object cleanup failed"
    );
  }
}

async function removeCompletionObjectFromInventory(
  completion: MessengerGenerationCompletion,
  fence: MessengerGenerationCompletionFence
): Promise<void> {
  if (!isRedisEnabled()) return;
  const objectKey = storageKeyFromPublicUrl(completion.imageUrl);
  if (!objectKey) return;
  const redis = await getRedisClient();
  await redis.srem(
    `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${objectIndexStorageId(fence)}`,
    objectKey
  );
}

function matchesFence(
  completion: MessengerGenerationCompletion,
  fence: MessengerGenerationCompletionFence
): boolean {
  return (
    completion.userKey === fence.userKey &&
    completion.workspaceId === fence.workspaceId &&
    completion.channelConnectionId === fence.channelConnectionId &&
    completion.bindingEpoch === fence.bindingEpoch &&
    completion.privacyEpoch === fence.privacyEpoch &&
    completion.pageId === fence.pageId &&
    (completion.channel ?? "facebook_messenger") ===
      (fence.channel ?? "facebook_messenger")
  );
}
