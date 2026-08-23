import { createHash, randomUUID } from "node:crypto";

import { getMessengerGenerationJobLeaseSeconds } from "./messengerGenerationQueue";
import { MessengerPrivacyFenceError } from "./messengerPrivacySubject";
import {
  getImageGenerationDailyLimit,
  getImageGenerationMonthlyLimit,
  getImageGenerationQuotaTimeZone,
} from "./quotaPolicy";
import { getRedisClient } from "./redis";
import {
  deleteEphemeralKey,
  deleteEphemeralKeyIfValue,
  deleteScopedState,
  getScopedStateStorageKey,
  hasEphemeralKeyValue,
  isRedisStateStoreEnabled,
  readScopedState,
  refreshEphemeralKeyIfValue,
  setEphemeralKeyIfAbsent,
  writeScopedState,
} from "./stateStore";

const QUOTA_SCOPE = "messenger-image-quota-v2";
const QUOTA_STATE_TTL_SECONDS = 50 * 24 * 60 * 60;
const QUOTA_RECEIPT_TTL_MS = 45 * 24 * 60 * 60 * 1000;
// This metadata-only fence only needs to outlive every quota state/receipt and
// any generation job that could still hold an old reservation.
const QUOTA_PRIVACY_TOMBSTONE_TTL_SECONDS = QUOTA_STATE_TTL_SECONDS;

export type MessengerImageQuotaIdentity = Readonly<{
  workspaceId: number;
  channelConnectionId: number;
  /** Current transport fence only; deliberately excluded from count keys. */
  bindingEpoch: number;
  privacyEpoch: number;
  /** HMAC-derived user key. Raw PSIDs never enter durable quota keys. */
  userKey: string;
}>;

export type MessengerImageQuotaErasureScope = Readonly<{
  workspaceId: number;
  channelConnectionId: number;
  privacyEpoch: number;
  /** HMAC-derived user key. Raw PSIDs never enter durable quota keys. */
  userKey: string;
}>;

type QuotaSubjectIndexEntry = {
  identityDigest: string;
  privacyFenceDigest: string;
  privacyEpoch: number;
};

type QuotaSubjectIndex = { entries: QuotaSubjectIndexEntry[] };
type QuotaPrivacyTombstone = { privacyEpoch: number };

export type MessengerImageQuotaStatus = {
  daily: { used: number; limit: number; remaining: number };
  monthly: { used: number; limit: number; remaining: number };
};

export type MessengerImageQuotaReservation = {
  token: string;
  receiptId: string;
  /**
   * The counter survives a Page reconnect, but an in-flight reservation does
   * not. Keeping the binding fence on the reservation prevents a caller from
   * committing old work through a newer binding identity.
   */
  bindingEpoch: number;
  dailyLimit: number;
  monthlyLimit: number;
  alreadyCommitted: boolean;
};

export type MessengerImageQuotaReservationDecision =
  | {
      status: "reserved" | "already_committed";
      reservation: MessengerImageQuotaReservation;
      quotaStatus: MessengerImageQuotaStatus;
    }
  | {
      status: "busy" | "daily_exhausted" | "monthly_exhausted";
      quotaStatus: MessengerImageQuotaStatus;
    };

export type MessengerImageQuotaCommitResult = {
  committed: boolean;
  alreadyCommitted: boolean;
  quotaStatus: MessengerImageQuotaStatus;
};

type QuotaReceipt = { expiresAt: number };
type QuotaState = {
  dayKey: string;
  dailyCount: number;
  monthKey: string;
  monthlyCount: number;
  receipts: Record<string, QuotaReceipt>;
};

