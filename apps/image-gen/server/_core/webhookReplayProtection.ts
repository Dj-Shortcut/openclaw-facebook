import { ensureRedisReady, getRedisClient, isRedisEnabled } from "./redis";

const DEFAULT_REPLAY_TTL_SECONDS = 300;
const DEFAULT_MAX_REPLAY_KEYS = 10000;
const REPLAY_KEY_PREFIX = "webhook-replay:";

const memoryReplayKeys = new Map<string, number>();

function getReplayTtlSeconds(): number {
  const raw = Number(process.env.WEBHOOK_REPLAY_TTL_SECONDS);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }

  return DEFAULT_REPLAY_TTL_SECONDS;
}

function pruneMemoryReplayKeys(now: number): void {
  memoryReplayKeys.forEach((expiresAt, key) => {
    if (expiresAt <= now) {
      memoryReplayKeys.delete(key);
    }
  });

  while (memoryReplayKeys.size > DEFAULT_MAX_REPLAY_KEYS) {
    const oldestKey = memoryReplayKeys.keys().next().value;
    if (!oldestKey) {
      break;
    }

    memoryReplayKeys.delete(oldestKey);
  }
}

function toRedisReplayKey(key: string): string {
  return `${REPLAY_KEY_PREFIX}${key}`;
}

export function isRedisReplayProtectionEnabled(): boolean {
  return isRedisEnabled();
}

export function assertProductionWebhookReplayProtectionConfig(): void {
  if (process.env.NODE_ENV !== "production") {
    return;
  }

  if (!isRedisReplayProtectionEnabled()) {
    throw new Error("REDIS_URL must be configured in production for webhook replay protection");
  }
}

export async function ensureWebhookReplayProtectionReady(): Promise<void> {
  await ensureRedisReady();
}

export async function claimWebhookReplayKey(key: string): Promise<boolean> {
  const ttlSeconds = getReplayTtlSeconds();

  if (!isRedisReplayProtectionEnabled()) {
    const now = Date.now();
    pruneMemoryReplayKeys(now);

    const expiresAt = memoryReplayKeys.get(key);
    if (expiresAt && expiresAt > now) {
      return false;
    }

    memoryReplayKeys.set(key, now + ttlSeconds * 1000);
    pruneMemoryReplayKeys(now);
    return true;
  }

  const redis = await getRedisClient();
  const result = await redis.set(toRedisReplayKey(key), "1", "EX", ttlSeconds, "NX");
  return result === "OK";
}

export function resetWebhookReplayProtection(): void {
  memoryReplayKeys.clear();
}

