import { randomBytes } from "node:crypto";
import {
  ensureRedisReady,
  getRedisClient,
  isRedisEnabled,
  type RedisLike,
} from "./redis";

const DEFAULT_REPLAY_TTL_SECONDS = 300;
const DEFAULT_WHATSAPP_REPLAY_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_WEBHOOK_INGRESS_DELIVERY_LEASE_SECONDS = 15 * 60;
const DEFAULT_WEBHOOK_INGRESS_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_REPLAY_KEYS = 10000;
const REPLAY_KEY_PREFIX = "webhook-replay:";
const LEGACY_COMPLETED_VALUE = "1";
const WHATSAPP_FALLBACK_PENDING_VALUE = "fallback_pending";
const WHATSAPP_COMPLETED_PREFIX = "completed:";
const WHATSAPP_EVENT_LEASE_PREFIX = "event:";
const WHATSAPP_FALLBACK_LEASE_PREFIX = "fallback:";
const WHATSAPP_OWNER_TOKEN_PATTERN = /^wr1\.[0-9a-f]{32}$/;

const CLAIM_WHATSAPP_REPLAY_SCRIPT = `
local clock = redis.call("TIME")
local now_ms = (tonumber(clock[1]) * 1000) + math.floor(tonumber(clock[2]) / 1000)
local deadline = now_ms + tonumber(ARGV[4])
local current = redis.call("GET", KEYS[1])
if current == false then
  redis.call("SET", KEYS[1], ARGV[2] .. ARGV[1] .. ":" .. deadline, "EX", ARGV[5])
  return 1
end
if current == "1" or string.sub(current, 1, 10) == ARGV[7] then
  return 3
end
local ttl = redis.call("PTTL", KEYS[1])
if ttl <= 0 then
  return -2
end
if current == ARGV[6] then
  redis.call("SET", KEYS[1], ARGV[3] .. ARGV[1] .. ":" .. deadline, "PX", ttl)
  return 2
end
local mode, owner, stored_deadline = string.match(current, "^(event:)(wr1%.[0-9a-f]+):(%d+)$")
if mode == nil then
  mode, owner, stored_deadline = string.match(current, "^(fallback:)(wr1%.[0-9a-f]+):(%d+)$")
end
if mode ~= nil then
  if tonumber(stored_deadline) > now_ms then
    return 4
  end
  redis.call("SET", KEYS[1], mode .. ARGV[1] .. ":" .. deadline, "PX", ttl)
  if mode == ARGV[2] then return 1 end
  return 2
end
return -1
`;

const COMPLETE_WHATSAPP_REPLAY_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if current == "1" or string.sub(current or "", 1, 10) == ARGV[2] then
  return 2
end
local mode, owner = string.match(current or "", "^(event:)(wr1%.[0-9a-f]+):%d+$")
if mode == nil then
  mode, owner = string.match(current or "", "^(fallback:)(wr1%.[0-9a-f]+):%d+$")
end
if owner == ARGV[1] then
  redis.call("SET", KEYS[1], ARGV[2] .. ARGV[1], "EX", ARGV[3])
  return 1
end
if current == false or current == ARGV[4] then
  return 0
end
return -1
`;

const RELEASE_WHATSAPP_REPLAY_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if current == "1" or string.sub(current or "", 1, 10) == ARGV[5] then
  return 2
end
local mode, owner = string.match(current or "", "^(event:)(wr1%.[0-9a-f]+):%d+$")
if mode == nil then
  mode, owner = string.match(current or "", "^(fallback:)(wr1%.[0-9a-f]+):%d+$")
end
if owner == ARGV[1] then
  if mode == ARGV[2] then
    redis.call("DEL", KEYS[1])
  else
    redis.call("SET", KEYS[1], ARGV[3], "EX", ARGV[4])
  end
  return 1
end
if current == false or current == ARGV[3] then
  return 2
end
return -1
`;

const MARK_WHATSAPP_EFFECTS_STARTED_SCRIPT = `
local clock = redis.call("TIME")
local now_ms = (tonumber(clock[1]) * 1000) + math.floor(tonumber(clock[2]) / 1000)
local deadline = now_ms + tonumber(ARGV[4])
local current = redis.call("GET", KEYS[1])
local mode, owner = string.match(current or "", "^(event:)(wr1%.[0-9a-f]+):%d+$")
if mode ~= nil and owner == ARGV[1] then
  local ttl = redis.call("PTTL", KEYS[1])
  if ttl <= 0 then return -2 end
  redis.call("SET", KEYS[1], ARGV[3] .. ARGV[1] .. ":" .. deadline, "PX", ttl)
  return 1
end
mode, owner = string.match(current or "", "^(fallback:)(wr1%.[0-9a-f]+):%d+$")
if mode ~= nil and owner == ARGV[1] then
  return 2
end
if current == false then
  return 0
end
return -1
`;

const MARK_WHATSAPP_FALLBACK_PENDING_SCRIPT = `
local current = redis.call("GET", KEYS[1])
local mode, owner = string.match(current or "", "^(event:)(wr1%.[0-9a-f]+):%d+$")
if mode == nil then
  mode, owner = string.match(current or "", "^(fallback:)(wr1%.[0-9a-f]+):%d+$")
end
if owner == ARGV[1] then
  redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])
  return 1
end
if current == ARGV[2] then
  return 2
end
if current == false then
  return 0
end
return -1
`;

