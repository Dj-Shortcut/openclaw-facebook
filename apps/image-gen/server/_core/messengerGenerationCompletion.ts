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
import type { MessengerChannel } from "./messengerRequestContext";
import { getRedisClient, isRedisEnabled } from "./redis";
import { assertMessengerGenerationOwnership } from "./workspaceEntitlementRuntime";
import type {
  MessengerImageQuotaIdentity,
  MessengerImageQuotaStatus,
} from "./messengerImageQuotaStore";
import {
  assertMessengerStorageScope,
  isLegacyMessengerStorageObjectKey,
  isMessengerStorageLegacyBridgeEnabled,
  messengerStorageObjectIsAllowedForScope,
  messengerStorageObjectMatchesScope,
  parseMessengerStorageObjectKey,
  type MessengerStorageScope,
} from "./messengerStorageObject";

const GENERATION_COMPLETION_SCOPE = "messenger-generation-completion";
const GENERATION_COMPLETION_USER_INDEX_SCOPE =
  "messenger-generation-completion:user";
const GENERATION_DELIVERY_RECEIPT_SCOPE =
  "messenger-generation-completion:receipt";
const GENERATION_DELIVERY_RECEIPT_REGISTRY_SCOPE =
  "messenger-generation-completion:receipt-registry";
const GENERATION_COMPLETION_TTL_SECONDS = 7 * 24 * 60 * 60;
const GENERATION_OBJECT_INVENTORY_TTL_SECONDS = 31 * 24 * 60 * 60;
const GENERATION_DELIVERY_RECEIPT_RACE_TTL_SECONDS = 5 * 60;
const MAX_DELIVERY_RECEIPT_MIDS = 100;
const MAX_DELIVERY_RECEIPT_COMPLETIONS = 256;
const MAX_DELIVERY_RECEIPT_SCOPES_PER_EPOCH = 64;
const USER_INDEX_LOCK_TTL_SECONDS = 15;
const USER_INDEX_LOCK_WAIT_MS = 5_000;
const USER_INDEX_LOCK_INITIAL_BACKOFF_MS = 10;
const USER_INDEX_LOCK_MAX_BACKOFF_MS = 125;

export type MessengerGenerationQuotaAccountingMode =
  | "success_only_v1"
  | "legacy_pre_success_v1"
  | "startpilot_attempt_committed_v1"
  | "paid_credit_delivery_v1";

export type MessengerGenerationCompletion = {
  reqId: string;
  imageUrl: string;
  completedAt: number;
  /**
   * `transport_started` is sticky delivery intent, not proof of a Meta call.
   * Recovery consults the durable DB provider fence before deciding whether a
   * reserved attempt is safe or an actually started attempt is ambiguous.
   */
  deliveryStatus?:
    "pending" | "transport_started" | "receipt_pending" | "delivered";
  deliveryStartedAt?: number;
  messengerAcceptedAt?: number;
  /** SHA-256 only; the raw Meta message ID is never persisted. */
  messengerMessageIdHash?: string;
  deliveredAt?: number;
  /** Written only by an exact scoped Meta delivery callback. */
  deliveryProof?: "meta_delivery_receipt_v1";
  receiptConfirmedAt?: number;
  /**
   * `success_only_v1` commits free quota after durable provider success.
   * `startpilot_attempt_committed_v1` commits paid usage atomically with the
   * provider-attempt transition. `legacy_pre_success_v1` is reserved for
   * explicitly identified pre-migration completions.
   * `paid_credit_delivery_v1` identifies a paid hold that may commit only
   * after this completion records exact durable Messenger delivery.
   */
  quotaAccountingMode?: MessengerGenerationQuotaAccountingMode;
  paidCreditMode?: "test" | "live";
  /**
   * The exact originating free-quota scope, or null when the originating
   * policy deliberately bypassed free quota. Older completions omit it.
   */
  quotaIdentity?: MessengerImageQuotaIdentity | null;
  quotaStatus?: MessengerImageQuotaStatus;
  quotaCommittedAt?: number;
  successNoticeStatus?: "pending" | "sent";
  successNoticeSentAt?: number;
  userKey?: string;
  workspaceId?: number;
  channelConnectionId?: number;
  bindingEpoch?: number;
  privacyEpoch?: number;
  pageId?: string;
  channel?: MessengerChannel;
  expiresAt?: number;
};

export type MessengerGenerationCompletionFence = Readonly<{
  workspaceId: number;
  channelConnectionId: number;
  bindingEpoch: number;
  privacyEpoch: number;
  userKey: string;
  pageId: string;
  channel?: MessengerChannel;
}>;

export type MessengerGenerationDeliveryStart =
  "started" | "already_started" | "receipt_pending" | "already_delivered";

export type MessengerGenerationDeliveryAcceptance =
  "receipt_pending" | "delivered";

const WRITE_COMPLETION_SCRIPT = `
local erasedEpoch = tonumber(redis.call('get', KEYS[3]) or '0')
local incomingEpoch = tonumber(ARGV[7])
if not incomingEpoch or incomingEpoch <= 0 then
  return redis.error_reply('invalid completion privacy epoch')
end
if erasedEpoch >= incomingEpoch then return {'erased'} end
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
elseif ARGV[4] == 'delivery_start' then
  if not existing then return {'missing'} end
  local decoded = cjson.decode(existing)
  local incoming = cjson.decode(ARGV[1])
  if decoded.imageUrl ~= incoming.imageUrl then return {'conflict', existing} end
  if decoded.deliveryStatus == 'delivered' then
    return {'already_delivered'}
  end
  if decoded.deliveryStatus == 'receipt_pending' then
    return {'receipt_pending'}
  end
  if decoded.deliveryStatus == 'transport_started' then
    return {'already_started'}
  end
  decoded.deliveryStatus = 'transport_started'
  decoded.deliveryStartedAt = incoming.deliveryStartedAt
  redis.call('set', KEYS[1], cjson.encode(decoded), 'PXAT', decoded.expiresAt)
  ARGV[3] = tostring(decoded.expiresAt)
elseif ARGV[4] == 'delivery_accept' then
  if not existing then return {'missing'} end
  local decoded = cjson.decode(existing)
  local incoming = cjson.decode(ARGV[1])
  if decoded.imageUrl ~= incoming.imageUrl then return {'conflict', existing} end
  if decoded.messengerMessageIdHash ~= nil and decoded.messengerMessageIdHash ~= incoming.messengerMessageIdHash then
    return {'conflict', existing}
  end
  if decoded.deliveryStatus == 'delivered' and decoded.deliveryProof == 'meta_delivery_receipt_v1' then
    return {'already_delivered', existing}
  end
  if decoded.deliveryStatus ~= 'transport_started' and decoded.deliveryStatus ~= 'receipt_pending' then
    return {'conflict', existing}
  end
  decoded.deliveryStatus = 'receipt_pending'
  decoded.messengerAcceptedAt = decoded.messengerAcceptedAt or incoming.messengerAcceptedAt
  decoded.messengerMessageIdHash = incoming.messengerMessageIdHash
  redis.call('set', KEYS[1], cjson.encode(decoded), 'PXAT', decoded.expiresAt)
  ARGV[3] = tostring(decoded.expiresAt)
elseif ARGV[4] == 'receipt_confirm' then
  if not existing then return {'missing'} end
  local decoded = cjson.decode(existing)
  local incoming = cjson.decode(ARGV[1])
  if decoded.imageUrl ~= incoming.imageUrl
    or decoded.messengerMessageIdHash ~= incoming.messengerMessageIdHash then
    return {'conflict', existing}
  end
  if decoded.deliveryProof ~= nil and decoded.deliveryProof ~= 'meta_delivery_receipt_v1' then
    return {'conflict', existing}
  end
  if decoded.deliveryStatus == 'delivered' and decoded.deliveryProof == 'meta_delivery_receipt_v1' then
    return {'already_delivered', existing}
  end
  if decoded.deliveryStatus ~= 'receipt_pending' and decoded.deliveryStatus ~= 'delivered' then
    return {'conflict', existing}
  end
  decoded.deliveryStatus = 'delivered'
  decoded.deliveredAt = incoming.deliveredAt
  decoded.deliveryProof = 'meta_delivery_receipt_v1'
  decoded.receiptConfirmedAt = incoming.receiptConfirmedAt
  redis.call('set', KEYS[1], cjson.encode(decoded), 'PXAT', decoded.expiresAt)
  ARGV[3] = tostring(decoded.expiresAt)
elseif ARGV[4] == 'delivery_retry' then
  if not existing then return {'missing'} end
  local decoded = cjson.decode(existing)
  local incoming = cjson.decode(ARGV[1])
  if decoded.imageUrl ~= incoming.imageUrl then return {'conflict', existing} end
  if decoded.deliveryStatus == 'delivered' then
    return {'already_delivered'}
  end
  if decoded.deliveryStatus ~= 'transport_started' then
    return {'already_pending'}
  end
  decoded.deliveryStatus = 'pending'
  decoded.deliveryStartedAt = nil
  redis.call('set', KEYS[1], cjson.encode(decoded), 'PXAT', decoded.expiresAt)
  ARGV[3] = tostring(decoded.expiresAt)
elseif ARGV[4] == 'quota' then
  if not existing then return {'missing'} end
  local decoded = cjson.decode(existing)
  local incoming = cjson.decode(ARGV[1])
  if decoded.imageUrl ~= incoming.imageUrl then return {'conflict', existing} end
  decoded.quotaStatus = incoming.quotaStatus
  decoded.quotaCommittedAt = decoded.quotaCommittedAt or incoming.quotaCommittedAt
  decoded.successNoticeStatus = decoded.successNoticeStatus or 'pending'
  redis.call('set', KEYS[1], cjson.encode(decoded), 'PXAT', decoded.expiresAt)
  ARGV[3] = tostring(decoded.expiresAt)
elseif ARGV[4] == 'notice' then
  if not existing then return {'missing'} end
  local decoded = cjson.decode(existing)
  local incoming = cjson.decode(ARGV[1])
  if decoded.imageUrl ~= incoming.imageUrl then return {'conflict', existing} end
  decoded.successNoticeStatus = 'sent'
  decoded.successNoticeSentAt = incoming.successNoticeSentAt
  redis.call('set', KEYS[1], cjson.encode(decoded), 'PXAT', decoded.expiresAt)
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
redis.call('sadd', KEYS[5], ARGV[7])
local epochIndexTtl = redis.call('pttl', KEYS[5])
if epochIndexTtl < 0 then
  redis.call('pexpireat', KEYS[5], ARGV[6])
else
  redis.call('pexpireat', KEYS[5], ARGV[6], 'GT')
end
return {'stored'}
`;

