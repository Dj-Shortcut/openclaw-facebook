type RedisLike = {
  ping(): Promise<string>;
  get(key: string): Promise<string | null>;
  scan(
    cursor: string,
    ...args: Array<string | number>
  ): Promise<[string, string[]]>;
  set(
    key: string,
    value: string,
    ...args: Array<string | number>
  ): Promise<unknown>;
  del(key: string): Promise<number>;
  lpop(key: string): Promise<string | null>;
  rpush(key: string, value: string): Promise<number>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  ttl(key: string): Promise<number>;
};

type RedisModule = {
  default: new (url: string, ...args: unknown[]) => RedisLike;
};

let redisClientPromise: Promise<RedisLike> | null = null;

function getRedisUrl(): string | null {
  return process.env.REDIS_URL?.trim() || null;
}

export function isRedisEnabled(): boolean {
  return Boolean(getRedisUrl());
}

async function importRedisModule(): Promise<RedisModule> {
  return (await import("ioredis")) as unknown as RedisModule;
}

async function createRedisClient(): Promise<RedisLike> {
  const redisUrl = getRedisUrl();
  if (!redisUrl) {
    throw new Error("REDIS_URL is not configured");
  }

  const { default: Redis } = await importRedisModule();
  return new Redis(redisUrl);
}

export async function getRedisClient(): Promise<RedisLike> {
  if (!redisClientPromise) {
    redisClientPromise = createRedisClient();
  }

  return redisClientPromise;
}

export async function ensureRedisReady(): Promise<void> {
  if (!isRedisEnabled()) {
    return;
  }

  const redis = await getRedisClient();
  await redis.ping();
}

export function resetRedisClientForTests(): void {
  redisClientPromise = null;
}
