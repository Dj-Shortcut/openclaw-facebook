import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import {
  deleteEphemeralKeyIfValue,
  decrementExpiringCounter,
  hasEphemeralKey,
  incrementExpiringCounter,
  isRedisStateStoreEnabled,
  setEphemeralKey,
  setEphemeralKeyIfAbsent,
} from "./stateStore";
import {
  summarizeBudgetedCostLedgerPeriod,
  summarizeBudgetedCostLedgerPeriods,
  summarizeCostLedgerPeriodForUser,
  summarizeOwnerBypassCostLedgerPeriod,
  summarizeOwnerBypassCostLedgerPeriods,
} from "./costLedger";
import { safeLog } from "./logger";
import { notifyOwner } from "./notification";
import { toLogUser } from "./privacy";
import { getRedisClient } from "./redis";

const DEFAULT_GLOBAL_CONCURRENCY = 3;
const DEFAULT_GLOBAL_LOCK_MS = 240000;
const DEFAULT_PSID_COOLDOWN_MS = 0;
const DEFAULT_PSID_LOCK_MS = 240000;
const DEFAULT_VIDEO_PSID_LOCK_MS = 900000;
const DEFAULT_GLOBAL_SLOT_WAIT_MS = 100;
const DAILY_BUDGET_KEY_PREFIX = "messenger:daily-image-budget";
const DAILY_VIDEO_BUDGET_KEY_PREFIX = "messenger:daily-video-budget";
const DAILY_AUDIO_TRANSCRIPTION_BUDGET_KEY_PREFIX =
  "messenger:daily-audio-transcription-budget";
const SPEND_COUNTER_SCALE = 1_000_000;
const DEFAULT_OWNER_EMERGENCY_DAILY_SPEND_CAP_USD = 100;
const DEFAULT_OWNER_EMERGENCY_MONTHLY_SPEND_CAP_USD = 1_000;

const RESERVE_SPEND_SCRIPT = `
  if redis.call("EXISTS", KEYS[1]) == 1 then
    return 2
  end

  local amount = tonumber(ARGV[1])
  local dailyCap = tonumber(ARGV[2])
  local monthlyCap = tonumber(ARGV[3])
  local userCap = tonumber(ARGV[4])
  local dailyBaseline = tonumber(ARGV[5])
  local monthlyBaseline = tonumber(ARGV[6])
  local userBaseline = tonumber(ARGV[7])
  local ttl = tonumber(ARGV[8])

  local daily = math.max(tonumber(redis.call("GET", KEYS[2]) or "0"), dailyBaseline)
  local monthly = math.max(tonumber(redis.call("GET", KEYS[3]) or "0"), monthlyBaseline)
  local user = math.max(tonumber(redis.call("GET", KEYS[4]) or "0"), userBaseline)

  if dailyCap > 0 and daily + amount > dailyCap then return -1 end
  if monthlyCap > 0 and monthly + amount > monthlyCap then return -2 end
  if userCap > 0 and user + amount > userCap then return -3 end

  redis.call("SET", KEYS[1], amount, "EX", ttl, "NX")
  redis.call("SET", KEYS[2], daily + amount, "EX", ttl)
  redis.call("SET", KEYS[3], monthly + amount, "EX", ttl)
  redis.call("SET", KEYS[4], user + amount, "EX", ttl)
  return 1
`;

const RELEASE_SPEND_SCRIPT = `
  local amount = tonumber(redis.call("GET", KEYS[1]) or "0")
  if amount <= 0 then return 0 end
  redis.call("DEL", KEYS[1])
  for index = 2, 4 do
    local current = tonumber(redis.call("GET", KEYS[index]) or "0")
    redis.call("SET", KEYS[index], math.max(0, current - amount), "EX", ARGV[1])
  end
  return 1
`;

function hashRequestId(reqId: string): string {
  const digest = createHash("sha256").update(reqId).digest("hex").slice(0, 24);
  return `req_${digest}`;
}

export class MessengerDailyImageBudgetExceededError extends Error {
  constructor(message = "Messenger daily image budget reached") {
    super(message);
    this.name = "MessengerDailyImageBudgetExceededError";
  }
}

export class MessengerDailyVideoBudgetExceededError extends Error {
  constructor(message = "Messenger daily video budget reached") {
    super(message);
    this.name = "MessengerDailyVideoBudgetExceededError";
  }
}

