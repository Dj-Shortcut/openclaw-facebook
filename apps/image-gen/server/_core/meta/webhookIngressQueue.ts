import { createHash, randomUUID } from "node:crypto";
import {
  ensureRedisReady,
  getRedisClient,
  isRedisEnabled,
  type RedisLike,
  resetRedisClientForTests,
} from "../redis";
import { safeLog } from "../messengerApi";
import { toUserKey } from "../privacy";
import { ensureActiveMessengerPrivacySubject } from "../messengerPrivacySubject";
import { resolveMessengerGenerationOwnership } from "../workspaceEntitlementRuntime";

const WEBHOOK_INGRESS_QUEUE_KEY = "{meta-webhook-ingress}:queued";
const WEBHOOK_INGRESS_PROCESSING_KEY = "{meta-webhook-ingress}:processing";
const WEBHOOK_INGRESS_DEAD_LETTER_KEY = "{meta-webhook-ingress}:dead";
const WEBHOOK_INGRESS_DELIVERY_PREFIX = "{meta-webhook-ingress}:delivery:";
const WEBHOOK_INGRESS_SUBJECT_PREFIX = "{meta-webhook-ingress}:subject:";
const WEBHOOK_INGRESS_SUBJECT_LEASE_PREFIX =
  "{meta-webhook-ingress}:subject-lease:";
const WEBHOOK_INGRESS_LEASE_PREFIX = "{meta-webhook-ingress}:lease:";
const DEFAULT_WEBHOOK_INGRESS_CONTENT_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_WEBHOOK_INGRESS_DELIVERY_LEASE_SECONDS = 15 * 60;
const DEFAULT_WEBHOOK_INGRESS_MAX_ATTEMPTS = 3;
const DEFAULT_WEBHOOK_INGRESS_RETRY_DELAY_MS = 1_000;
const DEFAULT_WEBHOOK_INGRESS_DEAD_MAX_ITEMS = 1_000;

type WebhookChannel = "facebook" | "whatsapp";

type WebhookIngressSubject = {
  workspaceId: number;
  channelConnectionId: number;
  bindingEpoch: number;
  privacyEpoch: number;
  pageId: string;
  userKey: string;
};

type QueuedWebhookDelivery = {
  deliveryId: string;
  channel: WebhookChannel;
  payload: unknown;
  receivedAt: string;
  expiresAt: number;
  attempts?: number;
  subjects: WebhookIngressSubject[];
};

type ReservedWebhookDelivery = {
  raw: string;
  delivery: QueuedWebhookDelivery;
  legacyInline: boolean;
  subjectLease?: WebhookIngressSubjectLease;
};

type WebhookIngressSubjectLease = {
  keys: string[];
  token: string;
};

let drainPromise: Promise<void> | null = null;
let drainRequested = false;

function serializeError(error: unknown): {
  class: string;
  code?: string | number;
} {
  try {
    const errorClass =
      error instanceof Error ? error.constructor.name : "UnknownError";
    if (!error || typeof error !== "object" || !("code" in error)) {
      return { class: errorClass };
    }

    const code = (error as { code?: unknown }).code;
    if (
      typeof code === "number" &&
      Number.isInteger(code) &&
      code >= 0 &&
      code <= 99_999
    ) {
      return { class: errorClass, code };
    }

    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) {
      return { class: errorClass, code };
    }

    return { class: errorClass };
  } catch {
    return { class: "UnknownError" };
  }
}