const RENEW_WHATSAPP_REPLAY_SCRIPT = `
local current = redis.call("GET", KEYS[1])
local mode, owner = string.match(current or "", "^(event:)(wr1%.[0-9a-f]+):%d+$")
if mode == nil then
  mode, owner = string.match(current or "", "^(fallback:)(wr1%.[0-9a-f]+):%d+$")
end
if owner == ARGV[1] then
  local clock = redis.call("TIME")
  local now_ms = (tonumber(clock[1]) * 1000) + math.floor(tonumber(clock[2]) / 1000)
  local ttl = redis.call("PTTL", KEYS[1])
  if ttl <= 0 then return -2 end
  redis.call("SET", KEYS[1], mode .. ARGV[1] .. ":" .. (now_ms + tonumber(ARGV[2])), "PX", ttl)
  return 1
end
if current == false then
  return 0
end
return -1
`;

type MemoryReplayEntry = Readonly<{
  value: string;
  expiresAt: number;
}>;

const memoryReplayKeys = new Map<string, MemoryReplayEntry>();

declare const whatsAppWebhookReplayOwnerTokenBrand: unique symbol;
const whatsAppWebhookReplayLeaseBrand: unique symbol = Symbol(
  "whatsAppWebhookReplayLease"
);
const whatsAppWebhookReplayLeases = new WeakSet<object>();

export type WhatsAppWebhookReplayOwnerToken = string & {
  readonly [whatsAppWebhookReplayOwnerTokenBrand]: true;
};

export type WhatsAppWebhookReplayMode = "event" | "fallback";

export type WhatsAppWebhookReplayLease = Readonly<{
  replayKey: string;
  ownerToken: WhatsAppWebhookReplayOwnerToken;
  mode: WhatsAppWebhookReplayMode;
  [whatsAppWebhookReplayLeaseBrand]: true;
}>;

export type WhatsAppWebhookReplayClaimResult =
  | Readonly<{
      status: "acquired";
      lease: WhatsAppWebhookReplayLease;
    }>
  | Readonly<{ status: "duplicate" }>;

export type WhatsAppWebhookReplayErrorCode =
  | "claim_busy"
  | "invalid_lease"
  | "invalid_store_response"
  | "lease_lost"
  | "lease_mismatch"
  | "store_unavailable";

export class WhatsAppWebhookReplayError extends Error {
  readonly code: WhatsAppWebhookReplayErrorCode;
  readonly retryable: boolean;

  constructor(code: WhatsAppWebhookReplayErrorCode, retryable = false) {
    super("WhatsApp webhook replay protection is unavailable");
    this.name = "WhatsAppWebhookReplayError";
    this.code = code;
    this.retryable = retryable;
  }
}

type WhatsAppWebhookReplayRedis = Pick<RedisLike, "eval" | "get" | "set">;

export type WhatsAppWebhookReplayDeps = Readonly<{
  createOwnerToken: () => WhatsAppWebhookReplayOwnerToken;
  getRedisClient: () => Promise<WhatsAppWebhookReplayRedis>;
  isRedisEnabled: () => boolean;
}>;

type StoredWhatsAppReplayState =
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "legacy_completed" }>
  | Readonly<{ status: "fallback_pending" }>
  | Readonly<{
      status: "processing";
      mode: WhatsAppWebhookReplayMode;
      ownerToken: WhatsAppWebhookReplayOwnerToken;
      leaseDeadlineMs: number;
    }>
  | Readonly<{
      status: "completed";
      ownerToken: WhatsAppWebhookReplayOwnerToken;
    }>
  | Readonly<{ status: "invalid" }>;

const DUPLICATE_WHATSAPP_REPLAY: WhatsAppWebhookReplayClaimResult =
  Object.freeze({ status: "duplicate" });

function getReplayTtlSeconds(): number {
  const configured = process.env.WEBHOOK_REPLAY_TTL_SECONDS?.trim();
  if (!configured) return DEFAULT_REPLAY_TTL_SECONDS;
  const seconds = Number(configured);
  if (!Number.isSafeInteger(seconds) || seconds < 3) {
    throw new Error(
      "WEBHOOK_REPLAY_TTL_SECONDS must be an integer of at least 3"
    );
  }
  return seconds;
}