const RESERVE_QUOTA_SCRIPT = `
local erasedEpoch = tonumber(redis.call('get', KEYS[4]) or '0')
if erasedEpoch >= tonumber(ARGV[10]) then return {'erased', 0, 0} end
redis.call('sadd', KEYS[3], ARGV[11])
redis.call('expire', KEYS[3], ARGV[9])
local raw = redis.call('get', KEYS[1])
local state
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if not ok then return redis.error_reply('invalid messenger image quota state') end
  state = decoded
else
  state = {dayKey = ARGV[2], dailyCount = 0, monthKey = ARGV[3], monthlyCount = 0, receipts = {}}
end

if state.dayKey ~= ARGV[2] then state.dayKey = ARGV[2] state.dailyCount = 0 end
if state.monthKey ~= ARGV[3] then state.monthKey = ARGV[3] state.monthlyCount = 0 end
state.dailyCount = tonumber(state.dailyCount or 0)
state.monthlyCount = tonumber(state.monthlyCount or 0)
state.receipts = state.receipts or {}
for id, receipt in pairs(state.receipts) do
  if tonumber(receipt.expiresAt or 0) <= tonumber(ARGV[1]) then state.receipts[id] = nil end
end

local receipt = state.receipts[ARGV[8]]
if receipt then
  redis.call('set', KEYS[1], cjson.encode(state), 'EX', ARGV[9])
  return {'already_committed', state.dailyCount, state.monthlyCount}
end
if redis.call('exists', KEYS[2]) == 1 then
  return {'busy', state.dailyCount, state.monthlyCount}
end
if state.dailyCount >= tonumber(ARGV[4]) then
  redis.call('set', KEYS[1], cjson.encode(state), 'EX', ARGV[9])
  return {'daily_exhausted', state.dailyCount, state.monthlyCount}
end
if state.monthlyCount >= tonumber(ARGV[5]) then
  redis.call('set', KEYS[1], cjson.encode(state), 'EX', ARGV[9])
  return {'monthly_exhausted', state.dailyCount, state.monthlyCount}
end
local claimed = redis.call('set', KEYS[2], ARGV[6], 'PX', ARGV[7], 'NX')
if not claimed then return {'busy', state.dailyCount, state.monthlyCount} end
redis.call('set', KEYS[1], cjson.encode(state), 'EX', ARGV[9])
return {'reserved', state.dailyCount, state.monthlyCount}
`;

const COMMIT_QUOTA_SCRIPT = `
local erasedEpoch = tonumber(redis.call('get', KEYS[4]) or '0')
if erasedEpoch >= tonumber(ARGV[10]) then return {'erased', 0, 0} end
redis.call('sadd', KEYS[3], ARGV[11])
redis.call('expire', KEYS[3], ARGV[9])
local raw = redis.call('get', KEYS[1])
local state
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if not ok then return redis.error_reply('invalid messenger image quota state') end
  state = decoded
else
  state = {dayKey = ARGV[2], dailyCount = 0, monthKey = ARGV[3], monthlyCount = 0, receipts = {}}
end

if state.dayKey ~= ARGV[2] then state.dayKey = ARGV[2] state.dailyCount = 0 end
if state.monthKey ~= ARGV[3] then state.monthKey = ARGV[3] state.monthlyCount = 0 end
state.dailyCount = tonumber(state.dailyCount or 0)
state.monthlyCount = tonumber(state.monthlyCount or 0)
state.receipts = state.receipts or {}
for id, receipt in pairs(state.receipts) do
  if tonumber(receipt.expiresAt or 0) <= tonumber(ARGV[1]) then state.receipts[id] = nil end
end

if state.receipts[ARGV[7]] then
  if redis.call('get', KEYS[2]) == ARGV[6] then redis.call('del', KEYS[2]) end
  redis.call('set', KEYS[1], cjson.encode(state), 'EX', ARGV[9])
  return {'already_committed', state.dailyCount, state.monthlyCount}
end
if redis.call('get', KEYS[2]) ~= ARGV[6] then
  return {'invalid', state.dailyCount, state.monthlyCount}
end
if state.dailyCount >= tonumber(ARGV[4]) then
  redis.call('del', KEYS[2])
  return {'daily_exhausted', state.dailyCount, state.monthlyCount}
end
if state.monthlyCount >= tonumber(ARGV[5]) then
  redis.call('del', KEYS[2])
  return {'monthly_exhausted', state.dailyCount, state.monthlyCount}
end

state.dailyCount = state.dailyCount + 1
state.monthlyCount = state.monthlyCount + 1
state.receipts[ARGV[7]] = {expiresAt = tonumber(ARGV[8])}
redis.call('set', KEYS[1], cjson.encode(state), 'EX', ARGV[9])
redis.call('del', KEYS[2])
return {'committed', state.dailyCount, state.monthlyCount}
`;