const BEGIN_ERASE_COMPLETIONS_SCRIPT = `
local currentEpoch = tonumber(redis.call('get', KEYS[1]) or '0')
local requestedEpoch = tonumber(ARGV[1])
if not requestedEpoch or requestedEpoch <= 0 then
  return redis.error_reply('invalid completion erasure epoch')
end
if currentEpoch < requestedEpoch then
  redis.call('set', KEYS[1], ARGV[1])
end

-- The first two indexes are the pre-epoch layout. Snapshot them in the same
-- atomic step that raises the erasure fence. A higher privacy epoch can start
-- immediately afterwards without being swept into this erasure attempt.
local legacyValues = {}
local protectedLegacyValues = {}
local legacyKeys = redis.call('smembers', KEYS[3])
for _, key in ipairs(legacyKeys) do
  local value = redis.call('get', key)
  if value then
    local shouldDelete = true
    local decodedOk, decoded = pcall(cjson.decode, value)
    if decodedOk and decoded.privacyEpoch ~= nil then
      local valueEpoch = tonumber(decoded.privacyEpoch)
      shouldDelete = not valueEpoch or valueEpoch <= requestedEpoch
    end
    if shouldDelete then
      table.insert(legacyValues, key)
      table.insert(legacyValues, value)
    else
      table.insert(protectedLegacyValues, value)
    end
  end
end
return {
  redis.call('smembers', KEYS[2]),
  legacyValues,
  redis.call('smembers', KEYS[4]),
  protectedLegacyValues
}
`;

const FINALIZE_EPOCH_ERASE_SCRIPT = `
local erasedEpoch = tonumber(redis.call('get', KEYS[1]) or '0')
local requestedEpoch = tonumber(ARGV[1])
local indexedEpoch = tonumber(ARGV[2])
local completionCount = tonumber(ARGV[3])
local deliveryStateKeyCount = tonumber(ARGV[4])
if not requestedEpoch or not indexedEpoch or not completionCount or not deliveryStateKeyCount then
  return redis.error_reply('invalid completion epoch finalization')
end
if #KEYS ~= 5 + deliveryStateKeyCount then
  return redis.error_reply('invalid completion delivery-state finalization')
end
if erasedEpoch < requestedEpoch or indexedEpoch > requestedEpoch then return 0 end
for index = 1, completionCount do
  redis.call('del', ARGV[index + 4])
end
for index = 3, #KEYS do
  redis.call('del', KEYS[index])
end
redis.call('srem', KEYS[2], ARGV[2])
return completionCount
`;

const FINALIZE_LEGACY_ERASE_SCRIPT = `
local erasedEpoch = tonumber(redis.call('get', KEYS[1]) or '0')
local requestedEpoch = tonumber(ARGV[1])
local completionCount = tonumber(ARGV[2])
local objectCount = tonumber(ARGV[3])
if not requestedEpoch or not completionCount or not objectCount then
  return redis.error_reply('invalid legacy completion finalization')
end
if erasedEpoch < requestedEpoch then return 0 end
local offset = 3
for index = 1, completionCount do
  local completionKey = ARGV[offset + index]
  redis.call('del', completionKey)
  redis.call('srem', KEYS[2], completionKey)
end
offset = offset + completionCount
for index = 1, objectCount do
  redis.call('srem', KEYS[3], ARGV[offset + index])
end
return completionCount + objectCount
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

const REMEMBER_DELIVERY_RECEIPT_SCRIPT = `
local erasedEpoch = tonumber(redis.call('get', KEYS[2]) or '0')
local incomingEpoch = tonumber(ARGV[2])
local maxReceipts = tonumber(ARGV[4])
if not incomingEpoch or incomingEpoch <= 0 or not maxReceipts then
  return redis.error_reply('invalid delivery receipt scope')
end
if erasedEpoch >= incomingEpoch then return 'erased' end
if redis.call('sismember', KEYS[1], ARGV[1]) == 1 then return 'exists' end
if redis.call('scard', KEYS[1]) >= maxReceipts then return 'full' end
redis.call('sadd', KEYS[1], ARGV[1])
redis.call('pexpireat', KEYS[1], ARGV[3])
redis.call('sadd', KEYS[3], ARGV[2])
local registryTtl = redis.call('pttl', KEYS[3])
if registryTtl < 0 then
  redis.call('pexpireat', KEYS[3], ARGV[5])
else
  redis.call('pexpireat', KEYS[3], ARGV[5], 'GT')
end
return 'stored'
`;

const ACCEPT_DELIVERY_MESSAGE_SCRIPT = `
local erasedEpoch = tonumber(redis.call('get', KEYS[4]) or '0')
local incomingEpoch = tonumber(ARGV[3])
if not incomingEpoch or incomingEpoch <= 0 then
  return redis.error_reply('invalid delivery acceptance scope')
end
if erasedEpoch >= incomingEpoch then return {'erased'} end
local existing = redis.call('get', KEYS[1])
if not existing then return {'missing'} end
local decoded = cjson.decode(existing)
local incoming = cjson.decode(ARGV[1])
if decoded.imageUrl ~= incoming.imageUrl then return {'conflict', existing} end
if decoded.messengerMessageIdHash ~= nil and decoded.messengerMessageIdHash ~= ARGV[2] then
  return {'conflict', existing}
end
local priorKey = redis.call('hget', KEYS[3], ARGV[2])
if priorKey and priorKey ~= KEYS[1] then
  if redis.call('exists', priorKey) == 1 then return {'claim_conflict'} end
  redis.call('hdel', KEYS[3], ARGV[2])
end
local alreadyDelivered = decoded.deliveryStatus == 'delivered' and decoded.deliveryProof == 'meta_delivery_receipt_v1'
if not alreadyDelivered and decoded.deliveryStatus ~= 'transport_started' and decoded.deliveryStatus ~= 'receipt_pending' then
  return {'conflict', existing}
end
if redis.call('sismember', KEYS[5], ARGV[4]) == 0 then
  if redis.call('scard', KEYS[5]) >= tonumber(ARGV[6]) then return {'scope_full'} end
  redis.call('sadd', KEYS[5], ARGV[4])
end
local scopeRegistryTtl = redis.call('pttl', KEYS[5])
if scopeRegistryTtl < 0 then
  redis.call('pexpireat', KEYS[5], ARGV[5])
else
  redis.call('pexpireat', KEYS[5], ARGV[5], 'GT')
end
if alreadyDelivered then
  redis.call('hset', KEYS[3], ARGV[2], KEYS[1])
  redis.call('pexpireat', KEYS[3], decoded.expiresAt)
  return {'delivered', existing}
end
decoded.deliveryStatus = 'receipt_pending'
decoded.messengerAcceptedAt = decoded.messengerAcceptedAt or incoming.messengerAcceptedAt
decoded.messengerMessageIdHash = ARGV[2]
redis.call('hset', KEYS[3], ARGV[2], KEYS[1])
local claimTtl = redis.call('pttl', KEYS[3])
if claimTtl < 0 then
  redis.call('pexpireat', KEYS[3], decoded.expiresAt)
else
  redis.call('pexpireat', KEYS[3], decoded.expiresAt, 'GT')
end
if redis.call('sismember', KEYS[2], ARGV[2]) == 1 then
  redis.call('srem', KEYS[2], ARGV[2])
  decoded.deliveryStatus = 'delivered'
  decoded.deliveredAt = incoming.receiptConfirmedAt
  decoded.deliveryProof = 'meta_delivery_receipt_v1'
  decoded.receiptConfirmedAt = incoming.receiptConfirmedAt
  redis.call('set', KEYS[1], cjson.encode(decoded), 'PXAT', decoded.expiresAt)
  return {'delivered', cjson.encode(decoded)}
end
redis.call('set', KEYS[1], cjson.encode(decoded), 'PXAT', decoded.expiresAt)
return {'receipt_pending', cjson.encode(decoded)}
`;

const CONFIRM_DELIVERY_MESSAGE_SCRIPT = `
local erasedEpoch = tonumber(redis.call('get', KEYS[4]) or '0')
local incomingEpoch = tonumber(ARGV[2])
local maxReceipts = tonumber(ARGV[4])
if not incomingEpoch or incomingEpoch <= 0 or not maxReceipts then
  return redis.error_reply('invalid delivery receipt scope')