export class MessengerDailyAudioTranscriptionBudgetExceededError extends Error {
  constructor(message = "Messenger daily audio transcription budget reached") {
    super(message);
    this.name = "MessengerDailyAudioTranscriptionBudgetExceededError";
  }
}

export class MessengerSpendBudgetExceededError extends Error {
  constructor(message = "Messenger spend budget reached") {
    super(message);
    this.name = "MessengerSpendBudgetExceededError";
  }
}

function readNonNegativeInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
}

function readPositiveInt(name: string): number | null {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
}

function readPositiveUsd(name: string): number | null {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

function areOwnerCostAlertsEnabled(): boolean {
  return process.env.MESSENGER_OWNER_COST_ALERTS === "1";
}

function getUtcDayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function getUtcMonthKey(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

function getUtcMonthDayPeriods(now = new Date()): string[] {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const dayCount = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Array.from({ length: dayCount }, (_, index) =>
    new Date(Date.UTC(year, month, index + 1)).toISOString().slice(0, 10)
  );
}

function secondsUntilNextUtcDay(now = new Date()): number {
  const nextDay = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1
  );
  return Math.max(1, Math.ceil((nextDay - now.getTime()) / 1000));
}

async function notifyOwnerCostAlert(input: {
  scope: "global_daily" | "global_monthly" | "user_daily";
  reason: "cap_reached" | "unpriced_attempt_blocked";
  period: string;
  capUsd: number;
  currentSpendUsd?: number;
  attemptEstimateUsd?: number;
  projectedSpendUsd?: number;
  user?: string;
}): Promise<void> {
  if (!areOwnerCostAlertsEnabled()) {
    return;
  }

  const lines = [
    `scope=${input.scope}`,
    `reason=${input.reason}`,
    `period=${input.period}`,
    `capUsd=${input.capUsd}`,
  ];
  if (typeof input.currentSpendUsd === "number") {
    lines.push(`currentSpendUsd=${input.currentSpendUsd}`);
  }
  if (typeof input.attemptEstimateUsd === "number") {
    lines.push(`attemptEstimateUsd=${input.attemptEstimateUsd}`);
  }
  if (typeof input.projectedSpendUsd === "number") {
    lines.push(`projectedSpendUsd=${input.projectedSpendUsd}`);
  }
  if (input.user) {
    lines.push(`user=${input.user}`);
  }

  try {
    const sent = await notifyOwner({
      title: "Messenger cost alert",
      content: lines.join("\n"),
    });
    if (!sent) {
      safeLog("messenger_owner_cost_alert_not_sent", {
        level: "warn",
        scope: input.scope,
        reason: input.reason,
        period: input.period,
      });
    }
  } catch (error) {
    safeLog("messenger_owner_cost_alert_failed", {
      level: "warn",
      scope: input.scope,
      reason: input.reason,
      period: input.period,
      error,
    });
  }
}

class ConcurrencyLimiter {
  private active = 0;

  private readonly pending: Array<() => void> = [];

  constructor(private readonly maxConcurrency: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrency) {
      await new Promise<void>(resolve => this.pending.push(resolve));
    }

    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      const next = this.pending.shift();
      next?.();
    }
  }
}

const globalLimiter = new ConcurrencyLimiter(
  Math.max(
    1,
    readNonNegativeInt("MESSENGER_MAX_IMAGE_JOBS", DEFAULT_GLOBAL_CONCURRENCY)
  )
);
const inMemorySpendAdmissionLimiter = new ConcurrencyLimiter(1);

type MessengerGenerationGlobalLimitStats = {
  redisBacked: boolean;
  max: number;
  active: number;
};

type MessengerGenerationGlobalLimitConfig = {
  redisBacked: boolean;
  max: number;
  lockTtlMs: number;
};

type MessengerDailyImageBudgetConfig = {
  enabled: boolean;
  cap: number | null;
};

type MessengerDailySpendBudgetConfig = {
  enabled: boolean;
  capUsd: number | null;
};

type MessengerMonthlySpendBudgetConfig = {
  enabled: boolean;
  capUsd: number | null;
};

type MessengerUserDailySpendBudgetConfig = {
  enabled: boolean;
  capUsd: number | null;
};