const READ_QUOTA_SCRIPT = `
local erasedEpoch = tonumber(redis.call('get', KEYS[3]) or '0')
if erasedEpoch >= tonumber(ARGV[5]) then return {'erased', 0, 0} end
redis.call('sadd', KEYS[2], ARGV[6])
redis.call('expire', KEYS[2], ARGV[4])
local raw = redis.call('get', KEYS[1])
local state
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if not ok then return redis.error_reply('invalid messenger image quota state') end
  state = decoded
else
  state = {dayKey = ARGV[2], dailyCount = 0, monthKey = ARGV[3], monthlyCount = 0, receipts = {}}
end
if state.dayKey ~= ARGV[2] then state.dayKey = ARGV[2] state.dailyCount = 0 end
if state.monthKey ~= ARGV[3] then state.monthKey = ARGV[3] state.monthlyCount = 0 end
state.dailyCount = tonumber(state.dailyCount or 0)
state.monthlyCount = tonumber(state.monthlyCount or 0)
state.receipts = state.receipts or {}
for id, receipt in pairs(state.receipts) do
  if tonumber(receipt.expiresAt or 0) <= tonumber(ARGV[1]) then state.receipts[id] = nil end
end
redis.call('set', KEYS[1], cjson.encode(state), 'EX', ARGV[4])
return {'active', state.dailyCount, state.monthlyCount}
`;

const RENEW_QUOTA_RESERVATION_SCRIPT = `
local erasedEpoch = tonumber(redis.call('get', KEYS[2]) or '0')
if erasedEpoch >= tonumber(ARGV[3]) then return -1 end
if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('pexpire', KEYS[1], ARGV[2])
`;

const ERASE_QUOTA_SUBJECT_SCRIPT = `
local requestedEpoch = tonumber(ARGV[1])
local currentEpoch = tonumber(redis.call('get', KEYS[2]) or '0')
if currentEpoch < requestedEpoch then
  redis.call('set', KEYS[2], ARGV[1], 'EX', ARGV[4])
else
  redis.call('expire', KEYS[2], ARGV[4])
end

local members = redis.call('smembers', KEYS[1])
for i = 1, #members do
  local fenceDigest, privacyEpoch, identityDigest = string.match(
    members[i],
    '^([0-9a-f]+):([0-9]+):([0-9a-f]+)$'
  )
  if fenceDigest and privacyEpoch and identityDigest then
    local fenceKey = ARGV[2] .. fenceDigest
    local indexedEpoch = tonumber(privacyEpoch)
    local erasedEpoch = tonumber(redis.call('get', fenceKey) or '0')
    if erasedEpoch < indexedEpoch then
      redis.call('set', fenceKey, privacyEpoch, 'EX', ARGV[4])
    else
      redis.call('expire', fenceKey, ARGV[4])
    end
    redis.call('del', ARGV[3] .. identityDigest .. ':state')
    redis.call('del', ARGV[3] .. identityDigest .. ':reservation')
  end
end
redis.call('del', KEYS[1])
return #members
`;

export async function reserveMessengerImageQuota(
  identity: MessengerImageQuotaIdentity,
  requestId: string
): Promise<MessengerImageQuotaReservationDecision> {
  assertIdentity(identity);
  const normalizedRequestId = requestId.trim();
  if (!normalizedRequestId)
    throw new Error("Messenger image quota request id is required");
  assertProductionRedis();

  const now = Date.now();
  const period = getQuotaPeriod(now);
  const dailyLimit = getImageGenerationDailyLimit();
  const monthlyLimit = getImageGenerationMonthlyLimit();
  const token = randomUUID();
  const receiptId = hashValue(`request\0${normalizedRequestId}`);
  const reservation: MessengerImageQuotaReservation = {
    token,
    receiptId,
    bindingEpoch: identity.bindingEpoch,
    dailyLimit,
    monthlyLimit,
    alreadyCommitted: false,
  };

  let result: [string, number, number];
  if (isRedisStateStoreEnabled()) {
    const redis = await getRedisClient();
    result = parseRedisTuple(
      await redis.eval(
        RESERVE_QUOTA_SCRIPT,
        4,
        quotaStateStorageKey(identity),
        quotaLockKey(identity),
        quotaSubjectIndexKey(identity),
        quotaPrivacyTombstoneKey(identity),
        now,
        period.dayKey,
        period.monthKey,
        dailyLimit,
        monthlyLimit,
        token,
        getMessengerGenerationJobLeaseSeconds() * 1000,
        receiptId,
        QUOTA_STATE_TTL_SECONDS,
        identity.privacyEpoch,
        quotaSubjectIndexMember(identity)
      )
    );
  } else {
    await registerInMemoryQuotaIdentity(identity);
    result = await reserveInMemory({
      identity,
      now,
      period,
      dailyLimit,
      monthlyLimit,
      token,
      receiptId,
    });
  }

  const [status, dailyCount, monthlyCount] = result;
  if (status === "erased") throw new MessengerPrivacyFenceError();
  const quotaStatus = buildStatus(
    dailyCount,
    monthlyCount,
    dailyLimit,
    monthlyLimit
  );
  if (status === "reserved") {
    return { status, reservation, quotaStatus };
  }
  if (status === "already_committed") {
    return {
      status,
      reservation: { ...reservation, alreadyCommitted: true },
      quotaStatus,
    };
  }
  if (
    status === "busy" ||
    status === "daily_exhausted" ||
    status === "monthly_exhausted"
  ) {
    return { status, quotaStatus };
  }
  throw new Error(
    `Unexpected Messenger image quota reservation result: ${status}`
  );
}