end
if erasedEpoch >= incomingEpoch then return {'erased'} end
if redis.call('sismember', KEYS[5], ARGV[7]) == 0 then
  if redis.call('scard', KEYS[5]) >= tonumber(ARGV[8]) then return {'scope_full'} end
  redis.call('sadd', KEYS[5], ARGV[7])
end
local scopeRegistryTtl = redis.call('pttl', KEYS[5])
if scopeRegistryTtl < 0 then
  redis.call('pexpireat', KEYS[5], ARGV[3] + ARGV[6])
else
  redis.call('pexpireat', KEYS[5], ARGV[3] + ARGV[6], 'GT')
end
local completionKey = redis.call('hget', KEYS[2], ARGV[1])
if completionKey then
  local existing = redis.call('get', completionKey)
  if existing then
    local decoded = cjson.decode(existing)
    if decoded.messengerMessageIdHash ~= ARGV[1] then return {'conflict'} end
    if decoded.deliveryStatus == 'delivered' and decoded.deliveryProof == 'meta_delivery_receipt_v1' then
      redis.call('srem', KEYS[1], ARGV[1])
      return {'delivered', existing}
    end
    if decoded.deliveryStatus ~= 'receipt_pending' and decoded.deliveryStatus ~= 'delivered' then
      return {'conflict'}
    end
    decoded.deliveryStatus = 'delivered'
    decoded.deliveredAt = ARGV[3]
    decoded.deliveryProof = 'meta_delivery_receipt_v1'
    decoded.receiptConfirmedAt = ARGV[3]
    redis.call('set', completionKey, cjson.encode(decoded), 'PXAT', decoded.expiresAt)
    redis.call('srem', KEYS[1], ARGV[1])
    return {'delivered', cjson.encode(decoded)}
  end
  redis.call('hdel', KEYS[2], ARGV[1])
end
if redis.call('sismember', KEYS[1], ARGV[1]) == 1 then return {'pending'} end
if redis.call('scard', KEYS[1]) >= maxReceipts then return {'full'} end
redis.call('sadd', KEYS[1], ARGV[1])
redis.call('pexpireat', KEYS[1], ARGV[3] + ARGV[5])
redis.call('sadd', KEYS[3], ARGV[2])
local registryTtl = redis.call('pttl', KEYS[3])
if registryTtl < 0 then
  redis.call('pexpireat', KEYS[3], ARGV[3] + ARGV[6])
else
  redis.call('pexpireat', KEYS[3], ARGV[3] + ARGV[6], 'GT')
end
return {'pending'}
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
    .update(fence.userKey);
  if (fence.channel === "whatsapp") {
    subjectDigest.update("\0whatsapp");
  }
  return `{mgc:${subjectDigest.digest("hex")}}`;
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
    .update(reqId);
  if (fence.channel === "whatsapp") {
    identity.update("\0whatsapp");
  }
  return `${subjectTag(fence)}:${identity.digest("hex")}`;
}

function rootIndexStorageId(fence: MessengerGenerationCompletionFence): string {
  // Kept for cleanup of the pre-epoch Redis layout and the non-Redis fallback.
  // New Redis writes must use epochIndexStorageId instead.
  return `${subjectTag(fence)}:index`;
}

function epochIndexStorageId(
  fence: MessengerGenerationCompletionFence,
  privacyEpoch = fence.privacyEpoch
): string {
  return `${subjectTag(fence)}:epoch:${privacyEpoch}:index`;
}

function epochRegistryStorageId(
  fence: MessengerGenerationCompletionFence
): string {
  return `${subjectTag(fence)}:epochs`;
}

function tombstoneStorageId(fence: MessengerGenerationCompletionFence): string {
  return `${subjectTag(fence)}:erased`;
}

function objectIndexStorageId(
  fence: MessengerGenerationCompletionFence
): string {
  // Pre-epoch Redis object inventory; new writes are privacy-epoch scoped.
  return `${subjectTag(fence)}:objects`;
}

function epochObjectIndexStorageId(
  fence: MessengerGenerationCompletionFence,
  privacyEpoch = fence.privacyEpoch
): string {
  return `${subjectTag(fence)}:epoch:${privacyEpoch}:objects`;
}

function epochReceiptStorageId(
  fence: MessengerGenerationCompletionFence,
  privacyEpoch = fence.privacyEpoch
): string {
  return receiptStorageIdForDigest(
    fence,
    deliveryReceiptScopeDigest(fence, privacyEpoch)
  );
}

function epochMessageClaimStorageId(
  fence: MessengerGenerationCompletionFence,
  privacyEpoch = fence.privacyEpoch
): string {
  return messageClaimStorageIdForDigest(
    fence,
    deliveryReceiptScopeDigest(fence, privacyEpoch)
  );
}

function epochReceiptScopeRegistryStorageId(
  fence: MessengerGenerationCompletionFence,
  privacyEpoch = fence.privacyEpoch
): string {
  return `${subjectTag(fence)}:epoch:${privacyEpoch}:receipt-scopes`;
}

function receiptStorageIdForDigest(
  fence: MessengerGenerationCompletionFence,
  scopeDigest: string
): string {
  return `${subjectTag(fence)}:receipt:${scopeDigest}`;
}

function messageClaimStorageIdForDigest(
  fence: MessengerGenerationCompletionFence,
  scopeDigest: string
): string {
  return `${subjectTag(fence)}:message-claim:${scopeDigest}`;
}

function deliveryReceiptScopeDigest(
  fence: MessengerGenerationCompletionFence,
  privacyEpoch = fence.privacyEpoch
): string {
  return createHash("sha256")
    .update("leaderbot.messenger-delivery-scope.v1\0", "utf8")
    .update(String(fence.workspaceId))
    .update("\0")
    .update(String(fence.channelConnectionId))
    .update("\0")
    .update(String(fence.bindingEpoch))
    .update("\0")
    .update(String(privacyEpoch))
    .update("\0")
    .update(fence.userKey)
    .update("\0")
    .update(fence.pageId)
    .update("\0")
    .update(fence.channel ?? "facebook_messenger")
    .digest("hex");
}

function messengerMessageIdHash(
  messageId: string,
  fence: MessengerGenerationCompletionFence
): string {
  const normalized = messageId.trim();
  if (
    normalized.length < 1 ||
    Buffer.byteLength(normalized, "ascii") > 1_024 ||
    !/^[\x21-\x7e]+$/.test(normalized)
  ) {
    throw new Error("Invalid Messenger delivery message ID");
  }
  return createHash("sha256")
    .update("leaderbot.messenger-delivery-message.v1\0", "utf8")
    .update(deliveryReceiptScopeDigest(fence), "ascii")
    .update("\0")
    .update(normalized, "ascii")
    .digest("hex");
}