function getGlobalMaxConcurrency(): number {
  return Math.max(
    1,
    readNonNegativeInt("MESSENGER_MAX_IMAGE_JOBS", DEFAULT_GLOBAL_CONCURRENCY)
  );
}

function getGlobalLockMs(): number {
  return readNonNegativeInt(
    "MESSENGER_GLOBAL_IMAGE_LOCK_TTL_MS",
    DEFAULT_GLOBAL_LOCK_MS
  );
}

function lockKey(psid: string): string {
  return `messenger:inflight:${psid}`;
}

function videoLockKey(psid: string): string {
  return `messenger:video-inflight:${psid}`;
}

function cooldownKey(psid: string): string {
  return `messenger:cooldown:${psid}`;
}

function globalSlotKey(index: number): string {
  return `messenger:global-inflight:${index}`;
}

function toSeconds(milliseconds: number): number {
  return Math.max(1, Math.ceil(milliseconds / 1000));
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

async function acquireGlobalGenerationSlot(
  token: string,
  maxConcurrency: number,
  ttlSeconds: number
): Promise<string> {
  while (true) {
    for (let index = 0; index < maxConcurrency; index += 1) {
      const key = globalSlotKey(index);
      if (await setEphemeralKeyIfAbsent(key, token, ttlSeconds)) {
        return key;
      }
    }

    await wait(DEFAULT_GLOBAL_SLOT_WAIT_MS);
  }
}

async function runWithGlobalGenerationLimit<T>(
  task: () => Promise<T>
): Promise<T> {
  const maxConcurrency = getGlobalMaxConcurrency();
  const lockMs = getGlobalLockMs();
  const ttlSeconds = toSeconds(lockMs);

  return globalLimiter.run(async () => {
    if (!isRedisStateStoreEnabled()) {
      return task();
    }

    const token = randomUUID();
    const slotKey = await acquireGlobalGenerationSlot(
      token,
      maxConcurrency,
      ttlSeconds
    );
    try {
      return await task();
    } finally {
      await deleteEphemeralKeyIfValue(slotKey, token);
    }
  });
}

export async function getMessengerGenerationGlobalLimitStats(): Promise<MessengerGenerationGlobalLimitStats> {
  const maxConcurrency = getGlobalMaxConcurrency();
  if (!isRedisStateStoreEnabled()) {
    return {
      redisBacked: false,
      max: maxConcurrency,
      active: 0,
    };
  }

  let active = 0;
  for (let index = 0; index < maxConcurrency; index += 1) {
    if (await hasEphemeralKey(globalSlotKey(index))) {
      active += 1;
    }
  }

  return {
    redisBacked: true,
    max: maxConcurrency,
    active,
  };
}

export function getMessengerGenerationGlobalLimitConfig(): MessengerGenerationGlobalLimitConfig {
  return {
    redisBacked: isRedisStateStoreEnabled(),
    max: getGlobalMaxConcurrency(),
    lockTtlMs: getGlobalLockMs(),
  };
}

export function getMessengerDailyImageBudgetConfig(): MessengerDailyImageBudgetConfig {
  const cap = readPositiveInt("MESSENGER_GLOBAL_DAILY_IMAGE_CAP");
  return {
    enabled: cap !== null,
    cap,
  };
}

export function getMessengerDailySpendBudgetConfig(): MessengerDailySpendBudgetConfig {
  const capUsd = readPositiveUsd("MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD");
  return {
    enabled: capUsd !== null,
    capUsd,
  };
}

export function getMessengerMonthlySpendBudgetConfig(): MessengerMonthlySpendBudgetConfig {
  const capUsd = readPositiveUsd("MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD");
  return {
    enabled: capUsd !== null,
    capUsd,
  };
}

export function getMessengerUserDailySpendBudgetConfig(): MessengerUserDailySpendBudgetConfig {
  const capUsd = readPositiveUsd("MESSENGER_USER_DAILY_SPEND_CAP_USD");
  return {
    enabled: capUsd !== null,
    capUsd,
  };
}

export function getMessengerOwnerEmergencySpendBudgetConfig(): {
  dailyCapUsd: number;
  monthlyCapUsd: number;
} {
  return {
    dailyCapUsd:
      readPositiveUsd("MESSENGER_OWNER_EMERGENCY_DAILY_SPEND_CAP_USD") ??
      DEFAULT_OWNER_EMERGENCY_DAILY_SPEND_CAP_USD,
    monthlyCapUsd:
      readPositiveUsd("MESSENGER_OWNER_EMERGENCY_MONTHLY_SPEND_CAP_USD") ??
      DEFAULT_OWNER_EMERGENCY_MONTHLY_SPEND_CAP_USD,
  };
}

async function assertMessengerOwnerEmergencySpendBudgetAvailable(input: {
  reqId: string;
  estimatedCostUsd: number | null;
  estimatedOutputCostUsd?: number | null;
  costEstimateComplete?: boolean;
  now: Date;
}): Promise<void> {
  const estimate =
    (input.estimatedCostUsd ?? 0) + (input.estimatedOutputCostUsd ?? 0);
  if (
    input.costEstimateComplete === false ||
    !Number.isFinite(estimate) ||
    estimate <= 0
  ) {
    throw new MessengerSpendBudgetExceededError(
      "Owner emergency spend stop requires completely priced provider attempts"
    );
  }
  const day = getUtcDayKey(input.now);
  const month = getUtcMonthKey(input.now);
  const config = getMessengerOwnerEmergencySpendBudgetConfig();
  const [dailySummary, monthlySummary] = await Promise.all([
    summarizeOwnerBypassCostLedgerPeriod(day),
    summarizeOwnerBypassCostLedgerPeriods(
      getUtcMonthDayPeriods(input.now),
      month
    ),
  ]);
  if (
    dailySummary.estimatedCostUsd + estimate > config.dailyCapUsd ||
    monthlySummary.estimatedCostUsd + estimate > config.monthlyCapUsd
  ) {
    safeLog("messenger_owner_emergency_spend_stop_reached", {
      level: "warn",
      reqId: hashRequestId(input.reqId),
    });
    throw new MessengerSpendBudgetExceededError(
      "Messenger owner emergency spend stop reached"
    );
  }
}

/**
 * Serializes the spend-cap decision with the durable attempt-ledger write.
 * Provider code must not start the external request until `recordAttempt`
 * completes. Production uses the shared Redis state store, so concurrent app
 * and worker processes cannot all pass the same remaining budget.
 */
export async function admitMessengerProviderSpend<T>(input: {
  reqId: string;
  attemptId: string;
  userKey: string;
  estimatedCostUsd: number | null;
  estimatedOutputCostUsd?: number | null;
  costEstimateComplete?: boolean;
  now?: Date;
  budgetClass?: "customer" | "owner_emergency";
  recordAttempt: () => Promise<T>;
}): Promise<T> {
  const ownerEmergency = input.budgetClass === "owner_emergency";
  const dailyEnabled = getMessengerDailySpendBudgetConfig().enabled;
  const monthlyEnabled = getMessengerMonthlySpendBudgetConfig().enabled;
  const userDailyEnabled = getMessengerUserDailySpendBudgetConfig().enabled;
  if (
    !ownerEmergency &&
    !dailyEnabled &&
    !monthlyEnabled &&
    !userDailyEnabled
  ) {
    return await input.recordAttempt();
  }

  const now = input.now ?? new Date();
  if (!isRedisStateStoreEnabled()) {
    if (process.env.NODE_ENV === "production") {
      safeLog("messenger_spend_admission_redis_required", {
        level: "error",
        reqId: hashRequestId(input.reqId),
      });
      throw new MessengerSpendBudgetExceededError(
        "Redis is required for production spend-cap admission"
      );
    }
    return await inMemorySpendAdmissionLimiter.run(async () => {
      if (ownerEmergency) {
        await assertMessengerOwnerEmergencySpendBudgetAvailable({
          ...input,
          now,
        });
        return await input.recordAttempt();
      }
      await assertMessengerDailySpendBudgetAvailable({ ...input, now });
      await assertMessengerMonthlySpendBudgetAvailable({ ...input, now });
      await assertMessengerUserDailySpendBudgetAvailable({ ...input, now });
      return await input.recordAttempt();
    });
  }

  const estimate =
    (input.estimatedCostUsd ?? 0) + (input.estimatedOutputCostUsd ?? 0);
  if (
    input.costEstimateComplete === false ||
    !Number.isFinite(estimate) ||
    estimate <= 0
  ) {
    await assertMessengerDailySpendBudgetAvailable({ ...input, now });
    await assertMessengerMonthlySpendBudgetAvailable({ ...input, now });
    await assertMessengerUserDailySpendBudgetAvailable({ ...input, now });
    throw new MessengerSpendBudgetExceededError();
  }

  const day = getUtcDayKey(now);
  const month = getUtcMonthKey(now);
  const [dailySummary, monthlySummary, userSummary] = ownerEmergency
    ? await Promise.all([
        summarizeOwnerBypassCostLedgerPeriod(day),
        summarizeOwnerBypassCostLedgerPeriods(
          getUtcMonthDayPeriods(now),
          month
        ),
        Promise.resolve({ estimatedCostUsd: 0 }),
      ])
    : await Promise.all([
        summarizeBudgetedCostLedgerPeriod(day),
        summarizeBudgetedCostLedgerPeriods(getUtcMonthDayPeriods(now), month),
        summarizeCostLedgerPeriodForUser(day, input.userKey),
      ]);
  const ownerConfig = getMessengerOwnerEmergencySpendBudgetConfig();
  const dailyCapUsd = ownerEmergency
    ? ownerConfig.dailyCapUsd
    : (getMessengerDailySpendBudgetConfig().capUsd ?? 0);
  const monthlyCapUsd = ownerEmergency
    ? ownerConfig.monthlyCapUsd
    : (getMessengerMonthlySpendBudgetConfig().capUsd ?? 0);
  const userDailyCapUsd = ownerEmergency
    ? 0
    : (getMessengerUserDailySpendBudgetConfig().capUsd ?? 0);
  const tag = ownerEmergency
    ? `{messenger-owner-emergency-spend:${month}}`
    : `{messenger-spend:${month}}`;
  const attemptKey = createHash("sha256")
    .update(input.attemptId)
    .digest("hex")
    .slice(0, 32);
  const userKey = createHash("sha256")
    .update(input.userKey)
    .digest("hex")
    .slice(0, 32);
  const keys = [
    `${tag}:attempt:${attemptKey}`,
    `${tag}:daily:${day}`,
    `${tag}:monthly`,
    `${tag}:user:${userKey}:${day}`,
  ];
  const ttlSeconds = secondsUntilSpendCounterExpiry(now);
  const redis = await getRedisClient();
  const result = Number(
    await redis.eval(
      RESERVE_SPEND_SCRIPT,
      keys.length,
      ...keys,
      usdToSpendUnits(estimate),
      usdToSpendUnits(dailyCapUsd),
      usdToSpendUnits(monthlyCapUsd),
      usdToSpendUnits(userDailyCapUsd),
      usdToSpendUnits(dailySummary.estimatedCostUsd),
      usdToSpendUnits(monthlySummary.estimatedCostUsd),
      usdToSpendUnits(userSummary.estimatedCostUsd),
      ttlSeconds
    )
  );
  if (result !== 1) {
    safeLog("messenger_spend_admission_rejected", {
      level: "warn",
      reqId: hashRequestId(input.reqId),
      budgetClass: input.budgetClass ?? "customer",
      reason:
        result === 2
          ? "duplicate_attempt"
          : result === -1
            ? "daily_cap"
            : result === -2
              ? "monthly_cap"
              : result === -3
                ? "user_daily_cap"
                : "store_result_invalid",
    });
    throw new MessengerSpendBudgetExceededError();
  }

  try {
    return await input.recordAttempt();
  } catch (error) {
    try {
      const released = Number(
        await redis.eval(RELEASE_SPEND_SCRIPT, keys.length, ...keys, ttlSeconds)
      );
      if (released !== 1) {
        safeLog("messenger_spend_reservation_release_incomplete", {
          level: "error",
          reqId: hashRequestId(input.reqId),
        });
      }
    } catch (releaseError) {
      safeLog("messenger_spend_reservation_release_failed", {
        level: "error",
        reqId: hashRequestId(input.reqId),
        error: releaseError,
      });
    }
    throw error;
  }
}

function usdToSpendUnits(value: number): number {
  return Math.max(0, Math.round(value * SPEND_COUNTER_SCALE));
}

function secondsUntilSpendCounterExpiry(now: Date): number {
  const expiry = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 3);
  return Math.max(1, Math.ceil((expiry - now.getTime()) / 1000));
}

