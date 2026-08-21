import { createHash, randomUUID } from "node:crypto";
import { safeLog } from "./messengerApi";
import { toLogUser } from "./privacy";
import {
  deleteEphemeralKeyIfValue,
  getScopedStateStorageKey,
  readScopedState,
  setEphemeralKeyIfAbsent,
  writeScopedState,
} from "./stateStore";
import { getRedisClient, isRedisEnabled } from "./redis";

const LEGACY_COST_LEDGER_SCOPE = "cost:ledger:period";
const COST_LEDGER_WORKSPACE_SCOPE = "cost:ledger:v2:workspace-period";
const COST_LEDGER_BUDGET_SCOPE = "cost:ledger:v2:budget-period";
const COST_LEDGER_TOMBSTONE_SCOPE = "cost:ledger:v2:subject-erasure";
const COST_LEDGER_RETENTION_DAYS = 90;
const COST_LEDGER_TTL_SECONDS = COST_LEDGER_RETENTION_DAYS * 24 * 60 * 60;
// A record written late on calendar day N-90 can still be live for a full
// 90-day TTL, so erasure must include both endpoints (N through N-90).
const COST_LEDGER_ERASURE_PERIOD_COUNT = COST_LEDGER_RETENTION_DAYS + 1;
const COST_LEDGER_MAX_ENTRIES_PER_WORKSPACE_PERIOD = 5_000;
const COST_LEDGER_LOCK_TTL_SECONDS = 15;
const COST_LEDGER_LOCK_MAX_ATTEMPTS = 40;
const LEGACY_SCAN_MAX_ITERATIONS = 10_000;
let costLedgerDroppedEntryCount = 0;
let beforeDetailCommitHookForTests: (() => Promise<void>) | null = null;

const ATOMIC_APPEND_WORKSPACE_ENTRY_SCRIPT = `
local tombstoneRaw = redis.call("GET", KEYS[2])
if tombstoneRaw then
  local tombstoneOk, tombstone = pcall(cjson.decode, tombstoneRaw)
  if not tombstoneOk or type(tombstone) ~= "table" or tonumber(tombstone.erasureEpoch) == nil then
    return {"corrupt_tombstone"}
  end
  if tonumber(ARGV[1]) <= tonumber(tombstone.erasureEpoch) then
    return {"tombstoned"}
  end
end

local current = {}
local currentRaw = redis.call("GET", KEYS[1])
if currentRaw then
  local currentOk, decoded = pcall(cjson.decode, currentRaw)
  if not currentOk or type(decoded) ~= "table" then
    return {"corrupt_period"}
  end
  current = decoded
end

for _, candidateRaw in ipairs(current) do
  if type(candidateRaw) ~= "string" then
    return {"corrupt_period"}
  end
  local candidateOk, candidate = pcall(cjson.decode, candidateRaw)
  if not candidateOk or type(candidate) ~= "table" then
    return {"corrupt_period"}
  end
  local scope = candidate.scope or {}
  if tostring(candidate.id or "") == ARGV[3]
    and tostring(candidate.userKey or "") == ARGV[4]
    and tonumber(scope.channelConnectionId) == tonumber(ARGV[5])
    and tonumber(scope.bindingEpoch) == tonumber(ARGV[6])
    and tonumber(scope.privacyEpoch) == tonumber(ARGV[1]) then
    return {"duplicate", candidateRaw}
  end
end

table.insert(current, ARGV[2])
local maximum = tonumber(ARGV[7])
local dropped = math.max(0, #current - maximum)
local next = {}
local first = dropped + 1
for index = first, #current do
  table.insert(next, current[index])
end
redis.call("SET", KEYS[1], cjson.encode(next), "EX", ARGV[8])
return {"appended", tostring(dropped), ARGV[2]}
`;

const ATOMIC_UPSERT_TOMBSTONE_SCRIPT = `
local currentRaw = redis.call("GET", KEYS[1])
local currentEpoch = 0
if currentRaw then
  local currentOk, current = pcall(cjson.decode, currentRaw)
  if not currentOk or type(current) ~= "table" or tonumber(current.erasureEpoch) == nil then
    return {"corrupt_tombstone"}
  end
  currentEpoch = tonumber(current.erasureEpoch)
end
local effectiveEpoch = math.max(currentEpoch, tonumber(ARGV[1]))
local tombstone = {
  version = 1,
  erasureEpoch = effectiveEpoch,
  erasedAt = ARGV[2]
}
redis.call("SET", KEYS[1], cjson.encode(tombstone), "EX", ARGV[3])
return {"ok", tostring(effectiveEpoch)}
`;

const ATOMIC_DELETE_SUBJECT_FROM_PERIOD_SCRIPT = `
local tombstoneRaw = redis.call("GET", KEYS[2])
if not tombstoneRaw then
  return {"missing_tombstone"}
end
local tombstoneOk, tombstone = pcall(cjson.decode, tombstoneRaw)
if not tombstoneOk or type(tombstone) ~= "table" or tonumber(tombstone.erasureEpoch) == nil then
  return {"corrupt_tombstone"}
end
if tonumber(tombstone.erasureEpoch) < tonumber(ARGV[3]) then
  return {"stale_tombstone"}
end

local currentRaw = redis.call("GET", KEYS[1])
if not currentRaw then
  return {"ok", "0"}
end
local ttl = redis.call("PTTL", KEYS[1])
if ttl <= 0 then
  return {"invalid_period_ttl"}
end
local currentOk, current = pcall(cjson.decode, currentRaw)
if not currentOk or type(current) ~= "table" then
  return {"corrupt_period"}
end

local next = {}
local deleted = 0
for _, candidateRaw in ipairs(current) do
  if type(candidateRaw) ~= "string" then
    return {"corrupt_period"}
  end
  local candidateOk, candidate = pcall(cjson.decode, candidateRaw)
  if not candidateOk or type(candidate) ~= "table" then
    return {"corrupt_period"}
  end
  local scope = candidate.scope or {}
  local matches = tonumber(scope.channelConnectionId) == tonumber(ARGV[1])
    and tostring(candidate.userKey or "") == ARGV[2]
    and tonumber(scope.privacyEpoch) ~= nil
    and tonumber(scope.privacyEpoch) <= tonumber(ARGV[3])
  if matches then
    deleted = deleted + 1
  else
    table.insert(next, candidateRaw)
  end
end
if deleted > 0 then
  if #next == 0 then
    redis.call("DEL", KEYS[1])
  else
    redis.call("SET", KEYS[1], cjson.encode(next), "PX", ttl)
  end
end
return {"ok", tostring(deleted)}
`;