function userIndexLockKey(subjectKey: string): string {
  return `lock:${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${subjectKey}`;
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

async function withUserIndexLock<T>(
  subjectKey: string,
  action: () => Promise<T>
): Promise<T> {
  const lockKey = userIndexLockKey(subjectKey);
  const token = randomUUID();
  const deadline = Date.now() + USER_INDEX_LOCK_WAIT_MS;
  let backoffMs = USER_INDEX_LOCK_INITIAL_BACKOFF_MS;

  while (Date.now() <= deadline) {
    if (
      await setEphemeralKeyIfAbsent(lockKey, token, USER_INDEX_LOCK_TTL_SECONDS)
    ) {
      try {
        return await action();
      } finally {
        await deleteEphemeralKeyIfValue(lockKey, token);
      }
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const jitterMs = Math.floor(Math.random() * 11);
    await wait(Math.min(remainingMs, backoffMs + jitterMs));
    backoffMs = Math.min(USER_INDEX_LOCK_MAX_BACKOFF_MS, backoffMs * 2);
  }

  throw new Error(
    "Timed out waiting for messenger generation completion index lock"
  );
}

export async function markMessengerGenerationCompleted(
  reqId: string,
  imageUrl: string,
  userKey?: string,
  now = Date.now(),
  fence?: MessengerGenerationCompletionFence,
  quotaAccountingMode: MessengerGenerationQuotaAccountingMode = "success_only_v1",
  quotaIdentity?: MessengerImageQuotaIdentity | null,
  paidCreditMode?: "test" | "live"
): Promise<void> {
  await writeMessengerGenerationCompletion(
    {
      reqId,
      imageUrl,
      completedAt: now,
      deliveryStatus: "pending",
      successNoticeStatus: "pending",
      quotaAccountingMode,
      ...(quotaIdentity !== undefined ? { quotaIdentity } : {}),
      ...(paidCreditMode !== undefined ? { paidCreditMode } : {}),
      userKey,
      ...fence,
      expiresAt: now + GENERATION_COMPLETION_TTL_SECONDS * 1_000,
    },
    fence,
    "create"
  );
}

/**
 * Records Messenger image-delivery intent before the external call.
 * A replay may continue after `already_started`: the durable DB provider fence
 * decides whether absent/reserved work is safe or started/ambiguous work must
 * be contained without another Meta call.
 */
export async function markMessengerGenerationDeliveryStarted(
  reqId: string,
  imageUrl: string,
  userKey?: string,
  now = Date.now(),
  fence?: MessengerGenerationCompletionFence
): Promise<MessengerGenerationDeliveryStart> {
  const result = await writeMessengerGenerationCompletion(
    {
      reqId,
      imageUrl,
      completedAt: now,
      deliveryStatus: "transport_started",
      deliveryStartedAt: now,
      userKey,
      ...fence,
      expiresAt: now + GENERATION_COMPLETION_TTL_SECONDS * 1_000,
    },
    fence,
    "delivery_start"
  );
  if (
    result !== "started" &&
    result !== "already_started" &&
    result !== "receipt_pending" &&
    result !== "already_delivered"
  ) {
    throw new Error(`Messenger completion delivery start ${result}`);
  }
  return result;
}

/**
 * Records Meta's accepted outbound message identity without treating the HTTP
 * response as delivery. A receipt that raced ahead is consumed under the same
 * subject lock and upgrades the completion to delivered exactly once.
 */
export async function markMessengerGenerationDeliveryAccepted(
  reqId: string,
  imageUrl: string,
  messageId: string,
  userKey: string,
  now = Date.now(),
  fence: MessengerGenerationCompletionFence
): Promise<MessengerGenerationDeliveryAcceptance> {
  if (userKey !== fence.userKey) {
    throw new Error("Messenger delivery acceptance scope mismatch");
  }
  const messageIdHash = messengerMessageIdHash(messageId, fence);
  if (isRedisEnabled()) {
    return acceptMessengerDeliveryMessageRedis({
      reqId,
      imageUrl,
      messageIdHash,
      now,
      fence,
    });
  }
  return await withUserIndexLock(rootIndexStorageId(fence), async () => {
    await registerDeliveryReceiptScopeNonRedis(fence);
    const completions = await readIndexedCompletions(fence);
    if (
      completions.some(
        completion =>
          completion.reqId !== reqId &&
          completion.messengerMessageIdHash === messageIdHash
      )
    ) {
      throw new Error("Messenger delivery message claim conflict");
    }
    const result = await writeMessengerGenerationCompletion(
      {
        reqId,
        imageUrl,
        completedAt: now,
        deliveryStatus: "receipt_pending",
        messengerAcceptedAt: now,
        messengerMessageIdHash: messageIdHash,
        ...fence,
        expiresAt: now + GENERATION_COMPLETION_TTL_SECONDS * 1_000,
      },
      fence,
      "delivery_accept",
      true
    );
    if (result === "already_delivered") return "delivered";
    if (result !== "stored") {
      throw new Error(`Messenger completion delivery acceptance ${result}`);
    }
    if (await consumePendingDeliveryReceipt(messageIdHash, fence)) {
      await writeMessengerGenerationCompletion(
        {
          reqId,
          imageUrl,
          completedAt: now,
          deliveryStatus: "delivered",
          deliveredAt: now,
          messengerMessageIdHash: messageIdHash,
          deliveryProof: "meta_delivery_receipt_v1",
          receiptConfirmedAt: now,
          ...fence,
          expiresAt: now + GENERATION_COMPLETION_TTL_SECONDS * 1_000,
        },
        fence,
        "receipt_confirm",
        true
      );
      return "delivered";
    }
    const current = await getMessengerGenerationCompletion(reqId, fence);
    return current?.deliveryStatus === "delivered"
      ? "delivered"
      : "receipt_pending";
  });
}

/**
 * Applies delivery confirmations only inside the exact Page/user/privacy
 * boundary supplied by durable webhook ingress. Unknown receipts are retained
 * briefly as hashes solely to close the callback-before-response race.
 */
export async function confirmMessengerGenerationDeliveryReceipts(
  messageIds: readonly string[],
  fence: MessengerGenerationCompletionFence,
  now = Date.now()
): Promise<MessengerGenerationCompletion[]> {
  if (messageIds.length < 1 || messageIds.length > MAX_DELIVERY_RECEIPT_MIDS) {
    throw new Error("Invalid Messenger delivery receipt batch");
  }
  const hashes = Array.from(
    new Set(
      messageIds.map(messageId => messengerMessageIdHash(messageId, fence))
    )
  );
  if (isRedisEnabled()) {
    return confirmMessengerDeliveryMessagesRedis(hashes, fence, now);
  }
  return await withUserIndexLock(rootIndexStorageId(fence), async () => {
    await assertMessengerPrivacySubject(fence);
    await assertMessengerGenerationOwnership(fence);
    const completions = await readIndexedCompletions(fence);
    const byHash = new Map<string, MessengerGenerationCompletion>();
    for (const completion of completions) {
      if (
        completion.messengerMessageIdHash &&
        matchesFence(completion, fence) &&
        (completion.deliveryStatus === "receipt_pending" ||
          completion.deliveryStatus === "delivered")
      ) {
        if (byHash.has(completion.messengerMessageIdHash)) {
          throw new Error("Messenger delivery receipt completion conflict");
        }
        byHash.set(completion.messengerMessageIdHash, completion);
      }
    }
    const delivered: MessengerGenerationCompletion[] = [];
    for (const hash of hashes) {
      const completion = byHash.get(hash);
      if (!completion) {
        await rememberPendingDeliveryReceipt(hash, fence, now);
        continue;
      }
      if (
        completion.deliveryStatus === "delivered" &&
        completion.deliveryProof === "meta_delivery_receipt_v1"
      ) {
        await forgetPendingDeliveryReceipt(hash, fence);
        delivered.push(completion);
        continue;
      }
      await writeMessengerGenerationCompletion(
        {
          reqId: completion.reqId,
          imageUrl: completion.imageUrl,
          completedAt: completion.completedAt,
          deliveryStatus: "delivered",
          deliveredAt: now,
          messengerMessageIdHash: hash,
          deliveryProof: "meta_delivery_receipt_v1",
          receiptConfirmedAt: now,
          ...fence,
          expiresAt:
            completion.expiresAt ??
            now + GENERATION_COMPLETION_TTL_SECONDS * 1_000,
        },
        fence,
        "receipt_confirm",
        true
      );
      await forgetPendingDeliveryReceipt(hash, fence);
      delivered.push({
        ...completion,
        deliveryStatus: "delivered",
        deliveredAt: now,
        messengerMessageIdHash: hash,
        deliveryProof: "meta_delivery_receipt_v1",
        receiptConfirmedAt: now,
      });
    }
    return delivered;
  });
}

async function acceptMessengerDeliveryMessageRedis(input: {
  reqId: string;
  imageUrl: string;
  messageIdHash: string;
  now: number;
  fence: MessengerGenerationCompletionFence;
}): Promise<MessengerGenerationDeliveryAcceptance> {
  await assertMessengerPrivacySubject(input.fence);
  await assertMessengerGenerationOwnership(input.fence);
  const redis = await getRedisClient();
  const completionKey = `${GENERATION_COMPLETION_SCOPE}:${completionStorageId(input.reqId, input.fence)}`;
  const expiresAt = input.now + GENERATION_COMPLETION_TTL_SECONDS * 1_000;
  const result = await redis.eval(
    ACCEPT_DELIVERY_MESSAGE_SCRIPT,
    5,
    completionKey,
    `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${epochReceiptStorageId(input.fence)}`,
    `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${epochMessageClaimStorageId(input.fence)}`,
    `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${tombstoneStorageId(input.fence)}`,
    `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${epochReceiptScopeRegistryStorageId(input.fence)}`,
    JSON.stringify({
      reqId: input.reqId,
      imageUrl: input.imageUrl,
      messengerAcceptedAt: input.now,
      receiptConfirmedAt: input.now,
      expiresAt,
    }),
    input.messageIdHash,
    input.fence.privacyEpoch,
    deliveryReceiptScopeDigest(input.fence),
    input.now + GENERATION_OBJECT_INVENTORY_TTL_SECONDS * 1_000,
    MAX_DELIVERY_RECEIPT_SCOPES_PER_EPOCH
  );
  const code = Array.isArray(result) ? String(result[0]) : "unknown";
  if (code === "delivered" || code === "receipt_pending") {
    await assertMessengerPrivacySubject(input.fence);
    await assertMessengerGenerationOwnership(input.fence);
    return code;
  }
  if (code === "claim_conflict") {
    throw new Error("Messenger delivery message claim conflict");
  }
  if (code === "erased") {
    throw new Error("Messenger completion subject is erased");
  }
  throw new Error(`Messenger completion delivery acceptance ${code}`);
}

async function confirmMessengerDeliveryMessagesRedis(
  messageIdHashes: readonly string[],
  fence: MessengerGenerationCompletionFence,
  now: number
): Promise<MessengerGenerationCompletion[]> {
  await assertMessengerPrivacySubject(fence);
  await assertMessengerGenerationOwnership(fence);
  const redis = await getRedisClient();
  const delivered: MessengerGenerationCompletion[] = [];
  for (const messageIdHash of messageIdHashes) {
    const result = await redis.eval(
      CONFIRM_DELIVERY_MESSAGE_SCRIPT,
      5,
      `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${epochReceiptStorageId(fence)}`,
      `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${epochMessageClaimStorageId(fence)}`,
      `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${epochRegistryStorageId(fence)}`,
      `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${tombstoneStorageId(fence)}`,
      `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${epochReceiptScopeRegistryStorageId(fence)}`,
      messageIdHash,
      fence.privacyEpoch,
      now,
      MAX_DELIVERY_RECEIPT_COMPLETIONS,
      GENERATION_DELIVERY_RECEIPT_RACE_TTL_SECONDS * 1_000,
      GENERATION_OBJECT_INVENTORY_TTL_SECONDS * 1_000,
      deliveryReceiptScopeDigest(fence),
      MAX_DELIVERY_RECEIPT_SCOPES_PER_EPOCH
    );
    const code = Array.isArray(result) ? String(result[0]) : "unknown";
    if (code === "pending") continue;
    if (code === "delivered" && Array.isArray(result) && result[1]) {
      const completion = parseCompletion(String(result[1]));
      if (
        !completion ||
        !matchesFence(completion, fence) ||
        completion.deliveryProof !== "meta_delivery_receipt_v1" ||
        completion.messengerMessageIdHash !== messageIdHash
      ) {
        throw new Error("Messenger delivery receipt completion conflict");
      }
      delivered.push(completion);
      continue;
    }
    if (code === "erased") {
      throw new Error("Messenger completion subject is erased");
    }
    throw new Error(`Messenger delivery receipt ${code}`);
  }
  await assertMessengerPrivacySubject(fence);
  await assertMessengerGenerationOwnership(fence);
  return delivered;
}

/** Re-opens delivery only when the transport is known not to have started. */
export async function markMessengerGenerationDeliveryRetryable(
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
      deliveryStatus: "pending",
      userKey,
      ...fence,
      expiresAt: now + GENERATION_COMPLETION_TTL_SECONDS * 1_000,
    },
    fence,
    "delivery_retry"
  );
}