export async function commitMessengerImageQuotaSuccess(
  identity: MessengerImageQuotaIdentity,
  reservation: MessengerImageQuotaReservation
): Promise<MessengerImageQuotaCommitResult> {
  assertIdentity(identity);
  assertReservation(reservation);
  assertProductionRedis();

  if (reservation.bindingEpoch !== identity.bindingEpoch) {
    return {
      committed: false,
      alreadyCommitted: false,
      quotaStatus: await getMessengerImageQuotaStatus(identity),
    };
  }

  const now = Date.now();
  const period = getQuotaPeriod(now);
  let result: [string, number, number];
  if (isRedisStateStoreEnabled()) {
    const redis = await getRedisClient();
    result = parseRedisTuple(
      await redis.eval(
        COMMIT_QUOTA_SCRIPT,
        4,
        quotaStateStorageKey(identity),
        quotaLockKey(identity),
        quotaSubjectIndexKey(identity),
        quotaPrivacyTombstoneKey(identity),
        now,
        period.dayKey,
        period.monthKey,
        reservation.dailyLimit,
        reservation.monthlyLimit,
        reservation.token,
        reservation.receiptId,
        now + QUOTA_RECEIPT_TTL_MS,
        QUOTA_STATE_TTL_SECONDS,
        identity.privacyEpoch,
        quotaSubjectIndexMember(identity)
      )
    );
  } else {
    await registerInMemoryQuotaIdentity(identity);
    result = await commitInMemory(identity, reservation, now, period);
  }

  const [status, dailyCount, monthlyCount] = result;
  if (status === "erased") throw new MessengerPrivacyFenceError();
  const quotaStatus = buildStatus(
    dailyCount,
    monthlyCount,
    reservation.dailyLimit,
    reservation.monthlyLimit
  );
  if (status === "committed" || status === "already_committed") {
    return {
      committed: true,
      alreadyCommitted: status === "already_committed",
      quotaStatus,
    };
  }
  return { committed: false, alreadyCommitted: false, quotaStatus };
}

export async function releaseMessengerImageQuotaReservation(
  identity: MessengerImageQuotaIdentity,
  reservation: MessengerImageQuotaReservation
): Promise<void> {
  assertIdentity(identity);
  assertReservation(reservation);
  if (reservation.bindingEpoch !== identity.bindingEpoch) return;
  await deleteEphemeralKeyIfValue(quotaLockKey(identity), reservation.token);
}

/**
 * Extends only the caller's still-owned reservation. A false result means the
 * lease was lost; an erasure fence throws and can never recreate old state.
 */
export async function renewMessengerImageQuotaReservation(
  identity: MessengerImageQuotaIdentity,
  reservation: MessengerImageQuotaReservation
): Promise<boolean> {
  assertIdentity(identity);
  assertReservation(reservation);
  assertProductionRedis();
  if (reservation.bindingEpoch !== identity.bindingEpoch) return false;
  const leaseSeconds = getMessengerGenerationJobLeaseSeconds();

  if (isRedisStateStoreEnabled()) {
    const redis = await getRedisClient();
    const result = Number(
      await redis.eval(
        RENEW_QUOTA_RESERVATION_SCRIPT,
        2,
        quotaLockKey(identity),
        quotaPrivacyTombstoneKey(identity),
        reservation.token,
        leaseSeconds * 1000,
        identity.privacyEpoch
      )
    );
    if (result === -1) throw new MessengerPrivacyFenceError();
    return result === 1;
  }

  const tombstone = await Promise.resolve(
    readScopedState<QuotaPrivacyTombstone>(
      QUOTA_SCOPE,
      quotaPrivacyTombstoneStateId(identity)
    )
  );
  if (toCount(tombstone?.privacyEpoch) >= identity.privacyEpoch) {
    throw new MessengerPrivacyFenceError();
  }
  return await refreshEphemeralKeyIfValue(
    quotaLockKey(identity),
    reservation.token,
    leaseSeconds
  );
}

