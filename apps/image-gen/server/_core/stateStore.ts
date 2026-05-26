import { ensureRedisReady, getRedisClient, isRedisEnabled } from "./redis";
import { getFaceMemoryStateTtlSeconds } from "./faceMemoryRetention";

const STATE_TTL_SECONDS = 172800;

export type MaybePromise<T> = T | Promise<T>;

const memoryState = new Map<string, string>();
const memoryStateExpiresAt = new Map<string, number>();
const memoryEphemeral = new Map<string, number>();

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return typeof (value as Promise<T> | undefined)?.then === "function";
}

function getStateKey(psid: string): string {
  return getScopedStateKey("psid", psid);
}

function getScopedStateKey(scope: string, key: string): string {
  return `${scope}:${key}`;
}

export function isRedisStateStoreEnabled(): boolean {
  return isRedisEnabled();
}

export function assertProductionStateStoreConfig(): void {
  if (process.env.NODE_ENV !== "production") {
    return;
  }

  if (!isRedisStateStoreEnabled()) {
    throw new Error("REDIS_URL must be configured in production for state consistency");
  }
}

export async function ensureStateStoreReady(): Promise<void> {
  await ensureRedisReady();
}

function readRawState<T>(storageKey: string): MaybePromise<T | null> {
  if (!isRedisStateStoreEnabled()) {
    clearExpiredMemoryState();
    const payload = memoryState.get(storageKey);
    return payload ? (JSON.parse(payload) as T) : null;
  }

  return getRedisClient().then(async redis => {
    const payload = await redis.get(storageKey);
    return payload ? (JSON.parse(payload) as T) : null;
  });
}

function writeRawState<T>(
  storageKey: string,
  value: T,
  ttlSeconds = STATE_TTL_SECONDS
): MaybePromise<void> {
  const payload = JSON.stringify(value);

  if (!isRedisStateStoreEnabled()) {
    clearExpiredMemoryState();
    if (ttlSeconds <= 0) {
      memoryState.delete(storageKey);
      memoryStateExpiresAt.delete(storageKey);
      return;
    }
    memoryState.set(storageKey, payload);
    memoryStateExpiresAt.set(storageKey, Date.now() + ttlSeconds * 1000);
    return;
  }

  return getRedisClient().then(redis => {
    return redis
      .set(storageKey, payload, "EX", ttlSeconds)
      .then(() => undefined);
  });
}

function deleteRawState(storageKey: string): MaybePromise<void> {
  if (!isRedisStateStoreEnabled()) {
    memoryState.delete(storageKey);
    memoryStateExpiresAt.delete(storageKey);
    return;
  }

  return getRedisClient().then(redis => redis.del(storageKey).then(() => undefined));
}

export function readScopedState<T>(scope: string, key: string): MaybePromise<T | null> {
  return readRawState<T>(getScopedStateKey(scope, key));
}

export function writeScopedState<T>(
  scope: string,
  key: string,
  value: T,
  ttlSeconds = STATE_TTL_SECONDS
): MaybePromise<void> {
  return writeRawState(getScopedStateKey(scope, key), value, ttlSeconds);
}

export function deleteScopedState(scope: string, key: string): MaybePromise<void> {
  return deleteRawState(getScopedStateKey(scope, key));
}

export function readState<T>(psid: string): MaybePromise<T | null> {
  return readRawState<T>(getStateKey(psid));
}

export function deleteState(psid: string): MaybePromise<void> {
  return deleteRawState(getStateKey(psid));
}

export function writeState<T>(psid: string, value: T): MaybePromise<void> {
  const faceMemoryValue = value as {
    faceMemoryConsent?: { given?: boolean } | null;
    lastSourceImageUrl?: string | null;
    lastSourceImageUpdatedAt?: number | null;
    pendingSourceImageDeleteUrl?: string | null;
  } | null;
  const hasActiveFaceMemory =
    faceMemoryValue?.faceMemoryConsent?.given === true &&
    Boolean(
      faceMemoryValue.lastSourceImageUrl ||
        faceMemoryValue.lastSourceImageUpdatedAt
    );
  const hasPendingSourceDelete = Boolean(
    faceMemoryValue?.pendingSourceImageDeleteUrl
  );
  const ttlSeconds =
    hasActiveFaceMemory || hasPendingSourceDelete
      ? getFaceMemoryStateTtlSeconds()
      : STATE_TTL_SECONDS;
  return writeRawState(getStateKey(psid), value, ttlSeconds);
}