function readPositiveInteger(name: string, fallback: number): number {
  const configured = process.env[name]?.trim();
  if (!configured) return fallback;
  const value = Number(configured);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function getWebhookIngressDeliveryLeaseSeconds(): number {
  return readPositiveInteger(
    "WEBHOOK_INGRESS_DELIVERY_LEASE_SECONDS",
    DEFAULT_WEBHOOK_INGRESS_DELIVERY_LEASE_SECONDS
  );
}

function getWebhookIngressRecoveryHorizonSeconds(): number {
  const maximumSeconds = 24 * 60 * 60;
  const minimumSeconds =
    getWebhookIngressDeliveryLeaseSeconds() *
    readPositiveInteger(
      "WEBHOOK_INGRESS_MAX_ATTEMPTS",
      DEFAULT_WEBHOOK_INGRESS_MAX_ATTEMPTS
    );
  const requested = readPositiveInteger(
    "WEBHOOK_INGRESS_CONTENT_TTL_SECONDS",
    DEFAULT_WHATSAPP_REPLAY_TTL_SECONDS
  );
  if (
    minimumSeconds > maximumSeconds ||
    requested < minimumSeconds ||
    requested > maximumSeconds
  ) {
    throw new Error(
      "WEBHOOK_INGRESS_CONTENT_TTL_SECONDS must cover retries and be at most 24h"
    );
  }
  return requested;
}

function getWhatsAppReplayTtlSeconds(): number {
  const maximumSeconds = 24 * 60 * 60;
  const ingressHorizon = getWebhookIngressRecoveryHorizonSeconds();
  const configured = process.env.WHATSAPP_WEBHOOK_REPLAY_TTL_SECONDS?.trim();
  const seconds = configured
    ? Number(configured)
    : DEFAULT_WHATSAPP_REPLAY_TTL_SECONDS;
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < ingressHorizon ||
    seconds > maximumSeconds
  ) {
    throw new Error(
      "WHATSAPP_WEBHOOK_REPLAY_TTL_SECONDS must cover the ingress recovery horizon and be at most 24h"
    );
  }
  return seconds;
}

function getWhatsAppReplayLeaseSeconds(): number {
  const ingressDeliveryLease = getWebhookIngressDeliveryLeaseSeconds();
  const configured = process.env.WHATSAPP_WEBHOOK_REPLAY_LEASE_SECONDS?.trim();
  const seconds = configured ? Number(configured) : DEFAULT_REPLAY_TTL_SECONDS;
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < 3 ||
    seconds > ingressDeliveryLease
  ) {
    throw new Error(
      "WHATSAPP_WEBHOOK_REPLAY_LEASE_SECONDS must be at least 3 and no longer than the ingress delivery lease"
    );
  }
  return seconds;
}

function getWhatsAppReplayHeartbeatIntervalMs(): number {
  return Math.max(
    1_000,
    Math.min(10_000, Math.floor((getWhatsAppReplayLeaseSeconds() * 1_000) / 3))
  );
}

function pruneMemoryReplayKeys(now: number): void {
  memoryReplayKeys.forEach((entry, key) => {
    if (entry.expiresAt <= now) {
      memoryReplayKeys.delete(key);
    }
  });

  while (memoryReplayKeys.size > DEFAULT_MAX_REPLAY_KEYS) {
    const oldestKey = memoryReplayKeys.keys().next().value;
    if (!oldestKey) break;
    memoryReplayKeys.delete(oldestKey);
  }
}

function toRedisReplayKey(key: string): string {
  return `${REPLAY_KEY_PREFIX}${key}`;
}

function toWhatsAppRedisReplayKey(key: string): string {
  if (!key.startsWith("whatsapp:")) {
    throw new WhatsAppWebhookReplayError("invalid_store_response");
  }
  // Keep the exact legacy key so old SET-NX instances and the phase-aware
  // runtime mutually exclude each other during a rolling deployment.
  return toRedisReplayKey(key);
}

function parseWhatsAppOwnerToken(
  value: unknown
): WhatsAppWebhookReplayOwnerToken {
  if (typeof value !== "string" || !WHATSAPP_OWNER_TOKEN_PATTERN.test(value)) {
    throw new WhatsAppWebhookReplayError("store_unavailable", true);
  }
  return value as WhatsAppWebhookReplayOwnerToken;
}

export function createWhatsAppWebhookReplayOwnerToken(): WhatsAppWebhookReplayOwnerToken {
  return parseWhatsAppOwnerToken(`wr1.${randomBytes(16).toString("hex")}`);
}

function eventLeaseValue(
  ownerToken: WhatsAppWebhookReplayOwnerToken,
  leaseDeadlineMs: number
): string {
  return `${WHATSAPP_EVENT_LEASE_PREFIX}${ownerToken}:${leaseDeadlineMs}`;
}

function fallbackLeaseValue(
  ownerToken: WhatsAppWebhookReplayOwnerToken,
  leaseDeadlineMs: number
): string {
  return `${WHATSAPP_FALLBACK_LEASE_PREFIX}${ownerToken}:${leaseDeadlineMs}`;
}

function completedValue(ownerToken: WhatsAppWebhookReplayOwnerToken): string {
  return `${WHATSAPP_COMPLETED_PREFIX}${ownerToken}`;
}

function parseStoredWhatsAppReplayState(
  value: string | null
): StoredWhatsAppReplayState {
  if (value === null) return Object.freeze({ status: "missing" });
  if (value === LEGACY_COMPLETED_VALUE) {
    return Object.freeze({ status: "legacy_completed" });
  }
  if (value === WHATSAPP_FALLBACK_PENDING_VALUE) {
    return Object.freeze({ status: "fallback_pending" });
  }
  const processing = /^(event|fallback):(wr1\.[0-9a-f]{32}):(\d+)$/.exec(value);
  if (processing) {
    const leaseDeadlineMs = Number(processing[3]);
    if (Number.isSafeInteger(leaseDeadlineMs) && leaseDeadlineMs > 0) {
      return Object.freeze({
        status: "processing",
        mode: processing[1] as WhatsAppWebhookReplayMode,
        ownerToken: processing[2] as WhatsAppWebhookReplayOwnerToken,
        leaseDeadlineMs,
      });
    }
  }
  if (value.startsWith(WHATSAPP_COMPLETED_PREFIX)) {
    const ownerToken = value.slice(WHATSAPP_COMPLETED_PREFIX.length);
    if (WHATSAPP_OWNER_TOKEN_PATTERN.test(ownerToken)) {
      return Object.freeze({
        status: "completed",
        ownerToken: ownerToken as WhatsAppWebhookReplayOwnerToken,
      });
    }
  }
  return Object.freeze({ status: "invalid" });
}