export async function assertMessengerDailySpendBudgetAvailable(input: {
  reqId: string;
  estimatedCostUsd: number | null;
  estimatedOutputCostUsd?: number | null;
  /** Explicit false fails closed; omitted preserves complete-or-unpriced callers. */
  costEstimateComplete?: boolean;
  now?: Date;
}): Promise<void> {
  const { capUsd } = getMessengerDailySpendBudgetConfig();
  if (!capUsd) {
    return;
  }

  const attemptEstimate =
    (input.estimatedCostUsd ?? 0) + (input.estimatedOutputCostUsd ?? 0);
  const period = getUtcDayKey(input.now ?? new Date());
  if (
    input.costEstimateComplete === false ||
    !Number.isFinite(attemptEstimate) ||
    attemptEstimate <= 0
  ) {
    safeLog("messenger_daily_spend_budget_unpriced_attempt_blocked", {
      level: "warn",
      reqId: hashRequestId(input.reqId),
      capUsd,
    });
    await notifyOwnerCostAlert({
      scope: "global_daily",
      reason: "unpriced_attempt_blocked",
      period,
      capUsd,
    });
    throw new MessengerSpendBudgetExceededError(
      "Messenger daily spend budget requires completely priced provider attempts"
    );
  }

  const summary = await summarizeBudgetedCostLedgerPeriod(period);
  const projectedSpendUsd = summary.estimatedCostUsd + attemptEstimate;
  if (projectedSpendUsd > capUsd) {
    safeLog("messenger_daily_spend_budget_reached", {
      level: "warn",
      reqId: hashRequestId(input.reqId),
      capUsd,
      currentSpendUsd: summary.estimatedCostUsd,
      attemptEstimateUsd: attemptEstimate,
      projectedSpendUsd,
    });
    await notifyOwnerCostAlert({
      scope: "global_daily",
      reason: "cap_reached",
      period,
      capUsd,
      currentSpendUsd: summary.estimatedCostUsd,
      attemptEstimateUsd: attemptEstimate,
      projectedSpendUsd,
    });
    throw new MessengerSpendBudgetExceededError();
  }
}

