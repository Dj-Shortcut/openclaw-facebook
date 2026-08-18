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

type QueuedWebhookDelivery = {
  deliveryId: string;
  channel: WebhookChannel;
  payload: unknown;
  receivedAt: string;
  attempts?: number;
  subjectKeys: string[];
};

type ReservedWebhookDelivery = {
  raw: string;
  delivery: QueuedWebhookDelivery;
  legacyInline: boolean;
};

let drainPromise: Promise<void> | null = null;

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
  const configured = Number(process.env.WEBHOOK_INGRESS_CONTENT_TTL_SECONDS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_WEBHOOK_INGRESS_CONTENT_TTL_SECONDS;
}

function getWebhookIngressDeliveryKey(deliveryId: string): string {
  return `${WEBHOOK_INGRESS_DELIVERY_PREFIX}${deliveryId}`;
}

function getWebhookIngressSubjectKey(userKey: string): string {
  return `${WEBHOOK_INGRESS_SUBJECT_PREFIX}${userKey}`;
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
    if (
      (parsed.channel === "facebook" || parsed.channel === "whatsapp") &&
      typeof parsed.receivedAt === "string" &&
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
        receivedAt: parsed.receivedAt,
        attempts: parsed.attempts,
        subjectKeys: Array.isArray(parsed.subjectKeys)
          ? parsed.subjectKeys.filter(
              (value): value is string =>
                typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
            )
          : [],
      };
    }
  } catch {
    // Invalid queue payloads are handled by the caller.
  }

  return null;
}

function extractFacebookSubjectKeys(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const entries = (payload as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) return [];

  const userKeys = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const messaging = (entry as { messaging?: unknown }).messaging;
    if (!Array.isArray(messaging)) continue;
    for (const event of messaging) {
      if (!event || typeof event !== "object") continue;
      const sender = (event as { sender?: unknown }).sender;
      const senderId =
        sender && typeof sender === "object"
          ? (sender as { id?: unknown }).id
          : undefined;
      if (typeof senderId === "string" && senderId.length > 0) {
        userKeys.add(toUserKey(senderId));
      }
    }
  }
  return [...userKeys];
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
}

export async function enqueueWebhookIngressDelivery(
  channel: WebhookChannel,
  payload: unknown
): Promise<void> {
  const redis = await getRedisClient();
  const deliveryId = randomUUID();
  const delivery: QueuedWebhookDelivery = {
    deliveryId,
    channel,
    payload,
    receivedAt: new Date().toISOString(),
    subjectKeys:
      channel === "facebook" ? extractFacebookSubjectKeys(payload) : [],
  };
  const ttlSeconds = getWebhookIngressContentTtlSeconds();
  const subjectIndexKeys = delivery.subjectKeys.map(
    getWebhookIngressSubjectKey
  );

  await redis.eval(
    `
      redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])
      redis.call("RPUSH", KEYS[2], ARGV[1])
      redis.call("EXPIRE", KEYS[2], ARGV[3])
      for i = 3, #KEYS do
        redis.call("SADD", KEYS[i], ARGV[1])
        redis.call("EXPIRE", KEYS[i], ARGV[3])
      end
      return 1
    `,
    2 + subjectIndexKeys.length,
    getWebhookIngressDeliveryKey(deliveryId),
    WEBHOOK_INGRESS_QUEUE_KEY,
    ...subjectIndexKeys,
    deliveryId,
    JSON.stringify(delivery),
    ttlSeconds
  );
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
    for (const userKey of delivery.subjectKeys) {
      await redis.srem(
        getWebhookIngressSubjectKey(userKey),
        delivery.deliveryId
      );
    }
  }
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
): Promise<"requeued" | "dead_lettered"> {
  const attempts = (reserved.delivery.attempts ?? 0) + 1;
  const retryDelivery: QueuedWebhookDelivery = {
    ...reserved.delivery,
    attempts,
  };
  const serializedRetryDelivery = JSON.stringify(retryDelivery);
  const serializedError = serializeError(error);

  if (attempts >= getWebhookIngressMaxAttempts()) {
    if (!reserved.legacyInline) {
      await redis.set(
        getWebhookIngressDeliveryKey(reserved.delivery.deliveryId),
        serializedRetryDelivery,
        "EX",
        getWebhookIngressContentTtlSeconds()
      );
    }
    await moveFailedWebhookIngressDelivery(
      redis,
      reserved,
      WEBHOOK_INGRESS_DEAD_LETTER_KEY,
      reserved.legacyInline
        ? serializedRetryDelivery
        : reserved.delivery.deliveryId,
      "RPUSH"
    );
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
      "EX",
      getWebhookIngressContentTtlSeconds()
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
  safeLog("webhook_queued_delivery_requeued", {
    channel: reserved.delivery.channel,
    attempts,
    error: serializedError,
  });
  return "requeued";
}

export async function eraseWebhookIngressDeliveriesForSubject(
  userKey: string
): Promise<number> {
  if (!isWebhookIngressQueueEnabled()) return 0;
  const redis = await getRedisClient();
  const subjectKey = getWebhookIngressSubjectKey(userKey);
  let total = 0;
  while (true) {
    const result = await redis.eval(
      `
        local ids = redis.call("SPOP", KEYS[4], 100)
        if type(ids) ~= "table" then ids = {} end
        for i = 1, #ids do
          local id = ids[i]
          redis.call("LREM", KEYS[1], 0, id)
          redis.call("LREM", KEYS[2], 0, id)
          redis.call("LREM", KEYS[3], 0, id)
          redis.call("DEL", ARGV[1] .. id)
          redis.call("DEL", ARGV[2] .. id)
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

          try {
            await processQueuedWebhookDelivery(reserved.delivery);
          } catch (error) {
            const result = await releaseFailedWebhookIngressDelivery(
              redis,
              reserved,
              error
            );
            if (result === "dead_lettered") {
              continue;
            }
            setTimeout(() => {
              if (!drainPromise) {
                scheduleWebhookIngressDrain();
              }
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
  setImmediate(() => {
    void processQueuedWebhookDelivery({
      deliveryId: "inline",
      channel,
      payload,
      receivedAt: new Date().toISOString(),
      subjectKeys: [],
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
}
