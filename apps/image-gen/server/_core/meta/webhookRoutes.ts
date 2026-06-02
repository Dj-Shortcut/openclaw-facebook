import express from "express";
import rateLimit from "express-rate-limit";
import { z, ZodError } from "zod";
import { facebookWebhookPayloadSchema } from "../webhookSchemas";
import {
  isWhatsAppWebhookPayload,
} from "../inbound/whatsappInbound";
import {
  enqueueWebhookIngressDelivery,
  isWebhookIngressQueueEnabled,
  processWebhookDeliveryInline,
  scheduleWebhookIngressDrain,
} from "./webhookIngressQueue";
import { recordWebhookAckMetric } from "../observability";
import { safeLog } from "../logger";

const webhookVerificationQuerySchema = z.object({
  "hub.mode": z.literal("subscribe"),
  "hub.verify_token": z.string().min(1),
  "hub.challenge": z.string().min(1),
});

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

const webhookDeliveryLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1_000,
  standardHeaders: true,
  legacyHeaders: false,
});

const DEFAULT_WEBHOOK_INGRESS_ENQUEUE_TIMEOUT_MS = 450;

class WebhookIngressEnqueueTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`webhook ingress enqueue timed out after ${timeoutMs}ms`);
    this.name = "WebhookIngressEnqueueTimeoutError";
  }
}

function getMetaVerifyToken(): string {
  return (
    process.env.META_VERIFY_TOKEN?.trim() ||
    process.env.FB_VERIFY_TOKEN?.trim() ||
    ""
  );
}

function getWebhookIngressEnqueueTimeoutMs(): number {
  const configured = Number(process.env.WEBHOOK_INGRESS_ENQUEUE_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_WEBHOOK_INGRESS_ENQUEUE_TIMEOUT_MS;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new WebhookIngressEnqueueTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

export function registerMetaWebhookRoutes(app: express.Express): void {

  const handleVerification: express.RequestHandler = (req, res) => {
    const configuredToken = getMetaVerifyToken();
    const parsedQuery = webhookVerificationQuerySchema.safeParse(req.query);
    const path = req.path;

    safeLog("meta_webhook_verification_requested", { path });

    if (
      !configuredToken ||
      !parsedQuery.success ||
      parsedQuery.data["hub.verify_token"] !== configuredToken
    ) {
      safeLog("meta_webhook_verification_rejected", {
        level: "warn",
        path,
        hasConfiguredToken: Boolean(configuredToken),
        hasMode: typeof req.query["hub.mode"] === "string",
        hasChallenge: typeof req.query["hub.challenge"] === "string",
      });
      return res.sendStatus(403);
    }

    safeLog("meta_webhook_verification_accepted", { path });
    return res
      .status(200)
      .type("text/plain")
      .send(parsedQuery.data["hub.challenge"]);
  };

  app.get("/webhook", webhookLimiter, handleVerification);
  app.get("/webhook/facebook", webhookLimiter, handleVerification);
  app.get("/webhook/whatsapp", webhookLimiter, handleVerification); // NIEUW

  // Keep this dispatch branch local for now; it is the narrow seam for a later helper extraction.
  const handleWebhookPost: express.RequestHandler = async (req, res) => {
    const receivedAt = Date.now();
    safeLog("webhook_delivery_received", {
      path: req.path,
      contentLength: req.get("content-length") ?? null,
    });
    const ack = (channel: "facebook" | "whatsapp", mode: string) => {
      res.sendStatus(200);
      const ackMs = Date.now() - receivedAt;
      recordWebhookAckMetric(channel, mode, ackMs);
      safeLog("webhook_ack_sent", {
        channel,
        mode,
        ackMs,
      });
    };

    const enqueueOrFallback = async (channel: "facebook" | "whatsapp") => {
      try {
        await withTimeout(
          enqueueWebhookIngressDelivery(channel, req.body),
          getWebhookIngressEnqueueTimeoutMs()
        );
        ack(channel, "queued");
        scheduleWebhookIngressDrain();
      } catch (error) {
        if (error instanceof WebhookIngressEnqueueTimeoutError) {
          safeLog("webhook_durable_enqueue_timed_out", {
            level: "error",
            channel,
            error: error.message,
          });
          res.sendStatus(503);
          return;
        }

        safeLog("webhook_durable_enqueue_failed_inline_fallback", {
          level: "error",
          channel,
          error: error instanceof Error ? error.message : String(error),
        });
        ack(channel, "inline_after_enqueue_failure");
        processWebhookDeliveryInline(channel, req.body);
      }
    };

    if (isWhatsAppWebhookPayload(req.body)) {
      safeLog("whatsapp_webhook_post_delivery_received");

      if (!isWebhookIngressQueueEnabled()) {
        ack("whatsapp", "inline");
        processWebhookDeliveryInline("whatsapp", req.body);
        return;
      }

      await enqueueOrFallback("whatsapp");
      return;
    }

    try {
      facebookWebhookPayloadSchema.parse(req.body);
    } catch (error) {
      if (error instanceof ZodError) {
        safeLog("messenger_webhook_post_invalid_payload", { level: "warn" });
        res.status(400).json({ error: "Invalid webhook payload" });
        return;
      }

      throw error;
    }

    safeLog("messenger_webhook_post_delivery_received");
    if (!isWebhookIngressQueueEnabled()) {
      ack("facebook", "inline");
      processWebhookDeliveryInline("facebook", req.body);
      return;
    }

    await enqueueOrFallback("facebook");
  };

  app.post("/webhook", webhookDeliveryLimiter, handleWebhookPost);
  app.post("/webhook/facebook", webhookDeliveryLimiter, handleWebhookPost);
  app.post("/webhook/whatsapp", webhookDeliveryLimiter, handleWebhookPost); // NIEUW
}
