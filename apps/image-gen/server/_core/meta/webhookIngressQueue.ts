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
import {
  assertMessengerPrivacySubject,
  ensureActiveMessengerPrivacySubject,
} from "../messengerPrivacySubject";
import { runWithMessengerRequestContext } from "../messengerRequestContext";
import { registerMessengerPrivacyOwnership } from "../messengerPrivacyOwnershipHistory";
import {
  assertMessengerGenerationOwnership,
  resolveMessengerGenerationOwnership,
} from "../workspaceEntitlementRuntime";

const WEBHOOK_INGRESS_QUEUE_KEY = "{meta-webhook-ingress}:queued";
const WEBHOOK_INGRESS_PROCESSING_KEY = "{meta-webhook-ingress}:processing";
const WEBHOOK_INGRESS_DEAD_LETTER_KEY = "{meta-webhook-ingress}:dead";
const WEBHOOK_INGRESS_DELIVERY_PREFIX = "{meta-webhook-ingress}:delivery:";
const WEBHOOK_INGRESS_SUBJECT_PREFIX = "{meta-webhook-ingress}:subject:";
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
};

let drainPromise: Promise<void> | null = null;
let drainRequested = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

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

function getWebhookIngressSubjectTombstoneKey(
  subject: Pick<
    WebhookIngressSubject,
    "workspaceId" | "channelConnectionId" | "userKey"
  >
): string {
  return `{meta-webhook-ingress}:erased:${getWebhookIngressSubjectId(subject)}`;
}