function createWhatsAppReplayLease(
  replayKey: string,
  ownerToken: WhatsAppWebhookReplayOwnerToken,
  mode: WhatsAppWebhookReplayMode
): WhatsAppWebhookReplayLease {
  const lease = { replayKey, ownerToken, mode } as WhatsAppWebhookReplayLease;
  Object.defineProperty(lease, whatsAppWebhookReplayLeaseBrand, {
    value: true,
  });
  Object.freeze(lease);
  whatsAppWebhookReplayLeases.add(lease);
  return lease;
}

function requireWhatsAppReplayLease(
  value: WhatsAppWebhookReplayLease
): WhatsAppWebhookReplayLease {
  if (
    !value ||
    typeof value !== "object" ||
    !whatsAppWebhookReplayLeases.has(value) ||
    value[whatsAppWebhookReplayLeaseBrand] !== true ||
    typeof value.replayKey !== "string" ||
    !value.replayKey.startsWith(`${REPLAY_KEY_PREFIX}whatsapp:`) ||
    (value.mode !== "event" && value.mode !== "fallback")
  ) {
    throw new WhatsAppWebhookReplayError("invalid_lease");
  }
  parseWhatsAppOwnerToken(value.ownerToken);
  return value;
}

function memoryEntry(key: string): MemoryReplayEntry | null {
  const now = Date.now();
  pruneMemoryReplayKeys(now);
  const entry = memoryReplayKeys.get(key);
  if (!entry || entry.expiresAt <= now) {
    memoryReplayKeys.delete(key);
    return null;
  }
  return entry;
}

function setMemoryEntry(
  key: string,
  value: string,
  ttlSeconds = getReplayTtlSeconds()
): void {
  const now = Date.now();
  memoryReplayKeys.set(key, {
    value,
    expiresAt: now + ttlSeconds * 1000,
  });
  pruneMemoryReplayKeys(now);
}

function replaceMemoryEntryPreservingExpiry(
  key: string,
  value: string
): boolean {
  const current = memoryEntry(key);
  if (!current) return false;
  memoryReplayKeys.set(key, { value, expiresAt: current.expiresAt });
  return true;
}

function requireRedisEnabled(
  deps: Pick<WhatsAppWebhookReplayDeps, "isRedisEnabled">
): boolean {
  try {
    return deps.isRedisEnabled();
  } catch {
    throw new WhatsAppWebhookReplayError("store_unavailable", true);
  }
}

async function getReplayRedis(
  deps: Pick<WhatsAppWebhookReplayDeps, "getRedisClient">
): Promise<WhatsAppWebhookReplayRedis> {
  try {
    return await deps.getRedisClient();
  } catch {
    throw new WhatsAppWebhookReplayError("store_unavailable", true);
  }
}

async function readRedisState(
  redis: WhatsAppWebhookReplayRedis,
  replayKey: string
): Promise<StoredWhatsAppReplayState> {
  try {
    return parseStoredWhatsAppReplayState(await redis.get(replayKey));
  } catch {
    throw new WhatsAppWebhookReplayError("store_unavailable", true);
  }
}

function claimWhatsAppReplayInMemory(
  replayKey: string,
  ownerToken: WhatsAppWebhookReplayOwnerToken
): WhatsAppWebhookReplayClaimResult {
  const now = Date.now();
  const stored = parseStoredWhatsAppReplayState(
    memoryEntry(replayKey)?.value ?? null
  );
  if (stored.status === "completed" || stored.status === "legacy_completed") {
    return DUPLICATE_WHATSAPP_REPLAY;
  }
  if (stored.status === "processing" && stored.leaseDeadlineMs > now) {
    throw new WhatsAppWebhookReplayError("claim_busy", true);
  }
  const mode =
    stored.status === "fallback_pending" ||
    (stored.status === "processing" && stored.mode === "fallback")
      ? "fallback"
      : "event";
  const deadline = now + getWhatsAppReplayLeaseSeconds() * 1_000;
  const nextValue =
    mode === "event"
      ? eventLeaseValue(ownerToken, deadline)
      : fallbackLeaseValue(ownerToken, deadline);
  if (stored.status === "missing") {
    setMemoryEntry(replayKey, nextValue, getWhatsAppReplayTtlSeconds());
  } else if (
    stored.status === "fallback_pending" ||
    stored.status === "processing"
  ) {
    if (!replaceMemoryEntryPreservingExpiry(replayKey, nextValue)) {
      throw new WhatsAppWebhookReplayError("store_unavailable", true);
    }
  } else {
    throw new WhatsAppWebhookReplayError("invalid_store_response", true);
  }
  return Object.freeze({
    status: "acquired",
    lease: createWhatsAppReplayLease(replayKey, ownerToken, mode),
  });
}

