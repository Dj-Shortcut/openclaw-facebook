import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import { getConfiguredJwtSecret } from "./env";
import { safeLog } from "./logger";
import { getRedisClient, isRedisEnabled } from "./redis";

const KEY_TAG = "{messenger-privacy-erasure-v1}";
const PENDING_KEY = `messenger-privacy-erasure:${KEY_TAG}:pending`;
const JOB_PREFIX = `messenger-privacy-erasure:${KEY_TAG}:job:`;
const LEASE_PREFIX = `messenger-privacy-erasure:${KEY_TAG}:lease:`;
const LEGACY_CRYPTO_DOMAIN = "leaderbot.messenger-privacy-erasure.v1";
const CRYPTO_DOMAIN = "leaderbot.messenger-privacy-erasure.v2";
const LEASE_MS = 5 * 60_000;
const MIN_SECRET_BYTES = 32;
const MAX_ATTEMPTS_PER_POLL = 10;
const MAX_READINESS_PENDING_JOBS = 500;
const MAX_ENCRYPTION_KEYS = 16;
const MAX_ENVELOPE_BYTES = 1_024;
const MAX_PSID_BYTES = 512;
const WORKER_PROCESS_ID = randomUUID();
const WORKER_STARTED_AT = Date.now();
const WORKER_HEARTBEAT_KEY = `messenger-privacy-erasure:${KEY_TAG}:worker:${WORKER_PROCESS_ID}`;
const WORKER_HEARTBEAT_TTL_SECONDS = 2 * 60;
const WORKER_HEARTBEAT_MAX_AGE_MS = 30_000;
const WORKER_OVERDUE_GRACE_MS = 60_000;
const ENCRYPTION_ACTIVE_KEY_ID_ENV =
  "MESSENGER_PRIVACY_ERASURE_ENCRYPTION_ACTIVE_KEY_ID";
const ENCRYPTION_KEYS_ENV = "MESSENGER_PRIVACY_ERASURE_ENCRYPTION_KEYS_JSON";
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

export type MessengerPrivacyErasureJobScope = {
  channel?: "facebook_messenger" | "whatsapp";
  workspaceId: number;
  channelConnectionId: number;
  pageId: string;
  bindingEpoch: number;
  userKey: string;
  oldPrivacyEpoch: number;
};

export type MessengerPrivacyErasureJob = MessengerPrivacyErasureJobScope & {
  version: 1;
  jobId: string;
  sealedPsid: string;
  erasureEpoch: number | null;
  attemptCount: number;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt: number;
  lastErrorCode: string | null;
};

export type ClaimedMessengerPrivacyErasureJob = {
  job: MessengerPrivacyErasureJob;
  psid: string;
  leaseToken: string;
};

type MessengerPrivacyErasureEncryptionKeyring = {
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
};

type OpenedPsid = {
  psid: string;
  needsRewrap: boolean;
};

type MessengerPrivacyErasureWorkerHeartbeat = {
  version: 1;
  processId: string;
  startedAt: number;
  lastPollAt: number;
  lastSuccessfulPollAt: number | null;
  status: "healthy" | "failed";
  lastClaimCount: number;
  errorCode: string | null;
};

let workerLastSuccessfulPollAt: number | null = null;

function deriveLegacySecretKey(purpose: "job-id" | "seal"): Buffer {
  const secret = getConfiguredJwtSecret();
  if (Buffer.byteLength(secret, "utf8") < MIN_SECRET_BYTES) {
    throw new Error(
      "JWT_SECRET must be at least 32 bytes for Messenger privacy erasure"
    );
  }
  return createHmac("sha256", secret)
    .update(LEGACY_CRYPTO_DOMAIN)
    .update("\0")
    .update(purpose)
    .digest();
}

