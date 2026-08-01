import express, { type Express } from "express";
import rateLimit from "express-rate-limit";
import { safeLog } from "../logger";
import {
  getMollieConfig,
  getMollieWebhookPath,
  getTenantBillingWorkerWorkspaceId,
} from "./config";
import { MollieApiError, MollieClient } from "./mollieClient";
import { applyMolliePaymentSnapshot } from "./paymentStore";

const WEBHOOK_BODY_LIMIT = "2kb";
const PAYMENT_ID_PATTERN = /^tr_[A-Za-z0-9]{1,60}$/;
const DEFAULT_WEBHOOK_RATE_LIMIT_PER_MINUTE = 6_000;

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
  const webhookRateLimiter = rateLimit({
    windowMs: 60_000,
    max: getWebhookRateLimitPerMinute(),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      safeLog("mollie_payment_webhook_rate_limited", { level: "warn" });
      res.status(503).type("text/plain").send("Retry");
    },
  });

  app.post(getMollieWebhookPath(), webhookRateLimiter, formParser, (req, res) => {
    void handleMollieWebhook(req.body, dependencies)
      .then(result => {
        safeLog("mollie_payment_webhook_processed", { result });
        res.status(200).type("text/plain").send("OK");
      })
      .catch(error => {
        safeLog("mollie_payment_webhook_failed_retryable", {
          level: "warn",
          errorCode: safeErrorCode(error),
        });
        // A transient provider/DB failure must remain retryable by Mollie.
        // Never disclose whether a payment or tenant exists.
        res.status(503).type("text/plain").send("Retry");
      });
  });
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
  const workspaceId = getTenantBillingWorkerWorkspaceId();
  if (!workspaceId) {
    throw new Error("tenant billing webhook workspace is not configured");
  }
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
  const result = await applyMolliePaymentSnapshot(payment, workspaceId);
  return result.result;
}

function readPaymentId(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = (body as Record<string, unknown>).id;
  if (typeof value !== "string" || !PAYMENT_ID_PATTERN.test(value)) return null;
  return value;
}

function safeErrorCode(error: unknown): string {
  if (error instanceof MollieApiError) return error.code;
  return error instanceof Error ? error.name : "UnknownError";
}
