import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import {
  getConversationIdentityKey,
  type ConversationIdentityKey,
  type ConversationScopeKeyId,
} from "./conversationIdentityConfig";
import {
  ConversationBoundaryEnvelopeError,
  requireVerifiedQueuedConversationSubjectV2,
  type VerifiedQueuedConversationBoundaryV2,
} from "./conversationBoundaryEnvelope";
import { getRedisClient, isRedisEnabled, type RedisLike } from "./redis";

const REPLAY_MAGIC = Buffer.from("leaderbot.webhook.replay\0", "ascii");
const REPLAY_VERSION = 2;
const REPLAY_PURPOSE_CLAIM = 1;
const DEFAULT_REPLAY_TTL_SECONDS = 300;
const DEFAULT_PROCESSING_LEASE_SECONDS = 30;
const MAX_META_MESSAGE_ID_BYTES = 1_024;
const CLAIM_ID_PATTERN = /^rc2\.[0-9a-f]{32}$/;
const LEASE_OWNER_TOKEN_PATTERN = /^ro2\.[0-9a-f]{32}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const PROCESSING_VALUE_PREFIX = "processing:";
const COMPLETED_VALUE_PREFIX = "completed:";
const READINESS_EVAL_SCRIPT = "return 1";
const COMPLETE_REPLAY_CLAIM_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if current == ARGV[1] then
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

declare const webhookReplayClaimIdBrand: unique symbol;
declare const webhookReplayLeaseOwnerTokenBrand: unique symbol;
const webhookReplayLeaseBrand: unique symbol = Symbol("webhookReplayLeaseV2");
const webhookReplayLeases = new WeakSet<object>();

export type WebhookReplayClaimIdV2 = string & {
  readonly [webhookReplayClaimIdBrand]: true;
};

export type WebhookReplayLeaseOwnerTokenV2 = string & {
  readonly [webhookReplayLeaseOwnerTokenBrand]: true;
};

export type WebhookReplayLeaseV2 = Readonly<{
  replayKey: string;
  replayClaimId: WebhookReplayClaimIdV2;
  leaseOwnerToken: WebhookReplayLeaseOwnerTokenV2;
  [webhookReplayLeaseBrand]: true;
}>;

export type WebhookReplayClaimResultV2 =
  | Readonly<{
      status: "acquired";
      lease: WebhookReplayLeaseV2;
    }>
  | Readonly<{
      status: "duplicate";
    }>;

export type WebhookReplayEventIdentityV2 =
  | Readonly<{
      kind: "meta_message_id";
      id: string;
    }>
  | Readonly<{
      kind: "canonical_fallback_sha256";
      digest: string;
    }>;

export type WebhookReplayV2ErrorCode =
  | "invalid_verified_boundary"
  | "invalid_event_identity"
  | "invalid_claim_id"
  | "lease_owner_unavailable"
  | "identity_key_unavailable"
  | "identity_key_mismatch"
  | "store_unavailable"
  | "invalid_store_response"
  | "claim_busy"
  | "invalid_lease"
  | "lease_lost"
  | "lease_mismatch";

export class WebhookReplayV2Error extends Error {
  readonly code: WebhookReplayV2ErrorCode;
  readonly retryable: boolean;

  constructor(code: WebhookReplayV2ErrorCode, retryable = false) {
    super("Webhook replay protection is unavailable");
    this.name = "WebhookReplayV2Error";
    this.code = code;
    this.retryable = retryable;
  }
}

type WebhookReplayV2Redis = Pick<RedisLike, "eval" | "get" | "ping" | "set">;

export type WebhookReplayV2Deps = Readonly<{
  getIdentityKey: () => ConversationIdentityKey;
  createLeaseOwnerToken: () => WebhookReplayLeaseOwnerTokenV2;
  isRedisEnabled: () => boolean;
  getRedisClient: () => Promise<WebhookReplayV2Redis>;
}>;

export type WebhookReplayV2ReadinessDeps = Pick<
  WebhookReplayV2Deps,
  "getRedisClient" | "isRedisEnabled"
>;

export type WebhookReplayV2StorageDeps = WebhookReplayV2ReadinessDeps;

type ParsedEventIdentity = Readonly<{
  kindByte: 1 | 2;
  bytes: Buffer;
}>;

type StoredReplayState =
  | Readonly<{ status: "missing" }>
  | Readonly<{
      status: "processing" | "completed";
      replayClaimId: WebhookReplayClaimIdV2;
      leaseOwnerToken: WebhookReplayLeaseOwnerTokenV2;
    }>
  | Readonly<{ status: "invalid" }>;