async function reconcileWhatsAppClaim(
  redis: WhatsAppWebhookReplayRedis,
  replayKey: string,
  ownerToken: WhatsAppWebhookReplayOwnerToken
): Promise<WhatsAppWebhookReplayClaimResult> {
  const stored = await readRedisState(redis, replayKey);
  if (stored.status === "completed" || stored.status === "legacy_completed") {
    return DUPLICATE_WHATSAPP_REPLAY;
  }
  if (stored.status === "processing" && stored.ownerToken === ownerToken) {
    return Object.freeze({
      status: "acquired",
      lease: createWhatsAppReplayLease(replayKey, ownerToken, stored.mode),
    });
  }
  if (stored.status === "processing") {
    throw new WhatsAppWebhookReplayError("claim_busy", true);
  }
  if (stored.status === "fallback_pending") {
    throw new WhatsAppWebhookReplayError("store_unavailable", true);
  }
  if (stored.status === "missing") {
    throw new WhatsAppWebhookReplayError("store_unavailable", true);
  }
  throw new WhatsAppWebhookReplayError("invalid_store_response", true);
}

export function isRedisReplayProtectionEnabled(): boolean {
  return isRedisEnabled();
}

export function assertProductionWebhookReplayProtectionConfig(): void {
  if (process.env.NODE_ENV !== "production") return;
  if (!isRedisReplayProtectionEnabled()) {
    throw new Error(
      "REDIS_URL must be configured in production for webhook replay protection"
    );
  }
  getReplayTtlSeconds();
  getWhatsAppReplayTtlSeconds();
  getWhatsAppReplayLeaseSeconds();
}

export async function ensureWebhookReplayProtectionReady(): Promise<void> {
  await ensureRedisReady();
}

/** Existing one-shot replay API used by Messenger. */
export async function claimWebhookReplayKey(key: string): Promise<boolean> {
  const replayKey = toRedisReplayKey(key);
  if (!isRedisReplayProtectionEnabled()) {
    if (memoryEntry(replayKey)) return false;
    setMemoryEntry(replayKey, LEGACY_COMPLETED_VALUE);
    return true;
  }

  const redis = await getRedisClient();
  const result = await redis.set(
    replayKey,
    LEGACY_COMPLETED_VALUE,
    "EX",
    getReplayTtlSeconds(),
    "NX"
  );
  return result === "OK";
}

export async function claimWhatsAppWebhookReplayLeaseWithDeps(input: {
  key: string;
  deps: WhatsAppWebhookReplayDeps;
}): Promise<WhatsAppWebhookReplayClaimResult> {
  const replayKey = toWhatsAppRedisReplayKey(input.key);
  let ownerToken: WhatsAppWebhookReplayOwnerToken;
  try {
    ownerToken = parseWhatsAppOwnerToken(input.deps.createOwnerToken());
  } catch {
    throw new WhatsAppWebhookReplayError("store_unavailable", true);
  }

  if (!requireRedisEnabled(input.deps)) {
    return claimWhatsAppReplayInMemory(replayKey, ownerToken);
  }
  const redis = await getReplayRedis(input.deps);
  let result: unknown;
  try {
    result = await redis.eval(
      CLAIM_WHATSAPP_REPLAY_SCRIPT,
      1,
      replayKey,
      ownerToken,
      WHATSAPP_EVENT_LEASE_PREFIX,
      WHATSAPP_FALLBACK_LEASE_PREFIX,
      getWhatsAppReplayLeaseSeconds() * 1_000,
      getWhatsAppReplayTtlSeconds(),
      WHATSAPP_FALLBACK_PENDING_VALUE,
      WHATSAPP_COMPLETED_PREFIX
    );
  } catch {
    return await reconcileWhatsAppClaim(redis, replayKey, ownerToken);
  }
  if (result === 1) {
    return Object.freeze({
      status: "acquired",
      lease: createWhatsAppReplayLease(replayKey, ownerToken, "event"),
    });
  }
  if (result === 2) {
    return Object.freeze({
      status: "acquired",
      lease: createWhatsAppReplayLease(replayKey, ownerToken, "fallback"),
    });
  }
  if (result === 3) return DUPLICATE_WHATSAPP_REPLAY;
  if (result === 4) {
    throw new WhatsAppWebhookReplayError("claim_busy", true);
  }
  if (result === -1 || result === -2) {
    throw new WhatsAppWebhookReplayError("invalid_store_response", true);
  }
  return await reconcileWhatsAppClaim(redis, replayKey, ownerToken);
}

async function reconcileWhatsAppCompletion(
  redis: WhatsAppWebhookReplayRedis,
  lease: WhatsAppWebhookReplayLease,
  pendingCode: "invalid_store_response" | "store_unavailable"
): Promise<void> {
  const stored = await readRedisState(redis, lease.replayKey);
  if (stored.status === "completed") return;
  if (
    stored.status === "processing" &&
    stored.ownerToken === lease.ownerToken
  ) {
    throw new WhatsAppWebhookReplayError(pendingCode, true);
  }
  if (stored.status === "missing" || stored.status === "fallback_pending") {
    throw new WhatsAppWebhookReplayError("lease_lost", true);
  }
  if (stored.status === "invalid") {
    throw new WhatsAppWebhookReplayError("invalid_store_response", true);
  }
  throw new WhatsAppWebhookReplayError("lease_mismatch");
}

