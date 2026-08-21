import { createHmac, randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import {
  MessengerSharedStateUnavailableError,
  validateMessengerStateIdentity,
  type MessengerBudgetKind,
  type MessengerDailyBudgetResult,
  type MessengerEphemeralStateStore,
  type MessengerStateScope,
} from "./messenger-state-store.js";

const CLAIM_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if not current then
  redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[2])
  return 1
end
if current == ARGV[1] then
  return 1
end
return 0
`;

const RESERVE_DAILY_SCRIPT = `
local prior = redis.call("GET", KEYS[2])
if prior then
  return prior
end
local count = tonumber(redis.call("GET", KEYS[1]) or "0")
if count >= tonumber(ARGV[1]) then
  return "exhausted:" .. count
end
count = redis.call("INCR", KEYS[1])
redis.call("PEXPIREAT", KEYS[1], ARGV[2])
local result = "allowed:" .. count
redis.call("SET", KEYS[2], result, "PXAT", ARGV[2])
return result
`;

const READINESS_SCRIPT = `
redis.call("SET", KEYS[1], ARGV[1], "PX", 5000)
local current = redis.call("GET", KEYS[1])
redis.call("DEL", KEYS[1])
if current == ARGV[1] then
  return 1
end
return 0
`;

type RedisCommandClient = Pick<Redis, "connect" | "ping" | "eval" | "quit" | "disconnect"> & {
  status: string;
};

type RedisStateConfig = {
  url: string;
  hmacSecret: Buffer;
  keyId: string;
};

function readRedisStateConfig(): RedisStateConfig {
  const url = process.env.MESSENGER_SHARED_STATE_REDIS_URL?.trim();
  const secretHex = process.env.MESSENGER_SHARED_STATE_HMAC_SECRET?.trim();
  const keyId = process.env.MESSENGER_SHARED_STATE_HMAC_KEY_ID?.trim() || "k1";
  if (!url || (!url.startsWith("redis://") && !url.startsWith("rediss://"))) {
    throw new MessengerSharedStateUnavailableError(
      "config",
      "MESSENGER_SHARED_STATE_REDIS_URL must use redis:// or rediss://",
    );
  }
  if (!secretHex || !/^[a-f0-9]{64}$/.test(secretHex)) {
    throw new MessengerSharedStateUnavailableError(
      "config",
      "MESSENGER_SHARED_STATE_HMAC_SECRET must be 64 lowercase hex characters",
    );
  }
  if (!/^[a-z0-9_-]{1,16}$/.test(keyId)) {
    throw new MessengerSharedStateUnavailableError(
      "config",
      "MESSENGER_SHARED_STATE_HMAC_KEY_ID is invalid",
    );
  }
  return { url, hmacSecret: Buffer.from(secretHex, "hex"), keyId };
}

export function buildRedisMessengerStateKeys(
  config: Pick<RedisStateConfig, "hmacSecret" | "keyId">,
  input: {
    scope: MessengerStateScope;
    eventIdentity: string;
    kind?: MessengerBudgetKind;
    dayKey?: string;
  },
): { partition: string; event: string; claim: string; counter?: string; reservation?: string } {
  validateMessengerStateIdentity(input.scope, input.eventIdentity);
  const digest = (...values: string[]) => {
    const hmac = createHmac("sha256", config.hmacSecret);
    for (const value of values) {
      const bytes = Buffer.from(value, "utf8");
      hmac.update(String(bytes.length));
      hmac.update(":");
      hmac.update(bytes);
    }
    return hmac.digest("hex");
  };
  const partition = digest(input.scope.accountId, input.scope.pageId);
  const event = digest(input.eventIdentity);
  const prefix = `ocfb:shared:v1:${config.keyId}`;
  const claim = `${prefix}:dedupe:{${partition}}:${event}`;
  if (!input.kind || !input.dayKey) {
    return { partition, event, claim };
  }
  const counter = `${prefix}:budget:{${partition}}:${input.kind}:${input.dayKey}`;
  const reservation = `${prefix}:budget-request:{${partition}}:${input.kind}:${input.dayKey}:${event}`;
  return { partition, event, claim, counter, reservation };
}

export class RedisMessengerEphemeralStateStore implements MessengerEphemeralStateStore {
  readonly mode = "redis" as const;
  private readinessPromise: Promise<void> | undefined;

  constructor(
    private readonly client: RedisCommandClient,
    private readonly config: Pick<RedisStateConfig, "hmacSecret" | "keyId">,
  ) {}

  async ensureReady(): Promise<void> {
    if (this.readinessPromise) {
      return await this.readinessPromise;
    }
    const readinessPromise = this.performReadinessCheck();
    this.readinessPromise = readinessPromise;
    try {
      await readinessPromise;
    } finally {
      if (this.readinessPromise === readinessPromise) {
        this.readinessPromise = undefined;
      }
    }
  }

  private async performReadinessCheck(): Promise<void> {
    try {
      if (this.client.status === "wait") {
        await this.client.connect();
      }
      const pong = await this.client.ping();
      if (pong !== "PONG") {
        throw new MessengerSharedStateUnavailableError(
          "protocol",
          "Messenger Redis readiness returned an invalid response",
        );
      }
      const probeValue = randomUUID();
      const probePartition = createHmac("sha256", this.config.hmacSecret)
        .update("readiness")
        .digest("hex");
      const probeIdentity = createHmac("sha256", this.config.hmacSecret)
        .update(probeValue)
        .digest("hex");
      const probeKey = `ocfb:shared:v1:${this.config.keyId}:readiness:{${probePartition}}:${probeIdentity}`;
      const probeResult = await this.client.eval(
        READINESS_SCRIPT,
        1,
        probeKey,
        probeValue,
      );
      if (probeResult !== 1) {
        throw new MessengerSharedStateUnavailableError(
          "protocol",
          "Messenger Redis readiness write probe returned an invalid response",
        );
      }
    } catch (error) {
      if (error instanceof MessengerSharedStateUnavailableError) throw error;
      throw new MessengerSharedStateUnavailableError(
        "connect",
        "Messenger Redis readiness failed",
        { cause: error },
      );
    }
  }

  async claimMessage(input: Readonly<{
    scope: MessengerStateScope;
    eventIdentity: string;
    ownerToken: string;
    ttlMs: number;
  }>): Promise<boolean> {
    validateMessengerStateIdentity(input.scope, input.eventIdentity);
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) {
      throw new MessengerSharedStateUnavailableError(
        "config",
        "Messenger Redis ttlMs must be a positive integer",
      );
    }
    const key = buildRedisMessengerStateKeys(this.config, input).claim;
    const result = await this.evalWithOneRetry(
      CLAIM_SCRIPT,
      1,
      key,
      input.ownerToken,
      String(input.ttlMs),
    );
    if (result === 1) return true;
    if (result === 0) return false;
    throw new MessengerSharedStateUnavailableError(
      "protocol",
      "Messenger Redis dedupe returned an invalid response",
    );
  }

  async reserveDaily(input: Readonly<{
    scope: MessengerStateScope;
    kind: MessengerBudgetKind;
    dayKey: string;
    eventIdentity: string;
    cap: number;
    expiresAtMs: number;
    now?: number;
  }>): Promise<MessengerDailyBudgetResult> {
    validateMessengerStateIdentity(input.scope, input.eventIdentity);
    if (!Number.isSafeInteger(input.cap) || input.cap <= 0) {
      throw new MessengerSharedStateUnavailableError(
        "config",
        "Messenger Redis cap must be a positive integer",
      );
    }
    if (
      !Number.isSafeInteger(input.expiresAtMs) ||
      input.expiresAtMs <= (input.now ?? Date.now())
    ) {
      throw new MessengerSharedStateUnavailableError(
        "config",
        "Messenger Redis expiry must be in the future",
      );
    }
    const keys = buildRedisMessengerStateKeys(this.config, input);
    const result = await this.evalWithOneRetry(
      RESERVE_DAILY_SCRIPT,
      2,
      keys.counter!,
      keys.reservation!,
      String(input.cap),
      String(input.expiresAtMs),
    );
    if (typeof result !== "string") {
      throw new MessengerSharedStateUnavailableError(
        "protocol",
        "Messenger Redis budget returned an invalid response",
      );
    }
    const match = /^(allowed|exhausted):(\d+)$/.exec(result);
    if (!match) {
      throw new MessengerSharedStateUnavailableError(
        "protocol",
        "Messenger Redis budget returned an invalid payload",
      );
    }
    const count = Number(match[2]);
    return match[1] === "allowed"
      ? { ok: true, count, cap: input.cap }
      : { ok: false, count, cap: input.cap };
  }

  async close(): Promise<void> {
    try {
      if (this.client.status === "ready" || this.client.status === "connect") {
        await this.client.quit();
      } else {
        this.client.disconnect();
      }
    } catch {
      this.client.disconnect();
    }
  }

  private async evalWithOneRetry(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown> {
    try {
      return await this.client.eval(script, numberOfKeys, ...args);
    } catch {
      await this.ensureReady();
    }
    try {
      return await this.client.eval(script, numberOfKeys, ...args);
    } catch (error) {
      throw new MessengerSharedStateUnavailableError(
        "command",
        "Messenger Redis command failed",
        { cause: error },
      );
    }
  }
}

export function createRedisMessengerEphemeralStateStore(): MessengerEphemeralStateStore {
  const config = readRedisStateConfig();
  const client = new Redis(config.url, {
    lazyConnect: true,
    connectTimeout: 5_000,
    commandTimeout: 2_000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  return new RedisMessengerEphemeralStateStore(client, config);
}