export function getMessengerImageQuotaReservationRenewIntervalMs(): number {
  return Math.max(
    1_000,
    Math.floor((getMessengerGenerationJobLeaseSeconds() * 1_000) / 3)
  );
}

export async function getMessengerImageQuotaStatus(
  identity: MessengerImageQuotaIdentity
): Promise<MessengerImageQuotaStatus> {
  assertIdentity(identity);
  assertProductionRedis();
  const now = Date.now();
  const period = getQuotaPeriod(now);
  const dailyLimit = getImageGenerationDailyLimit();
  const monthlyLimit = getImageGenerationMonthlyLimit();

  let counts: [number, number];
  if (isRedisStateStoreEnabled()) {
    const redis = await getRedisClient();
    const values = parseRedisTuple(
      await redis.eval(
        READ_QUOTA_SCRIPT,
        3,
        quotaStateStorageKey(identity),
        quotaSubjectIndexKey(identity),
        quotaPrivacyTombstoneKey(identity),
        now,
        period.dayKey,
        period.monthKey,
        QUOTA_STATE_TTL_SECONDS,
        identity.privacyEpoch,
        quotaSubjectIndexMember(identity)
      )
    );
    if (values[0] === "erased") throw new MessengerPrivacyFenceError();
    counts = [values[1], values[2]];
  } else {
    await registerInMemoryQuotaIdentity(identity);
    const state = await readQuotaState(identity, now, period);
    await writeQuotaState(identity, state);
    counts = [state.dailyCount, state.monthlyCount];
  }
  return buildStatus(counts[0], counts[1], dailyLimit, monthlyLimit);
}

export async function canGenerateMessengerImage(
  identity: MessengerImageQuotaIdentity
): Promise<boolean> {
  const status = await getMessengerImageQuotaStatus(identity);
  return status.daily.remaining > 0 && status.monthly.remaining > 0;
}

/**
 * Deletes every quota epoch for one workspace-owned user and installs exact
 * connection fences so an in-flight pre-erasure reservation cannot recreate it.
 */
export async function eraseMessengerImageQuotaForUser(
  input: MessengerImageQuotaErasureScope
): Promise<void> {
  assertErasureScope(input);
  if (isRedisStateStoreEnabled()) {
    const redis = await getRedisClient();
    await redis.eval(
      ERASE_QUOTA_SUBJECT_SCRIPT,
      2,
      quotaSubjectIndexKey(input),
      quotaPrivacyTombstoneKey(input),
      input.privacyEpoch,
      quotaPrivacyTombstonePrefix(input),
      quotaSubjectStatePrefix(input),
      QUOTA_PRIVACY_TOMBSTONE_TTL_SECONDS
    );
    return;
  }

  await writeInMemoryPrivacyTombstone(
    quotaPrivacyTombstoneStateId(input),
    input.privacyEpoch
  );
  const index = await Promise.resolve(
    readScopedState<QuotaSubjectIndex>(
      QUOTA_SCOPE,
      quotaSubjectIndexStateId(input)
    )
  );
  for (const entry of index?.entries ?? []) {
    if (!isQuotaSubjectIndexEntry(entry)) continue;
    await writeInMemoryPrivacyTombstone(
      quotaPrivacyTombstoneStateId(input, entry.privacyFenceDigest),
      entry.privacyEpoch
    );
    await Promise.all([
      Promise.resolve(
        deleteScopedState(
          QUOTA_SCOPE,
          quotaStateIdFromDigest(input, entry.identityDigest)
        )
      ),
      deleteEphemeralKey(quotaLockKeyFromDigest(input, entry.identityDigest)),
    ]);
  }
  await Promise.resolve(
    deleteScopedState(QUOTA_SCOPE, quotaSubjectIndexStateId(input))
  );
}