export async function markMessengerGenerationQuotaCommitted(
  reqId: string,
  imageUrl: string,
  userKey: string,
  quotaStatus: MessengerImageQuotaStatus,
  now = Date.now(),
  fence?: MessengerGenerationCompletionFence
): Promise<void> {
  await writeMessengerGenerationCompletion(
    {
      reqId,
      imageUrl,
      completedAt: now,
      deliveryStatus: "pending",
      quotaStatus,
      quotaCommittedAt: now,
      successNoticeStatus: "pending",
      userKey,
      ...fence,
      expiresAt: now + GENERATION_COMPLETION_TTL_SECONDS * 1_000,
    },
    fence,
    "quota"
  );
}

export async function markMessengerGenerationSuccessNoticeSent(
  reqId: string,
  imageUrl: string,
  userKey: string,
  now = Date.now(),
  fence?: MessengerGenerationCompletionFence
): Promise<void> {
  await writeMessengerGenerationCompletion(
    {
      reqId,
      imageUrl,
      completedAt: now,
      deliveryStatus: "delivered",
      successNoticeStatus: "sent",
      successNoticeSentAt: now,
      userKey,
      ...fence,
      expiresAt: now + GENERATION_COMPLETION_TTL_SECONDS * 1_000,
    },
    fence,
    "notice"
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
  mode:
    | "create"
    | "deliver"
    | "delivery_start"
    | "delivery_accept"
    | "receipt_confirm"
    | "delivery_retry"
    | "quota"
    | "notice",
  userIndexLockHeld = false
): Promise<string> {
  return Promise.resolve().then(async () => {
    const completionObjectKey = fence
      ? completionObjectKeyForFence(completion, fence)
      : null;
    if (mode === "create" && fence && isRedisEnabled()) {
      const inventoried = await indexCompletionObjectForPrivacyCleanup(
        completionObjectKey,
        fence
      );
      if (!inventoried) {
        await cleanupCompletionObject(JSON.stringify(completion), {
          mode: "exact",
          fence,
        });
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
          await cleanupCompletionObject(JSON.stringify(completion), {
            mode: "exact",
            fence,
          });
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
        5,
        `${GENERATION_COMPLETION_SCOPE}:${completionStorageId(completion.reqId, fence)}`,
        `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${epochIndexStorageId(fence)}`,
        `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${tombstoneStorageId(fence)}`,
        `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${epochObjectIndexStorageId(fence)}`,
        `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${epochRegistryStorageId(fence)}`,
        JSON.stringify(completion),
        completion.deliveryStatus ?? "pending",
        expiresAt,
        mode,
        completionObjectKey ?? "",
        Date.now() + GENERATION_OBJECT_INVENTORY_TTL_SECONDS * 1_000,
        fence.privacyEpoch
      );
      const resultCode = Array.isArray(result) ? String(result[0]) : "unknown";
      if (resultCode === "stored") {
        try {
          await assertMessengerPrivacySubject(fence);
          await assertMessengerGenerationOwnership(fence);
        } catch (error) {
          await deleteCompletionIfExact(redis, completion, fence);
          await cleanupCompletionObject(JSON.stringify(completion), {
            mode: "exact",
            fence,
          });
          throw error;
        }
        if (mode === "delivery_start") return "started";
        if (mode === "delivery_retry") return "retryable";
        return "stored";
      }
      if (
        resultCode === "already_started" ||
        resultCode === "receipt_pending" ||
        resultCode === "already_delivered" ||
        resultCode === "already_pending"
      ) {
        return resultCode;
      }
      const retained =
        Array.isArray(result) && result[1]
          ? parseCompletion(String(result[1]))
          : null;
      if (
        mode !== "notice" &&
        (!retained || retained.imageUrl !== completion.imageUrl)
      ) {
        await cleanupCompletionObject(
          JSON.stringify(completion),
          fence ? { mode: "exact", fence } : undefined
        );
      }
      if (resultCode === "exists") return "exists";
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
    if (mode !== "create" && !existing) {
      if (
        mode === "deliver" ||
        mode === "delivery_start" ||
        mode === "delivery_accept" ||
        mode === "receipt_confirm" ||
        mode === "delivery_retry" ||
        mode === "quota"
      ) {
        await cleanupCompletionObject(
          JSON.stringify(completion),
          fence ? { mode: "exact", fence } : undefined
        );
      }
      throw new Error("Messenger completion missing");
    }
    if (existing) {
      if (existing.imageUrl !== completion.imageUrl) {
        if (mode !== "notice") {
          await cleanupCompletionObject(
            JSON.stringify(completion),
            fence ? { mode: "exact", fence } : undefined
          );
        }
        if (mode === "create") return "exists";
        throw new Error("Messenger completion conflict");
      }
      if (mode === "create") return "exists";
      if (mode === "deliver") {
        if (existing.deliveryStatus === "delivered") {
          return "already_delivered";
        }
        completion = {
          ...existing,
          deliveryStatus: "delivered",
          deliveredAt: completion.deliveredAt,
        };
      } else if (mode === "delivery_start") {
        if (existing.deliveryStatus === "delivered") {
          return "already_delivered";
        }
        if (existing.deliveryStatus === "receipt_pending") {
          return "receipt_pending";
        }
        if (existing.deliveryStatus === "transport_started") {
          return "already_started";
        }
        completion = {
          ...existing,
          deliveryStatus: "transport_started",
          deliveryStartedAt: completion.deliveryStartedAt,
        };
      } else if (mode === "delivery_accept") {
        if (
          existing.messengerMessageIdHash &&
          existing.messengerMessageIdHash !== completion.messengerMessageIdHash
        ) {
          throw new Error("Messenger completion conflict");
        }
        if (
          existing.deliveryStatus === "delivered" &&
          existing.deliveryProof === "meta_delivery_receipt_v1"
        ) {
          return "already_delivered";
        }
        if (
          existing.deliveryStatus !== "transport_started" &&
          existing.deliveryStatus !== "receipt_pending"
        ) {
          throw new Error("Messenger completion conflict");
        }
        completion = {
          ...existing,
          deliveryStatus: "receipt_pending",
          messengerAcceptedAt:
            existing.messengerAcceptedAt ?? completion.messengerAcceptedAt,
          messengerMessageIdHash: completion.messengerMessageIdHash,
        };
      } else if (mode === "receipt_confirm") {
        if (
          existing.messengerMessageIdHash !==
            completion.messengerMessageIdHash ||
          (existing.deliveryProof !== undefined &&
            existing.deliveryProof !== "meta_delivery_receipt_v1")
        ) {
          throw new Error("Messenger completion conflict");
        }
        if (
          existing.deliveryStatus === "delivered" &&
          existing.deliveryProof === "meta_delivery_receipt_v1"
        ) {
          return "already_delivered";
        }
        if (
          existing.deliveryStatus !== "receipt_pending" &&
          existing.deliveryStatus !== "delivered"
        ) {
          throw new Error("Messenger completion conflict");
        }
        completion = {
          ...existing,
          deliveryStatus: "delivered",
          deliveredAt: completion.deliveredAt,
          deliveryProof: "meta_delivery_receipt_v1",
          receiptConfirmedAt: completion.receiptConfirmedAt,
        };
      } else if (mode === "delivery_retry") {
        if (existing.deliveryStatus === "delivered") {
          return "already_delivered";
        }
        if (existing.deliveryStatus !== "transport_started") {
          return "already_pending";
        }
        completion = {
          ...existing,
          deliveryStatus: "pending",
          deliveryStartedAt: undefined,
        };
      } else if (mode === "quota") {
        completion = {
          ...existing,
          quotaStatus: completion.quotaStatus,
          quotaCommittedAt:
            existing.quotaCommittedAt ?? completion.quotaCommittedAt,
          successNoticeStatus: existing.successNoticeStatus ?? "pending",
        };
      } else {
        if (existing.successNoticeStatus === "sent") return "already_sent";
        completion = {
          ...existing,
          successNoticeStatus: "sent",
          successNoticeSentAt: completion.successNoticeSentAt,
        };
      }
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
      return mode === "delivery_start"
        ? "started"
        : mode === "delivery_retry"
          ? "retryable"
          : "stored";
    }

    const subjectKey = fence
      ? rootIndexStorageId(fence)
      : completionSubjectKey(userKey, fence);
    const updateUserIndex = async (): Promise<void> => {
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
    };
    if (userIndexLockHeld) {
      await updateUserIndex();
    } else {
      await withUserIndexLock(subjectKey, updateUserIndex);
    }
    return mode === "delivery_start"
      ? "started"
      : mode === "delivery_retry"
        ? "retryable"
        : "stored";
  });
}

async function readIndexedCompletions(
  fence: MessengerGenerationCompletionFence
): Promise<MessengerGenerationCompletion[]> {
  if (isRedisEnabled()) {
    const redis = await getRedisClient();
    const indexKey = `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${epochIndexStorageId(fence)}`;
    const keys = await redis.smembers(indexKey);
    const serialized = await Promise.all(keys.map(key => redis.get(key)));
    const staleKeys: string[] = [];
    const completions = serialized.flatMap((value, index) => {
      if (!value) {
        staleKeys.push(keys[index]);
        return [];
      }
      const completion = parseCompletion(value);
      if (!completion) {
        // Preserve corrupt-but-present metadata in the privacy index. Receipt
        // matching must ignore it, but delete-my-data can still delete the
        // indexed key without needing to parse its value.
        return [];
      }
      // The epoch index is shared by every Page/binding fence for this
      // subject. A valid nonmatching completion must stay indexed so a later
      // delete-my-data pass can still erase the older binding's metadata and
      // object inventory; it is merely not a candidate for this receipt.
      return matchesFence(completion, fence) ? [completion] : [];
    });
    if (staleKeys.length > 0) {
      await Promise.all(staleKeys.map(key => redis.srem(indexKey, key)));
    }
    if (completions.length > MAX_DELIVERY_RECEIPT_COMPLETIONS) {
      throw new Error("Messenger delivery receipt inventory exceeds limit");
    }
    return completions;
  }

  const storageIds =
    (await Promise.resolve(
      readScopedState<string[]>(
        GENERATION_COMPLETION_USER_INDEX_SCOPE,
        rootIndexStorageId(fence)
      )
    )) ?? [];
  const completions = await Promise.all(
    storageIds.map(storageId =>
      Promise.resolve(
        readScopedState<MessengerGenerationCompletion>(
          GENERATION_COMPLETION_SCOPE,
          storageId
        )
      )
    )
  );
  const retainedIds: string[] = [];
  const retained: MessengerGenerationCompletion[] = [];
  completions.forEach((completion, index) => {
    if (completion === null) return;
    // The non-Redis root index is shared across bindings too. Prune only a
    // genuinely missing entry; valid nonmatching completions remain reachable
    // by privacy erasure while being excluded from this receipt scan.
    retainedIds.push(storageIds[index]);
    if (matchesFence(completion, fence)) retained.push(completion);
  });
  if (retainedIds.length !== storageIds.length) {
    if (retainedIds.length === 0) {
      await Promise.resolve(
        deleteScopedState(
          GENERATION_COMPLETION_USER_INDEX_SCOPE,
          rootIndexStorageId(fence)
        )
      );
    } else {
      await Promise.resolve(
        writeScopedState(
          GENERATION_COMPLETION_USER_INDEX_SCOPE,
          rootIndexStorageId(fence),
          retainedIds,
          GENERATION_COMPLETION_TTL_SECONDS
        )
      );
    }
  }
  if (retained.length > MAX_DELIVERY_RECEIPT_COMPLETIONS) {
    throw new Error("Messenger delivery receipt inventory exceeds limit");
  }
  return retained;
}

async function registerDeliveryReceiptScopeNonRedis(
  fence: MessengerGenerationCompletionFence
): Promise<void> {
  const registryKey = epochReceiptScopeRegistryStorageId(fence);
  const scopeDigest = deliveryReceiptScopeDigest(fence);
  const current =
    (await Promise.resolve(
      readScopedState<string[]>(
        GENERATION_DELIVERY_RECEIPT_REGISTRY_SCOPE,
        registryKey
      )
    )) ?? [];
  if (!current.includes(scopeDigest)) {
    if (current.length >= MAX_DELIVERY_RECEIPT_SCOPES_PER_EPOCH) {
      throw new Error(
        "Messenger delivery receipt scope inventory exceeds limit"
      );
    }
    current.push(scopeDigest);
  }
  await Promise.resolve(
    writeScopedState(
      GENERATION_DELIVERY_RECEIPT_REGISTRY_SCOPE,
      registryKey,
      current,
      GENERATION_OBJECT_INVENTORY_TTL_SECONDS
    )
  );
}

async function rememberPendingDeliveryReceipt(
  messageIdHash: string,
  fence: MessengerGenerationCompletionFence,
  now: number
): Promise<void> {
  if (isRedisEnabled()) {
    const redis = await getRedisClient();
    const result = String(
      await redis.eval(
        REMEMBER_DELIVERY_RECEIPT_SCRIPT,
        3,
        `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${epochReceiptStorageId(fence)}`,
        `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${tombstoneStorageId(fence)}`,
        `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${epochRegistryStorageId(fence)}`,
        messageIdHash,
        fence.privacyEpoch,
        now + GENERATION_DELIVERY_RECEIPT_RACE_TTL_SECONDS * 1_000,
        MAX_DELIVERY_RECEIPT_COMPLETIONS,
        now + GENERATION_OBJECT_INVENTORY_TTL_SECONDS * 1_000
      )
    );
    if (result === "stored" || result === "exists") return;
    if (result === "erased") {
      throw new Error("Messenger completion subject is erased");
    }
    throw new Error(`Messenger delivery receipt ${result}`);
  }

  await registerDeliveryReceiptScopeNonRedis(fence);
  const key = epochReceiptStorageId(fence);
  const current =
    (await Promise.resolve(
      readScopedState<string[]>(GENERATION_DELIVERY_RECEIPT_SCOPE, key)
    )) ?? [];
  if (!current.includes(messageIdHash)) {
    if (current.length >= MAX_DELIVERY_RECEIPT_COMPLETIONS) {
      throw new Error("Messenger delivery receipt inventory exceeds limit");
    }
    current.push(messageIdHash);
  }
  await Promise.resolve(
    writeScopedState(
      GENERATION_DELIVERY_RECEIPT_SCOPE,
      key,
      current,
      GENERATION_DELIVERY_RECEIPT_RACE_TTL_SECONDS
    )
  );
}

async function consumePendingDeliveryReceipt(
  messageIdHash: string,
  fence: MessengerGenerationCompletionFence
): Promise<boolean> {
  if (isRedisEnabled()) {
    const redis = await getRedisClient();
    return (
      (await redis.srem(
        `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${epochReceiptStorageId(fence)}`,
        messageIdHash
      )) === 1
    );
  }

  const key = epochReceiptStorageId(fence);
  const current =
    (await Promise.resolve(
      readScopedState<string[]>(GENERATION_DELIVERY_RECEIPT_SCOPE, key)
    )) ?? [];
  if (!current.includes(messageIdHash)) return false;
  const remaining = current.filter(value => value !== messageIdHash);
  if (remaining.length === 0) {
    await Promise.resolve(
      deleteScopedState(GENERATION_DELIVERY_RECEIPT_SCOPE, key)
    );
  } else {
    await Promise.resolve(
      writeScopedState(
        GENERATION_DELIVERY_RECEIPT_SCOPE,
        key,
        remaining,
        GENERATION_DELIVERY_RECEIPT_RACE_TTL_SECONDS
      )
    );
  }
  return true;
}

async function forgetPendingDeliveryReceipt(
  messageIdHash: string,
  fence: MessengerGenerationCompletionFence
): Promise<void> {
  await consumePendingDeliveryReceipt(messageIdHash, fence);
}

async function indexCompletionObjectForPrivacyCleanup(
  objectKey: string | null,
  fence: MessengerGenerationCompletionFence
): Promise<boolean> {
  if (!objectKey) return true;
  return await registerMessengerObjectForPrivacyCleanup(objectKey, fence);
}

/**
 * Durably records an object before the first external write can start.
 *
 * Source-image uploads use the same tenant-scoped inventory as generated
 * images so delete-my-data can still scrub an object when a worker exits
 * after the upload but before it publishes normal Messenger state.
 */
export async function registerMessengerObjectForPrivacyCleanup(
  objectKey: string,
  fence: MessengerGenerationCompletionFence,
  now = Date.now()
): Promise<boolean> {
  const normalizedObjectKey = objectKey.trim();
  if (!normalizedObjectKey) {
    throw new Error("Messenger object inventory key is required");
  }
  assertCompletionObjectKeyMatchesFence(normalizedObjectKey, fence);
  if (!isRedisEnabled()) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Messenger object inventory Redis store is unavailable");
    }
    return true;
  }
  const redis = await getRedisClient();
  const result = Number(
    await redis.eval(
      `
        local erasedEpoch = tonumber(redis.call('get', KEYS[2]) or '0')
        local incomingEpoch = tonumber(ARGV[3])
        if not incomingEpoch or incomingEpoch <= 0 then
          return redis.error_reply('invalid completion object privacy epoch')
        end
        if erasedEpoch >= incomingEpoch then return 0 end
        redis.call('sadd', KEYS[1], ARGV[1])
        local ttl = redis.call('pttl', KEYS[1])
        if ttl < 0 then
          redis.call('pexpireat', KEYS[1], ARGV[2])
        else
          redis.call('pexpireat', KEYS[1], ARGV[2], 'GT')
        end
        redis.call('sadd', KEYS[3], ARGV[3])
        local epochIndexTtl = redis.call('pttl', KEYS[3])
        if epochIndexTtl < 0 then
          redis.call('pexpireat', KEYS[3], ARGV[2])
        else
          redis.call('pexpireat', KEYS[3], ARGV[2], 'GT')
        end
        return 1
      `,
      3,
      `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${epochObjectIndexStorageId(fence)}`,
      `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${tombstoneStorageId(fence)}`,
      `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${epochRegistryStorageId(fence)}`,
      normalizedObjectKey,
      now + GENERATION_OBJECT_INVENTORY_TTL_SECONDS * 1_000,
      fence.privacyEpoch
    )
  );
  return result === 1;
}