function getEncryptionKeyring(): MessengerPrivacyErasureEncryptionKeyring {
  const activeKeyId = process.env[ENCRYPTION_ACTIVE_KEY_ID_ENV]?.trim() ?? "";
  const encodedKeyring = process.env[ENCRYPTION_KEYS_ENV]?.trim() ?? "";
  if (!KEY_ID_PATTERN.test(activeKeyId)) {
    throw new Error(
      `${ENCRYPTION_ACTIVE_KEY_ID_ENV} must contain a valid key id`
    );
  }
  if (!encodedKeyring || Buffer.byteLength(encodedKeyring, "utf8") > 16_384) {
    throw new Error(
      `${ENCRYPTION_KEYS_ENV} must contain a bounded JSON keyring`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(encodedKeyring);
  } catch {
    throw new Error(`${ENCRYPTION_KEYS_ENV} must contain valid JSON`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.length > MAX_ENCRYPTION_KEYS
  ) {
    throw new Error(
      `${ENCRYPTION_KEYS_ENV} must contain 1-${MAX_ENCRYPTION_KEYS} keys`
    );
  }

  const keys = new Map<string, Buffer>();
  for (const entry of parsed) {
    if (!isExactEncryptionKeyEntry(entry)) {
      throw new Error(`${ENCRYPTION_KEYS_ENV} contains an invalid key entry`);
    }
    if (keys.has(entry.id)) {
      throw new Error(`${ENCRYPTION_KEYS_ENV} contains a duplicate key id`);
    }
    const key = decodeCanonicalBase64Url(entry.key, "encryption key");
    if (key.length !== 32) {
      throw new Error(`${ENCRYPTION_KEYS_ENV} keys must decode to 32 bytes`);
    }
    keys.set(entry.id, key);
  }
  if (!keys.has(activeKeyId)) {
    throw new Error(
      `${ENCRYPTION_ACTIVE_KEY_ID_ENV} is not present in ${ENCRYPTION_KEYS_ENV}`
    );
  }
  return { activeKeyId, keys };
}

function isExactEncryptionKeyEntry(
  value: unknown
): value is { id: string; key: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const names = Object.keys(record).sort();
  return (
    names.length === 2 &&
    names[0] === "id" &&
    names[1] === "key" &&
    typeof record.id === "string" &&
    KEY_ID_PATTERN.test(record.id) &&
    typeof record.key === "string"
  );
}

function decodeCanonicalBase64Url(value: string, label: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`Messenger privacy erasure ${label} is invalid`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length === 0 || decoded.toString("base64url") !== value) {
    throw new Error(`Messenger privacy erasure ${label} is invalid`);
  }
  return decoded;
}

export function assertMessengerPrivacyErasureEncryptionConfig(): void {
  void getEncryptionKeyring();
}

/**
 * Proves that every durable pending erasure job is still decryptable before
 * reporting ready. The atomic Redis snapshot avoids a transient false alarm
 * when a worker completes a job between reading the pending index and its
 * payload. A larger backlog fails closed instead of silently sampling it.
 */
export async function ensureMessengerPrivacyErasureQueueReadable(): Promise<void> {
  assertMessengerPrivacyErasureEncryptionConfig();
  if (!isRedisEnabled()) return;

  const redis = await getRedisClient();
  const snapshot = (await redis.eval(
    `
      local pendingType = redis.call("TYPE", KEYS[1]).ok
      if pendingType ~= "none" and pendingType ~= "zset" then
        return redis.error_reply("privacy erasure pending key has invalid type")
      end
      local count = redis.call("ZCARD", KEYS[1])
      if count > tonumber(ARGV[1]) then
        return {"backlog", tostring(count)}
      end
      local result = {"jobs", tostring(count)}
      local ids = redis.call("ZRANGE", KEYS[1], 0, -1, "WITHSCORES")
      for index = 1, #ids, 2 do
        local id = ids[index]
        local score = ids[index + 1]
        local raw = redis.call("GET", ARGV[2] .. id)
        if not raw then
          return redis.error_reply("privacy erasure pending job is missing")
        end
        table.insert(result, id)
        table.insert(result, raw)
        table.insert(result, score)
      end
      return result
    `,
    1,
    PENDING_KEY,
    MAX_READINESS_PENDING_JOBS,
    JOB_PREFIX
  )) as string[];

  if (snapshot[0] === "backlog") {
    throw new Error("Messenger privacy erasure readiness backlog exceeded");
  }
  if (snapshot[0] !== "jobs") {
    throw new Error("Messenger privacy erasure readiness snapshot is invalid");
  }
  const count = Number(snapshot[1]);
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    snapshot.length !== 2 + count * 3
  ) {
    throw new Error("Messenger privacy erasure readiness snapshot is invalid");
  }
  for (let index = 0; index < count; index += 1) {
    const jobId = snapshot[2 + index * 3];
    const raw = snapshot[3 + index * 3];
    const rawScore = snapshot[4 + index * 3];
    if (!jobId || !raw || !rawScore) {
      throw new Error(
        "Messenger privacy erasure readiness snapshot is invalid"
      );
    }
    const job = parseJob(raw);
    if (job.jobId !== jobId) {
      throw new Error("Messenger privacy erasure job identity mismatch");
    }
    const score = Number(rawScore);
    if (!Number.isFinite(score) || score !== job.nextAttemptAt) {
      throw new Error("Messenger privacy erasure pending score mismatch");
    }
    void openPsid(job);
  }
}