const ATOMIC_UPDATE_WORKSPACE_ENTRY_SCRIPT = `
local tombstoneRaw = redis.call("GET", KEYS[2])
if tombstoneRaw then
  local tombstoneOk, tombstone = pcall(cjson.decode, tombstoneRaw)
  if not tombstoneOk or type(tombstone) ~= "table" or tonumber(tombstone.erasureEpoch) == nil then
    return {"corrupt_tombstone"}
  end
  if tonumber(ARGV[1]) <= tonumber(tombstone.erasureEpoch) then
    return {"tombstoned"}
  end
end

local currentRaw = redis.call("GET", KEYS[1])
if not currentRaw then return {"not_found"} end
if currentRaw ~= ARGV[2] then return {"retry"} end
local ttl = redis.call("PTTL", KEYS[1])
if ttl <= 0 then return {"invalid_period_ttl"} end
redis.call("SET", KEYS[1], ARGV[3], "PX", ttl)
return {"updated"}
`;

const ATOMIC_COMPARE_AND_SET_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if ARGV[1] == "__leaderbot_missing__" then
  if current then return "retry" end
elseif current ~= ARGV[1] then
  return "retry"
end
redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])
return "updated"
`;

export type CostLedgerStatus =
  | "provider_attempt_started"
  | "provider_attempt_succeeded"
  | "provider_attempt_failed"
  | "blocked";

/** Immutable admission-time tenant and privacy boundary. */
export type CostLedgerScope = Readonly<{
  workspaceId: number;
  channelConnectionId: number;
  bindingEpoch: number;
  privacyEpoch: number;
}>;

export type CostLedgerSubjectScope = CostLedgerScope &
  Readonly<{ userKey: string }>;

export type CostLedgerErasureScope = Readonly<{
  workspaceId: number;
  channelConnectionId: number;
  userKey: string;
  /** Entries at or below this monotonic epoch are no longer writable. */
  erasureEpoch: number;
}>;

export type CostLedgerEntry = {
  scope: CostLedgerScope;
  id: string;
  channel: string;
  operation: string;
  provider: string;
  model: string | null;
  providerUsage?: Record<string, string | number | boolean | null>;
  userKey: string;
  reqId: string;
  status: CostLedgerStatus;
  estimatedCostUsd: number | null;
  estimatedOutputCostUsd: number | null;
  finalCostUsd: number | null;
  costEstimateComplete: boolean;
  estimateSource: string | null;
  unpricedCostComponents: string[];
};

export type StoredCostLedgerEntry = CostLedgerEntry & {
  period: string;
  recordedAt: string;
};

/**
 * Global spend baseline. It deliberately contains no workspace, connection,
 * user, request, entry, channel, model, or provider-usage fields.
 */
export type CostLedgerBudgetAggregate = {
  version: 2;
  period: string;
  attempts: number;
  estimatedCostUsd: number;
  completeEstimateEntries: number;
  incompleteEstimateEntries: number;
  unpricedCostComponents: string[];
  byOperation: Record<string, { attempts: number; estimatedCostUsd: number }>;
  byProvider: Record<string, { attempts: number; estimatedCostUsd: number }>;
};

export type CostLedgerReliabilityStats = {
  droppedEntryCount: number;
  maxEntriesPerPeriod: number;
};

type CostSummaryBucket = {
  attempts: number;
  estimatedCostUsd: number;
  finalCostUsd: number;
};

type CostRequestSummaryBucket = CostSummaryBucket & {
  operation: string;
  provider: string;
  statuses: Record<string, number>;
  completeEstimateEntries: number;
  incompleteEstimateEntries: number;
  unpricedCostComponents: string[];
};

export type CostLedgerSummary = {
  period: string;
  totalEntries: number;
  uniqueUserCount: number;
  estimatedCostUsd: number;
  finalCostUsd: number;
  openAttemptEntries: number;
  failedAttemptEntries: number;
  blockedEntries: number;
  completeEstimateEntries: number;
  incompleteEstimateEntries: number;
  unpricedCostComponents: string[];
  byStatus: Record<CostLedgerStatus, number>;
  byOperation: Record<string, CostSummaryBucket>;
  byProvider: Record<string, CostSummaryBucket>;
  byRequest: Record<string, CostRequestSummaryBucket>;
};

type CostLedgerTombstone = {
  version: 1;
  erasureEpoch: number;
  erasedAt: string;
};

export class CostLedgerScopeError extends Error {
  constructor(message = "A valid tenant cost-ledger scope is required") {
    super(message);
    this.name = "CostLedgerScopeError";
  }
}

export class CostLedgerPrivacyTombstoneError extends Error {
  constructor() {
    super("The cost-ledger subject has been erased");
    this.name = "CostLedgerPrivacyTombstoneError";
  }
}

export class LegacyCostLedgerDataError extends Error {
  constructor() {
    super(
      "Unscoped legacy cost-ledger data must be explicitly purged before production readiness"
    );
    this.name = "LegacyCostLedgerDataError";
  }
}

function periodFromDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function normalizeStoredReqId(reqId: string): string {
  return toRequestSummaryKey(reqId);
}

function summarizeRequestId(reqId: string): string {
  return reqId.startsWith("sha256:") ? reqId : toRequestSummaryKey(reqId);
}

function dateFromPeriod(period: string): Date {
  return new Date(`${period}T00:00:00.000Z`);
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate() + days
    )
  );
}

function candidateUpdatePeriods(periodDate: Date): string[] {
  const period = periodFromDate(periodDate);
  const periodStart = dateFromPeriod(period);
  return Array.from(
    new Set([
      period,
      periodFromDate(addUtcDays(periodStart, -1)),
      periodFromDate(addUtcDays(periodStart, 1)),
    ])
  );
}

function getRetainedLedgerPeriods(now = new Date()): string[] {
  const periods = new Set<string>();
  const cursor = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  for (let offset = 0; offset < COST_LEDGER_ERASURE_PERIOD_COUNT; offset += 1) {
    periods.add(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return [...periods];
}

function costValue(value: number | null): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function toRequestSummaryKey(reqId: string): string {
  return `sha256:${createHash("sha256").update(reqId).digest("hex").slice(0, 12)}`;
}

function createStringRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function assertCostLedgerScope(scope: CostLedgerScope): void {
  if (
    !scope ||
    !isPositiveInteger(scope.workspaceId) ||
    !isPositiveInteger(scope.channelConnectionId) ||
    !isPositiveInteger(scope.bindingEpoch) ||
    !isPositiveInteger(scope.privacyEpoch)
  ) {
    throw new CostLedgerScopeError();
  }
}

function assertSubjectScope(scope: CostLedgerSubjectScope): void {
  assertCostLedgerScope(scope);
  if (!scope.userKey?.trim()) throw new CostLedgerScopeError();
}

function assertErasureScope(scope: CostLedgerErasureScope): void {
  if (
    !scope ||
    !isPositiveInteger(scope.workspaceId) ||
    !isPositiveInteger(scope.channelConnectionId) ||
    !isPositiveInteger(scope.erasureEpoch) ||
    !scope.userKey?.trim()
  ) {
    throw new CostLedgerScopeError();
  }
}

function workspacePeriodKey(workspaceId: number, period: string): string {
  return `{cost-ledger-v2:${workspaceId}}:period:${period}`;
}

function subjectDigest(input: {
  workspaceId: number;
  channelConnectionId: number;
  userKey: string;
}): string {
  return createHash("sha256")
    .update(String(input.workspaceId))
    .update("\0")
    .update(String(input.channelConnectionId))
    .update("\0")
    .update(input.userKey)
    .digest("hex");
}

function subjectTombstoneKey(input: {
  workspaceId: number;
  channelConnectionId: number;
  userKey: string;
}): string {
  return `{cost-ledger-v2:${input.workspaceId}}:subject:${input.channelConnectionId}:${subjectDigest(input)}`;
}

function workspacePeriodStorageKey(
  workspaceId: number,
  period: string
): string {
  return getScopedStateStorageKey(
    COST_LEDGER_WORKSPACE_SCOPE,
    workspacePeriodKey(workspaceId, period)
  );
}

function subjectTombstoneStorageKey(input: {
  workspaceId: number;
  channelConnectionId: number;
  userKey: string;
}): string {
  return getScopedStateStorageKey(
    COST_LEDGER_TOMBSTONE_SCOPE,
    subjectTombstoneKey(input)
  );
}

function globalBudgetStorageKey(period: string): string {
  return getScopedStateStorageKey(COST_LEDGER_BUDGET_SCOPE, period);
}

function parseRedisTuple(value: unknown, operation: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.some(item => typeof item !== "string")
  ) {
    throw new Error(`Invalid Redis response for ${operation}`);
  }
  return value as string[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function throwAtomicLedgerError(status: string): never {
  if (status === "tombstoned") throw new CostLedgerPrivacyTombstoneError();
  throw new Error(`Cost ledger atomic state failure: ${status}`);
}

function validateStoredLedgerEntry(
  value: unknown,
  workspaceId: number,
  period: string
): StoredCostLedgerEntry {
  const entry = value as StoredCostLedgerEntry;
  if (!entry || typeof entry !== "object") {
    throw new Error("Cost ledger period contains an invalid entry");
  }
  assertCostLedgerScope(entry.scope);
  if (
    entry.scope.workspaceId !== workspaceId ||
    entry.period !== period ||
    !entry.id?.trim() ||
    !entry.userKey?.trim() ||
    !entry.reqId?.startsWith("sha256:") ||
    !isCostLedgerStatus(entry.status) ||
    !isNonNegativeCost(entry.estimatedCostUsd) ||
    !isNonNegativeCost(entry.estimatedOutputCostUsd) ||
    !isNonNegativeCost(entry.finalCostUsd) ||
    typeof entry.costEstimateComplete !== "boolean" ||
    !Array.isArray(entry.unpricedCostComponents) ||
    entry.unpricedCostComponents.some(
      component => typeof component !== "string"
    )
  ) {
    throw new Error("Cost ledger entry scope is invalid");
  }
  return entry;
}

function isCostLedgerStatus(value: unknown): value is CostLedgerStatus {
  return (
    value === "provider_attempt_started" ||
    value === "provider_attempt_succeeded" ||
    value === "provider_attempt_failed" ||
    value === "blocked"
  );
}

function isNonNegativeCost(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0)
  );
}

function workspacePeriodLockKey(workspaceId: number, period: string): string {
  return `lock:${COST_LEDGER_WORKSPACE_SCOPE}:${workspaceId}:${period}`;
}

function globalBudgetLockKey(period: string): string {
  return `lock:${COST_LEDGER_BUDGET_SCOPE}:${period}`;
}

function subjectLockKey(input: {
  workspaceId: number;
  channelConnectionId: number;
  userKey: string;
}): string {
  return `lock:${COST_LEDGER_TOMBSTONE_SCOPE}:${subjectTombstoneKey(input)}`;
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

async function withCostLedgerLock<T>(
  lockKey: string,
  action: () => Promise<T>
): Promise<T> {
  const token = randomUUID();
  for (let attempt = 0; attempt < COST_LEDGER_LOCK_MAX_ATTEMPTS; attempt += 1) {
    if (
      await setEphemeralKeyIfAbsent(
        lockKey,
        token,
        COST_LEDGER_LOCK_TTL_SECONDS
      )
    ) {
      try {
        return await action();
      } finally {
        await deleteEphemeralKeyIfValue(lockKey, token);
      }
    }
    await wait(10);
  }
  safeLog("cost_ledger_lock_timeout", { level: "warn" });
  throw new Error("Timed out waiting for cost ledger lock");
}

async function readSubjectTombstone(input: {
  workspaceId: number;
  channelConnectionId: number;
  userKey: string;
}): Promise<CostLedgerTombstone | null> {
  return await Promise.resolve(
    readScopedState<CostLedgerTombstone>(
      COST_LEDGER_TOMBSTONE_SCOPE,
      subjectTombstoneKey(input)
    )
  );
}

async function assertSubjectWritable(
  input: CostLedgerSubjectScope
): Promise<void> {
  const tombstone = await readSubjectTombstone(input);
  if (tombstone && input.privacyEpoch <= tombstone.erasureEpoch) {
    throw new CostLedgerPrivacyTombstoneError();
  }
}

async function appendWorkspaceEntryAtomically(
  subject: CostLedgerSubjectScope,
  period: string,
  storedEntry: StoredCostLedgerEntry
): Promise<{ entry: StoredCostLedgerEntry; droppedEntries: number }> {
  if (!isRedisEnabled()) {
    await assertSubjectWritable(subject);
    const current = await readCostLedgerPeriod(subject, period);
    const duplicate = current.find(
      candidate =>
        candidate.id === storedEntry.id &&
        candidate.userKey === storedEntry.userKey &&
        candidate.scope.channelConnectionId ===
          storedEntry.scope.channelConnectionId &&
        candidate.scope.bindingEpoch === storedEntry.scope.bindingEpoch &&
        candidate.scope.privacyEpoch === storedEntry.scope.privacyEpoch
    );
    if (duplicate) return { entry: duplicate, droppedEntries: 0 };
    const appended = [...current, storedEntry];
    const droppedEntries = Math.max(
      0,
      appended.length - COST_LEDGER_MAX_ENTRIES_PER_WORKSPACE_PERIOD
    );
    await Promise.resolve(
      writeScopedState(
        COST_LEDGER_WORKSPACE_SCOPE,
        workspacePeriodKey(subject.workspaceId, period),
        appended.slice(-COST_LEDGER_MAX_ENTRIES_PER_WORKSPACE_PERIOD),
        COST_LEDGER_TTL_SECONDS
      )
    );
    return { entry: storedEntry, droppedEntries };
  }

  const redis = await getRedisClient();
  const result = parseRedisTuple(
    await redis.eval(
      ATOMIC_APPEND_WORKSPACE_ENTRY_SCRIPT,
      2,
      workspacePeriodStorageKey(subject.workspaceId, period),
      subjectTombstoneStorageKey(subject),
      subject.privacyEpoch,
      JSON.stringify(storedEntry),
      storedEntry.id,
      storedEntry.userKey,
      storedEntry.scope.channelConnectionId,
      storedEntry.scope.bindingEpoch,
      COST_LEDGER_MAX_ENTRIES_PER_WORKSPACE_PERIOD,
      COST_LEDGER_TTL_SECONDS
    ),
    "append"
  );
  if (result[0] === "duplicate") {
    return {
      entry: JSON.parse(result[1] ?? "null") as StoredCostLedgerEntry,
      droppedEntries: 0,
    };
  }
  if (result[0] !== "appended") throwAtomicLedgerError(result[0]);
  return {
    entry: storedEntry,
    droppedEntries: Number(result[1] ?? 0),
  };
}

async function upsertSubjectTombstoneAtomically(
  input: CostLedgerErasureScope,
  erasedAt: Date
): Promise<number> {
  if (!isRedisEnabled()) {
    const current = await readSubjectTombstone(input);
    const erasureEpoch = Math.max(
      input.erasureEpoch,
      current?.erasureEpoch ?? 0
    );
    await Promise.resolve(
      writeScopedState<CostLedgerTombstone>(
        COST_LEDGER_TOMBSTONE_SCOPE,
        subjectTombstoneKey(input),
        { version: 1, erasureEpoch, erasedAt: erasedAt.toISOString() },
        COST_LEDGER_TTL_SECONDS
      )
    );
    return erasureEpoch;
  }

  const redis = await getRedisClient();
  const result = parseRedisTuple(
    await redis.eval(
      ATOMIC_UPSERT_TOMBSTONE_SCRIPT,
      1,
      subjectTombstoneStorageKey(input),
      input.erasureEpoch,
      erasedAt.toISOString(),
      COST_LEDGER_TTL_SECONDS
    ),
    "tombstone"
  );
  if (result[0] !== "ok") throwAtomicLedgerError(result[0]);
  const effectiveEpoch = Number(result[1]);
  if (!isPositiveInteger(effectiveEpoch)) {
    throw new Error("Invalid cost ledger tombstone epoch");
  }
  return effectiveEpoch;
}

async function deleteSubjectFromPeriodAtomically(
  input: CostLedgerErasureScope,
  effectiveErasureEpoch: number,
  period: string
): Promise<number> {
  if (!isRedisEnabled()) {
    const readScope: CostLedgerScope = {
      workspaceId: input.workspaceId,
      channelConnectionId: input.channelConnectionId,
      bindingEpoch: 1,
      privacyEpoch: 1,
    };
    const current = await readCostLedgerPeriod(readScope, period);
    if (!current.length) return 0;
    const next = current.filter(
      entry =>
        !(
          entry.scope.channelConnectionId === input.channelConnectionId &&
          entry.userKey === input.userKey &&
          entry.scope.privacyEpoch <= effectiveErasureEpoch
        )
    );
    const deleted = current.length - next.length;
    if (deleted > 0) {
      await Promise.resolve(
        writeScopedState(
          COST_LEDGER_WORKSPACE_SCOPE,
          workspacePeriodKey(input.workspaceId, period),
          next,
          COST_LEDGER_TTL_SECONDS
        )
      );
    }
    return deleted;
  }

  const redis = await getRedisClient();
  const result = parseRedisTuple(
    await redis.eval(
      ATOMIC_DELETE_SUBJECT_FROM_PERIOD_SCRIPT,
      2,
      workspacePeriodStorageKey(input.workspaceId, period),
      subjectTombstoneStorageKey(input),
      input.channelConnectionId,
      input.userKey,
      effectiveErasureEpoch
    ),
    "delete"
  );
  if (result[0] !== "ok") throwAtomicLedgerError(result[0]);
  return Number(result[1] ?? 0);
}

async function updateWorkspaceEntryAtomically(
  subject: CostLedgerSubjectScope,
  period: string,
  id: string,
  updates: Partial<
    Pick<
      CostLedgerEntry,
      "status" | "finalCostUsd" | "costEstimateComplete" | "estimateSource"
    >
  >
): Promise<StoredCostLedgerEntry | null> {
  if (!isRedisEnabled()) {
    await assertSubjectWritable(subject);
    const current = await readCostLedgerPeriod(subject, period);
    const index = current.findIndex(
      entry => entry.id === id && entryMatchesSubject(entry, subject)
    );
    if (index < 0) return null;
    const updatedEntry: StoredCostLedgerEntry = {
      ...current[index],
      ...updates,
    };
    const next = [...current];
    next[index] = updatedEntry;
    await Promise.resolve(
      writeScopedState(
        COST_LEDGER_WORKSPACE_SCOPE,
        workspacePeriodKey(subject.workspaceId, period),
        next,
        COST_LEDGER_TTL_SECONDS
      )
    );
    return updatedEntry;
  }

  const redis = await getRedisClient();
  const storageKey = workspacePeriodStorageKey(subject.workspaceId, period);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const currentRaw = await redis.get(storageKey);
    if (!currentRaw) return null;
    const serializedEntries = JSON.parse(currentRaw) as unknown;
    if (!isStringArray(serializedEntries)) {
      throw new Error("Cost ledger period has an unsupported storage shape");
    }
    const index = serializedEntries.findIndex(value => {
      const entry = JSON.parse(value) as StoredCostLedgerEntry;
      return entry.id === id && entryMatchesSubject(entry, subject);
    });
    if (index < 0) return null;
    const currentEntry = JSON.parse(
      serializedEntries[index]
    ) as StoredCostLedgerEntry;
    const updatedEntry: StoredCostLedgerEntry = {
      ...currentEntry,
      ...updates,
    };
    const next = [...serializedEntries] as string[];
    next[index] = JSON.stringify(updatedEntry);
    const result = parseRedisTuple(
      await redis.eval(
        ATOMIC_UPDATE_WORKSPACE_ENTRY_SCRIPT,
        2,
        storageKey,
        subjectTombstoneStorageKey(subject),
        subject.privacyEpoch,
        currentRaw,
        JSON.stringify(next)
      ),
      "update"
    );
    if (result[0] === "updated") return updatedEntry;
    if (result[0] === "not_found") return null;
    if (result[0] !== "retry") throwAtomicLedgerError(result[0]);
  }
  throw new Error("Cost ledger update contention exceeded retry limit");
}

function emptyBudgetAggregate(period: string): CostLedgerBudgetAggregate {
  return {
    version: 2,
    period,
    attempts: 0,
    estimatedCostUsd: 0,
    completeEstimateEntries: 0,
    incompleteEstimateEntries: 0,
    unpricedCostComponents: [],
    byOperation: createStringRecord(),
    byProvider: createStringRecord(),
  };
}

function addBudgetBucket(
  target: Record<string, { attempts: number; estimatedCostUsd: number }>,
  key: string,
  estimatedCostUsd: number
): void {
  const bucket = target[key] ?? { attempts: 0, estimatedCostUsd: 0 };
  target[key] = {
    attempts: bucket.attempts + 1,
    estimatedCostUsd: roundUsd(bucket.estimatedCostUsd + estimatedCostUsd),
  };
}

function nextBudgetAggregate(
  current: CostLedgerBudgetAggregate,
  entry: CostLedgerEntry,
  period: string
): CostLedgerBudgetAggregate {
  const attemptEstimate = roundUsd(
    costValue(entry.estimatedCostUsd) + costValue(entry.estimatedOutputCostUsd)
  );
  const next: CostLedgerBudgetAggregate = {
    ...current,
    version: 2,
    period,
    attempts: current.attempts + 1,
    estimatedCostUsd: roundUsd(current.estimatedCostUsd + attemptEstimate),
    completeEstimateEntries:
      current.completeEstimateEntries + (entry.costEstimateComplete ? 1 : 0),
    incompleteEstimateEntries:
      current.incompleteEstimateEntries + (entry.costEstimateComplete ? 0 : 1),
    unpricedCostComponents: [
      ...new Set([
        ...current.unpricedCostComponents,
        ...entry.unpricedCostComponents,
      ]),
    ].sort(),
    byOperation: { ...current.byOperation },
    byProvider: { ...current.byProvider },
  };
  addBudgetBucket(next.byOperation, entry.operation, attemptEstimate);
  addBudgetBucket(next.byProvider, entry.provider, attemptEstimate);
  return next;
}

function validateBudgetAggregate(
  value: unknown,
  period: string
): CostLedgerBudgetAggregate {
  if (value == null) return emptyBudgetAggregate(period);
  const aggregate = value as CostLedgerBudgetAggregate;
  if (
    !aggregate ||
    typeof aggregate !== "object" ||
    Array.isArray(aggregate) ||
    aggregate.version !== 2 ||
    aggregate.period !== period ||
    !Number.isSafeInteger(aggregate.attempts) ||
    aggregate.attempts < 0 ||
    !isNonNegativeCost(aggregate.estimatedCostUsd) ||
    aggregate.estimatedCostUsd === null ||
    !Number.isSafeInteger(aggregate.completeEstimateEntries) ||
    aggregate.completeEstimateEntries < 0 ||
    !Number.isSafeInteger(aggregate.incompleteEstimateEntries) ||
    aggregate.incompleteEstimateEntries < 0 ||
    !Array.isArray(aggregate.unpricedCostComponents) ||
    aggregate.unpricedCostComponents.some(
      component => typeof component !== "string"
    ) ||
    !isBudgetBucketRecord(aggregate.byOperation) ||
    !isBudgetBucketRecord(aggregate.byProvider)
  ) {
    throw new Error("Cost ledger budget aggregate is invalid");
  }
  return aggregate;
}

function isBudgetBucketRecord(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return !Object.values(value).some(
    bucket =>
      !bucket ||
      typeof bucket !== "object" ||
      Array.isArray(bucket) ||
      !Number.isSafeInteger((bucket as { attempts?: unknown }).attempts) ||
      Number((bucket as { attempts?: unknown }).attempts) < 0 ||
      !isNonNegativeCost(
        (bucket as { estimatedCostUsd?: unknown }).estimatedCostUsd
      ) ||
      (bucket as { estimatedCostUsd?: unknown }).estimatedCostUsd === null
  );
}

function parseBudgetAggregate(
  raw: string | null,
  period: string
): CostLedgerBudgetAggregate {
  if (!raw) return emptyBudgetAggregate(period);
  return validateBudgetAggregate(JSON.parse(raw) as unknown, period);
}

async function conservativelyAddToBudgetAggregate(
  entry: CostLedgerEntry,
  period: string
): Promise<void> {
  if (isRedisEnabled()) {
    const redis = await getRedisClient();
    const storageKey = globalBudgetStorageKey(period);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const currentRaw = await redis.get(storageKey);
      const current = parseBudgetAggregate(currentRaw, period);
      const next = nextBudgetAggregate(current, entry, period);
      const result = await redis.eval(
        ATOMIC_COMPARE_AND_SET_SCRIPT,
        1,
        storageKey,
        currentRaw ?? "__leaderbot_missing__",
        JSON.stringify(next),
        COST_LEDGER_TTL_SECONDS
      );
      if (result === "updated") return;
      if (result !== "retry") {
        throw new Error("Invalid Redis response for budget aggregate");
      }
    }
    throw new Error("Cost ledger budget contention exceeded retry limit");
  }

  await withCostLedgerLock(globalBudgetLockKey(period), async () => {
    const current =
      (await Promise.resolve(
        readScopedState<CostLedgerBudgetAggregate>(
          COST_LEDGER_BUDGET_SCOPE,
          period
        )
      )) ?? emptyBudgetAggregate(period);
    const next = nextBudgetAggregate(current, entry, period);
    // Global aggregate first: a later tenant-detail failure can only produce
    // conservative overcount, never an undercount that permits provider spend.
    await Promise.resolve(
      writeScopedState(
        COST_LEDGER_BUDGET_SCOPE,
        period,
        next,
        COST_LEDGER_TTL_SECONDS
      )
    );
  });
}

export async function readCostLedgerBudgetPeriod(
  period: string
): Promise<CostLedgerBudgetAggregate> {
  return validateBudgetAggregate(
    await Promise.resolve(
      readScopedState<unknown>(COST_LEDGER_BUDGET_SCOPE, period)
    ),
    period
  );
}

export async function summarizeCostLedgerBudgetPeriods(
  periods: string[],
  summaryPeriod = periods.join(",")
): Promise<CostLedgerBudgetAggregate> {
  const values = await Promise.all(periods.map(readCostLedgerBudgetPeriod));
  const summary = emptyBudgetAggregate(summaryPeriod);
  for (const value of values) {
    summary.attempts += value.attempts;
    summary.estimatedCostUsd = roundUsd(
      summary.estimatedCostUsd + value.estimatedCostUsd
    );
    summary.completeEstimateEntries += value.completeEstimateEntries;
    summary.incompleteEstimateEntries += value.incompleteEstimateEntries;
    summary.unpricedCostComponents = [
      ...new Set([
        ...summary.unpricedCostComponents,
        ...value.unpricedCostComponents,
      ]),
    ].sort();
    for (const [operation, bucket] of Object.entries(value.byOperation)) {
      const current = summary.byOperation[operation] ?? {
        attempts: 0,
        estimatedCostUsd: 0,
      };
      summary.byOperation[operation] = {
        attempts: current.attempts + bucket.attempts,
        estimatedCostUsd: roundUsd(
          current.estimatedCostUsd + bucket.estimatedCostUsd
        ),
      };
    }
    for (const [provider, bucket] of Object.entries(value.byProvider)) {
      const current = summary.byProvider[provider] ?? {
        attempts: 0,
        estimatedCostUsd: 0,
      };
      summary.byProvider[provider] = {
        attempts: current.attempts + bucket.attempts,
        estimatedCostUsd: roundUsd(
          current.estimatedCostUsd + bucket.estimatedCostUsd
        ),
      };
    }
  }
  return summary;
}

export async function readCostLedgerPeriod(
  scope: CostLedgerScope,
  period: string
): Promise<StoredCostLedgerEntry[]> {
  assertCostLedgerScope(scope);
  if (isRedisEnabled()) {
    const redis = await getRedisClient();
    const raw = await redis.get(
      workspacePeriodStorageKey(scope.workspaceId, period)
    );
    if (!raw) return [];
    const values = JSON.parse(raw) as unknown;
    if (!isStringArray(values)) {
      throw new Error("Cost ledger period has an unsupported storage shape");
    }
    return values.map(value => {
      return validateStoredLedgerEntry(
        JSON.parse(value),
        scope.workspaceId,
        period
      );
    });
  }
  const values =
    (await Promise.resolve(
      readScopedState<StoredCostLedgerEntry[]>(
        COST_LEDGER_WORKSPACE_SCOPE,
        workspacePeriodKey(scope.workspaceId, period)
      )
    )) ?? [];
  if (!Array.isArray(values)) {
    throw new Error("Cost ledger period has an unsupported storage shape");
  }
  return values.map(value =>
    validateStoredLedgerEntry(value, scope.workspaceId, period)
  );
}

export async function appendCostLedgerEntry(
  entry: CostLedgerEntry,
  recordedAt = new Date()
): Promise<StoredCostLedgerEntry> {
  assertCostLedgerScope(entry.scope);
  if (!entry.userKey?.trim()) throw new CostLedgerScopeError();
  if (process.env.NODE_ENV === "production") await assertCostLedgerV2Ready();
  const subject: CostLedgerSubjectScope = {
    ...entry.scope,
    userKey: entry.userKey,
  };
  const period = periodFromDate(recordedAt);

  return await withCostLedgerLock(subjectLockKey(subject), async () => {
    await assertSubjectWritable(subject);
    const currentBeforeAggregate = await readCostLedgerPeriod(
      entry.scope,
      period
    );
    const existing = currentBeforeAggregate.find(
      candidate =>
        candidate.id === entry.id &&
        candidate.userKey === entry.userKey &&
        candidate.scope.channelConnectionId ===
          entry.scope.channelConnectionId &&
        candidate.scope.bindingEpoch === entry.scope.bindingEpoch &&
        candidate.scope.privacyEpoch === entry.scope.privacyEpoch
    );
    if (existing) return existing;

    await conservativelyAddToBudgetAggregate(entry, period);
    await beforeDetailCommitHookForTests?.();
    const storedEntry: StoredCostLedgerEntry = {
      ...entry,
      scope: { ...entry.scope },
      reqId: normalizeStoredReqId(entry.reqId),
      period,
      recordedAt: recordedAt.toISOString(),
    };
    const result = await withCostLedgerLock(
      workspacePeriodLockKey(entry.scope.workspaceId, period),
      async () =>
        await appendWorkspaceEntryAtomically(subject, period, storedEntry)
    );
    if (result.droppedEntries > 0) {
      costLedgerDroppedEntryCount += result.droppedEntries;
      safeLog("cost_ledger_period_overflow", {
        level: "warn",
        workspaceId: entry.scope.workspaceId,
        period,
        droppedEntries: result.droppedEntries,
        maxEntriesPerPeriod: COST_LEDGER_MAX_ENTRIES_PER_WORKSPACE_PERIOD,
        totalDroppedEntries: costLedgerDroppedEntryCount,
      });
    }
    return result.entry;
  });
}

export function getCostLedgerReliabilityStats(): CostLedgerReliabilityStats {
  return {
    droppedEntryCount: costLedgerDroppedEntryCount,
    maxEntriesPerPeriod: COST_LEDGER_MAX_ENTRIES_PER_WORKSPACE_PERIOD,
  };
}

export function resetCostLedgerReliabilityStatsForTests(): void {
  costLedgerDroppedEntryCount = 0;
  beforeDetailCommitHookForTests = null;
}

export function setCostLedgerBeforeDetailCommitHookForTests(
  hook: (() => Promise<void>) | null
): void {
  if (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") {
    throw new Error("Cost ledger test hooks are unavailable outside tests");
  }
  beforeDetailCommitHookForTests = hook;
}

export async function deleteCostLedgerEntriesForSubject(
  input: CostLedgerErasureScope,
  now = new Date()
): Promise<number> {
  assertErasureScope(input);
  if (process.env.NODE_ENV === "production") await assertCostLedgerV2Ready();

  const effectiveErasureEpoch = await withCostLedgerLock(
    subjectLockKey(input),
    async () => await upsertSubjectTombstoneAtomically(input, now)
  );

  let deleted = 0;
  let touchedPeriods = 0;
  for (const period of getRetainedLedgerPeriods(now)) {
    const deletedInPeriod = await withCostLedgerLock(
      workspacePeriodLockKey(input.workspaceId, period),
      async () =>
        await deleteSubjectFromPeriodAtomically(
          input,
          effectiveErasureEpoch,
          period
        )
    );
    deleted += deletedInPeriod;
    if (deletedInPeriod > 0) touchedPeriods += 1;
  }
  safeLog("cost_ledger_subject_delete_completed", {
    user: toLogUser(input.userKey),
    workspaceId: input.workspaceId,
    channelConnectionId: input.channelConnectionId,
    scannedPeriods: COST_LEDGER_ERASURE_PERIOD_COUNT,
    touchedPeriods,
    deletedEntries: deleted,
  });
  return deleted;
}

function entryMatchesSubject(
  entry: StoredCostLedgerEntry,
  subject: CostLedgerSubjectScope
): boolean {
  return (
    entry.userKey === subject.userKey &&
    entry.scope.workspaceId === subject.workspaceId &&
    entry.scope.channelConnectionId === subject.channelConnectionId &&
    entry.scope.bindingEpoch === subject.bindingEpoch &&
    entry.scope.privacyEpoch === subject.privacyEpoch
  );
}

export async function updateCostLedgerEntry(
  subject: CostLedgerSubjectScope,
  id: string,
  updates: Partial<
    Pick<
      CostLedgerEntry,
      "status" | "finalCostUsd" | "costEstimateComplete" | "estimateSource"
    >
  >,
  periodDate = new Date()
): Promise<StoredCostLedgerEntry | null> {
  assertSubjectScope(subject);
  return await withCostLedgerLock(subjectLockKey(subject), async () => {
    await assertSubjectWritable(subject);
    for (const period of candidateUpdatePeriods(periodDate)) {
      const updated = await withCostLedgerLock(
        workspacePeriodLockKey(subject.workspaceId, period),
        async () =>
          await updateWorkspaceEntryAtomically(subject, period, id, updates)
      );
      if (updated) return updated;
    }
    return null;
  });
}

export async function safelyUpdateCostLedgerEntry(
  subject: CostLedgerSubjectScope,
  id: string,
  updates: Partial<
    Pick<
      CostLedgerEntry,
      "status" | "finalCostUsd" | "costEstimateComplete" | "estimateSource"
    >
  >,
  periodDate = new Date()
): Promise<StoredCostLedgerEntry | null> {
  try {
    return await updateCostLedgerEntry(subject, id, updates, periodDate);
  } catch (error) {
    safeLog("cost_ledger_update_failed", {
      id: toRequestSummaryKey(id),
      status: updates.status,
      user: toLogUser(subject.userKey),
      errorCode:
        error instanceof Error ? error.constructor.name : "UnknownError",
    });
    return null;
  }
}

export async function safelyAppendCostLedgerEntry(
  entry: CostLedgerEntry,
  recordedAt = new Date()
): Promise<StoredCostLedgerEntry | null> {
  try {
    return await appendCostLedgerEntry(entry, recordedAt);
  } catch (error) {
    safeLog("cost_ledger_append_failed", {
      reqId: toRequestSummaryKey(entry.reqId),
      channel: entry.channel,
      operation: entry.operation,
      provider: entry.provider,
      model: entry.model,
      status: entry.status,
      user: toLogUser(entry.userKey),
      errorCode:
        error instanceof Error ? error.constructor.name : "UnknownError",
    });
    return null;
  }
}

function mergeSummaryLabel(previous: string, next: string): string {
  return previous === next ? previous : "mixed";
}

function addToBucket(
  target: Record<string, CostSummaryBucket>,
  key: string,
  entry: StoredCostLedgerEntry
): void {
  const bucket =
    target[key] ??
    (target[key] = { attempts: 0, estimatedCostUsd: 0, finalCostUsd: 0 });
  bucket.attempts += 1;
  bucket.estimatedCostUsd = roundUsd(
    bucket.estimatedCostUsd +
      costValue(entry.estimatedCostUsd) +
      costValue(entry.estimatedOutputCostUsd)
  );
  bucket.finalCostUsd = roundUsd(
    bucket.finalCostUsd + costValue(entry.finalCostUsd)
  );
}

function addToRequestBucket(
  target: Record<string, CostRequestSummaryBucket>,
  entry: StoredCostLedgerEntry
): void {
  const key = summarizeRequestId(entry.reqId);
  const bucket =
    target[key] ??
    (target[key] = {
      attempts: 0,
      estimatedCostUsd: 0,
      finalCostUsd: 0,
      operation: entry.operation,
      provider: entry.provider,
      statuses: createStringRecord(),
      completeEstimateEntries: 0,
      incompleteEstimateEntries: 0,
      unpricedCostComponents: [],
    });
  bucket.attempts += 1;
  bucket.estimatedCostUsd = roundUsd(
    bucket.estimatedCostUsd +
      costValue(entry.estimatedCostUsd) +
      costValue(entry.estimatedOutputCostUsd)
  );
  bucket.finalCostUsd = roundUsd(
    bucket.finalCostUsd + costValue(entry.finalCostUsd)
  );
  bucket.operation = mergeSummaryLabel(bucket.operation, entry.operation);
  bucket.provider = mergeSummaryLabel(bucket.provider, entry.provider);
  bucket.statuses[entry.status] = (bucket.statuses[entry.status] ?? 0) + 1;
  if (entry.costEstimateComplete) bucket.completeEstimateEntries += 1;
  else bucket.incompleteEstimateEntries += 1;
  bucket.unpricedCostComponents = [
    ...new Set([
      ...bucket.unpricedCostComponents,
      ...entry.unpricedCostComponents,
    ]),
  ].sort();
}

function summarizeCostLedgerEntries(
  period: string,
  entries: StoredCostLedgerEntry[]
): CostLedgerSummary {
  const users = new Set<string>();
  const unpriced = new Set<string>();
  const byOperation = createStringRecord<CostSummaryBucket>();
  const byProvider = createStringRecord<CostSummaryBucket>();
  const byRequest = createStringRecord<CostRequestSummaryBucket>();
  const byStatus: Record<CostLedgerStatus, number> = {
    provider_attempt_started: 0,
    provider_attempt_succeeded: 0,
    provider_attempt_failed: 0,
    blocked: 0,
  };
  let estimatedCostUsd = 0;
  let finalCostUsd = 0;
  let completeEstimateEntries = 0;
  let incompleteEstimateEntries = 0;
  for (const entry of entries) {
    byStatus[entry.status] += 1;
    users.add(entry.userKey);
    estimatedCostUsd +=
      costValue(entry.estimatedCostUsd) +
      costValue(entry.estimatedOutputCostUsd);
    finalCostUsd += costValue(entry.finalCostUsd);
    if (entry.costEstimateComplete) completeEstimateEntries += 1;
    else incompleteEstimateEntries += 1;
    for (const component of entry.unpricedCostComponents)
      unpriced.add(component);
    addToBucket(byOperation, entry.operation, entry);
    addToBucket(byProvider, entry.provider, entry);
    addToRequestBucket(byRequest, entry);
  }
  return {
    period,
    totalEntries: entries.length,
    uniqueUserCount: users.size,
    estimatedCostUsd: roundUsd(estimatedCostUsd),
    finalCostUsd: roundUsd(finalCostUsd),
    openAttemptEntries: byStatus.provider_attempt_started,
    failedAttemptEntries: byStatus.provider_attempt_failed,
    blockedEntries: byStatus.blocked,
    completeEstimateEntries,
    incompleteEstimateEntries,
    unpricedCostComponents: [...unpriced].sort(),
    byStatus,
    byOperation,
    byProvider,
    byRequest,
  };
}

export async function summarizeCostLedgerPeriod(
  scope: CostLedgerScope,
  period: string
): Promise<CostLedgerSummary> {
  return summarizeCostLedgerEntries(
    period,
    await readCostLedgerPeriod(scope, period)
  );
}

export async function summarizeCostLedgerPeriods(
  scope: CostLedgerScope,
  periods: string[],
  summaryPeriod = periods.join(",")
): Promise<CostLedgerSummary> {
  const entries = (
    await Promise.all(
      periods.map(period => readCostLedgerPeriod(scope, period))
    )
  ).flat();
  return summarizeCostLedgerEntries(summaryPeriod, entries);
}

export async function summarizeCostLedgerPeriodForUser(
  scope: CostLedgerScope,
  period: string,
  userKey: string
): Promise<CostLedgerSummary> {
  const entries = (await readCostLedgerPeriod(scope, period)).filter(
    entry =>
      entry.userKey === userKey &&
      entry.scope.channelConnectionId === scope.channelConnectionId
  );
  return summarizeCostLedgerEntries(period, entries);
}

async function hasLegacyCostLedgerKeys(): Promise<boolean> {
  if (!isRedisEnabled()) return false;
  const redis = await getRedisClient();
  let cursor = "0";
  for (
    let iteration = 0;
    iteration < LEGACY_SCAN_MAX_ITERATIONS;
    iteration += 1
  ) {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      "MATCH",
      `${LEGACY_COST_LEDGER_SCOPE}:*`,
      "COUNT",
      100
    );
    if (keys.length > 0) return true;
    cursor = nextCursor;
    if (cursor === "0") return false;
  }
  throw new Error("Unable to complete legacy cost-ledger readiness scan");
}

/** No legacy record is inferred into a tenant; an explicit purge is required. */
export async function assertCostLedgerV2Ready(): Promise<void> {
  if (process.env.NODE_ENV === "production" && !isRedisEnabled()) {
    throw new Error("Redis is required for production cost-ledger isolation");
  }
  if (await hasLegacyCostLedgerKeys()) throw new LegacyCostLedgerDataError();
}