/** Removes only a confirmed-absent object from the cleanup inventory. */
export async function unregisterMessengerObjectFromPrivacyCleanup(
  objectKey: string,
  fence: MessengerGenerationCompletionFence
): Promise<boolean> {
  const normalizedObjectKey = objectKey.trim();
  if (!normalizedObjectKey) return true;
  assertCompletionObjectKeyMatchesFence(normalizedObjectKey, fence);
  if (!isRedisEnabled()) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Messenger object inventory Redis store is unavailable");
    }
    return true;
  }
  const redis = await getRedisClient();
  const result = Number(
    await redis.eval(
      `
        local erasedEpoch = tonumber(redis.call('get', KEYS[2]) or '0')
        local incomingEpoch = tonumber(ARGV[2])
        if not incomingEpoch or incomingEpoch <= 0 then
          return redis.error_reply('invalid completion object privacy epoch')
        end
        if erasedEpoch >= incomingEpoch then return 0 end
        redis.call('srem', KEYS[1], ARGV[1])
        return 1
      `,
      2,
      `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${epochObjectIndexStorageId(fence)}`,
      `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${tombstoneStorageId(fence)}`,
      normalizedObjectKey,
      fence.privacyEpoch
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
    `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${epochIndexStorageId(fence)}`,
    completion.imageUrl,
    String(completion.completedAt)
  );
}