function workerErrorCode(error: unknown): string {
  const name = error instanceof Error ? error.constructor.name : "UnknownError";
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "UnknownError";
}

function parseWorkerHeartbeat(
  raw: string
): MessengerPrivacyErasureWorkerHeartbeat {
  const value = JSON.parse(
    raw
  ) as Partial<MessengerPrivacyErasureWorkerHeartbeat>;
  if (
    !value ||
    value.version !== 1 ||
    value.processId !== WORKER_PROCESS_ID ||
    !Number.isSafeInteger(value.startedAt) ||
    Number(value.startedAt) < 0 ||
    !Number.isSafeInteger(value.lastPollAt) ||
    Number(value.lastPollAt) < 0 ||
    (value.lastSuccessfulPollAt !== null &&
      (!Number.isSafeInteger(value.lastSuccessfulPollAt) ||
        Number(value.lastSuccessfulPollAt) < 0)) ||
    (value.status !== "healthy" && value.status !== "failed") ||
    !Number.isSafeInteger(value.lastClaimCount) ||
    Number(value.lastClaimCount) < 0 ||
    (value.errorCode !== null &&
      (typeof value.errorCode !== "string" ||
        !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value.errorCode)))
  ) {
    throw new Error("Messenger privacy erasure worker heartbeat is invalid");
  }
  return value as MessengerPrivacyErasureWorkerHeartbeat;
}

async function storeWorkerHeartbeat(
  heartbeat: MessengerPrivacyErasureWorkerHeartbeat
): Promise<void> {
  const redis = await getRedisClient();
  const result = await redis.set(
    WORKER_HEARTBEAT_KEY,
    JSON.stringify(heartbeat),
    "EX",
    WORKER_HEARTBEAT_TTL_SECONDS
  );
  if (result !== "OK") {
    throw new Error("Messenger privacy erasure worker heartbeat write failed");
  }
}

export async function recordMessengerPrivacyErasureWorkerPollSuccess(
  claimCount: number,
  now = Date.now()
): Promise<void> {
  if (!isRedisEnabled()) return;
  if (
    !Number.isSafeInteger(claimCount) ||
    claimCount < 0 ||
    !Number.isSafeInteger(now) ||
    now < 0
  ) {
    throw new Error(
      "Messenger privacy erasure worker poll metadata is invalid"
    );
  }
  const heartbeat = {
    version: 1,
    processId: WORKER_PROCESS_ID,
    startedAt: WORKER_STARTED_AT,
    lastPollAt: now,
    lastSuccessfulPollAt: now,
    status: "healthy",
    lastClaimCount: claimCount,
    errorCode: null,
  } satisfies MessengerPrivacyErasureWorkerHeartbeat;
  await storeWorkerHeartbeat(heartbeat);
  workerLastSuccessfulPollAt = now;
}

export async function recordMessengerPrivacyErasureWorkerPollFailure(
  error: unknown,
  now = Date.now()
): Promise<void> {
  if (!isRedisEnabled()) return;
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error(
      "Messenger privacy erasure worker poll metadata is invalid"
    );
  }
  await storeWorkerHeartbeat({
    version: 1,
    processId: WORKER_PROCESS_ID,
    startedAt: WORKER_STARTED_AT,
    lastPollAt: now,
    lastSuccessfulPollAt: workerLastSuccessfulPollAt,
    status: "failed",
    lastClaimCount: 0,
    errorCode: workerErrorCode(error),
  });
}

/**
 * Requires this process to have completed a recent poll and rejects an overdue
 * durable job. The snapshot contains only process timing and queue counts; it
 * never reads an erasure envelope or customer identifier.
 */