async function reserveInMemory(input: {
  identity: MessengerImageQuotaIdentity;
  now: number;
  period: { dayKey: string; monthKey: string };
  dailyLimit: number;
  monthlyLimit: number;
  token: string;
  receiptId: string;
}): Promise<[string, number, number]> {
  let state = await readQuotaState(input.identity, input.now, input.period);
  if (state.receipts[input.receiptId]) {
    await writeQuotaState(input.identity, state);
    return ["already_committed", state.dailyCount, state.monthlyCount];
  }
  const claimed = await setEphemeralKeyIfAbsent(
    quotaLockKey(input.identity),
    input.token,
    getMessengerGenerationJobLeaseSeconds()
  );
  if (!claimed) return ["busy", state.dailyCount, state.monthlyCount];

  state = await readQuotaState(input.identity, input.now, input.period);
  if (state.dailyCount >= input.dailyLimit) {
    await deleteEphemeralKeyIfValue(quotaLockKey(input.identity), input.token);
    return ["daily_exhausted", state.dailyCount, state.monthlyCount];
  }
  if (state.monthlyCount >= input.monthlyLimit) {
    await deleteEphemeralKeyIfValue(quotaLockKey(input.identity), input.token);
    return ["monthly_exhausted", state.dailyCount, state.monthlyCount];
  }
  await writeQuotaState(input.identity, state);
  return ["reserved", state.dailyCount, state.monthlyCount];
}

async function commitInMemory(
  identity: MessengerImageQuotaIdentity,
  reservation: MessengerImageQuotaReservation,
  now: number,
  period: { dayKey: string; monthKey: string }
): Promise<[string, number, number]> {
  const state = await readQuotaState(identity, now, period);
  if (state.receipts[reservation.receiptId]) {
    await deleteEphemeralKeyIfValue(quotaLockKey(identity), reservation.token);
    return ["already_committed", state.dailyCount, state.monthlyCount];
  }
  if (
    !(await hasEphemeralKeyValue(quotaLockKey(identity), reservation.token))
  ) {
    return ["invalid", state.dailyCount, state.monthlyCount];
  }
  if (state.dailyCount >= reservation.dailyLimit) {
    await deleteEphemeralKeyIfValue(quotaLockKey(identity), reservation.token);
    return ["daily_exhausted", state.dailyCount, state.monthlyCount];
  }
  if (state.monthlyCount >= reservation.monthlyLimit) {
    await deleteEphemeralKeyIfValue(quotaLockKey(identity), reservation.token);
    return ["monthly_exhausted", state.dailyCount, state.monthlyCount];
  }

  state.dailyCount += 1;
  state.monthlyCount += 1;
  state.receipts[reservation.receiptId] = {
    expiresAt: now + QUOTA_RECEIPT_TTL_MS,
  };
  await writeQuotaState(identity, state);
  await deleteEphemeralKeyIfValue(quotaLockKey(identity), reservation.token);
  return ["committed", state.dailyCount, state.monthlyCount];
}

async function readQuotaState(
  identity: MessengerImageQuotaIdentity,
  now: number,
  period: { dayKey: string; monthKey: string }
): Promise<QuotaState> {
  const stored = await Promise.resolve(
    readScopedState<QuotaState>(QUOTA_SCOPE, quotaStateId(identity))
  );
  return syncQuotaState(stored, now, period);
}

async function writeQuotaState(
  identity: MessengerImageQuotaIdentity,
  state: QuotaState
): Promise<void> {
  await Promise.resolve(
    writeScopedState(
      QUOTA_SCOPE,
      quotaStateId(identity),
      state,
      QUOTA_STATE_TTL_SECONDS
    )
  );
}

async function registerInMemoryQuotaIdentity(
  identity: MessengerImageQuotaIdentity
): Promise<void> {
  const tombstone = await Promise.resolve(
    readScopedState<QuotaPrivacyTombstone>(
      QUOTA_SCOPE,
      quotaPrivacyTombstoneStateId(identity)
    )
  );
  if (toCount(tombstone?.privacyEpoch) >= identity.privacyEpoch) {
    throw new MessengerPrivacyFenceError();
  }

  const stateId = quotaSubjectIndexStateId(identity);
  const current = await Promise.resolve(
    readScopedState<QuotaSubjectIndex>(QUOTA_SCOPE, stateId)
  );
  const entry: QuotaSubjectIndexEntry = {
    identityDigest: quotaIdentityDigest(identity),
    privacyFenceDigest: quotaPrivacyFenceDigest(identity),
    privacyEpoch: identity.privacyEpoch,
  };
  const entries = (current?.entries ?? []).filter(
    candidate =>
      isQuotaSubjectIndexEntry(candidate) &&
      candidate.identityDigest !== entry.identityDigest
  );
  entries.push(entry);
  await Promise.resolve(
    writeScopedState(
      QUOTA_SCOPE,
      stateId,
      { entries } satisfies QuotaSubjectIndex,
      QUOTA_STATE_TTL_SECONDS
    )
  );
}