export async function assertMessengerMonthlySpendBudgetAvailable(input: {
  reqId: string;
  estimatedCostUsd: number | null;
  estimatedOutputCostUsd?: number | null;
  /** Explicit false fails closed; omitted preserves complete-or-unpriced callers. */
  costEstimateComplete?: boolean;
  now?: Date;
}): Promise<void> {
  const { capUsd } = getMessengerMonthlySpendBudgetConfig();
  if (!capUsd) {
    return;
  }

  const attemptEstimate =
    (input.estimatedCostUsd ?? 0) + (input.estimatedOutputCostUsd ?? 0);
  const now = input.now ?? new Date();
  const monthPeriod = getUtcMonthKey(now);
  if (
    input.costEstimateComplete === false ||
    !Number.isFinite(attemptEstimate) ||
    attemptEstimate <= 0
  ) {
    safeLog("messenger_monthly_spend_budget_unpriced_attempt_blocked", {
      level: "warn",
      reqId: hashRequestId(input.reqId),
      capUsd,
    });
    await notifyOwnerCostAlert({
      scope: "global_monthly",
      reason: "unpriced_attempt_blocked",
      period: monthPeriod,
      capUsd,
    });
    throw new MessengerSpendBudgetExceededError(
      "Messenger monthly spend budget requires completely priced provider attempts"
    );
  }

  const summary = await summarizeBudgetedCostLedgerPeriods(
    getUtcMonthDayPeriods(now),
    monthPeriod
  );
  const projectedSpendUsd = summary.estimatedCostUsd + attemptEstimate;
  if (projectedSpendUsd > capUsd) {
    safeLog("messenger_monthly_spend_budget_reached", {
      level: "warn",
      reqId: hashRequestId(input.reqId),
      capUsd,
      currentSpendUsd: summary.estimatedCostUsd,
      attemptEstimateUsd: attemptEstimate,
      projectedSpendUsd,
    });
    await notifyOwnerCostAlert({
      scope: "global_monthly",
      reason: "cap_reached",
      period: monthPeriod,
      capUsd,
      currentSpendUsd: summary.estimatedCostUsd,
      attemptEstimateUsd: attemptEstimate,
      projectedSpendUsd,
    });
    throw new MessengerSpendBudgetExceededError();
  }
}

