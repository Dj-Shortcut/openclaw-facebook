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
import { getRedisClient, isRedisEnabled } from "./redis";
import { assertMessengerGenerationOwnership } from "./workspaceEntitlementRuntime";

const GENERATION_COMPLETION_SCOPE = "messenger-generation-completion";
const GENERATION_COMPLETION_USER_INDEX_SCOPE =
  "messenger-generation-completion:user";
const GENERATION_COMPLETION_TTL_SECONDS = 7 * 24 * 60 * 60;
const GENERATION_OBJECT_INVENTORY_TTL_SECONDS = 31 * 24 * 60 * 60;
const USER_INDEX_LOCK_TTL_SECONDS = 5;
const USER_INDEX_LOCK_MAX_ATTEMPTS = 20;

export type MessengerGenerationCompletion = {
  reqId: string;
  imageUrl: string;
  completedAt: number;
  deliveryStatus?: "pending" | "delivered";
  deliveredAt?: number;
  userKey?: string;
  workspaceId?: number;
  channelConnectionId?: number;
  bindingEpoch?: number;
  privacyEpoch?: number;
  pageId?: string;
  expiresAt?: number;
};

export type MessengerGenerationCompletionFence = Readonly<{
  workspaceId: number;
  channelConnectionId: number;
  bindingEpoch: number;
  privacyEpoch: number;
  userKey: string;
  pageId: string;
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

const ERASE_COMPLETIONS_SCRIPT = `
redis.call('set', KEYS[2], ARGV[1])
local keys = redis.call('smembers', KEYS[1])
local values = {}
for _, key in ipairs(keys) do
  local value = redis.call('get', key)
  if value then
    table.insert(values, key)
    table.insert(values, value)
  end
end
return values
`;

const FINALIZE_ERASE_COMPLETIONS_SCRIPT = `
if redis.call('exists', KEYS[2]) == 0 then return 0 end
for index = 1, #ARGV do redis.call('del', ARGV[index]) end
redis.call('del', KEYS[1])
redis.call('del', KEYS[3])
return #ARGV
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
    await assertMessengerGenerationOwnership(expectedFence);
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
        if (isLegacyMessengerGenerationCompletionKey(prefix, key)) {
          unsafe.push(key);
        }
        if (unsafe.length >= limit) return unsafe;
      }
      cursor = next;
    } while (cursor !== "0");
  }
  return unsafe;
}

export function isLegacyMessengerGenerationCompletionKey(
  prefix: string,
  key: string
): boolean {
  if (
    prefix === GENERATION_COMPLETION_SCOPE &&
    key.startsWith(`${GENERATION_COMPLETION_USER_INDEX_SCOPE}:`)
  ) {
    return false;
  }
  return !key.startsWith(`${prefix}:{mgc:`);
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
  const subjectDigest = createHash("sha256")
    .update(String(fence.workspaceId))
    .update("\0")
    .update(String(fence.channelConnectionId))
    .update("\0")
    .update(fence.userKey)
    .digest("hex");
  return `{mgc:${subjectDigest}}`;
}

function completionStorageId(
  reqId: string,
  fence: MessengerGenerationCompletionFence
): string {
  const identity = createHash("sha256")
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
    .update(reqId)
    .digest("hex");
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

function writeMessengerGenerationCompletion(
  completion: MessengerGenerationCompletion,
  fence: MessengerGenerationCompletionFence | undefined,
  mode: "create" | "deliver"
): Promise<void> {
  return Promise.resolve().then(async () => {
    if (mode === "create" && fence && isRedisEnabled()) {
      const inventoried = await indexCompletionObjectForPrivacyCleanup(
        completion,
        fence
      );
      if (!inventoried) {
        await cleanupCompletionObject(JSON.stringify(completion));
        throw new Error("Messenger completion subject is erased");
      }
    }
    if (fence) {
      try {
        await assertMessengerPrivacySubject(fence);
        await assertMessengerGenerationOwnership(fence);
      } catch (error) {
        // The generated object already exists before the completion commit.
        // If deletion/rebind wins at this first fence, no durable inventory
        // exists yet to scrub it later.
        if (mode === "create") {
          await cleanupCompletionObject(JSON.stringify(completion));
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
          await assertMessengerGenerationOwnership(fence);
        } catch (error) {
          await deleteCompletionIfExact(redis, completion, fence);
          await cleanupCompletionObject(JSON.stringify(completion));
          throw error;
        }
        return;
      }
      const retained =
        Array.isArray(result) && result[1]
          ? parseCompletion(String(result[1]))
          : null;
      if (!retained || retained.imageUrl !== completion.imageUrl) {
        await cleanupCompletionObject(JSON.stringify(completion));
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
      await cleanupCompletionObject(JSON.stringify(completion));
      throw new Error("Messenger completion missing");
    }
    if (existing) {
      if (existing.imageUrl !== completion.imageUrl) {
        await cleanupCompletionObject(JSON.stringify(completion));
        if (mode === "create") return;
        throw new Error("Messenger completion conflict");
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
        await assertMessengerGenerationOwnership(fence);
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
    const values = await redis.eval(
      ERASE_COMPLETIONS_SCRIPT,
      2,
      `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${rootIndexStorageId(fence)}`,
      `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${tombstoneStorageId(fence)}`,
      String(fence.privacyEpoch)
    );
    const objectKeys = await redis.smembers(
      `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${objectIndexStorageId(fence)}`
    );
    if (Array.isArray(values)) {
      const keys: string[] = [];
      for (let index = 0; index < values.length; index += 2) {
        keys.push(String(values[index]));
        await cleanupCompletionObject(String(values[index + 1]));
      }
      for (const objectKey of objectKeys) await storageDelete(objectKey);
      await redis.eval(
        FINALIZE_ERASE_COMPLETIONS_SCRIPT,
        3,
        `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${rootIndexStorageId(fence)}`,
        `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${tombstoneStorageId(fence)}`,
        `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${objectIndexStorageId(fence)}`,
        ...keys
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
    completion.pageId === fence.pageId
  );
}