const DUPLICATE_CLAIM_RESULT: WebhookReplayClaimResultV2 = Object.freeze({
  status: "duplicate",
});

export function parseWebhookReplayClaimIdV2(
  value: unknown
): WebhookReplayClaimIdV2 {
  if (typeof value !== "string" || !CLAIM_ID_PATTERN.test(value)) {
    throw new WebhookReplayV2Error("invalid_claim_id");
  }
  return value as WebhookReplayClaimIdV2;
}

export function createWebhookReplayClaimIdV2(): WebhookReplayClaimIdV2 {
  return parseWebhookReplayClaimIdV2(`rc2.${randomBytes(16).toString("hex")}`);
}

function parseWebhookReplayLeaseOwnerTokenV2(
  value: unknown
): WebhookReplayLeaseOwnerTokenV2 {
  if (typeof value !== "string" || !LEASE_OWNER_TOKEN_PATTERN.test(value)) {
    throw new WebhookReplayV2Error("lease_owner_unavailable", true);
  }
  return value as WebhookReplayLeaseOwnerTokenV2;
}

export function createWebhookReplayLeaseOwnerTokenV2(): WebhookReplayLeaseOwnerTokenV2 {
  return parseWebhookReplayLeaseOwnerTokenV2(
    `ro2.${randomBytes(16).toString("hex")}`
  );
}

function getReplayTtlSeconds(): number {
  const raw = Number(process.env.WEBHOOK_REPLAY_TTL_SECONDS);
  if (Number.isSafeInteger(raw) && raw >= DEFAULT_PROCESSING_LEASE_SECONDS) {
    return raw;
  }
  return DEFAULT_REPLAY_TTL_SECONDS;
}

function getProcessingLeaseSeconds(): number {
  return Math.min(DEFAULT_PROCESSING_LEASE_SECONDS, getReplayTtlSeconds());
}

function processingValue(
  replayClaimId: WebhookReplayClaimIdV2,
  leaseOwnerToken: WebhookReplayLeaseOwnerTokenV2
): string {
  return `${PROCESSING_VALUE_PREFIX}${replayClaimId}:${leaseOwnerToken}`;
}

function completedValue(
  replayClaimId: WebhookReplayClaimIdV2,
  leaseOwnerToken: WebhookReplayLeaseOwnerTokenV2
): string {
  return `${COMPLETED_VALUE_PREFIX}${replayClaimId}:${leaseOwnerToken}`;
}

function parseStoredReplayState(value: string | null): StoredReplayState {
  if (value === null) {
    return Object.freeze({ status: "missing" });
  }
  if (value.startsWith(PROCESSING_VALUE_PREFIX)) {
    const [claimId, ownerToken, ...unexpected] = value
      .slice(PROCESSING_VALUE_PREFIX.length)
      .split(":");
    if (
      unexpected.length === 0 &&
      CLAIM_ID_PATTERN.test(claimId ?? "") &&
      LEASE_OWNER_TOKEN_PATTERN.test(ownerToken ?? "")
    ) {
      return Object.freeze({
        status: "processing",
        replayClaimId: claimId as WebhookReplayClaimIdV2,
        leaseOwnerToken: ownerToken as WebhookReplayLeaseOwnerTokenV2,
      });
    }
    return Object.freeze({ status: "invalid" });
  }
  if (value.startsWith(COMPLETED_VALUE_PREFIX)) {
    const [claimId, ownerToken, ...unexpected] = value
      .slice(COMPLETED_VALUE_PREFIX.length)
      .split(":");
    if (
      unexpected.length === 0 &&
      CLAIM_ID_PATTERN.test(claimId ?? "") &&
      LEASE_OWNER_TOKEN_PATTERN.test(ownerToken ?? "")
    ) {
      return Object.freeze({
        status: "completed",
        replayClaimId: claimId as WebhookReplayClaimIdV2,
        leaseOwnerToken: ownerToken as WebhookReplayLeaseOwnerTokenV2,
      });
    }
    return Object.freeze({ status: "invalid" });
  }
  return Object.freeze({ status: "invalid" });
}

function createReplayLease(
  replayKey: string,
  replayClaimId: WebhookReplayClaimIdV2,
  leaseOwnerToken: WebhookReplayLeaseOwnerTokenV2
): WebhookReplayLeaseV2 {
  const lease = {
    replayKey,
    replayClaimId,
    leaseOwnerToken,
  } as WebhookReplayLeaseV2;
  Object.defineProperty(lease, webhookReplayLeaseBrand, { value: true });
  Object.freeze(lease);
  webhookReplayLeases.add(lease);
  return lease;
}