function getWebhookIngressDeliveryLeaseKey(rawDelivery: string): string {
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      rawDelivery
    )
  ) {
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
      // Register the immutable owner before any raw event content can be
      // committed. A Page transfer after enqueue can then fan GDPR erasure
      // out to this historical scope even when no conversation state exists.
      await registerMessengerPrivacyOwnership({
        pageId,
        userKey,
        workspaceId: ownership.workspaceId,
        channelConnectionId: ownership.channelConnectionId,
        bindingEpoch: ownership.bindingEpoch,
        privacyEpoch,
        channel: "facebook_messenger",
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

function getFacebookIngressSubject(
  delivery: QueuedWebhookDelivery
): WebhookIngressSubject {
  if (delivery.subjects.length !== 1) {
    throw new Error("Queued Messenger ingress requires one immutable subject");
  }
  const subject = delivery.subjects[0];
  const payload = delivery.payload;
  if (!payload || typeof payload !== "object") {
    throw new Error("Queued Messenger ingress payload is invalid");
  }
  const entries = (payload as { entry?: unknown }).entry;
  if (!Array.isArray(entries) || entries.length !== 1) {
    throw new Error("Queued Messenger ingress requires one Page entry");
  }
  const entry = entries[0];
  if (
    !entry ||
    typeof entry !== "object" ||
    (entry as { id?: unknown }).id !== subject.pageId
  ) {
    throw new Error("Queued Messenger ingress Page scope is invalid");
  }
  const messaging = (entry as { messaging?: unknown }).messaging;
  if (!Array.isArray(messaging) || messaging.length !== 1) {
    throw new Error("Queued Messenger ingress requires one event");
  }
  const event = messaging[0];
  const sender =
    event && typeof event === "object"
      ? (event as { sender?: unknown }).sender
      : undefined;
  const recipient =
    event && typeof event === "object"
      ? (event as { recipient?: unknown }).recipient
      : undefined;
  const senderId =
    sender && typeof sender === "object"
      ? (sender as { id?: unknown }).id
      : undefined;
  const recipientId =
    recipient && typeof recipient === "object"
      ? (recipient as { id?: unknown }).id
      : undefined;
  if (
    typeof senderId !== "string" ||
    toUserKey(senderId) !== subject.userKey ||
    recipientId !== subject.pageId
  ) {
    throw new Error("Queued Messenger ingress subject does not match payload");
  }
  return subject;
}

async function processQueuedWebhookDelivery(
  delivery: QueuedWebhookDelivery,
  options: { allowUnscopedTestDelivery?: boolean } = {}
): Promise<void> {
  if (delivery.channel === "whatsapp") {
    await processWhatsAppWebhookPayloadSafely(delivery.payload);
    return;
  }

  if (
    options.allowUnscopedTestDelivery &&
    process.env.NODE_ENV === "test" &&
    delivery.subjects.length === 0
  ) {
    await processFacebookWebhookPayloadSafely(delivery.payload);
    return;
  }

  const subject = getFacebookIngressSubject(delivery);
  await assertMessengerGenerationOwnership(subject);
  await assertMessengerPrivacySubject({
    workspaceId: subject.workspaceId,
    channelConnectionId: subject.channelConnectionId,
    userKey: subject.userKey,
    privacyEpoch: subject.privacyEpoch,
  });
  await runWithMessengerRequestContext(
    subject.pageId,
    () => processFacebookWebhookPayloadSafely(delivery.payload),
    subject
  );
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
    WEBHOOK_INGRESS_DEAD_LETTER_KEY,
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
): Promise<ReservedWebhookDelivery | { raw: string; invalid: true } | null> {
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

  return { raw, delivery, legacyInline };
}

async function completeWebhookIngressDelivery(
  redis: RedisLike,
  raw: string,
  delivery?: QueuedWebhookDelivery,
  legacyInline = false
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
): Promise<"moved" | "erased"> {
  if (reserved.legacyInline) {
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

        if found == 0 then return 0 end

        redis.call(ARGV[2], KEYS[3], ARGV[3])
        if ARGV[4] == "dead" then
          redis.call("LTRIM", KEYS[3], -tonumber(ARGV[5]), -1)
          redis.call("EXPIRE", KEYS[3], ARGV[6])
        end
        local removed = redis.call("LREM", KEYS[1], 1, ARGV[1])
        if removed > 0 then redis.call("DEL", KEYS[2]) end
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
    return "moved";
  }

  const delivery = reserved.delivery;
  const subjectIndexKeys = delivery.subjects.map(getWebhookIngressSubjectKey);
  const subjectTombstoneKeys = delivery.subjects.map(
    getWebhookIngressSubjectTombstoneKey
  );
  const transition = Number(
    await redis.eval(
      `
      local subjectCount = tonumber(ARGV[7])
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

      local contentType = redis.call("TYPE", KEYS[4]).ok
      if contentType ~= "none" and contentType ~= "string" then
        return redis.error_reply("delivery content key is not a string")
      end

      local erased = tonumber(ARGV[5]) <= tonumber(ARGV[6])
      for i = 1, subjectCount do
        local indexType = redis.call("TYPE", KEYS[4 + i]).ok
        if indexType ~= "none" and indexType ~= "set" then
          return redis.error_reply("subject index key is not a set")
        end
        local tombstoneType = redis.call("TYPE", KEYS[4 + subjectCount + i]).ok
        if tombstoneType ~= "none" and tombstoneType ~= "string" then
          return redis.error_reply("subject tombstone key is not a string")
        end
        local erasedEpoch = tonumber(
          redis.call("GET", KEYS[4 + subjectCount + i]) or "0"
        )
        if erasedEpoch >= tonumber(ARGV[7 + i]) then erased = true end
      end

      local function scrubDelivery()
        redis.call("LREM", KEYS[1], 0, ARGV[1])
        redis.call("LREM", KEYS[3], 0, ARGV[1])
        redis.call("DEL", KEYS[2])
        redis.call("DEL", KEYS[4])
        for i = 1, subjectCount do
          redis.call("SREM", KEYS[4 + i], ARGV[1])
        end
      end

      if erased then
        scrubDelivery()
        return -1
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

      local function extendDeadline(key, deadline)
        local ttl = redis.call("PTTL", key)
        if ttl < 0 then
          redis.call("PEXPIREAT", key, deadline)
        else
          redis.call("PEXPIREAT", key, deadline, "GT")
        end
      end

      if ARGV[2] == "dead" then
        redis.call("RPUSH", KEYS[3], ARGV[1])
        redis.call("LTRIM", KEYS[3], -tonumber(ARGV[4]), -1)
        extendDeadline(KEYS[3], ARGV[5])
        redis.call("DEL", KEYS[4])
        for i = 1, subjectCount do
          redis.call("SREM", KEYS[4 + i], ARGV[1])
        end
      else
        redis.call("SET", KEYS[4], ARGV[3], "PXAT", ARGV[5])
        redis.call("RPUSH", KEYS[3], ARGV[1])
        extendDeadline(KEYS[3], ARGV[5])
        for i = 1, subjectCount do
          redis.call("SADD", KEYS[4 + i], ARGV[1])
          extendDeadline(KEYS[4 + i], ARGV[5])
        end
      end
      local removed = redis.call("LREM", KEYS[1], 1, ARGV[1])
      if removed > 0 then redis.call("DEL", KEYS[2]) end
      if ARGV[2] == "dead" then return 2 end
      return 1
    `,
      4 + subjectIndexKeys.length + subjectTombstoneKeys.length,
      WEBHOOK_INGRESS_PROCESSING_KEY,
      getWebhookIngressDeliveryLeaseKey(reserved.raw),
      destinationKey,
      getWebhookIngressDeliveryKey(delivery.deliveryId),
      ...subjectIndexKeys,
      ...subjectTombstoneKeys,
      reserved.raw,
      destinationKey === WEBHOOK_INGRESS_DEAD_LETTER_KEY ? "dead" : "retry",
      serializedDelivery,
      DEFAULT_WEBHOOK_INGRESS_DEAD_MAX_ITEMS,
      delivery.expiresAt,
      Date.now(),
      delivery.subjects.length,
      ...delivery.subjects.map(subject => subject.privacyEpoch)
    )
  );

  if (transition === -1) return "erased";
  const expectedTransition =
    destinationKey === WEBHOOK_INGRESS_DEAD_LETTER_KEY ? 2 : 1;
  if (transition !== expectedTransition) {
    throw new Error("Reserved webhook delivery was not found in processing");
  }
  return "moved";
}

async function releaseFailedWebhookIngressDelivery(
  redis: RedisLike,
  reserved: ReservedWebhookDelivery,
  error: unknown
): Promise<"requeued" | "dead_lettered" | "erased"> {
  const attempts = (reserved.delivery.attempts ?? 0) + 1;
  const retryDelivery: QueuedWebhookDelivery = {
    ...reserved.delivery,
    attempts,
  };
  const serializedRetryDelivery = JSON.stringify(retryDelivery);
  const serializedError = serializeError(error);
  if (reserved.legacyInline && reserved.delivery.expiresAt <= Date.now()) {
    await completeWebhookIngressDelivery(
      redis,
      reserved.raw,
      reserved.delivery,
      reserved.legacyInline
    );
    return "erased";
  }

  if (attempts >= getWebhookIngressMaxAttempts()) {
    const transition = await moveFailedWebhookIngressDelivery(
      redis,
      reserved,
      WEBHOOK_INGRESS_DEAD_LETTER_KEY,
      reserved.legacyInline
        ? serializedRetryDelivery
        : reserved.delivery.deliveryId,
      "RPUSH"
    );
    if (transition === "erased") return "erased";
    safeLog("webhook_queued_delivery_dead_lettered", {
      channel: reserved.delivery.channel,
      attempts,
      error: serializedError,
    });
    return "dead_lettered";
  }

  const transition = await moveFailedWebhookIngressDelivery(
    redis,
    reserved,
    WEBHOOK_INGRESS_QUEUE_KEY,
    reserved.legacyInline
      ? serializedRetryDelivery
      : reserved.delivery.deliveryId,
    "RPUSH"
  );
  if (transition === "erased") return "erased";
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
        if redis.call("SCARD", KEYS[4]) == 0 then redis.call("DEL", KEYS[4]) end
        return #ids
      `,
      4,
      WEBHOOK_INGRESS_QUEUE_KEY,
      WEBHOOK_INGRESS_PROCESSING_KEY,
      WEBHOOK_INGRESS_DEAD_LETTER_KEY,
      subjectKey,
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
              false
            );
            continue;
          }

          try {
            await processQueuedWebhookDelivery(reserved.delivery, {
              allowUnscopedTestDelivery: reserved.legacyInline,
            });
          } catch (error) {
            const result = await releaseFailedWebhookIngressDelivery(
              redis,
              reserved,
              error
            );
            if (result === "dead_lettered" || result === "erased") {
              continue;
            }
            retryTimer = setTimeout(() => {
              retryTimer = null;
              drainRequested = true;
              if (!drainPromise) scheduleWebhookIngressDrain();
            }, getWebhookIngressRetryDelayMs());
            return;
          }

          await completeWebhookIngressDelivery(
            redis,
            reserved.raw,
            reserved.delivery,
            reserved.legacyInline
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
    void processQueuedWebhookDelivery(
      {
        deliveryId: "inline",
        channel,
        payload,
        receivedAt: new Date(now).toISOString(),
        expiresAt: now + getWebhookIngressContentTtlSeconds() * 1_000,
        subjects: [],
      },
      { allowUnscopedTestDelivery: true }
    ).catch(error => {
      safeLog("webhook_async_processing_failed", {
        channel,
        error: serializeError(error),
      });
    });
  });
}

export function resetWebhookIngressQueueForTests(): void {
  resetRedisClientForTests();
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  drainPromise = null;
  drainRequested = false;
}