export async function assertMessengerUserDailySpendBudgetAvailable(input: {
  reqId: string;
  userKey: string;
  estimatedCostUsd: number | null;
  estimatedOutputCostUsd?: number | null;
  /** Explicit false fails closed; omitted preserves complete-or-unpriced callers. */
  costEstimateComplete?: boolean;
  now?: Date;
}): Promise<void> {
  const { capUsd } = getMessengerUserDailySpendBudgetConfig();
  if (!capUsd) {
    return;
  }

  const attemptEstimate =
    (input.estimatedCostUsd ?? 0) + (input.estimatedOutputCostUsd ?? 0);
  const period = getUtcDayKey(input.now ?? new Date());
  const logUser = toLogUser(input.userKey);
  if (
    input.costEstimateComplete === false ||
    !Number.isFinite(attemptEstimate) ||
    attemptEstimate <= 0
  ) {
    safeLog("messenger_user_daily_spend_budget_unpriced_attempt_blocked", {
      level: "warn",
      reqId: hashRequestId(input.reqId),
      user: logUser,
      capUsd,
    });
    await notifyOwnerCostAlert({
      scope: "user_daily",
      reason: "unpriced_attempt_blocked",
      period,
      capUsd,
      user: logUser,
    });
    throw new MessengerSpendBudgetExceededError(
      "Messenger user daily spend budget requires completely priced provider attempts"
    );
  }

  const summary = await summarizeCostLedgerPeriodForUser(period, input.userKey);
  const projectedSpendUsd = summary.estimatedCostUsd + attemptEstimate;
  if (projectedSpendUsd > capUsd) {
    safeLog("messenger_user_daily_spend_budget_reached", {
      level: "warn",
      reqId: hashRequestId(input.reqId),
      user: logUser,
      capUsd,
      currentSpendUsd: summary.estimatedCostUsd,
      attemptEstimateUsd: attemptEstimate,
      projectedSpendUsd,
    });
    await notifyOwnerCostAlert({
      scope: "user_daily",
      reason: "cap_reached",
      period,
      capUsd,
      currentSpendUsd: summary.estimatedCostUsd,
      attemptEstimateUsd: attemptEstimate,
      projectedSpendUsd,
      user: logUser,
    });
    throw new MessengerSpendBudgetExceededError();
  }
}