type CompletionEraseEntry = Readonly<{
  key: string;
  serialized: string;
}>;

type EpochEraseSnapshot = Readonly<{
  privacyEpoch: number;
  completionKeys: string[];
  completions: CompletionEraseEntry[];
  objectKeys: string[];
  deliveryStateKeys: string[];
}>;

type CompletionEraseSnapshot = Readonly<{
  legacyCompletionKeys: string[];
  legacyCompletions: CompletionEraseEntry[];
  legacyObjectKeys: string[];
  epochs: EpochEraseSnapshot[];
}>;

function parseRedisArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid Messenger completion ${label} snapshot`);
  }
  return value.map(item => String(item));
}

function parseIndexedPrivacyEpochs(
  members: string[],
  requestedEpoch: number
): number[] {
  const epochs: number[] = [];
  for (const member of members) {
    if (!/^[1-9]\d*$/.test(member)) {
      throw new Error("Invalid Messenger completion privacy epoch index");
    }
    const epoch = Number(member);
    if (!Number.isSafeInteger(epoch)) {
      throw new Error("Invalid Messenger completion privacy epoch index");
    }
    if (epoch <= requestedEpoch) epochs.push(epoch);
  }
  return epochs.sort((left, right) => left - right);
}

function parseDeliveryReceiptScopeDigests(members: string[]): string[] {
  if (members.length > MAX_DELIVERY_RECEIPT_SCOPES_PER_EPOCH) {
    throw new Error("Messenger delivery receipt scope index exceeds limit");
  }
  const unique = new Set<string>();
  for (const member of members) {
    if (!/^[a-f0-9]{64}$/.test(member)) {
      throw new Error("Invalid Messenger delivery receipt scope index");
    }
    unique.add(member);
  }
  return [...unique];
}

async function beginCompletionErasure(
  redis: Awaited<ReturnType<typeof getRedisClient>>,
  fence: MessengerGenerationCompletionFence
): Promise<CompletionEraseSnapshot> {
  const result = await redis.eval(
    BEGIN_ERASE_COMPLETIONS_SCRIPT,
    4,
    `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${tombstoneStorageId(fence)}`,
    `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${epochRegistryStorageId(fence)}`,
    `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${rootIndexStorageId(fence)}`,
    `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${objectIndexStorageId(fence)}`,
    String(fence.privacyEpoch)
  );
  if (!Array.isArray(result) || result.length !== 4) {
    throw new Error("Invalid Messenger completion erasure snapshot");
  }

  const indexedEpochs = parseIndexedPrivacyEpochs(
    parseRedisArray(result[0], "epoch index"),
    fence.privacyEpoch
  );
  const legacyPairs = parseRedisArray(result[1], "legacy completion");
  if (legacyPairs.length % 2 !== 0) {
    throw new Error("Invalid Messenger legacy completion snapshot");
  }
  const legacyCompletions: CompletionEraseEntry[] = [];
  for (let index = 0; index < legacyPairs.length; index += 2) {
    legacyCompletions.push({
      key: legacyPairs[index],
      serialized: legacyPairs[index + 1],
    });
  }
  const protectedLegacyObjectKeys = new Set(
    parseRedisArray(result[3], "protected legacy completion")
      .map(parseCompletion)
      .map(completion =>
        completion ? safeStorageKeyFromPublicUrl(completion.imageUrl) : null
      )
      .filter((key): key is string => Boolean(key))
  );

  const epochs = await Promise.all(
    indexedEpochs.map(async privacyEpoch => {
      const indexKey = `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${epochIndexStorageId(fence, privacyEpoch)}`;
      const objectIndexKey = `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${epochObjectIndexStorageId(fence, privacyEpoch)}`;
      const receiptScopeRegistryKey = `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${epochReceiptScopeRegistryStorageId(fence, privacyEpoch)}`;
      const [completionKeys, objectKeys, receiptScopeMembers] =
        await Promise.all([
          redis.smembers(indexKey),
          redis.smembers(objectIndexKey),
          redis.smembers(receiptScopeRegistryKey),
        ]);
      const serialized = await Promise.all(
        completionKeys.map(key => redis.get(key))
      );
      const completions: CompletionEraseEntry[] = [];
      for (let index = 0; index < completionKeys.length; index += 1) {
        const value = serialized[index];
        if (value !== null) {
          completions.push({ key: completionKeys[index], serialized: value });
        }
      }
      const receiptScopeDigests = parseDeliveryReceiptScopeDigests([
        ...receiptScopeMembers,
        ...(receiptScopeMembers.length === 0
          ? [deliveryReceiptScopeDigest(fence, privacyEpoch)]
          : []),
      ]);
      return {
        privacyEpoch,
        completionKeys,
        completions,
        objectKeys,
        deliveryStateKeys: receiptScopeDigests.flatMap(scopeDigest => [
          `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${receiptStorageIdForDigest(fence, scopeDigest)}`,
          `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${messageClaimStorageIdForDigest(fence, scopeDigest)}`,
        ]),
      };
    })
  );

  return {
    legacyCompletionKeys: legacyCompletions.map(entry => entry.key),
    legacyCompletions,
    legacyObjectKeys: parseRedisArray(result[2], "legacy object").filter(
      objectKey => !protectedLegacyObjectKeys.has(objectKey)
    ),
    epochs,
  };
}

async function finalizeCompletionErasure(
  redis: Awaited<ReturnType<typeof getRedisClient>>,
  fence: MessengerGenerationCompletionFence,
  snapshot: CompletionEraseSnapshot
): Promise<void> {
  await redis.eval(
    FINALIZE_LEGACY_ERASE_SCRIPT,
    3,
    `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${tombstoneStorageId(fence)}`,
    `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${rootIndexStorageId(fence)}`,
    `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${objectIndexStorageId(fence)}`,
    String(fence.privacyEpoch),
    snapshot.legacyCompletionKeys.length,
    snapshot.legacyObjectKeys.length,
    ...snapshot.legacyCompletionKeys,
    ...snapshot.legacyObjectKeys
  );

  await Promise.all(
    snapshot.epochs.map(epoch => {
      const keys = [
        `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${tombstoneStorageId(fence)}`,
        `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${epochRegistryStorageId(fence)}`,
        `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${epochIndexStorageId(fence, epoch.privacyEpoch)}`,
        `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${epochObjectIndexStorageId(fence, epoch.privacyEpoch)}`,
        `${GENERATION_COMPLETION_USER_INDEX_SCOPE}:${epochReceiptScopeRegistryStorageId(fence, epoch.privacyEpoch)}`,
        ...epoch.deliveryStateKeys,
      ];
      return redis.eval(
        FINALIZE_EPOCH_ERASE_SCRIPT,
        keys.length,
        ...keys,
        String(fence.privacyEpoch),
        String(epoch.privacyEpoch),
        epoch.completionKeys.length,
        epoch.deliveryStateKeys.length,
        ...epoch.completionKeys
      );
    })
  );
}

export type DeleteMessengerGenerationCompletionsOptions = Readonly<{
  /**
   * During the WhatsApp channel-key rollout, delete the exact pre-channel
   * indexes for this same workspace/connection/user tuple as well. The
   * bridge is intentionally explicit so other channels cannot select the
   * unqualified namespace by accident.
   */
  includeLegacyUnqualifiedWhatsAppIndexes?: boolean;
}>;

async function deleteMessengerGenerationCompletionsForFence(
  userKey: string,
  fence?: MessengerGenerationCompletionFence,
  keyFence = fence,
  allowLegacyUnqualifiedWhatsApp = false
): Promise<void> {
  if (fence && keyFence && isRedisEnabled()) {
    const redis = await getRedisClient();
    const snapshot = await beginCompletionErasure(redis, keyFence);
    for (const completion of snapshot.legacyCompletions) {
      await cleanupCompletionObject(completion.serialized, {
        mode: "erasure",
        fence,
        allowLegacyUnqualifiedWhatsApp,
      });
    }
    for (const epoch of snapshot.epochs) {
      for (const completion of epoch.completions) {
        await cleanupCompletionObject(completion.serialized, {
          mode: "erasure",
          fence,
          indexedPrivacyEpoch: epoch.privacyEpoch,
          allowLegacyUnqualifiedWhatsApp,
        });
      }
    }
    for (const objectKey of snapshot.legacyObjectKeys) {
      await cleanupIndexedObjectForErasure(objectKey, fence);
    }
    for (const epoch of snapshot.epochs) {
      for (const objectKey of epoch.objectKeys) {
        await cleanupIndexedObjectForErasure(
          objectKey,
          fence,
          epoch.privacyEpoch
        );
      }
    }
    await finalizeCompletionErasure(redis, keyFence, snapshot);
    return;
  }
  const subjectKey = keyFence
    ? rootIndexStorageId(keyFence)
    : completionSubjectKey(userKey, keyFence);
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
      if (completion) {
        await cleanupCompletionObject(
          JSON.stringify(completion),
          fence
            ? {
                mode: "erasure",
                fence,
                allowLegacyUnqualifiedWhatsApp,
              }
            : undefined
        );
      }
      await Promise.resolve(
        deleteScopedState(GENERATION_COMPLETION_SCOPE, storageId)
      );
    })
  );
  await Promise.resolve(
    deleteScopedState(GENERATION_COMPLETION_USER_INDEX_SCOPE, subjectKey)
  );
  if (keyFence) {
    const receiptScopeRegistryKey =
      epochReceiptScopeRegistryStorageId(keyFence);
    const registeredScopes =
      (await Promise.resolve(
        readScopedState<string[]>(
          GENERATION_DELIVERY_RECEIPT_REGISTRY_SCOPE,
          receiptScopeRegistryKey
        )
      )) ?? [];
    const receiptScopeDigests = parseDeliveryReceiptScopeDigests([
      ...registeredScopes,
      ...(registeredScopes.length === 0
        ? [deliveryReceiptScopeDigest(keyFence)]
        : []),
    ]);
    await Promise.all(
      receiptScopeDigests.map(scopeDigest =>
        Promise.resolve(
          deleteScopedState(
            GENERATION_DELIVERY_RECEIPT_SCOPE,
            receiptStorageIdForDigest(keyFence, scopeDigest)
          )
        )
      )
    );
    await Promise.resolve(
      deleteScopedState(
        GENERATION_DELIVERY_RECEIPT_REGISTRY_SCOPE,
        receiptScopeRegistryKey
      )
    );
  }
}

export async function deleteMessengerGenerationCompletionsForUser(
  userKey: string,
  fence?: MessengerGenerationCompletionFence,
  options: DeleteMessengerGenerationCompletionsOptions = {}
): Promise<void> {
  await deleteMessengerGenerationCompletionsForFence(userKey, fence);
  if (!options.includeLegacyUnqualifiedWhatsAppIndexes) return;
  if (!fence || fence.channel !== "whatsapp") {
    throw new Error(
      "Legacy unqualified completion cleanup requires an exact WhatsApp fence"
    );
  }
  const legacyKeyFence: MessengerGenerationCompletionFence = {
    workspaceId: fence.workspaceId,
    channelConnectionId: fence.channelConnectionId,
    bindingEpoch: fence.bindingEpoch,
    privacyEpoch: fence.privacyEpoch,
    userKey: fence.userKey,
    pageId: fence.pageId,
  };
  await deleteMessengerGenerationCompletionsForFence(
    userKey,
    fence,
    legacyKeyFence,
    true
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

type CompletionObjectCleanupContext =
  | Readonly<{
      mode: "exact";
      fence: MessengerGenerationCompletionFence;
    }>
  | Readonly<{
      mode: "erasure";
      fence: MessengerGenerationCompletionFence;
      indexedPrivacyEpoch?: number;
      allowLegacyUnqualifiedWhatsApp?: boolean;
    }>;

function completionStorageScope(
  completion: MessengerGenerationCompletion
): MessengerStorageScope | null {
  const scope = {
    workspaceId: completion.workspaceId,
    channelConnectionId: completion.channelConnectionId,
    bindingEpoch: completion.bindingEpoch,
    privacyEpoch: completion.privacyEpoch,
    userKey: completion.userKey,
  };
  if (
    typeof scope.workspaceId !== "number" ||
    typeof scope.channelConnectionId !== "number" ||
    typeof scope.bindingEpoch !== "number" ||
    typeof scope.privacyEpoch !== "number" ||
    typeof scope.userKey !== "string"
  ) {
    return null;
  }
  try {
    assertMessengerStorageScope(scope as MessengerStorageScope);
  } catch {
    return null;
  }
  return scope as MessengerStorageScope;
}

function completionMatchesCleanupContext(
  completion: MessengerGenerationCompletion,
  scope: MessengerStorageScope,
  context: CompletionObjectCleanupContext
): boolean {
  const legacyUnqualifiedWhatsAppCompletion =
    context.mode === "erasure" &&
    context.allowLegacyUnqualifiedWhatsApp === true &&
    context.fence.channel === "whatsapp" &&
    completion.channel === undefined;
  if (
    !completionChannelMatchesFence(completion, context.fence) &&
    !legacyUnqualifiedWhatsAppCompletion
  ) {
    return false;
  }
  if (context.mode === "exact") {
    return matchesFence(completion, context.fence);
  }
  if (
    scope.workspaceId !== context.fence.workspaceId ||
    scope.channelConnectionId !== context.fence.channelConnectionId ||
    scope.userKey !== context.fence.userKey ||
    scope.privacyEpoch > context.fence.privacyEpoch
  ) {
    return false;
  }
  return (
    context.indexedPrivacyEpoch === undefined ||
    scope.privacyEpoch === context.indexedPrivacyEpoch
  );
}

function assertCompletionObjectKeyMatchesFence(
  objectKey: string,
  fence: MessengerGenerationCompletionFence
): void {
  if (!messengerStorageObjectIsAllowedForScope(objectKey, fence)) {
    throw new Error(
      "Messenger storage object does not match completion privacy fence"
    );
  }
}

function completionObjectKeyForFence(
  completion: MessengerGenerationCompletion,
  fence: MessengerGenerationCompletionFence
): string | null {
  const objectKey = storageKeyFromPublicUrl(completion.imageUrl);
  if (objectKey) assertCompletionObjectKeyMatchesFence(objectKey, fence);
  return objectKey;
}

function safeStorageKeyFromPublicUrl(publicUrl: string): string | null {
  try {
    return storageKeyFromPublicUrl(publicUrl);
  } catch {
    return null;
  }
}

async function cleanupCompletionObject(
  serialized: string,
  context?: CompletionObjectCleanupContext
): Promise<void> {
  let completion: MessengerGenerationCompletion;
  try {
    completion = JSON.parse(serialized) as MessengerGenerationCompletion;
  } catch {
    return;
  }
  const key = safeStorageKeyFromPublicUrl(completion.imageUrl);
  if (!key) return;
  const parsed = parseMessengerStorageObjectKey(key);
  if (parsed) {
    const scope = completionStorageScope(completion);
    if (!scope || !messengerStorageObjectMatchesScope(key, scope)) return;
    if (
      context &&
      !completionMatchesCleanupContext(completion, scope, context)
    ) {
      return;
    }
  } else if (
    !isMessengerStorageLegacyBridgeEnabled() ||
    !isLegacyMessengerStorageObjectKey(key)
  ) {
    return;
  }
  await storageDelete(key);
}

async function cleanupIndexedObjectForErasure(
  objectKey: string,
  fence: MessengerGenerationCompletionFence,
  indexedPrivacyEpoch?: number
): Promise<void> {
  const parsed = parseMessengerStorageObjectKey(objectKey);
  if (!parsed) {
    if (
      isMessengerStorageLegacyBridgeEnabled() &&
      isLegacyMessengerStorageObjectKey(objectKey)
    ) {
      await storageDelete(objectKey);
    }
    return;
  }
  const scope = parsed.scope;
  if (
    scope.workspaceId !== fence.workspaceId ||
    scope.channelConnectionId !== fence.channelConnectionId ||
    scope.userKey !== fence.userKey ||
    scope.privacyEpoch > fence.privacyEpoch ||
    (indexedPrivacyEpoch !== undefined &&
      scope.privacyEpoch !== indexedPrivacyEpoch)
  ) {
    return;
  }
  await storageDelete(objectKey);
}

function matchesFence(
  completion: MessengerGenerationCompletion,
  fence: MessengerGenerationCompletionFence
): boolean {
  return (
    completionChannelMatchesFence(completion, fence) &&
    completion.userKey === fence.userKey &&
    completion.workspaceId === fence.workspaceId &&
    completion.channelConnectionId === fence.channelConnectionId &&
    completion.bindingEpoch === fence.bindingEpoch &&
    completion.privacyEpoch === fence.privacyEpoch &&
    completion.pageId === fence.pageId
  );
}

function completionChannelMatchesFence(
  completion: Pick<MessengerGenerationCompletion, "channel">,
  fence: Pick<MessengerGenerationCompletionFence, "channel">
): boolean {
  return (
    (completion.channel ?? "facebook_messenger") ===
    (fence.channel ?? "facebook_messenger")
  );
}
