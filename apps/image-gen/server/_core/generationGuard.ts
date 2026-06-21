import { randomUUID } from "node:crypto";
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
  summarizeCostLedgerPeriod,
  summarizeCostLedgerPeriods,
  summarizeCostLedgerPeriodForUser,
} from "./costLedger";
import { safeLog } from "./logger";
import { toLogUser } from "./privacy";

const DEFAULT_GLOBAL_CONCURRENCY = 3;
const DEFAULT_GLOBAL_LOCK_MS = 240000;
const DEFAULT_PSID_COOLDOWN_MS = 0;
const DEFAULT_PSID_LOCK_MS = 240000;
const DEFAULT_VIDEO_PSID_LOCK_MS = 900000;
const DEFAULT_GLOBAL_SLOT_WAIT_MS = 100;
const DAILY_BUDGET_KEY_PREFIX = "messenger:daily-image-budget";
const DAILY_VIDEO_BUDGET_KEY_PREFIX = "messenger:daily-video-budget";

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

export class MessengerDailySpendBudgetExceededError extends Error {
  constructor(message = "Messenger daily spend budget reached") {
    super(message);
    this.name = "MessengerDailySpendBudgetExceededError";
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

export async function assertMessengerDailySpendBudgetAvailable(input: {
  reqId: string;
  estimatedCostUsd: number | null;
  estimatedOutputCostUsd?: number | null;
  now?: Date;
}): Promise<void> {
  const { capUsd } = getMessengerDailySpendBudgetConfig();
  if (!capUsd) {
    return;
  }

  const attemptEstimate =
    (input.estimatedCostUsd ?? 0) + (input.estimatedOutputCostUsd ?? 0);
  if (!Number.isFinite(attemptEstimate) || attemptEstimate <= 0) {
    safeLog("messenger_daily_spend_budget_unpriced_attempt_blocked", {
      level: "warn",
      reqId: input.reqId,
      capUsd,
    });
    throw new MessengerDailySpendBudgetExceededError(
      "Messenger daily spend budget requires priced provider attempts"
    );
  }

  const period = getUtcDayKey(input.now ?? new Date());
  const summary = await summarizeCostLedgerPeriod(period);
  const projectedSpendUsd = summary.estimatedCostUsd + attemptEstimate;
  if (projectedSpendUsd > capUsd) {
    safeLog("messenger_daily_spend_budget_reached", {
      level: "warn",
      reqId: input.reqId,
      capUsd,
      currentSpendUsd: summary.estimatedCostUsd,
      attemptEstimateUsd: attemptEstimate,
      projectedSpendUsd,
    });
    throw new MessengerDailySpendBudgetExceededError();
  }
}

export async function assertMessengerMonthlySpendBudgetAvailable(input: {
  reqId: string;
  estimatedCostUsd: number | null;
  estimatedOutputCostUsd?: number | null;
  now?: Date;
}): Promise<void> {
  const { capUsd } = getMessengerMonthlySpendBudgetConfig();
  if (!capUsd) {
    return;
  }

  const attemptEstimate =
    (input.estimatedCostUsd ?? 0) + (input.estimatedOutputCostUsd ?? 0);
  if (!Number.isFinite(attemptEstimate) || attemptEstimate <= 0) {
    safeLog("messenger_monthly_spend_budget_unpriced_attempt_blocked", {
      level: "warn",
      reqId: input.reqId,
      capUsd,
    });
    throw new MessengerDailySpendBudgetExceededError(
      "Messenger monthly spend budget requires priced provider attempts"
    );
  }

  const now = input.now ?? new Date();
  const summary = await summarizeCostLedgerPeriods(
    getUtcMonthDayPeriods(now),
    getUtcMonthKey(now)
  );
  const projectedSpendUsd = summary.estimatedCostUsd + attemptEstimate;
  if (projectedSpendUsd > capUsd) {
    safeLog("messenger_monthly_spend_budget_reached", {
      level: "warn",
      reqId: input.reqId,
      capUsd,
      currentSpendUsd: summary.estimatedCostUsd,
      attemptEstimateUsd: attemptEstimate,
      projectedSpendUsd,
    });
    throw new MessengerDailySpendBudgetExceededError();
  }
}

export async function assertMessengerUserDailySpendBudgetAvailable(input: {
  reqId: string;
  userKey: string;
  estimatedCostUsd: number | null;
  estimatedOutputCostUsd?: number | null;
  now?: Date;
}): Promise<void> {
  const { capUsd } = getMessengerUserDailySpendBudgetConfig();
  if (!capUsd) {
    return;
  }

  const attemptEstimate =
    (input.estimatedCostUsd ?? 0) + (input.estimatedOutputCostUsd ?? 0);
  if (!Number.isFinite(attemptEstimate) || attemptEstimate <= 0) {
    safeLog("messenger_user_daily_spend_budget_unpriced_attempt_blocked", {
      level: "warn",
      reqId: input.reqId,
      user: toLogUser(input.userKey),
      capUsd,
    });
    throw new MessengerDailySpendBudgetExceededError(
      "Messenger user daily spend budget requires priced provider attempts"
    );
  }

  const period = getUtcDayKey(input.now ?? new Date());
  const summary = await summarizeCostLedgerPeriodForUser(period, input.userKey);
  const projectedSpendUsd = summary.estimatedCostUsd + attemptEstimate;
  if (projectedSpendUsd > capUsd) {
    safeLog("messenger_user_daily_spend_budget_reached", {
      level: "warn",
      reqId: input.reqId,
      user: toLogUser(input.userKey),
      capUsd,
      currentSpendUsd: summary.estimatedCostUsd,
      attemptEstimateUsd: attemptEstimate,
      projectedSpendUsd,
    });
    throw new MessengerDailySpendBudgetExceededError();
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
  const count = await incrementExpiringCounter(key, secondsUntilNextUtcDay(now));
  if (count > cap) {
    await decrementExpiringCounter(key);
    safeLog("messenger_daily_image_budget_reached", {
      level: "warn",
      reqId: input.reqId,
      cap,
      count,
    });
    throw new MessengerDailyImageBudgetExceededError();
  }
}

export async function releaseMessengerDailyImageBudgetReservation(input: {
  now?: Date;
} = {}): Promise<void> {
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
  const count = await incrementExpiringCounter(key, secondsUntilNextUtcDay(now));
  if (count > cap) {
    await decrementExpiringCounter(key);
    safeLog("messenger_daily_video_budget_reached", {
      level: "warn",
      reqId: input.reqId,
      cap,
      count,
    });
    throw new MessengerDailyVideoBudgetExceededError();
  }
}

export async function releaseMessengerDailyVideoBudgetReservation(input: {
  now?: Date;
} = {}): Promise<void> {
  const cap = readPositiveInt("MESSENGER_GLOBAL_DAILY_VIDEO_CAP");
  if (!cap) {
    return;
  }

  const now = input.now ?? new Date();
  const key = `${DAILY_VIDEO_BUDGET_KEY_PREFIX}:${getUtcDayKey(now)}`;
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
  return (await hasEphemeralKey(lockKey(psid))) || (await hasEphemeralKey(videoLockKey(psid)));
}