export async function assertMessengerDailyImageBudgetAvailable(input: {
  reqId: string;
  now?: Date;
}): Promise<void> {
  const { cap } = getMessengerDailyImageBudgetConfig();
  if (!cap) {
    return;
  }

  const now = input.now ?? new Date();
  const key = `${DAILY_BUDGET_KEY_PREFIX}:${getUtcDayKey(now)}`;
  const count = await incrementExpiringCounter(
    key,
    secondsUntilNextUtcDay(now)
  );
  if (count > cap) {
    await decrementExpiringCounter(key);
    safeLog("messenger_daily_image_budget_reached", {
      level: "warn",
      reqId: hashRequestId(input.reqId),
      cap,
      count,
    });
    throw new MessengerDailyImageBudgetExceededError();
  }
}

export async function releaseMessengerDailyImageBudgetReservation(
  input: {
    now?: Date;
  } = {}
): Promise<void> {
  const { cap } = getMessengerDailyImageBudgetConfig();
  if (!cap) {
    return;
  }

  const now = input.now ?? new Date();
  const key = `${DAILY_BUDGET_KEY_PREFIX}:${getUtcDayKey(now)}`;
  await decrementExpiringCounter(key);
}

export async function assertMessengerDailyVideoBudgetAvailable(input: {
  reqId: string;
  now?: Date;
}): Promise<void> {
  const cap = readPositiveInt("MESSENGER_GLOBAL_DAILY_VIDEO_CAP");
  if (!cap) {
    return;
  }

  const now = input.now ?? new Date();
  const key = `${DAILY_VIDEO_BUDGET_KEY_PREFIX}:${getUtcDayKey(now)}`;
  const count = await incrementExpiringCounter(
    key,
    secondsUntilNextUtcDay(now)
  );
  if (count > cap) {
    await decrementExpiringCounter(key);
    safeLog("messenger_daily_video_budget_reached", {
      level: "warn",
      reqId: hashRequestId(input.reqId),
      cap,
      count,
    });
    throw new MessengerDailyVideoBudgetExceededError();
  }
}