async function writeInMemoryPrivacyTombstone(
  stateId: string,
  privacyEpoch: number
): Promise<void> {
  const current = await Promise.resolve(
    readScopedState<QuotaPrivacyTombstone>(QUOTA_SCOPE, stateId)
  );
  await Promise.resolve(
    writeScopedState(
      QUOTA_SCOPE,
      stateId,
      { privacyEpoch: Math.max(toCount(current?.privacyEpoch), privacyEpoch) },
      QUOTA_PRIVACY_TOMBSTONE_TTL_SECONDS
    )
  );
}

function isQuotaSubjectIndexEntry(
  value: unknown
): value is QuotaSubjectIndexEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<QuotaSubjectIndexEntry>;
  return (
    typeof entry.identityDigest === "string" &&
    /^[a-f0-9]{64}$/i.test(entry.identityDigest) &&
    typeof entry.privacyFenceDigest === "string" &&
    /^[a-f0-9]{64}$/i.test(entry.privacyFenceDigest) &&
    Number.isSafeInteger(entry.privacyEpoch) &&
    Number(entry.privacyEpoch) > 0
  );
}

function syncQuotaState(
  stored: QuotaState | null,
  now: number,
  period: { dayKey: string; monthKey: string }
): QuotaState {
  const receipts = Object.fromEntries(
    Object.entries(stored?.receipts ?? {}).filter(
      ([, receipt]) =>
        receipt && Number.isFinite(receipt.expiresAt) && receipt.expiresAt > now
    )
  );
  return {
    dayKey: period.dayKey,
    dailyCount:
      stored?.dayKey === period.dayKey ? toCount(stored.dailyCount) : 0,
    monthKey: period.monthKey,
    monthlyCount:
      stored?.monthKey === period.monthKey ? toCount(stored.monthlyCount) : 0,
    receipts,
  };
}

function getQuotaPeriod(now: number): { dayKey: string; monthKey: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: getImageGenerationQuotaTimeZone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find(part => part.type === type)?.value ?? "";
  const year = value("year");
  const month = value("month");
  const day = value("day");
  if (!year || !month || !day)
    throw new Error("Messenger image quota period is invalid");
  return { dayKey: `${year}-${month}-${day}`, monthKey: `${year}-${month}` };
}

function buildStatus(
  dailyCount: number,
  monthlyCount: number,
  dailyLimit: number,
  monthlyLimit: number
): MessengerImageQuotaStatus {
  return {
    daily: {
      used: dailyCount,
      limit: dailyLimit,
      remaining: Math.max(0, dailyLimit - dailyCount),
    },
    monthly: {
      used: monthlyCount,
      limit: monthlyLimit,
      remaining: Math.max(0, monthlyLimit - monthlyCount),
    },
  };
}

function quotaStateId(identity: MessengerImageQuotaIdentity): string {
  return quotaStateIdFromDigest(identity, quotaIdentityDigest(identity));
}

function quotaStateStorageKey(identity: MessengerImageQuotaIdentity): string {
  return getScopedStateStorageKey(QUOTA_SCOPE, quotaStateId(identity));
}

function quotaLockKey(identity: MessengerImageQuotaIdentity): string {
  return quotaLockKeyFromDigest(identity, quotaIdentityDigest(identity));
}

function quotaStateIdFromDigest(
  input: Pick<MessengerImageQuotaIdentity, "workspaceId" | "userKey">,
  identityDigest: string
): string {
  return `${quotaSubjectHashTag(input)}:${identityDigest}:state`;
}

function quotaLockKeyFromDigest(
  input: Pick<MessengerImageQuotaIdentity, "workspaceId" | "userKey">,
  identityDigest: string
): string {
  return `${QUOTA_SCOPE}:${quotaSubjectHashTag(input)}:${identityDigest}:reservation`;
}

function quotaIdentityDigest(identity: MessengerImageQuotaIdentity): string {
  // Reconnecting the same Page increments bindingEpoch but must not grant a
  // fresh 5/20 allowance. Privacy reactivation intentionally starts anew.
  return hashValue(
    [
      "messenger-image-quota-v2",
      identity.workspaceId,
      identity.channelConnectionId,
      identity.privacyEpoch,
      identity.userKey,
    ].join("\0")
  );
}

function quotaSubjectHashTag(
  input: Pick<MessengerImageQuotaIdentity, "workspaceId" | "userKey">
): string {
  const digest = hashValue(
    ["messenger-image-quota-subject-v2", input.workspaceId, input.userKey].join(
      "\0"
    )
  );
  return `{messenger-image-quota-${digest}}`;
}