export function getOrCreateStoredState<T>(
  psid: string,
  createValue: () => T
): MaybePromise<T> {
  const current = readState<T>(psid);

  if (isPromiseLike(current)) {
    return current.then(existing => {
      if (existing) {
        return existing;
      }

      const created = createValue();
      return Promise.resolve(writeState(psid, created)).then(() => created);
    });
  }

  if (current) {
    return current;
  }

  const created = createValue();
  const saved = writeState(psid, created);

  if (isPromiseLike(saved)) {
    return saved.then(() => created);
  }

  return created;
}

export function updateStoredState<T>(
  psid: string,
  updater: (current: T | null) => T
): MaybePromise<T> {
  const current = readState<T>(psid);

  if (isPromiseLike(current)) {
    return current.then(existing => {
      const next = updater(existing);
      return Promise.resolve(writeState(psid, next)).then(() => next);
    });
  }

  const next = updater(current);
  const saved = writeState(psid, next);

  if (isPromiseLike(saved)) {
    return saved.then(() => next);
  }

  return next;
}

export function findInMemoryState<T>(
  predicate: (value: T) => boolean
): T | null {
  if (isRedisStateStoreEnabled()) {
    return null;
  }

  clearExpiredMemoryState();

  for (const payload of memoryState.values()) {
    const value = JSON.parse(payload) as T;
    if (predicate(value)) {
      return value;
    }
  }

  return null;
}

export async function forEachStoredState<T>(
  visitor: (psid: string, value: T) => Promise<void> | void
): Promise<void> {
  if (!isRedisStateStoreEnabled()) {
    clearExpiredMemoryState();
    for (const [storageKey, payload] of memoryState.entries()) {
      if (!storageKey.startsWith("psid:")) {
        continue;
      }
      await visitor(storageKey.slice("psid:".length), JSON.parse(payload) as T);
    }
    return;
  }

  const redis = await getRedisClient();
  let cursor = "0";
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      "MATCH",
      "psid:*",
      "COUNT",
      100
    );
    cursor = nextCursor;
    for (const storageKey of keys) {
      const payload = await redis.get(storageKey);
      if (!payload) {
        continue;
      }
      await visitor(storageKey.slice("psid:".length), JSON.parse(payload) as T);
    }
  } while (cursor !== "0");
}

export function clearStateStore(): void {
  memoryState.clear();
  memoryStateExpiresAt.clear();
  memoryEphemeral.clear();
}

function clearExpiredMemoryState(now = Date.now()): void {
  for (const [key, expiresAt] of memoryStateExpiresAt.entries()) {
    if (expiresAt <= now) {
      memoryStateExpiresAt.delete(key);
      memoryState.delete(key);
    }
  }
}

function clearExpiredMemoryEphemeral(now = Date.now()): void {
  for (const [key, expiresAt] of memoryEphemeral.entries()) {
    if (expiresAt <= now) {
      memoryEphemeral.delete(key);
    }
  }
}

export async function hasEphemeralKey(key: string): Promise<boolean> {
  if (!isRedisStateStoreEnabled()) {
    clearExpiredMemoryEphemeral();
    return memoryEphemeral.has(key);
  }

  const redis = await getRedisClient();
  return (await redis.get(key)) !== null;
}

export async function setEphemeralKey(
  key: string,
  value: string,
  ttlSeconds: number
): Promise<void> {
  if (!isRedisStateStoreEnabled()) {
    memoryEphemeral.set(key, Date.now() + ttlSeconds * 1000);
    return;
  }

  const redis = await getRedisClient();
  await redis.set(key, value, "EX", ttlSeconds);
}

export async function setEphemeralKeyIfAbsent(
  key: string,
  value: string,
  ttlSeconds: number
): Promise<boolean> {
  if (!isRedisStateStoreEnabled()) {
    clearExpiredMemoryEphemeral();
    if (memoryEphemeral.has(key)) {
      return false;
    }

    memoryEphemeral.set(key, Date.now() + ttlSeconds * 1000);
    return true;
  }

  const redis = await getRedisClient();
  const response = await redis.set(key, value, "EX", ttlSeconds, "NX");
  return response === "OK";
}

export async function deleteEphemeralKey(key: string): Promise<void> {
  if (!isRedisStateStoreEnabled()) {
    memoryEphemeral.delete(key);
    return;
  }

  const redis = await getRedisClient();
  await redis.del(key);
}

export { isPromiseLike };