export async function completeWhatsAppWebhookReplayLeaseWithDeps(input: {
  lease: WhatsAppWebhookReplayLease;
  deps: Pick<WhatsAppWebhookReplayDeps, "getRedisClient" | "isRedisEnabled">;
}): Promise<void> {
  const lease = requireWhatsAppReplayLease(input.lease);
  if (!requireRedisEnabled(input.deps)) {
    const stored = parseStoredWhatsAppReplayState(
      memoryEntry(lease.replayKey)?.value ?? null
    );
    if (stored.status === "completed") return;
    if (
      stored.status === "processing" &&
      stored.ownerToken === lease.ownerToken
    ) {
      setMemoryEntry(
        lease.replayKey,
        completedValue(lease.ownerToken),
        getWhatsAppReplayTtlSeconds()
      );
      return;
    }
    if (stored.status === "missing" || stored.status === "fallback_pending") {
      throw new WhatsAppWebhookReplayError("lease_lost", true);
    }
    throw new WhatsAppWebhookReplayError("lease_mismatch");
  }

  const redis = await getReplayRedis(input.deps);
  let result: unknown;
  try {
    result = await redis.eval(
      COMPLETE_WHATSAPP_REPLAY_SCRIPT,
      1,
      lease.replayKey,
      lease.ownerToken,
      WHATSAPP_COMPLETED_PREFIX,
      getWhatsAppReplayTtlSeconds(),
      WHATSAPP_FALLBACK_PENDING_VALUE
    );
  } catch {
    return await reconcileWhatsAppCompletion(redis, lease, "store_unavailable");
  }
  if (result === 1 || result === 2) return;
  if (result === 0) {
    throw new WhatsAppWebhookReplayError("lease_lost", true);
  }
  if (result === -1) {
    throw new WhatsAppWebhookReplayError("lease_mismatch");
  }
  return await reconcileWhatsAppCompletion(
    redis,
    lease,
    "invalid_store_response"
  );
}

async function reconcileWhatsAppRenewal(
  redis: WhatsAppWebhookReplayRedis,
  lease: WhatsAppWebhookReplayLease,
  pendingCode: "invalid_store_response" | "store_unavailable"
): Promise<void> {
  const stored = await readRedisState(redis, lease.replayKey);
  if (
    stored.status === "processing" &&
    stored.ownerToken === lease.ownerToken
  ) {
    throw new WhatsAppWebhookReplayError(pendingCode, true);
  }
  if (stored.status === "missing" || stored.status === "fallback_pending") {
    throw new WhatsAppWebhookReplayError("lease_lost", true);
  }
  throw new WhatsAppWebhookReplayError("lease_mismatch");
}

export async function renewWhatsAppWebhookReplayLeaseWithDeps(input: {
  lease: WhatsAppWebhookReplayLease;
  deps: Pick<WhatsAppWebhookReplayDeps, "getRedisClient" | "isRedisEnabled">;
}): Promise<void> {
  const lease = requireWhatsAppReplayLease(input.lease);
  if (!requireRedisEnabled(input.deps)) {
    const stored = parseStoredWhatsAppReplayState(
      memoryEntry(lease.replayKey)?.value ?? null
    );
    if (
      stored.status === "processing" &&
      stored.ownerToken === lease.ownerToken
    ) {
      const deadline = Date.now() + getWhatsAppReplayLeaseSeconds() * 1_000;
      replaceMemoryEntryPreservingExpiry(
        lease.replayKey,
        stored.mode === "event"
          ? eventLeaseValue(lease.ownerToken, deadline)
          : fallbackLeaseValue(lease.ownerToken, deadline)
      );
      return;
    }
    if (stored.status === "missing" || stored.status === "fallback_pending") {
      throw new WhatsAppWebhookReplayError("lease_lost", true);
    }
    throw new WhatsAppWebhookReplayError("lease_mismatch");
  }

  const redis = await getReplayRedis(input.deps);
  let result: unknown;
  try {
    result = await redis.eval(
      RENEW_WHATSAPP_REPLAY_SCRIPT,
      1,
      lease.replayKey,
      lease.ownerToken,
      getWhatsAppReplayLeaseSeconds() * 1_000
    );
  } catch {
    return await reconcileWhatsAppRenewal(redis, lease, "store_unavailable");
  }
  if (result === 1) return;
  if (result === 0) {
    throw new WhatsAppWebhookReplayError("lease_lost", true);
  }
  if (result === -1) {
    throw new WhatsAppWebhookReplayError("lease_mismatch");
  }
  return await reconcileWhatsAppRenewal(redis, lease, "invalid_store_response");
}