function quotaPrivacyFenceDigest(
  input: Pick<
    MessengerImageQuotaIdentity,
    "workspaceId" | "channelConnectionId" | "userKey"
  >
): string {
  return hashValue(
    [
      "messenger-image-quota-privacy-fence-v2",
      input.workspaceId,
      input.channelConnectionId,
      input.userKey,
    ].join("\0")
  );
}

function quotaSubjectIndexStateId(
  input: Pick<MessengerImageQuotaIdentity, "workspaceId" | "userKey">
): string {
  return `${quotaSubjectHashTag(input)}:index`;
}

function quotaSubjectIndexKey(
  input: Pick<MessengerImageQuotaIdentity, "workspaceId" | "userKey">
): string {
  return getScopedStateStorageKey(QUOTA_SCOPE, quotaSubjectIndexStateId(input));
}

function quotaSubjectIndexMember(
  identity: MessengerImageQuotaIdentity
): string {
  return [
    quotaPrivacyFenceDigest(identity),
    identity.privacyEpoch,
    quotaIdentityDigest(identity),
  ].join(":");
}

function quotaPrivacyTombstoneStateId(
  input: Pick<
    MessengerImageQuotaIdentity,
    "workspaceId" | "channelConnectionId" | "userKey"
  >,
  privacyFenceDigest = quotaPrivacyFenceDigest(input)
): string {
  return `${quotaSubjectHashTag(input)}:erased:${privacyFenceDigest}`;
}

function quotaPrivacyTombstoneKey(
  input: Pick<
    MessengerImageQuotaIdentity,
    "workspaceId" | "channelConnectionId" | "userKey"
  >
): string {
  return getScopedStateStorageKey(
    QUOTA_SCOPE,
    quotaPrivacyTombstoneStateId(input)
  );
}

function quotaPrivacyTombstonePrefix(
  input: Pick<MessengerImageQuotaIdentity, "workspaceId" | "userKey">
): string {
  return `${QUOTA_SCOPE}:${quotaSubjectHashTag(input)}:erased:`;
}

function quotaSubjectStatePrefix(
  input: Pick<MessengerImageQuotaIdentity, "workspaceId" | "userKey">
): string {
  return `${QUOTA_SCOPE}:${quotaSubjectHashTag(input)}:`;
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseRedisTuple(value: unknown): [string, number, number] {
  const values = Array.isArray(value) ? value : [];
  return [
    String(values[0] ?? "invalid"),
    toCount(values[1]),
    toCount(values[2]),
  ];
}

function toCount(value: unknown): number {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function assertIdentity(identity: MessengerImageQuotaIdentity): void {
  for (const [name, value] of Object.entries({
    workspaceId: identity.workspaceId,
    channelConnectionId: identity.channelConnectionId,
    bindingEpoch: identity.bindingEpoch,
    privacyEpoch: identity.privacyEpoch,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Messenger image quota ${name} is invalid`);
    }
  }
  if (!/^[a-f0-9]{64}$/i.test(identity.userKey)) {
    throw new Error("Messenger image quota user key is invalid");
  }
}

function assertErasureScope(input: MessengerImageQuotaErasureScope): void {
  for (const [name, value] of Object.entries({
    workspaceId: input.workspaceId,
    channelConnectionId: input.channelConnectionId,
    privacyEpoch: input.privacyEpoch,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Messenger image quota erasure ${name} is invalid`);
    }
  }
  if (!/^[a-f0-9]{64}$/i.test(input.userKey)) {
    throw new Error("Messenger image quota erasure user key is invalid");
  }
}

function assertReservation(reservation: MessengerImageQuotaReservation): void {
  if (
    !reservation.token ||
    !/^[a-f0-9]{64}$/i.test(reservation.receiptId) ||
    !Number.isSafeInteger(reservation.bindingEpoch) ||
    reservation.bindingEpoch <= 0 ||
    !Number.isSafeInteger(reservation.dailyLimit) ||
    reservation.dailyLimit < 0 ||
    !Number.isSafeInteger(reservation.monthlyLimit) ||
    reservation.monthlyLimit < 0
  ) {
    throw new Error("Messenger image quota reservation is invalid");
  }
}

function assertProductionRedis(): void {
  if (process.env.NODE_ENV === "production" && !isRedisStateStoreEnabled()) {
    throw new Error("Redis is required for production Messenger image quota");
  }
}