function requireReplayLease(value: WebhookReplayLeaseV2): WebhookReplayLeaseV2 {
  if (
    !value ||
    typeof value !== "object" ||
    !webhookReplayLeases.has(value) ||
    value[webhookReplayLeaseBrand] !== true ||
    typeof value.replayKey !== "string" ||
    !value.replayKey.startsWith("webhook-replay:v2:")
  ) {
    throw new WebhookReplayV2Error("invalid_lease");
  }
  parseWebhookReplayClaimIdV2(value.replayClaimId);
  parseWebhookReplayLeaseOwnerTokenV2(value.leaseOwnerToken);
  return value;
}

function requireRedisEnabled(
  deps: Pick<WebhookReplayV2Deps, "isRedisEnabled">
): void {
  let enabled: boolean;
  try {
    enabled = deps.isRedisEnabled();
  } catch {
    throw new WebhookReplayV2Error("store_unavailable", true);
  }
  if (!enabled) {
    throw new WebhookReplayV2Error("store_unavailable", true);
  }
}

function encodeLength(length: number): Buffer {
  const encoded = Buffer.alloc(4);
  encoded.writeUInt32BE(length);
  return encoded;
}

function encodeUint64(value: number): Buffer {
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64BE(BigInt(value));
  return encoded;
}

function encodeField(tag: number, value: Uint8Array): Buffer[] {
  const bytes = Buffer.from(value);
  return [Buffer.from([tag]), encodeLength(bytes.length), bytes];
}

function parseEventIdentity(
  value: WebhookReplayEventIdentityV2
): ParsedEventIdentity {
  if (!value || typeof value !== "object") {
    throw new WebhookReplayV2Error("invalid_event_identity");
  }

  if (value.kind === "meta_message_id") {
    if (typeof value.id !== "string") {
      throw new WebhookReplayV2Error("invalid_event_identity");
    }
    const bytes = Buffer.from(value.id, "ascii");
    if (
      bytes.length < 1 ||
      bytes.length > MAX_META_MESSAGE_ID_BYTES ||
      !/^[\x21-\x7e]+$/.test(value.id) ||
      bytes.toString("ascii") !== value.id
    ) {
      throw new WebhookReplayV2Error("invalid_event_identity");
    }
    return Object.freeze({ kindByte: 1, bytes });
  }

  if (value.kind === "canonical_fallback_sha256") {
    if (
      typeof value.digest !== "string" ||
      !SHA256_HEX_PATTERN.test(value.digest)
    ) {
      throw new WebhookReplayV2Error("invalid_event_identity");
    }
    return Object.freeze({
      kindByte: 2,
      bytes: Buffer.from(value.digest, "hex"),
    });
  }

  throw new WebhookReplayV2Error("invalid_event_identity");
}

function resolveVerifiedSubject(
  verified: VerifiedQueuedConversationBoundaryV2
) {
  try {
    return requireVerifiedQueuedConversationSubjectV2(verified);
  } catch (error) {
    if (error instanceof ConversationBoundaryEnvelopeError) {
      throw new WebhookReplayV2Error("invalid_verified_boundary");
    }
    throw error;
  }
}

function resolveIdentityKey(
  deps: WebhookReplayV2Deps,
  expectedKeyId: ConversationScopeKeyId
): ConversationIdentityKey {
  let key: ConversationIdentityKey;
  try {
    key = deps.getIdentityKey();
  } catch {
    throw new WebhookReplayV2Error("identity_key_unavailable", true);
  }
  if (key.keyId !== expectedKeyId) {
    throw new WebhookReplayV2Error("identity_key_mismatch");
  }
  return key;
}

function encodeReplayClaim(
  subject: ReturnType<typeof requireVerifiedQueuedConversationSubjectV2>,
  eventIdentity: ParsedEventIdentity,
  keyId: ConversationScopeKeyId
): Buffer {
  const keyIdBytes = Buffer.from(keyId, "utf8");
  return Buffer.concat([
    REPLAY_MAGIC,
    Buffer.from([REPLAY_VERSION, REPLAY_PURPOSE_CLAIM]),
    encodeLength(keyIdBytes.length),
    keyIdBytes,
    ...encodeField(1, encodeUint64(subject.workspaceId)),
    ...encodeField(2, Buffer.from([subject.channel === "messenger" ? 1 : 2])),
    ...encodeField(3, encodeUint64(subject.channelConnectionId)),
    ...encodeField(4, Buffer.from(subject.tenantKey, "ascii")),
    ...encodeField(5, Buffer.from(subject.bindingKey, "ascii")),
    ...encodeField(6, Buffer.from(subject.userKey, "ascii")),
    ...encodeField(7, Buffer.from([eventIdentity.kindByte])),
    ...encodeField(8, eventIdentity.bytes),
  ]);
}

