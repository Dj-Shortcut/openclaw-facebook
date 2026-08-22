import express, { type Express } from "express";
import { ipKeyGenerator } from "express-rate-limit";
import { safeLog } from "../logger";
import { createSharedRedisRateLimiter } from "../redisRateLimit";
import {
  getMollieConfig,
  getMollieWebhookPath,
  getTenantBillingWorkerWorkspaceId,
} from "./config";
import { safeBillingErrorCode } from "./errorCode";
import { MollieApiError, MollieClient } from "./mollieClient";
import { applyMolliePaymentSnapshot } from "./paymentStore";
import { resolveMollieWebhookWorkspace } from "./checkoutStore";

const WEBHOOK_BODY_LIMIT = "2kb";
const PAYMENT_ID_PATTERN = /^tr_[A-Za-z0-9]{1,60}$/;
const DEFAULT_WEBHOOK_RATE_LIMIT_PER_MINUTE = 6_000;
const WEBHOOK_REDIS_OPERATION_TIMEOUT_MS = 2_000;

export function registerMollieWebhookRoute(
  app: Express,
  dependencies?: {
    createClient?: () => MollieClient;
  }
): void {
  const formParser = express.urlencoded({
    extended: false,
    limit: WEBHOOK_BODY_LIMIT,
    parameterLimit: 2,
    type: "application/x-www-form-urlencoded",
  });
  const webhookRateLimiter = createSharedRedisRateLimiter({
    keyPrefix: "mollie-webhook-rate-limit:",
    windowMs: 60_000,
    operationTimeoutMs: WEBHOOK_REDIS_OPERATION_TIMEOUT_MS,
    limit: getWebhookRateLimitPerMinute,
    keyGenerator: getMollieWebhookRateLimitKey,
    onLimited: (_req, res, retryAfterSeconds) => {
      res.setHeader("Retry-After", String(retryAfterSeconds));
      safeLog("mollie_payment_webhook_rate_limited", { level: "warn" });
      res.status(503).type("text/plain").send("Retry");
    },
    onUnavailable: (error, _req, res) => {
      safeLog("mollie_payment_webhook_rate_limit_unavailable", {
        level: "warn",
        errorCode: safeBillingErrorCode(error),
      });
      res.status(503).type("text/plain").send("Retry");
    },
  });

  app.post(
    getMollieWebhookPath(),
    webhookRateLimiter,
    formParser,
    (req, res) => {
      void handleMollieWebhook(req.body, dependencies)
        .then(result => {
          safeLog("mollie_payment_webhook_processed", { result });
          res.status(200).type("text/plain").send("OK");
        })
        .catch(error => {
          safeLog("mollie_payment_webhook_failed_retryable", {
            level: "warn",
            errorCode: safeBillingErrorCode(error),
          });
          // A transient provider/DB failure must remain retryable by Mollie.
          // Never disclose whether a payment or tenant exists.
          res.status(503).type("text/plain").send("Retry");
        });
    }
  );
}

export function getMollieWebhookRateLimitKey(req: express.Request): string {
  const clientIp = req.ip || req.socket.remoteAddress;
  return `${req.method}:${clientIp ? ipKeyGenerator(clientIp) : "unknown"}`;
}

function getWebhookRateLimitPerMinute(): number {
  const parsed = Number(process.env.MOLLIE_WEBHOOK_RATE_LIMIT_PER_MINUTE);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_WEBHOOK_RATE_LIMIT_PER_MINUTE;
}

export async function handleMollieWebhook(
  body: unknown,
  dependencies?: { createClient?: () => MollieClient }
): Promise<"invalid" | "unknown" | "duplicate" | "mismatch" | "processed"> {
  const paymentId = readPaymentId(body);
  if (!paymentId) return "invalid";

  const config = getMollieConfig();
  const client = dependencies?.createClient?.() ?? new MollieClient(config);
  let payment;
  try {
    payment = await client.getPayment(paymentId);
  } catch (error) {
    if (error instanceof MollieApiError && error.status === 404) {
      return "unknown";
    }
    throw error;
  }
  if (payment.id !== paymentId || payment.mode !== config.mode) {
    return "unknown";
  }
  const intentId = readProviderIntentId(payment.metadata);
  if (!intentId) return "unknown";
  const workspaceId = await resolveMollieWebhookWorkspace(
    config.mode,
    paymentId,
    intentId
  );
  if (!workspaceId) {
    throw new Error("tenant billing webhook route is not available yet");
  }
  const pinnedWorkspaceId = getTenantBillingWorkerWorkspaceId();
  if (pinnedWorkspaceId && pinnedWorkspaceId !== workspaceId) {
    throw new Error("tenant billing webhook is outside the pilot boundary");
  }
  const result = await applyMolliePaymentSnapshot(payment, workspaceId);
  return result.result;
}

function readProviderIntentId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const intentId = (metadata as Record<string, unknown>).billingIntentId;
  return typeof intentId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{7,95}$/.test(intentId)
    ? intentId
    : null;
}

function readPaymentId(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = (body as Record<string, unknown>).id;
  if (typeof value !== "string" || !PAYMENT_ID_PATTERN.test(value)) return null;
  return value;
}