export async function ensureMessengerPrivacyErasureWorkerReady(
  now = Date.now()
): Promise<void> {
  if (!isRedisEnabled()) return;
  const redis = await getRedisClient();
  const snapshot = (await redis.eval(
    `
      local heartbeatType = redis.call("TYPE", KEYS[1]).ok
      local pendingType = redis.call("TYPE", KEYS[2]).ok
      if heartbeatType ~= "none" and heartbeatType ~= "string" then
        return redis.error_reply("privacy erasure heartbeat key has invalid type")
      end
      if pendingType ~= "none" and pendingType ~= "zset" then
        return redis.error_reply("privacy erasure pending key has invalid type")
      end
      local oldest = redis.call("ZRANGE", KEYS[2], 0, 0, "WITHSCORES")
      return {
        redis.call("GET", KEYS[1]) or "",
        tostring(redis.call("ZCARD", KEYS[2])),
        oldest[2] or ""
      }
    `,
    2,
    WORKER_HEARTBEAT_KEY,
    PENDING_KEY
  )) as string[];
  if (!Array.isArray(snapshot) || snapshot.length !== 3) {
    throw new Error("Messenger privacy erasure worker snapshot is invalid");
  }
  const [rawHeartbeat, rawPendingCount, rawOldestDueAt] = snapshot;
  if (!rawHeartbeat) {
    throw new Error("Messenger privacy erasure worker has not polled");
  }
  const heartbeat = parseWorkerHeartbeat(rawHeartbeat);
  if (
    heartbeat.status !== "healthy" ||
    heartbeat.lastSuccessfulPollAt === null
  ) {
    throw new Error("Messenger privacy erasure worker last poll failed");
  }
  if (
    heartbeat.lastSuccessfulPollAt > now + 5_000 ||
    now - heartbeat.lastSuccessfulPollAt > WORKER_HEARTBEAT_MAX_AGE_MS
  ) {
    throw new Error("Messenger privacy erasure worker heartbeat is stale");
  }
  const pendingCount = Number(rawPendingCount);
  if (!Number.isSafeInteger(pendingCount) || pendingCount < 0) {
    throw new Error("Messenger privacy erasure pending count is invalid");
  }
  if (pendingCount === 0) {
    if (rawOldestDueAt !== "") {
      throw new Error("Messenger privacy erasure queue snapshot is invalid");
    }
    return;
  }
  const oldestDueAt = Number(rawOldestDueAt);
  if (!Number.isFinite(oldestDueAt) || oldestDueAt < 0) {
    throw new Error("Messenger privacy erasure oldest due time is invalid");
  }
  if (oldestDueAt <= now - WORKER_OVERDUE_GRACE_MS) {
    throw new Error("Messenger privacy erasure backlog is overdue");
  }
}

function validateScope(scope: MessengerPrivacyErasureJobScope): void {
  if (
    (scope.channel !== undefined &&
      scope.channel !== "facebook_messenger" &&
      scope.channel !== "whatsapp") ||
    !Number.isSafeInteger(scope.workspaceId) ||
    scope.workspaceId <= 0 ||
    !Number.isSafeInteger(scope.channelConnectionId) ||
    scope.channelConnectionId <= 0 ||
    !scope.pageId.trim() ||
    !Number.isSafeInteger(scope.bindingEpoch) ||
    scope.bindingEpoch <= 0 ||
    !/^[A-Za-z0-9:_-]{16,96}$/.test(scope.userKey) ||
    !Number.isSafeInteger(scope.oldPrivacyEpoch) ||
    scope.oldPrivacyEpoch <= 0
  ) {
    throw new Error("Messenger privacy erasure scope is invalid");
  }
}

function scopePayload(scope: MessengerPrivacyErasureJobScope): string {
  return JSON.stringify({
    channel: scope.channel ?? "facebook_messenger",
    workspaceId: scope.workspaceId,
    channelConnectionId: scope.channelConnectionId,
    pageId: scope.pageId.trim(),
    bindingEpoch: scope.bindingEpoch,
    userKey: scope.userKey,
    oldPrivacyEpoch: scope.oldPrivacyEpoch,
  });
}

function jobScope(
  job: MessengerPrivacyErasureJobScope
): MessengerPrivacyErasureJobScope {
  return {
    channel: job.channel ?? "facebook_messenger",
    workspaceId: job.workspaceId,
    channelConnectionId: job.channelConnectionId,
    pageId: job.pageId,
    bindingEpoch: job.bindingEpoch,
    userKey: job.userKey,
    oldPrivacyEpoch: job.oldPrivacyEpoch,
  };
}