function buildReplayKey(
  verified: VerifiedQueuedConversationBoundaryV2,
  eventIdentity: WebhookReplayEventIdentityV2,
  deps: WebhookReplayV2Deps
): string {
  const subject = resolveVerifiedSubject(verified);
  const parsedEventIdentity = parseEventIdentity(eventIdentity);
  const key = resolveIdentityKey(deps, subject.keyId);
  let digest: Buffer;
  try {
    digest = key.sign(
      encodeReplayClaim(subject, parsedEventIdentity, subject.keyId)
    );
  } catch {
    throw new WebhookReplayV2Error("identity_key_unavailable", true);
  }
  if (!Buffer.isBuffer(digest) || digest.length !== 32) {
    throw new WebhookReplayV2Error("identity_key_unavailable", true);
  }
  return `webhook-replay:v2:{${subject.bindingKey}}:e2.${subject.keyId}.${digest.toString("hex")}`;
}

async function reconcileAmbiguousClaim(
  redis: WebhookReplayV2Redis,
  replayKey: string,
  attemptedOwner: Readonly<{
    replayClaimId: WebhookReplayClaimIdV2;
    leaseOwnerToken: WebhookReplayLeaseOwnerTokenV2;
  }>,
  allowOwnedAcquisition: boolean,
  emptyOwnerError: "store_unavailable" | "invalid_store_response"
): Promise<WebhookReplayClaimResultV2> {
  let storedValue: string | null;
  try {
    storedValue = await redis.get(replayKey);
  } catch {
    throw new WebhookReplayV2Error("store_unavailable", true);
  }

  const stored = parseStoredReplayState(storedValue);
  switch (stored.status) {
    case "completed":
      return DUPLICATE_CLAIM_RESULT;
    case "processing":
      if (
        allowOwnedAcquisition &&
        stored.replayClaimId === attemptedOwner.replayClaimId &&
        stored.leaseOwnerToken === attemptedOwner.leaseOwnerToken
      ) {
        return Object.freeze({
          status: "acquired",
          lease: createReplayLease(
            replayKey,
            attemptedOwner.replayClaimId,
            attemptedOwner.leaseOwnerToken
          ),
        });
      }
      throw new WebhookReplayV2Error("claim_busy", true);
    case "missing":
      throw new WebhookReplayV2Error(emptyOwnerError, true);
    case "invalid":
      throw new WebhookReplayV2Error("invalid_store_response", true);
  }
}

export async function claimWebhookReplayV2WithDeps(input: {
  verified: VerifiedQueuedConversationBoundaryV2;
  eventIdentity: WebhookReplayEventIdentityV2;
  replayClaimId: WebhookReplayClaimIdV2;
  deps: WebhookReplayV2Deps;
}): Promise<WebhookReplayClaimResultV2> {
  const replayClaimId = parseWebhookReplayClaimIdV2(input.replayClaimId);
  let leaseOwnerToken: WebhookReplayLeaseOwnerTokenV2;
  try {
    leaseOwnerToken = parseWebhookReplayLeaseOwnerTokenV2(
      input.deps.createLeaseOwnerToken()
    );
  } catch {
    throw new WebhookReplayV2Error("lease_owner_unavailable", true);
  }
  const attemptedOwner = Object.freeze({ replayClaimId, leaseOwnerToken });
  const replayKey = buildReplayKey(
    input.verified,
    input.eventIdentity,
    input.deps
  );
  requireRedisEnabled(input.deps);

  let redis: WebhookReplayV2Redis;
  try {
    redis = await input.deps.getRedisClient();
  } catch {
    throw new WebhookReplayV2Error("store_unavailable", true);
  }

  let result: unknown;
  try {
    result = await redis.set(
      replayKey,
      processingValue(replayClaimId, leaseOwnerToken),
      "EX",
      getProcessingLeaseSeconds(),
      "NX"
    );
  } catch {
    return await reconcileAmbiguousClaim(
      redis,
      replayKey,
      attemptedOwner,
      true,
      "store_unavailable"
    );
  }
  if (result === "OK") {
    return Object.freeze({
      status: "acquired",
      lease: createReplayLease(replayKey, replayClaimId, leaseOwnerToken),
    });
  }
  if (result === null) {
    return await reconcileAmbiguousClaim(
      redis,
      replayKey,
      attemptedOwner,
      false,
      "store_unavailable"
    );
  }
  return await reconcileAmbiguousClaim(
    redis,
    replayKey,
    attemptedOwner,
    true,
    "invalid_store_response"
  );
}

