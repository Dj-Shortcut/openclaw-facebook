import { createHash } from "node:crypto";
import {
  ensureRedisReady,
  getRedisClient,
  isRedisEnabled,
  type RedisLike,
  resetRedisClientForTests,
} from "../redis";
import { safeLog } from "../messengerApi";

const WEBHOOK_INGRESS_QUEUE_KEY = "meta-webhook-ingress";
const WEBHOOK_INGRESS_PROCESSING_KEY = "meta-webhook-ingress:processing";
const WEBHOOK_INGRESS_DEAD_LETTER_KEY = "meta-webhook-ingress:dead";
const DEFAULT_WEBHOOK_INGRESS_DELIVERY_LEASE_SECONDS = 15 * 60;
const DEFAULT_WEBHOOK_INGRESS_MAX_ATTEMPTS = 3;

type WebhookChannel = "facebook" | "whatsapp";

type QueuedWebhookDelivery = {
  channel: WebhookChannel;
  payload: unknown;
  receivedAt: string;
  attempts?: number;
};

type ReservedWebhookDelivery = {
  raw: string;
  delivery: QueuedWebhookDelivery;
};

let drainPromise: Promise<void> | null = null;

function serializeError(error: unknown): {
  class: string;
  message: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return {
      class: error.constructor.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return { class: "UnknownError", message: String(error) };
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

function getWebhookIngressDeliveryLeaseKey(rawDelivery: string): string {
  const digest = createHash("sha256").update(rawDelivery).digest("hex");
  return `meta-webhook-ingress-lease:${digest}`;
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
        channel: parsed.channel,
        payload: parsed.payload,
        receivedAt: parsed.receivedAt,
        attempts: parsed.attempts,
      };
    }
  } catch {
    // Invalid queue payloads are handled by the caller.
  }

  return null;
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
  const delivery: QueuedWebhookDelivery = {
    channel,
    payload,
    receivedAt: new Date().toISOString(),
  };

  await redis.rpush(WEBHOOK_INGRESS_QUEUE_KEY, JSON.stringify(delivery));
}

async function reserveWebhookIngressDelivery(
  redis: RedisLike
): Promise<ReservedWebhookDelivery | { raw: string; invalid: true } | null> {
  const raw = await redis.lmove(
    WEBHOOK_INGRESS_QUEUE_KEY,
    WEBHOOK_INGRESS_PROCESSING_KEY,
    "LEFT",
    "RIGHT"
  );
  if (!raw) {
    return null;
  }

  await redis.set(
    getWebhookIngressDeliveryLeaseKey(raw),
    "1",
    "EX",
    getWebhookIngressDeliveryLeaseSeconds()
  );

  const delivery = parseQueuedWebhookDelivery(raw);
  if (!delivery) {
    return { raw, invalid: true };
  }

  return { raw, delivery };
}

async function completeWebhookIngressDelivery(
  redis: RedisLike,
  raw: string
): Promise<void> {
  await redis.lrem(WEBHOOK_INGRESS_PROCESSING_KEY, 1, raw);
  await redis.del(getWebhookIngressDeliveryLeaseKey(raw));
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
    serializedDelivery
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
    await moveFailedWebhookIngressDelivery(
      redis,
      reserved,
      WEBHOOK_INGRESS_DEAD_LETTER_KEY,
      serializedRetryDelivery,
      "RPUSH"
    );
    safeLog("webhook_queued_delivery_dead_lettered", {
      channel: reserved.delivery.channel,
      attempts,
      error: serializedError,
    });
    return "dead_lettered";
  }

  await moveFailedWebhookIngressDelivery(
    redis,
    reserved,
    WEBHOOK_INGRESS_QUEUE_KEY,
    serializedRetryDelivery,
    "LPUSH"
  );
  safeLog("webhook_queued_delivery_requeued", {
    channel: reserved.delivery.channel,
    attempts,
    error: serializedError,
  });
  return "requeued";
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

    const removed = await redis.lrem(WEBHOOK_INGRESS_PROCESSING_KEY, 1, raw);
    if (removed > 0) {
      await redis.lpush(WEBHOOK_INGRESS_QUEUE_KEY, raw);
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
            await releaseFailedWebhookIngressDelivery(redis, reserved, error);
            return;
          }

          await completeWebhookIngressDelivery(redis, reserved.raw);
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
  setImmediate(() => {
    void processQueuedWebhookDelivery({
      channel,
      payload,
      receivedAt: new Date().toISOString(),
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