function createJobId(
  psid: string,
  scope: MessengerPrivacyErasureJobScope
): string {
  return createHmac("sha256", deriveLegacySecretKey("job-id"))
    .update("job\0")
    .update(scopePayload(scope))
    .update("\0")
    .update(psid)
    .digest("hex");
}

function legacyAad(
  jobId: string,
  scope: MessengerPrivacyErasureJobScope
): Buffer {
  return Buffer.from(
    JSON.stringify({ domain: LEGACY_CRYPTO_DOMAIN, jobId, ...scope }),
    "utf8"
  );
}

function encryptionAad(
  jobId: string,
  scope: MessengerPrivacyErasureJobScope,
  keyId: string
): Buffer {
  return Buffer.from(
    JSON.stringify({ domain: CRYPTO_DOMAIN, keyId, jobId, ...scope }),
    "utf8"
  );
}

function sealPsidV2(
  psid: string,
  jobId: string,
  scope: MessengerPrivacyErasureJobScope,
  keyring = getEncryptionKeyring()
): string {
  validatePsid(psid);
  const key = keyring.keys.get(keyring.activeKeyId);
  if (!key) {
    throw new Error(
      "Messenger privacy erasure active encryption key is missing"
    );
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(encryptionAad(jobId, scope, keyring.activeKeyId));
  const ciphertext = Buffer.concat([
    cipher.update(psid, "utf8"),
    cipher.final(),
  ]);
  return `v2:${keyring.activeKeyId}:${iv.toString("base64url")}:${cipher
    .getAuthTag()
    .toString("base64url")}:${ciphertext.toString("base64url")}`;
}

function openPsid(job: MessengerPrivacyErasureJob): OpenedPsid {
  if (Buffer.byteLength(job.sealedPsid, "utf8") > MAX_ENVELOPE_BYTES) {
    throw new Error("Messenger privacy erasure envelope is invalid");
  }
  const parts = job.sealedPsid.split(":");
  if (parts[0] === "v1" && parts.length === 4) {
    const psid = decryptPsid({
      ivValue: parts[1],
      tagValue: parts[2],
      ciphertextValue: parts[3],
      key: deriveLegacySecretKey("seal"),
      aadValue: legacyAad(job.jobId, jobScope(job)),
    });
    return { psid, needsRewrap: true };
  }
  if (parts[0] !== "v2" || parts.length !== 5) {
    throw new Error("Messenger privacy erasure envelope is invalid");
  }
  const keyId = parts[1];
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new Error("Messenger privacy erasure envelope key id is invalid");
  }
  const keyring = getEncryptionKeyring();
  const key = keyring.keys.get(keyId);
  if (!key) {
    throw new Error("Messenger privacy erasure envelope key is unavailable");
  }
  const psid = decryptPsid({
    ivValue: parts[2],
    tagValue: parts[3],
    ciphertextValue: parts[4],
    key,
    aadValue: encryptionAad(job.jobId, jobScope(job), keyId),
  });
  return { psid, needsRewrap: keyId !== keyring.activeKeyId };
}

function decryptPsid(input: {
  ivValue: string;
  tagValue: string;
  ciphertextValue: string;
  key: Buffer;
  aadValue: Buffer;
}): string {
  try {
    const iv = decodeCanonicalBase64Url(input.ivValue, "envelope IV");
    const tag = decodeCanonicalBase64Url(input.tagValue, "envelope tag");
    const ciphertext = decodeCanonicalBase64Url(
      input.ciphertextValue,
      "envelope ciphertext"
    );
    if (
      iv.length !== 12 ||
      tag.length !== 16 ||
      ciphertext.length > MAX_PSID_BYTES
    ) {
      throw new Error("invalid envelope length");
    }
    const decipher = createDecipheriv("aes-256-gcm", input.key, iv);
    decipher.setAAD(input.aadValue);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    const psid = plaintext.toString("utf8");
    if (!Buffer.from(psid, "utf8").equals(plaintext)) {
      throw new Error("invalid UTF-8");
    }
    validatePsid(psid);
    return psid;
  } catch {
    throw new Error("Messenger privacy erasure envelope could not be opened");
  }
}

function validatePsid(psid: string): void {
  const bytes = Buffer.byteLength(psid, "utf8");
  if (
    bytes === 0 ||
    bytes > MAX_PSID_BYTES ||
    /[\u0000-\u001f\u007f]/.test(psid)
  ) {
    throw new Error("Messenger privacy erasure subject is invalid");
  }
}