async function reconcileWhatsAppRelease(
  redis: WhatsAppWebhookReplayRedis,
  lease: WhatsAppWebhookReplayLease,
  pendingCode: "invalid_store_response" | "store_unavailable"
): Promise<void> {
  const stored = await readRedisState(redis, lease.replayKey);
  if (
    stored.status === "missing" ||
    stored.status === "fallback_pending" ||
    stored.status === "completed" ||
    stored.status === "legacy_completed"
  ) {
    return;
  }
  if (
    stored.status === "processing" &&
    stored.ownerToken === lease.ownerToken
  ) {
    throw new WhatsAppWebhookReplayError(pendingCode, true);
  }
  throw new WhatsAppWebhookReplayError("lease_mismatch");
}

export async function releaseWhatsAppWebhookReplayLeaseWithDeps(input: {
  lease: WhatsAppWebhookReplayLease;
  deps: Pick<WhatsAppWebhookReplayDeps, "getRedisClient" | "isRedisEnabled">;
}): Promise<void> {
  const lease = requireWhatsAppReplayLease(input.lease);
  if (!requireRedisEnabled(input.deps)) {
    const stored = parseStoredWhatsAppReplayState(
      memoryEntry(lease.replayKey)?.value ?? null
    );
    if (
      stored.status === "missing" ||
      stored.status === "fallback_pending" ||
      stored.status === "completed" ||
      stored.status === "legacy_completed"
    ) {
      return;
    }
    if (
      stored.status === "processing" &&
      stored.ownerToken === lease.ownerToken
    ) {
      if (stored.mode === "event") {
        memoryReplayKeys.delete(lease.replayKey);
      } else {
        setMemoryEntry(
          lease.replayKey,
          WHATSAPP_FALLBACK_PENDING_VALUE,
          getWhatsAppReplayTtlSeconds()
        );
      }
      return;
    }
    throw new WhatsAppWebhookReplayError("lease_mismatch");
  }

  const redis = await getReplayRedis(input.deps);
  let result: unknown;
  try {
    result = await redis.eval(
      RELEASE_WHATSAPP_REPLAY_SCRIPT,
      1,
      lease.replayKey,
      lease.ownerToken,
      WHATSAPP_EVENT_LEASE_PREFIX,
      WHATSAPP_FALLBACK_PENDING_VALUE,
      getWhatsAppReplayTtlSeconds(),
      WHATSAPP_COMPLETED_PREFIX
    );
  } catch {
    return await reconcileWhatsAppRelease(redis, lease, "store_unavailable");
  }
  if (result === 1 || result === 2) return;
  if (result === -1) {
    throw new WhatsAppWebhookReplayError("lease_mismatch");
  }
  return await reconcileWhatsAppRelease(redis, lease, "invalid_store_response");
}

export async function markWhatsAppWebhookEffectsStartedWithDeps(input: {
  lease: WhatsAppWebhookReplayLease;
  deps: Pick<WhatsAppWebhookReplayDeps, "getRedisClient" | "isRedisEnabled">;
}): Promise<void> {
  if (requireWhatsAppReplayLease(input.lease).mode !== "event") {
    throw new WhatsAppWebhookReplayError("invalid_lease");
  }
  const lease = input.lease;
  if (!requireRedisEnabled(input.deps)) {
    const stored = parseStoredWhatsAppReplayState(
      memoryEntry(lease.replayKey)?.value ?? null
    );
    if (
      stored.status === "processing" &&
      stored.ownerToken === lease.ownerToken
    ) {
      if (stored.mode === "fallback") return;
      const deadline = Date.now() + getWhatsAppReplayLeaseSeconds() * 1_000;
      replaceMemoryEntryPreservingExpiry(
        lease.replayKey,
        fallbackLeaseValue(lease.ownerToken, deadline)
      );
      return;
    }
    throw new WhatsAppWebhookReplayError(
      stored.status === "missing" ? "lease_lost" : "lease_mismatch",
      stored.status === "missing"
    );
  }
  const redis = await getReplayRedis(input.deps);
  let result: unknown;
  try {
    result = await redis.eval(
      MARK_WHATSAPP_EFFECTS_STARTED_SCRIPT,
      1,
      lease.replayKey,
      lease.ownerToken,
      WHATSAPP_EVENT_LEASE_PREFIX,
      WHATSAPP_FALLBACK_LEASE_PREFIX,
      getWhatsAppReplayLeaseSeconds() * 1_000
    );
  } catch {
    const phase = await readRedisState(redis, lease.replayKey);
    if (
      phase.status === "processing" &&
      phase.mode === "fallback" &&
      phase.ownerToken === lease.ownerToken
    ) {
      return;
    }
    throw new WhatsAppWebhookReplayError("store_unavailable", true);
  }
  if (result === 1 || result === 2) return;
  if (result === 0) {
    throw new WhatsAppWebhookReplayError("lease_lost", true);
  }
  throw new WhatsAppWebhookReplayError(
    result === -1 ? "lease_mismatch" : "invalid_store_response",
    result !== -1
  );
}