export async function releaseMessengerDailyVideoBudgetReservation(
  input: {
    now?: Date;
  } = {}
): Promise<void> {
  const cap = readPositiveInt("MESSENGER_GLOBAL_DAILY_VIDEO_CAP");
  if (!cap) {
    return;
  }

  const now = input.now ?? new Date();
  const key = `${DAILY_VIDEO_BUDGET_KEY_PREFIX}:${getUtcDayKey(now)}`;
  await decrementExpiringCounter(key);
}

export async function assertMessengerDailyAudioTranscriptionBudgetAvailable(input: {
  reqId: string;
  now?: Date;
}): Promise<void> {
  const cap = readPositiveInt(
    "MESSENGER_GATEWAY_DAILY_AUDIO_TRANSCRIPTION_CAP"
  );
  if (!cap) {
    return;
  }

  const now = input.now ?? new Date();
  const key = `${DAILY_AUDIO_TRANSCRIPTION_BUDGET_KEY_PREFIX}:${getUtcDayKey(now)}`;
  const count = await incrementExpiringCounter(
    key,
    secondsUntilNextUtcDay(now)
  );
  if (count > cap) {
    await decrementExpiringCounter(key);
    safeLog("messenger_daily_audio_transcription_budget_reached", {
      level: "warn",
      reqId: hashRequestId(input.reqId),
      cap,
      count,
    });
    throw new MessengerDailyAudioTranscriptionBudgetExceededError();
  }
}

export async function releaseMessengerDailyAudioTranscriptionBudgetReservation(
  input: {
    now?: Date;
  } = {}
): Promise<void> {
  const cap = readPositiveInt(
    "MESSENGER_GATEWAY_DAILY_AUDIO_TRANSCRIPTION_CAP"
  );
  if (!cap) {
    return;
  }

  const now = input.now ?? new Date();
  const key = `${DAILY_AUDIO_TRANSCRIPTION_BUDGET_KEY_PREFIX}:${getUtcDayKey(now)}`;
  await decrementExpiringCounter(key);
}

export async function runGuardedGeneration<T>(
  psid: string,
  task: () => Promise<T>
): Promise<T | null> {
  const cooldownMs = readNonNegativeInt(
    "MESSENGER_PSID_COOLDOWN_MS",
    DEFAULT_PSID_COOLDOWN_MS
  );
  const lockMs = readNonNegativeInt(
    "MESSENGER_PSID_LOCK_TTL_MS",
    DEFAULT_PSID_LOCK_MS
  );

  if (cooldownMs > 0 && (await hasEphemeralKey(cooldownKey(psid)))) {
    return null;
  }

  const lockToken = randomUUID();
  const acquired = await setEphemeralKeyIfAbsent(
    lockKey(psid),
    lockToken,
    toSeconds(lockMs)
  );
  if (!acquired) {
    return null;
  }

  try {
    return await runWithGlobalGenerationLimit(task);
  } finally {
    await deleteEphemeralKeyIfValue(lockKey(psid), lockToken);
    if (cooldownMs > 0) {
      await setEphemeralKey(cooldownKey(psid), "1", toSeconds(cooldownMs));
    }
  }
}

export async function runGuardedVideoGeneration<T>(
  psid: string,
  task: () => Promise<T>
): Promise<T | null> {
  const lockMs = readNonNegativeInt(
    "MESSENGER_VIDEO_PSID_LOCK_TTL_MS",
    DEFAULT_VIDEO_PSID_LOCK_MS
  );

  const lockToken = randomUUID();
  const acquired = await setEphemeralKeyIfAbsent(
    videoLockKey(psid),
    lockToken,
    toSeconds(lockMs)
  );
  if (!acquired) {
    return null;
  }

  try {
    return await runWithGlobalGenerationLimit(task);
  } finally {
    await deleteEphemeralKeyIfValue(videoLockKey(psid), lockToken);
  }
}

export async function hasInFlightGeneration(psid: string): Promise<boolean> {
  return (
    (await hasEphemeralKey(lockKey(psid))) ||
    (await hasEphemeralKey(videoLockKey(psid)))
  );
}