function getWebhookIngressDeliveryLeaseSeconds(): number {
  const configured = Number(process.env.WEBHOOK_INGRESS_DELIVERY_LEASE_SECONDS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_WEBHOOK_INGRESS_DELIVERY_LEASE_SECONDS;
}

function getWebhookIngressMaxAttempts(): number {
  const configured = Number(process.env.WEBHOOK_INGRESS_MAX_ATTEMPTS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_WEBHOOK_INGRESS_MAX_ATTEMPTS;
}

function getWebhookIngressRetryDelayMs(): number {
  const configured = Number(process.env.WEBHOOK_INGRESS_RETRY_DELAY_MS);
  const delayMs = Math.floor(configured);
  return Number.isFinite(delayMs) && delayMs >= 1
    ? delayMs
    : DEFAULT_WEBHOOK_INGRESS_RETRY_DELAY_MS;
}

function getWebhookIngressContentTtlSeconds(): number {
  const maximumSeconds = 24 * 60 * 60;
  const minimumSeconds =
    getWebhookIngressDeliveryLeaseSeconds() * getWebhookIngressMaxAttempts();
  if (minimumSeconds > maximumSeconds) {
    throw new Error("Webhook ingress operation exceeds the content TTL cap");
  }
  const configured = Number(process.env.WEBHOOK_INGRESS_CONTENT_TTL_SECONDS);
  const requested =
    Number.isFinite(configured) && configured > 0
      ? Math.floor(configured)
      : DEFAULT_WEBHOOK_INGRESS_CONTENT_TTL_SECONDS;
  if (requested < minimumSeconds || requested > maximumSeconds) {
    throw new Error(
      "WEBHOOK_INGRESS_CONTENT_TTL_SECONDS must cover retries and be at most 24h"
    );
  }
  return requested;
}

function getWebhookIngressDeliveryKey(deliveryId: string): string {
  return `${WEBHOOK_INGRESS_DELIVERY_PREFIX}${deliveryId}`;
}

function isCanonicalWebhookIngressDeliveryId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

function getWebhookIngressSubjectId(
  subject: Pick<
    WebhookIngressSubject,
    "workspaceId" | "channelConnectionId" | "userKey"
  >
): string {
  return createHash("sha256")
    .update(String(subject.workspaceId))
    .update("\0")
    .update(String(subject.channelConnectionId))
    .update("\0")
    .update(subject.userKey)
    .digest("hex");
}

function getWebhookIngressSubjectKey(subject: WebhookIngressSubject): string {
  return `${WEBHOOK_INGRESS_SUBJECT_PREFIX}${getWebhookIngressSubjectId(subject)}`;
}

function getWebhookIngressSubjectLeaseKey(
  subject: WebhookIngressSubject
): string {
  return `${WEBHOOK_INGRESS_SUBJECT_LEASE_PREFIX}${getWebhookIngressSubjectId(subject)}`;
}

function getWebhookIngressSubjectTombstoneKey(
  subject: Pick<
    WebhookIngressSubject,
    "workspaceId" | "channelConnectionId" | "userKey"
  >
): string {
  return `{meta-webhook-ingress}:erased:${getWebhookIngressSubjectId(subject)}`;
}

function getWebhookIngressDeliveryLeaseKey(rawDelivery: string): string {
  if (isCanonicalWebhookIngressDeliveryId(rawDelivery)) {
    return `${WEBHOOK_INGRESS_LEASE_PREFIX}${rawDelivery}`;
  }
  const digest = createHash("sha256").update(rawDelivery).digest("hex");
  return `${WEBHOOK_INGRESS_LEASE_PREFIX}${digest}`;
}

function parseQueuedWebhookDelivery(
  rawDelivery: string
): QueuedWebhookDelivery | null {
  try {
    const parsed = JSON.parse(rawDelivery) as Partial<QueuedWebhookDelivery>;
    const legacyTestDelivery =
      parsed.expiresAt === undefined && process.env.NODE_ENV === "test";
    if (
      (parsed.channel === "facebook" || parsed.channel === "whatsapp") &&
      typeof parsed.receivedAt === "string" &&
      (isWebhookIngressExpiry(parsed.receivedAt, parsed.expiresAt) ||
        legacyTestDelivery) &&
      (parsed.attempts === undefined ||
        (typeof parsed.attempts === "number" &&
          Number.isInteger(parsed.attempts) &&
          parsed.attempts >= 0))
    ) {
      return {
        deliveryId:
          typeof parsed.deliveryId === "string" ? parsed.deliveryId : "legacy",
        channel: parsed.channel,
        payload: parsed.payload,
        receivedAt: legacyTestDelivery
          ? new Date().toISOString()
          : parsed.receivedAt,
        expiresAt:
          typeof parsed.expiresAt === "number"
            ? parsed.expiresAt
            : Date.now() + getWebhookIngressContentTtlSeconds() * 1_000,
        attempts: parsed.attempts,
        subjects: Array.isArray(parsed.subjects)
          ? parsed.subjects.filter(isWebhookIngressSubject)
          : [],
      };
    }
  } catch {
    // Invalid queue payloads are handled by the caller.
  }

  return null;
}

function isWebhookIngressExpiry(
  receivedAt: string,
  expiresAt: unknown
): expiresAt is number {
  const receivedAtMs = Date.parse(receivedAt);
  return (
    Number.isFinite(receivedAtMs) &&
    typeof expiresAt === "number" &&
    Number.isSafeInteger(expiresAt) &&
    expiresAt >= receivedAtMs &&
    expiresAt <= receivedAtMs + 24 * 60 * 60 * 1_000
  );
}

function isWebhookIngressSubject(
  value: unknown
): value is WebhookIngressSubject {
  if (!value || typeof value !== "object") return false;
  const subject = value as Partial<WebhookIngressSubject>;
  return (
    Number.isSafeInteger(subject.workspaceId) &&
    Number(subject.workspaceId) > 0 &&
    Number.isSafeInteger(subject.channelConnectionId) &&
    Number(subject.channelConnectionId) > 0 &&
    Number.isSafeInteger(subject.bindingEpoch) &&
    Number(subject.bindingEpoch) > 0 &&
    Number.isSafeInteger(subject.privacyEpoch) &&
    Number(subject.privacyEpoch) > 0 &&
    typeof subject.pageId === "string" &&
    Boolean(subject.pageId.trim()) &&
    typeof subject.userKey === "string" &&
    /^[a-f0-9]{64}$/i.test(subject.userKey)
  );
}

async function createFacebookIngressDeliveries(
  payload: unknown
): Promise<Array<{ payload: unknown; subjects: WebhookIngressSubject[] }>> {
  if (!payload || typeof payload !== "object") return [];
  const entries = (payload as { entry?: unknown; object?: unknown }).entry;
  if (!Array.isArray(entries)) return [];
  const object = (payload as { object?: unknown }).object;
  const deliveries: Array<{
    payload: unknown;
    subjects: WebhookIngressSubject[];
  }> = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const pageId =
      typeof (entry as { id?: unknown }).id === "string"
        ? String((entry as { id?: unknown }).id).trim()
        : "";
    const ownership = pageId
      ? await resolveMessengerGenerationOwnership(pageId)
      : null;
    if (!ownership) {
      throw new Error("Webhook ingress Page ownership is unavailable");
    }
    const messaging = (entry as { messaging?: unknown }).messaging;
    if (!Array.isArray(messaging)) continue;
    for (const event of messaging) {
      if (!event || typeof event !== "object") continue;
      const recipient = (event as { recipient?: unknown }).recipient;
      const recipientId =
        recipient && typeof recipient === "object"
          ? (recipient as { id?: unknown }).id
          : undefined;
      if (recipientId !== pageId) {
        throw new Error("Webhook ingress recipient Page does not match entry");
      }
      const sender = (event as { sender?: unknown }).sender;
      const senderId =
        sender && typeof sender === "object"
          ? (sender as { id?: unknown }).id
          : undefined;
      if (typeof senderId !== "string" || !senderId.trim()) {
        continue;
      }
      const userKey = toUserKey(senderId);
      const privacyEpoch = await ensureActiveMessengerPrivacySubject({
        workspaceId: ownership.workspaceId,
        channelConnectionId: ownership.channelConnectionId,
        userKey,
      });
      deliveries.push({
        payload: { object, entry: [{ ...entry, messaging: [event] }] },
        subjects: [{ ...ownership, userKey, privacyEpoch }],
      });
    }
  }
  return deliveries;
}

async function processWhatsAppWebhookPayloadSafely(
  payload: unknown
): Promise<void> {
  const module = await import("../whatsappWebhook");
  await module.processWhatsAppWebhookPayload(payload);
}

async function processFacebookWebhookPayloadSafely(
  payload: unknown
): Promise<void> {
  const module = await import("../messengerWebhook");
  await module.processFacebookWebhookPayload(payload);
}

async function processQueuedWebhookDelivery(
  delivery: QueuedWebhookDelivery
): Promise<void> {
  if (delivery.channel === "whatsapp") {
    await processWhatsAppWebhookPayloadSafely(delivery.payload);
    return;
  }

  await processFacebookWebhookPayloadSafely(delivery.payload);
}

export function isWebhookIngressQueueEnabled(): boolean {
  return isRedisEnabled();
}

export async function ensureWebhookIngressQueueReady(): Promise<void> {
  await ensureRedisReady();
  const redis = await getRedisClient();
  for (const listKey of [
    WEBHOOK_INGRESS_QUEUE_KEY,
    WEBHOOK_INGRESS_PROCESSING_KEY,
  ]) {
    const refs = await redis.lrange(listKey, 0, 1_000);
    if (refs.length > 1_000) {
      throw new Error("Webhook ingress readiness scan is not bounded");
    }
    for (const ref of refs) {
      const raw = ref.startsWith("{")
        ? ref
        : await redis.get(getWebhookIngressDeliveryKey(ref));
      const delivery = raw ? parseQueuedWebhookDelivery(raw) : null;
      if (
        !delivery ||
        (delivery.channel === "facebook" && delivery.subjects.length === 0)
      ) {
        throw new Error(
          "Legacy or unscoped webhook ingress delivery requires purge"
        );
      }
    }
  }

  const deadLetterRefs = await redis.lrange(
    WEBHOOK_INGRESS_DEAD_LETTER_KEY,
    0,
    1_000
  );
  if (deadLetterRefs.length > 1_000) {
    throw new Error("Webhook ingress readiness scan is not bounded");
  }
  if (deadLetterRefs.some(ref => !isCanonicalWebhookIngressDeliveryId(ref))) {
    throw new Error("Legacy webhook ingress dead-letter requires purge");
  }
}

export async function enqueueWebhookIngressDelivery(
  channel: WebhookChannel,
  payload: unknown
): Promise<void> {
  const units =
    channel === "facebook"
      ? await createFacebookIngressDeliveries(payload)
      : [{ payload, subjects: [] }];
  if (channel === "facebook" && units.length === 0) {
    throw new Error("Webhook ingress contains no scoped Messenger events");
  }
  for (const unit of units) {
    await enqueueWebhookIngressUnit(channel, unit.payload, unit.subjects);
  }
}

async function enqueueWebhookIngressUnit(
  channel: WebhookChannel,
  payload: unknown,
  subjects: WebhookIngressSubject[]
): Promise<void> {
  const redis = await getRedisClient();
  const deliveryId = randomUUID();
  const now = Date.now();
  const delivery: QueuedWebhookDelivery = {
    deliveryId,
    channel,
    payload,
    receivedAt: new Date(now).toISOString(),
    expiresAt: now + getWebhookIngressContentTtlSeconds() * 1_000,
    subjects,
  };
  const subjectIndexKeys = delivery.subjects.map(getWebhookIngressSubjectKey);
  const subjectTombstoneKeys = delivery.subjects.map(
    getWebhookIngressSubjectTombstoneKey
  );

  const result = Number(
    await redis.eval(
      `
      local subjectCount = tonumber(ARGV[4])
      local deliveryType = redis.call("TYPE", KEYS[1]).ok
      if deliveryType ~= "none" then return -2 end
      local queueType = redis.call("TYPE", KEYS[2]).ok
      if queueType ~= "none" and queueType ~= "list" then return -2 end
      for i = 1, subjectCount do
        local indexType = redis.call("TYPE", KEYS[2 + i]).ok
        if indexType ~= "none" and indexType ~= "set" then return -2 end
        local tombstoneType = redis.call("TYPE", KEYS[2 + subjectCount + i]).ok
        if tombstoneType ~= "none" and tombstoneType ~= "string" then return -2 end
        local erased = tonumber(redis.call("GET", KEYS[2 + subjectCount + i]) or "0")
        local incoming = tonumber(ARGV[4 + i])
        if erased >= incoming then return -1 end
      end
      local function extendDeadline(key, deadline)
        local ttl = redis.call("PTTL", key)
        if ttl < 0 then
          redis.call("PEXPIREAT", key, deadline)
        else
          redis.call("PEXPIREAT", key, deadline, "GT")
        end
      end

      redis.call("SET", KEYS[1], ARGV[2], "PXAT", ARGV[3])
      redis.call("RPUSH", KEYS[2], ARGV[1])
      extendDeadline(KEYS[2], ARGV[3])
      for i = 3, 2 + subjectCount do
        redis.call("SADD", KEYS[i], ARGV[1])
        extendDeadline(KEYS[i], ARGV[3])
      end
      return 1
    `,
      2 + subjectIndexKeys.length + subjectTombstoneKeys.length,
      getWebhookIngressDeliveryKey(deliveryId),
      WEBHOOK_INGRESS_QUEUE_KEY,
      ...subjectIndexKeys,
      ...subjectTombstoneKeys,
      deliveryId,
      JSON.stringify(delivery),
      delivery.expiresAt,
      subjects.length,
      ...subjects.map(subject => subject.privacyEpoch)
    )
  );
  if (result !== 1) {
    if (result === -1) {
      throw new Error("Webhook ingress subject epoch is erased");
    }
    throw new Error("Webhook ingress enqueue storage is inconsistent");
  }
}

async function reserveWebhookIngressDelivery(
  redis: RedisLike
): Promise<
  | ReservedWebhookDelivery
  | { raw: string; invalid: true }
  | { subjectBlocked: true }
  | null
> {
  const reservedResult =
    process.env.NODE_ENV === "test"
      ? await (async () => {
          const ref = await redis.lmove(
            WEBHOOK_INGRESS_QUEUE_KEY,
            WEBHOOK_INGRESS_PROCESSING_KEY,
            "LEFT",
            "RIGHT"
          );
          if (ref) {
            await redis.set(
              getWebhookIngressDeliveryLeaseKey(ref),
              "1",
              "EX",
              getWebhookIngressDeliveryLeaseSeconds()
            );
          }
          return ref;
        })()
      : await redis.eval(
          `
      local ref = redis.call("LPOP", KEYS[1])
      if not ref then return nil end
      redis.call("RPUSH", KEYS[2], ref)
      redis.call("SET", ARGV[1] .. ref, "1", "EX", ARGV[2])
      return ref
    `,
          2,
          WEBHOOK_INGRESS_QUEUE_KEY,
          WEBHOOK_INGRESS_PROCESSING_KEY,
          WEBHOOK_INGRESS_LEASE_PREFIX,
          getWebhookIngressDeliveryLeaseSeconds()
        );
  const raw = typeof reservedResult === "string" ? reservedResult : null;
  if (!raw) {
    return null;
  }

  const legacyInline = raw.startsWith("{") && process.env.NODE_ENV === "test";
  const serializedDelivery = legacyInline
    ? raw
    : await redis.get(getWebhookIngressDeliveryKey(raw));
  const delivery = serializedDelivery
    ? parseQueuedWebhookDelivery(serializedDelivery)
    : null;
  if (!delivery || (!legacyInline && delivery.deliveryId !== raw)) {
    return { raw, invalid: true };
  }

  const subjectLease = await acquireWebhookIngressSubjectLease(redis, delivery);
  if (delivery.subjects.length > 0 && !subjectLease) {
    await returnWebhookIngressDeliveryToFront(redis, raw);
    return { subjectBlocked: true };
  }

  return { raw, delivery, legacyInline, subjectLease };
}

async function acquireWebhookIngressSubjectLease(
  redis: RedisLike,
  delivery: QueuedWebhookDelivery
): Promise<WebhookIngressSubjectLease | undefined> {
  const keys = Array.from(
    new Set(delivery.subjects.map(getWebhookIngressSubjectLeaseKey))
  );
  if (keys.length === 0) return undefined;
  const token = randomUUID();
  const acquired = Number(
    await redis.eval(
      `
        for i = 1, #KEYS do
          if redis.call("EXISTS", KEYS[i]) == 1 then return 0 end
        end
        for i = 1, #KEYS do
          redis.call("SET", KEYS[i], ARGV[1], "EX", ARGV[2])
        end
        return 1
      `,
      keys.length,
      ...keys,
      token,
      getWebhookIngressDeliveryLeaseSeconds()
    )
  );
  return acquired === 1 ? { keys, token } : undefined;
}

async function returnWebhookIngressDeliveryToFront(
  redis: RedisLike,
  raw: string
): Promise<void> {
  const returned = Number(
    await redis.eval(
      `
        local removed = redis.call("LREM", KEYS[1], 1, ARGV[1])
        if removed == 1 then
          redis.call("DEL", KEYS[2])
          redis.call("LPUSH", KEYS[3], ARGV[1])
        end
        return removed
      `,
      3,
      WEBHOOK_INGRESS_PROCESSING_KEY,
      getWebhookIngressDeliveryLeaseKey(raw),
      WEBHOOK_INGRESS_QUEUE_KEY,
      raw
    )
  );
  if (returned !== 1) {
    throw new Error("Blocked webhook delivery was not returned to queue");
  }
}

async function releaseWebhookIngressSubjectLease(
  redis: RedisLike,
  lease: WebhookIngressSubjectLease | undefined
): Promise<void> {
  if (!lease) return;
  await redis.eval(
    `
      for i = 1, #KEYS do
        if redis.call("GET", KEYS[i]) == ARGV[1] then
          redis.call("DEL", KEYS[i])
        end
      end
      return 1
    `,
    lease.keys.length,
    ...lease.keys,
    lease.token
  );
}

async function completeWebhookIngressDelivery(
  redis: RedisLike,
  raw: string,
  delivery?: QueuedWebhookDelivery,
  legacyInline = false,
  subjectLease?: WebhookIngressSubjectLease
): Promise<void> {
  await redis.lrem(WEBHOOK_INGRESS_PROCESSING_KEY, 1, raw);
  await redis.del(getWebhookIngressDeliveryLeaseKey(raw));
  if (!legacyInline && delivery) {
    await redis.del(getWebhookIngressDeliveryKey(delivery.deliveryId));
    for (const subject of delivery.subjects) {
      await redis.srem(
        getWebhookIngressSubjectKey(subject),
        delivery.deliveryId
      );
    }
  }
  await releaseWebhookIngressSubjectLease(redis, subjectLease);
}

async function isWebhookIngressDeliveryErased(
  redis: RedisLike,
  delivery: QueuedWebhookDelivery
): Promise<boolean> {
  for (const subject of delivery.subjects) {
    const erasedEpoch = Number(
      (await redis.get(getWebhookIngressSubjectTombstoneKey(subject))) ?? "0"
    );
    if (erasedEpoch >= subject.privacyEpoch) return true;
  }
  return false;
}

async function moveFailedWebhookIngressDelivery(
  redis: RedisLike,
  reserved: ReservedWebhookDelivery,
  destinationKey: string,
  serializedDelivery: string,
  pushDirection: "LPUSH" | "RPUSH"
): Promise<void> {
  const removed = await redis.eval(
    `
      local processingType = redis.call("TYPE", KEYS[1]).ok
      if processingType ~= "none" and processingType ~= "list" then
        return redis.error_reply("processing key is not a list")
      end

      local leaseType = redis.call("TYPE", KEYS[2]).ok
      if leaseType ~= "none" and leaseType ~= "string" then
        return redis.error_reply("lease key is not a string")
      end

      local destinationType = redis.call("TYPE", KEYS[3]).ok
      if destinationType ~= "none" and destinationType ~= "list" then
        return redis.error_reply("destination key is not a list")
      end

      local found = 0
      local processingDeliveries = redis.call("LRANGE", KEYS[1], 0, -1)
      for i = 1, #processingDeliveries do
        if processingDeliveries[i] == ARGV[1] then
          found = 1
          break
        end
      end

      if found == 0 then
        return 0
      end

      redis.call(ARGV[2], KEYS[3], ARGV[3])
      if ARGV[4] == "dead" then
        redis.call("LTRIM", KEYS[3], -tonumber(ARGV[5]), -1)
        redis.call("EXPIRE", KEYS[3], ARGV[6])
      end
      local removed = redis.call("LREM", KEYS[1], 1, ARGV[1])
      if removed > 0 then
        redis.call("DEL", KEYS[2])
      end
      return removed
    `,
    3,
    WEBHOOK_INGRESS_PROCESSING_KEY,
    getWebhookIngressDeliveryLeaseKey(reserved.raw),
    destinationKey,
    reserved.raw,
    pushDirection,
    serializedDelivery,
    destinationKey === WEBHOOK_INGRESS_DEAD_LETTER_KEY ? "dead" : "retry",
    DEFAULT_WEBHOOK_INGRESS_DEAD_MAX_ITEMS,
    getWebhookIngressContentTtlSeconds()
  );

  if (removed !== 1) {
    throw new Error("Reserved webhook delivery was not found in processing");
  }
}

async function releaseFailedWebhookIngressDelivery(
  redis: RedisLike,
  reserved: ReservedWebhookDelivery,
  error: unknown
): Promise<"requeued" | "dead_lettered" | "erased"> {
  if (
    !reserved.legacyInline &&
    (await isWebhookIngressDeliveryErased(redis, reserved.delivery))
  ) {
    await completeWebhookIngressDelivery(
      redis,
      reserved.raw,
      reserved.delivery,
      false,
      reserved.subjectLease
    );
    return "erased";
  }
  const attempts = (reserved.delivery.attempts ?? 0) + 1;
  const retryDelivery: QueuedWebhookDelivery = {
    ...reserved.delivery,
    attempts,
  };
  const serializedRetryDelivery = JSON.stringify(retryDelivery);
  const serializedError = serializeError(error);
  if (reserved.delivery.expiresAt <= Date.now()) {
    await completeWebhookIngressDelivery(
      redis,
      reserved.raw,
      reserved.delivery,
      reserved.legacyInline,
      reserved.subjectLease
    );
    return "erased";
  }

  if (attempts >= getWebhookIngressMaxAttempts()) {
    await moveFailedWebhookIngressDelivery(
      redis,
      reserved,
      WEBHOOK_INGRESS_DEAD_LETTER_KEY,
      reserved.legacyInline
        ? serializedRetryDelivery
        : reserved.delivery.deliveryId,
      "RPUSH"
    );
    if (!reserved.legacyInline) {
      await redis.del(
        getWebhookIngressDeliveryKey(reserved.delivery.deliveryId)
      );
      for (const subject of reserved.delivery.subjects) {
        await redis.srem(
          getWebhookIngressSubjectKey(subject),
          reserved.delivery.deliveryId
        );
      }
    }
    await releaseWebhookIngressSubjectLease(redis, reserved.subjectLease);
    safeLog("webhook_queued_delivery_dead_lettered", {
      channel: reserved.delivery.channel,
      attempts,
      error: serializedError,
    });
    return "dead_lettered";
  }

  if (!reserved.legacyInline) {
    await redis.set(
      getWebhookIngressDeliveryKey(reserved.delivery.deliveryId),
      serializedRetryDelivery,
      "PXAT",
      reserved.delivery.expiresAt
    );
  }
  await moveFailedWebhookIngressDelivery(
    redis,
    reserved,
    WEBHOOK_INGRESS_QUEUE_KEY,
    reserved.legacyInline
      ? serializedRetryDelivery
      : reserved.delivery.deliveryId,
    "RPUSH"
  );
  await releaseWebhookIngressSubjectLease(redis, reserved.subjectLease);
  safeLog("webhook_queued_delivery_requeued", {
    channel: reserved.delivery.channel,
    attempts,
    error: serializedError,
  });
  return "requeued";
}

export async function eraseWebhookIngressDeliveriesForSubject(input: {
  workspaceId: number;
  channelConnectionId: number;
  userKey: string;
  privacyEpoch: number;
}): Promise<number> {
  if (!isWebhookIngressQueueEnabled()) {
    throw new Error("Webhook ingress queue is required for privacy erasure");
  }
  const redis = await getRedisClient();
  const subject = {
    ...input,
    bindingEpoch: 1,
    pageId: "privacy-erasure",
  } satisfies WebhookIngressSubject;
  const subjectKey = getWebhookIngressSubjectKey(subject);
  const tombstoneResult = Number(
    await redis.eval(
      `
        local current = tonumber(redis.call("GET", KEYS[1]) or "0")
        local requested = tonumber(ARGV[1])
        if current < requested then
          redis.call("SET", KEYS[1], ARGV[1])
          return requested
        end
        return current
      `,
      1,
      getWebhookIngressSubjectTombstoneKey(subject),
      input.privacyEpoch
    )
  );
  if (
    !Number.isSafeInteger(tombstoneResult) ||
    tombstoneResult < input.privacyEpoch
  ) {
    throw new Error("Webhook ingress privacy tombstone update failed");
  }
  let total = 0;
  while (true) {
    const result = await redis.eval(
      `
        local queueType = redis.call("TYPE", KEYS[1]).ok
        local processingType = redis.call("TYPE", KEYS[2]).ok
        local deadType = redis.call("TYPE", KEYS[3]).ok
        local subjectType = redis.call("TYPE", KEYS[4]).ok
        if (queueType ~= "none" and queueType ~= "list")
          or (processingType ~= "none" and processingType ~= "list")
          or (deadType ~= "none" and deadType ~= "list")
          or (subjectType ~= "none" and subjectType ~= "set") then
          return redis.error_reply("webhook ingress privacy index is inconsistent")
        end

        local ids = redis.call("SRANDMEMBER", KEYS[4], 100)
        if type(ids) ~= "table" then ids = {} end
        for i = 1, #ids do
          local contentType = redis.call("TYPE", ARGV[1] .. ids[i]).ok
          local leaseType = redis.call("TYPE", ARGV[2] .. ids[i]).ok
          if (contentType ~= "none" and contentType ~= "string")
            or (leaseType ~= "none" and leaseType ~= "string") then
            return redis.error_reply("webhook ingress subject reference is inconsistent")
          end
        end
        for i = 1, #ids do
          local id = ids[i]
          redis.call("LREM", KEYS[1], 0, id)
          redis.call("LREM", KEYS[2], 0, id)
          redis.call("LREM", KEYS[3], 0, id)
          redis.call("DEL", ARGV[1] .. id)
          redis.call("DEL", ARGV[2] .. id)
          redis.call("SREM", KEYS[4], id)
        end
        if redis.call("SCARD", KEYS[4]) == 0 then
          redis.call("DEL", KEYS[4])
          redis.call("DEL", KEYS[5])
        end
        return #ids
      `,
      5,
      WEBHOOK_INGRESS_QUEUE_KEY,
      WEBHOOK_INGRESS_PROCESSING_KEY,
      WEBHOOK_INGRESS_DEAD_LETTER_KEY,
      subjectKey,
      getWebhookIngressSubjectLeaseKey(subject),
      WEBHOOK_INGRESS_DELIVERY_PREFIX,
      WEBHOOK_INGRESS_LEASE_PREFIX
    );
    const removed = typeof result === "number" ? result : Number(result) || 0;
    total += removed;
    if (removed < 100) return total;
  }
}

async function reclaimExpiredWebhookIngressDeliveries(
  redis: RedisLike
): Promise<number> {
  const processingDeliveries = await redis.lrange(
    WEBHOOK_INGRESS_PROCESSING_KEY,
    0,
    -1
  );
  let reclaimed = 0;

  for (const raw of processingDeliveries) {
    if ((await redis.get(getWebhookIngressDeliveryLeaseKey(raw))) !== null) {
      continue;
    }

    const removed =
      process.env.NODE_ENV === "test"
        ? await (async () => {
            const count = await redis.lrem(
              WEBHOOK_INGRESS_PROCESSING_KEY,
              1,
              raw
            );
            if (count > 0) await redis.lpush(WEBHOOK_INGRESS_QUEUE_KEY, raw);
            return count;
          })()
        : Number(
            await redis.eval(
              `
          if redis.call("EXISTS", KEYS[3]) == 1 then return 0 end
          local removed = redis.call("LREM", KEYS[1], 1, ARGV[1])
          if removed == 1 then redis.call("LPUSH", KEYS[2], ARGV[1]) end
          return removed
        `,
              3,
              WEBHOOK_INGRESS_PROCESSING_KEY,
              WEBHOOK_INGRESS_QUEUE_KEY,
              getWebhookIngressDeliveryLeaseKey(raw),
              raw
            )
          );
    if (removed > 0) {
      reclaimed += 1;
    }
  }

  if (reclaimed > 0) {
    safeLog("webhook_ingress_deliveries_reclaimed", { count: reclaimed });
  }

  return reclaimed;
}

export function scheduleWebhookIngressDrain(): void {
  if (!isWebhookIngressQueueEnabled()) {
    return;
  }

  if (!drainPromise) {
    drainRequested = false;
    drainPromise = (async () => {
      try {
        const redis = await getRedisClient();
        await reclaimExpiredWebhookIngressDeliveries(redis);

        while (true) {
          const reserved = await reserveWebhookIngressDelivery(redis);
          if (!reserved) {
            return;
          }

          if ("subjectBlocked" in reserved) {
            setTimeout(() => {
              drainRequested = true;
              if (!drainPromise) scheduleWebhookIngressDrain();
            }, getWebhookIngressRetryDelayMs());
            return;
          }

          if ("invalid" in reserved) {
            safeLog("webhook_queued_delivery_invalid", {});
            await completeWebhookIngressDelivery(redis, reserved.raw);
            continue;
          }

          if (
            !reserved.legacyInline &&
            (await isWebhookIngressDeliveryErased(redis, reserved.delivery))
          ) {
            await completeWebhookIngressDelivery(
              redis,
              reserved.raw,
              reserved.delivery,
              false,
              reserved.subjectLease
            );
            continue;
          }

          try {
            await processQueuedWebhookDelivery(reserved.delivery);
          } catch (error) {
            const result = await releaseFailedWebhookIngressDelivery(
              redis,
              reserved,
              error
            );
            if (result === "dead_lettered" || result === "erased") {
              continue;
            }
            setTimeout(() => {
              drainRequested = true;
              if (!drainPromise) scheduleWebhookIngressDrain();
            }, getWebhookIngressRetryDelayMs());
            return;
          }

          await completeWebhookIngressDelivery(
            redis,
            reserved.raw,
            reserved.delivery,
            reserved.legacyInline,
            reserved.subjectLease
          );
        }
      } catch (error) {
        safeLog("webhook_ingress_queue_drain_failed", {
          error: serializeError(error),
        });
      } finally {
        drainPromise = null;
        if (drainRequested) {
          drainRequested = false;
          scheduleWebhookIngressDrain();
        }
      }
    })();
  }
}

export function processWebhookDeliveryInline(
  channel: WebhookChannel,
  payload: unknown
): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Production webhook ingress requires the durable queue");
  }
  const now = Date.now();
  setImmediate(() => {
    void processQueuedWebhookDelivery({
      deliveryId: "inline",
      channel,
      payload,
      receivedAt: new Date(now).toISOString(),
      expiresAt: now + getWebhookIngressContentTtlSeconds() * 1_000,
      subjects: [],
    }).catch(error => {
      safeLog("webhook_async_processing_failed", {
        channel,
        error: serializeError(error),
      });
    });
  });
}

export function resetWebhookIngressQueueForTests(): void {
  resetRedisClientForTests();
  drainPromise = null;
  drainRequested = false;
}

export const webhookIngressQueueTestHooks = {
  reserveWebhookIngressDelivery,
  completeWebhookIngressDelivery,
};