export async function markWhatsAppWebhookFallbackPendingWithDeps(input: {
  lease: WhatsAppWebhookReplayLease;
  deps: Pick<WhatsAppWebhookReplayDeps, "getRedisClient" | "isRedisEnabled">;
}): Promise<void> {
  if (requireWhatsAppReplayLease(input.lease).mode !== "event") {
    throw new WhatsAppWebhookReplayError("invalid_lease");
  }
  const lease = input.lease;
  if (!requireRedisEnabled(input.deps)) {
    const stored = parseStoredWhatsAppReplayState(
      memoryEntry(lease.replayKey)?.value ?? null
    );
    if (stored.status === "fallback_pending") return;
    if (
      stored.status === "processing" &&
      stored.ownerToken === lease.ownerToken
    ) {
      setMemoryEntry(
        lease.replayKey,
        WHATSAPP_FALLBACK_PENDING_VALUE,
        getWhatsAppReplayTtlSeconds()
      );
      return;
    }
    throw new WhatsAppWebhookReplayError(
      stored.status === "missing" ? "lease_lost" : "lease_mismatch",
      stored.status === "missing"
    );
  }
  const redis = await getReplayRedis(input.deps);
  let result: unknown;
  try {
    result = await redis.eval(
      MARK_WHATSAPP_FALLBACK_PENDING_SCRIPT,
      1,
      lease.replayKey,
      lease.ownerToken,
      WHATSAPP_FALLBACK_PENDING_VALUE,
      getWhatsAppReplayTtlSeconds()
    );
  } catch {
    const phase = await readRedisState(redis, lease.replayKey);
    if (phase.status === "fallback_pending") return;
    throw new WhatsAppWebhookReplayError("store_unavailable", true);
  }
  if (result === 1 || result === 2) return;
  if (result === 0) {
    throw new WhatsAppWebhookReplayError("lease_lost", true);
  }
  throw new WhatsAppWebhookReplayError(
    result === -1 ? "lease_mismatch" : "invalid_store_response",
    result !== -1
  );
}

const runtimeWhatsAppReplayDeps: WhatsAppWebhookReplayDeps = Object.freeze({
  createOwnerToken: createWhatsAppWebhookReplayOwnerToken,
  getRedisClient,
  isRedisEnabled,
});

export async function claimWhatsAppWebhookReplayLease(
  key: string
): Promise<WhatsAppWebhookReplayClaimResult> {
  return await claimWhatsAppWebhookReplayLeaseWithDeps({
    key,
    deps: runtimeWhatsAppReplayDeps,
  });
}

export async function completeWhatsAppWebhookReplayLease(
  lease: WhatsAppWebhookReplayLease
): Promise<void> {
  await completeWhatsAppWebhookReplayLeaseWithDeps({
    lease,
    deps: runtimeWhatsAppReplayDeps,
  });
}

export async function releaseWhatsAppWebhookReplayLease(
  lease: WhatsAppWebhookReplayLease
): Promise<void> {
  await releaseWhatsAppWebhookReplayLeaseWithDeps({
    lease,
    deps: runtimeWhatsAppReplayDeps,
  });
}

export async function markWhatsAppWebhookFallbackPending(
  lease: WhatsAppWebhookReplayLease
): Promise<void> {
  await markWhatsAppWebhookFallbackPendingWithDeps({
    lease,
    deps: runtimeWhatsAppReplayDeps,
  });
}

export async function markWhatsAppWebhookEffectsStarted(
  lease: WhatsAppWebhookReplayLease
): Promise<void> {
  await markWhatsAppWebhookEffectsStartedWithDeps({
    lease,
    deps: runtimeWhatsAppReplayDeps,
  });
}

export async function renewWhatsAppWebhookReplayLease(
  lease: WhatsAppWebhookReplayLease
): Promise<void> {
  await renewWhatsAppWebhookReplayLeaseWithDeps({
    lease,
    deps: runtimeWhatsAppReplayDeps,
  });
}

export async function runWithWhatsAppWebhookReplayLeaseHeartbeat<T>(
  lease: WhatsAppWebhookReplayLease,
  callback: () => Promise<T>
): Promise<T> {
  let heartbeatError: unknown;
  let pendingHeartbeat = Promise.resolve();
  const heartbeat = setInterval(() => {
    if (heartbeatError) return;
    pendingHeartbeat = pendingHeartbeat
      .then(() => renewWhatsAppWebhookReplayLease(lease))
      .catch(error => {
        heartbeatError = error;
      });
  }, getWhatsAppReplayHeartbeatIntervalMs());
  heartbeat.unref?.();

  let callbackResult: T | undefined;
  let callbackError: unknown;
  try {
    callbackResult = await callback();
  } catch (error) {
    callbackError = error;
  } finally {
    clearInterval(heartbeat);
    await pendingHeartbeat;
  }

  if (callbackError !== undefined && heartbeatError !== undefined) {
    throw new AggregateError(
      [callbackError, heartbeatError],
      "WhatsApp replay heartbeat and event processing failed",
      { cause: callbackError }
    );
  }
  if (callbackError !== undefined) {
    if (callbackError instanceof Error) throw callbackError;
    throw new Error("WhatsApp event processing failed", {
      cause: callbackError,
    });
  }
  if (heartbeatError !== undefined) {
    if (heartbeatError instanceof Error) throw heartbeatError;
    throw new Error("WhatsApp replay heartbeat failed", {
      cause: heartbeatError,
    });
  }
  return callbackResult as T;
}

export function resetWebhookReplayProtection(): void {
  memoryReplayKeys.clear();
}