function jobKey(jobId: string): string {
  return `${JOB_PREFIX}${jobId}`;
}

function leaseKey(jobId: string): string {
  return `${LEASE_PREFIX}${jobId}`;
}

function parseJob(raw: string): MessengerPrivacyErasureJob {
  const job = JSON.parse(raw) as MessengerPrivacyErasureJob;
  validateScope(job);
  if (
    job.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(job.jobId) ||
    !job.sealedPsid ||
    (job.erasureEpoch !== null &&
      (!Number.isSafeInteger(job.erasureEpoch) || job.erasureEpoch <= 0)) ||
    !Number.isSafeInteger(job.attemptCount) ||
    job.attemptCount < 0 ||
    !Number.isFinite(job.createdAt) ||
    !Number.isFinite(job.updatedAt) ||
    !Number.isFinite(job.nextAttemptAt)
  ) {
    throw new Error("Messenger privacy erasure job is invalid");
  }
  return job;
}

function sameText(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function enqueueMessengerPrivacyErasureJob(input: {
  psid: string;
  scope: MessengerPrivacyErasureJobScope;
  now?: number;
}): Promise<string> {
  if (!isRedisEnabled()) {
    throw new Error("Redis is required for Messenger privacy erasure");
  }
  validateScope(input.scope);
  validatePsid(input.psid);
  const now = input.now ?? Date.now();
  const scope: MessengerPrivacyErasureJobScope = {
    channel: input.scope.channel ?? "facebook_messenger",
    workspaceId: input.scope.workspaceId,
    channelConnectionId: input.scope.channelConnectionId,
    pageId: input.scope.pageId.trim(),
    bindingEpoch: input.scope.bindingEpoch,
    userKey: input.scope.userKey,
    oldPrivacyEpoch: input.scope.oldPrivacyEpoch,
  };
  const jobId = createJobId(input.psid, scope);
  const job: MessengerPrivacyErasureJob = {
    version: 1,
    jobId,
    ...scope,
    sealedPsid: sealPsidV2(input.psid, jobId, scope),
    erasureEpoch: null,
    attemptCount: 0,
    createdAt: now,
    updatedAt: now,
    nextAttemptAt: now,
    lastErrorCode: null,
  };
  const redis = await getRedisClient();
  const storedRaw = (await redis.eval(
    `
      local jobType = redis.call("TYPE", KEYS[1]).ok
      local pendingType = redis.call("TYPE", KEYS[2]).ok
      if jobType ~= "none" and jobType ~= "string" then
        return redis.error_reply("privacy erasure job key has invalid type")
      end
      if pendingType ~= "none" and pendingType ~= "zset" then
        return redis.error_reply("privacy erasure pending key has invalid type")
      end
      local current = redis.call("GET", KEYS[1])
      if not current then
        redis.call("SET", KEYS[1], ARGV[1])
        current = ARGV[1]
      end
      redis.call("ZADD", KEYS[2], ARGV[2], ARGV[3])
      return current
    `,
    2,
    jobKey(jobId),
    PENDING_KEY,
    JSON.stringify(job),
    now,
    jobId
  )) as string;
  const stored = parseJob(storedRaw);
  if (
    stored.jobId !== jobId ||
    scopePayload(stored) !== scopePayload(scope) ||
    !sameText(openPsid(stored).psid, input.psid)
  ) {
    throw new Error("Messenger privacy erasure job identity mismatch");
  }
  return jobId;
}

async function claimJob(
  jobId: string,
  now = Date.now()
): Promise<ClaimedMessengerPrivacyErasureJob | null> {
  if (!/^[a-f0-9]{64}$/.test(jobId)) return null;
  const redis = await getRedisClient();
  const leaseToken = randomUUID();
  const acquired = await redis.set(
    leaseKey(jobId),
    leaseToken,
    "PX",
    LEASE_MS,
    "NX"
  );
  if (acquired !== "OK") return null;
  try {
    const raw = await redis.get(jobKey(jobId));
    if (!raw) {
      await releaseLease(jobId, leaseToken);
      return null;
    }
    const job = parseJob(raw);
    if (job.jobId !== jobId) {
      throw new Error("Messenger privacy erasure job identity mismatch");
    }
    if (job.nextAttemptAt > now) {
      await releaseLease(jobId, leaseToken);
      return null;
    }
    const opened = openPsid(job);
    const claim = { job, psid: opened.psid, leaseToken };
    if (opened.needsRewrap) {
      const next = {
        ...job,
        sealedPsid: sealPsidV2(opened.psid, job.jobId, jobScope(job)),
      } satisfies MessengerPrivacyErasureJob;
      await writeClaimedJob(claim, next);
      claim.job = next;
    }
    return claim;
  } catch (error) {
    await releaseLease(jobId, leaseToken);
    throw error;
  }
}

export function claimMessengerPrivacyErasureJob(
  jobId: string,
  now = Date.now()
): Promise<ClaimedMessengerPrivacyErasureJob | null> {
  return claimJob(jobId, now);
}

export async function claimDueMessengerPrivacyErasureJobs(
  now = Date.now(),
  limit = MAX_ATTEMPTS_PER_POLL
): Promise<ClaimedMessengerPrivacyErasureJob[]> {
  const redis = await getRedisClient();
  const desired = Math.max(
    1,
    Math.min(MAX_ATTEMPTS_PER_POLL, Math.floor(limit))
  );
  // Read ahead so leases held by another replica cannot head-of-line block
  // unrelated subjects. The pending score still provides oldest-due fairness.
  const candidateLimit = Math.min(100, Math.max(25, desired * 10));
  const ids = (await redis.eval(
    `return redis.call("ZRANGEBYSCORE", KEYS[1], "-inf", ARGV[1], "LIMIT", 0, ARGV[2])`,
    1,
    PENDING_KEY,
    now,
    candidateLimit
  )) as string[];
  const candidateGroups = new Map<string, string[]>();
  for (const id of ids) {
    try {
      const raw = await redis.get(jobKey(id));
      if (!raw) throw new Error("Messenger privacy erasure job is missing");
      const job = parseJob(raw);
      if (job.jobId !== id) {
        throw new Error("Messenger privacy erasure job identity mismatch");
      }
      const groupKey = `${job.workspaceId}:${job.channelConnectionId}`;
      const group = candidateGroups.get(groupKey) ?? [];
      group.push(id);
      candidateGroups.set(groupKey, group);
    } catch (error) {
      await deferUnreadableJob(redis, id, now, error);
    }
  }

  // Round-robin exact tenant/connection groups before taking leases. A single
  // noisy workspace cannot consume the whole bounded poll while another
  // tenant has due privacy work.
  const orderedIds: string[] = [];
  while (candidateGroups.size > 0) {
    for (const [groupKey, group] of candidateGroups) {
      const id = group.shift();
      if (id) orderedIds.push(id);
      if (group.length === 0) candidateGroups.delete(groupKey);
    }
  }

  const claimed: ClaimedMessengerPrivacyErasureJob[] = [];
  for (const id of orderedIds) {
    try {
      const job = await claimJob(id, now);
      if (job) claimed.push(job);
    } catch (error) {
      await deferUnreadableJob(redis, id, now, error);
    }
    if (claimed.length >= desired) break;
  }
  return claimed;
}

async function deferUnreadableJob(
  redis: Awaited<ReturnType<typeof getRedisClient>>,
  jobId: string,
  now: number,
  error: unknown
): Promise<void> {
  // Keep corrupt/temporarily unreadable work durable, move it behind healthy
  // subjects, and continue the bounded batch instead of head-of-line blocking.
  await redis.eval(
    `redis.call("ZADD", KEYS[1], ARGV[1], ARGV[2]); return 1`,
    1,
    PENDING_KEY,
    now + 15 * 60_000,
    jobId
  );
  safeLog("messenger_privacy_erasure_job_unreadable", {
    level: "error",
    jobId,
    errorCode: error instanceof Error ? error.constructor.name : "UnknownError",
  });
}

export async function setMessengerPrivacyErasureEpoch(input: {
  claim: ClaimedMessengerPrivacyErasureJob;
  erasureEpoch: number;
  now?: number;
}): Promise<MessengerPrivacyErasureJob> {
  const now = input.now ?? Date.now();
  const next = {
    ...input.claim.job,
    erasureEpoch: input.erasureEpoch,
    updatedAt: now,
    nextAttemptAt: now,
    lastErrorCode: null,
  } satisfies MessengerPrivacyErasureJob;
  await writeClaimedJob(input.claim, next);
  input.claim.job = next;
  return next;
}

async function writeClaimedJob(
  claim: ClaimedMessengerPrivacyErasureJob,
  next: MessengerPrivacyErasureJob
): Promise<void> {
  const redis = await getRedisClient();
  const result = Number(
    await redis.eval(
      `
        if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
        local jobType = redis.call("TYPE", KEYS[2]).ok
        local pendingType = redis.call("TYPE", KEYS[3]).ok
        if jobType ~= "string" or pendingType ~= "zset" then return 0 end
        redis.call("SET", KEYS[2], ARGV[2])
        redis.call("ZADD", KEYS[3], ARGV[3], ARGV[4])
        return 1
      `,
      3,
      leaseKey(claim.job.jobId),
      jobKey(claim.job.jobId),
      PENDING_KEY,
      claim.leaseToken,
      JSON.stringify(next),
      next.nextAttemptAt,
      next.jobId
    )
  );
  if (result !== 1) throw new Error("Messenger privacy erasure lease was lost");
}

export async function rescheduleMessengerPrivacyErasureJob(input: {
  claim: ClaimedMessengerPrivacyErasureJob;
  errorCode: string;
  now?: number;
}): Promise<void> {
  const now = input.now ?? Date.now();
  const attemptCount = input.claim.job.attemptCount + 1;
  const delay = Math.min(15 * 60_000, 1_000 * 2 ** Math.min(attemptCount, 9));
  const next: MessengerPrivacyErasureJob = {
    ...input.claim.job,
    attemptCount,
    updatedAt: now,
    nextAttemptAt: now + delay,
    lastErrorCode: /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(input.errorCode)
      ? input.errorCode
      : "UnknownError",
  };
  await writeClaimedJob(input.claim, next);
  await releaseLease(input.claim.job.jobId, input.claim.leaseToken);
}

/** Proves that a pending processor result was durably advanced and unlocked. */
export async function assertMessengerPrivacyErasureRetryStored(
  claim: ClaimedMessengerPrivacyErasureJob
): Promise<void> {
  const redis = await getRedisClient();
  const snapshot = (await redis.eval(
    `
      return {
        redis.call("GET", KEYS[1]) or "",
        redis.call("GET", KEYS[2]) or "",
        redis.call("ZSCORE", KEYS[3], ARGV[1]) or ""
      }
    `,
    3,
    leaseKey(claim.job.jobId),
    jobKey(claim.job.jobId),
    PENDING_KEY,
    claim.job.jobId
  )) as string[];
  if (
    !Array.isArray(snapshot) ||
    snapshot.length !== 3 ||
    snapshot[0] !== "" ||
    !snapshot[1] ||
    !snapshot[2]
  ) {
    throw new Error("Messenger privacy erasure retry was not durably stored");
  }
  const stored = parseJob(snapshot[1]);
  const storedScore = Number(snapshot[2]);
  if (
    stored.jobId !== claim.job.jobId ||
    stored.attemptCount !== claim.job.attemptCount + 1 ||
    !Number.isFinite(storedScore) ||
    storedScore !== stored.nextAttemptAt
  ) {
    throw new Error("Messenger privacy erasure retry was not durably stored");
  }
}

export async function completeMessengerPrivacyErasureJob(
  claim: ClaimedMessengerPrivacyErasureJob
): Promise<void> {
  const redis = await getRedisClient();
  const result = Number(
    await redis.eval(
      `
        if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
        local jobType = redis.call("TYPE", KEYS[2]).ok
        local pendingType = redis.call("TYPE", KEYS[3]).ok
        if jobType ~= "string" or pendingType ~= "zset" then return 0 end
        redis.call("DEL", KEYS[2])
        redis.call("ZREM", KEYS[3], ARGV[2])
        redis.call("DEL", KEYS[1])
        return 1
      `,
      3,
      leaseKey(claim.job.jobId),
      jobKey(claim.job.jobId),
      PENDING_KEY,
      claim.leaseToken,
      claim.job.jobId
    )
  );
  if (result !== 1) throw new Error("Messenger privacy erasure lease was lost");
}

async function releaseLease(jobId: string, leaseToken: string): Promise<void> {
  const redis = await getRedisClient();
  await redis.eval(
    `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      end
      return 0
    `,
    1,
    leaseKey(jobId),
    leaseToken
  );
}

export async function getMessengerPrivacyErasurePendingCount(): Promise<number> {
  const redis = await getRedisClient();
  return Number(
    await redis.eval(`return redis.call("ZCARD", KEYS[1])`, 1, PENDING_KEY)
  );
}