async function reconcileAmbiguousCompletion(
  redis: WebhookReplayV2Redis,
  lease: WebhookReplayLeaseV2,
  pendingOwnerError: "store_unavailable" | "invalid_store_response"
): Promise<void> {
  let storedValue: string | null;
  try {
    storedValue = await redis.get(lease.replayKey);
  } catch {
    throw new WebhookReplayV2Error("store_unavailable", true);
  }

  const stored = parseStoredReplayState(storedValue);
  if (
    stored.status === "completed" &&
    stored.replayClaimId === lease.replayClaimId &&
    stored.leaseOwnerToken === lease.leaseOwnerToken
  ) {
    return;
  }
  if (
    stored.status === "processing" &&
    stored.replayClaimId === lease.replayClaimId &&
    stored.leaseOwnerToken === lease.leaseOwnerToken
  ) {
    throw new WebhookReplayV2Error(pendingOwnerError, true);
  }
  if (stored.status === "missing") {
    throw new WebhookReplayV2Error("lease_lost", true);
  }
  if (stored.status === "invalid") {
    throw new WebhookReplayV2Error("invalid_store_response", true);
  }
  throw new WebhookReplayV2Error("lease_mismatch");
}

export async function completeWebhookReplayV2WithDeps(input: {
  lease: WebhookReplayLeaseV2;
  deps: WebhookReplayV2StorageDeps;
}): Promise<void> {
  const lease = requireReplayLease(input.lease);
  requireRedisEnabled(input.deps);

  let redis: WebhookReplayV2Redis;
  try {
    redis = await input.deps.getRedisClient();
  } catch {
    throw new WebhookReplayV2Error("store_unavailable", true);
  }

  let result: unknown;
  try {
    result = await redis.eval(
      COMPLETE_REPLAY_CLAIM_SCRIPT,
      1,
      lease.replayKey,
      processingValue(lease.replayClaimId, lease.leaseOwnerToken),
      completedValue(lease.replayClaimId, lease.leaseOwnerToken),
      getReplayTtlSeconds()
    );
  } catch {
    return await reconcileAmbiguousCompletion(
      redis,
      lease,
      "store_unavailable"
    );
  }
  if (result === 1 || result === 2) {
    return;
  }
  if (result === 0) {
    throw new WebhookReplayV2Error("lease_lost", true);
  }
  if (result === -1) {
    throw new WebhookReplayV2Error("lease_mismatch");
  }
  return await reconcileAmbiguousCompletion(
    redis,
    lease,
    "invalid_store_response"
  );
}

const runtimeReplayDeps: WebhookReplayV2Deps = {
  getIdentityKey: getConversationIdentityKey,
  createLeaseOwnerToken: createWebhookReplayLeaseOwnerTokenV2,
  isRedisEnabled,
  getRedisClient,
};

export async function claimWebhookReplayV2(input: {
  verified: VerifiedQueuedConversationBoundaryV2;
  eventIdentity: WebhookReplayEventIdentityV2;
  replayClaimId: WebhookReplayClaimIdV2;
}): Promise<WebhookReplayClaimResultV2> {
  return await claimWebhookReplayV2WithDeps({
    ...input,
    deps: runtimeReplayDeps,
  });
}

export async function completeWebhookReplayV2(
  lease: WebhookReplayLeaseV2
): Promise<void> {
  await completeWebhookReplayV2WithDeps({
    lease,
    deps: runtimeReplayDeps,
  });
}

export async function ensureWebhookReplayV2ReadyWithDeps(
  deps: WebhookReplayV2ReadinessDeps
): Promise<void> {
  requireRedisEnabled(deps);
  let redis: WebhookReplayV2Redis;
  try {
    redis = await deps.getRedisClient();
  } catch {
    throw new WebhookReplayV2Error("store_unavailable", true);
  }
  let response: unknown;
  try {
    response = await redis.ping();
  } catch {
    throw new WebhookReplayV2Error("store_unavailable", true);
  }
  if (response !== "PONG") {
    throw new WebhookReplayV2Error("invalid_store_response", true);
  }
  try {
    response = await redis.eval(READINESS_EVAL_SCRIPT, 0);
  } catch {
    throw new WebhookReplayV2Error("store_unavailable", true);
  }
  if (response !== 1) {
    throw new WebhookReplayV2Error("invalid_store_response", true);
  }
}

export async function ensureWebhookReplayV2Ready(): Promise<void> {
  await ensureWebhookReplayV2ReadyWithDeps(runtimeReplayDeps);
}
