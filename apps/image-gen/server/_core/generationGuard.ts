import { randomUUID } from "node:crypto";
import {
  deleteEphemeralKeyIfValue,
  hasEphemeralKey,
  isRedisStateStoreEnabled,
  setEphemeralKey,
  setEphemeralKeyIfAbsent,
} from "./stateStore";

const DEFAULT_GLOBAL_CONCURRENCY = 3;
const DEFAULT_GLOBAL_LOCK_MS = 120000;
const DEFAULT_PSID_COOLDOWN_MS = 0;
const DEFAULT_PSID_LOCK_MS = 120000;
const DEFAULT_GLOBAL_SLOT_WAIT_MS = 100;

function readNonNegativeInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
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

export type MessengerGenerationGlobalLimitStats = {
  redisBacked: boolean;
  max: number;
  active: number;
};

export type MessengerGenerationGlobalLimitConfig = {
  redisBacked: boolean;
  max: number;
  lockTtlMs: number;
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

export async function hasInFlightGeneration(psid: string): Promise<boolean> {
  return hasEphemeralKey(lockKey(psid));
}
