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

function getMetaVerifyToken(): string {
  return (
    process.env.META_VERIFY_TOKEN?.trim() ||
    process.env.FB_VERIFY_TOKEN?.trim() ||
    ""
  );
}

export function registerMetaWebhookRoutes(app: express.Express): void {

  const handleVerification: express.RequestHandler = (req, res) => {
    const configuredToken = getMetaVerifyToken();
    const parsedQuery = webhookVerificationQuerySchema.safeParse(req.query);
    const path = req.path;

    console.log("[meta webhook] GET verification request", { path });

    if (
      !configuredToken ||
      !parsedQuery.success ||
      parsedQuery.data["hub.verify_token"] !== configuredToken
    ) {
      console.warn("[meta webhook] GET verification rejected", {
        path,
        hasConfiguredToken: Boolean(configuredToken),
        hasMode: typeof req.query["hub.mode"] === "string",
        hasChallenge: typeof req.query["hub.challenge"] === "string",
      });
      return res.sendStatus(403);
    }

    console.log("[meta webhook] GET verification accepted", { path });
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
    if (isWhatsAppWebhookPayload(req.body)) {
      console.log("[whatsapp webhook] POST delivery received");
      if (!isWebhookIngressQueueEnabled()) {
        res.sendStatus(200);
        processWebhookDeliveryInline("whatsapp", req.body);
        return;
      }

      try {
        await enqueueWebhookIngressDelivery("whatsapp", req.body);
      } catch (error) {
        console.error("[whatsapp webhook] durable enqueue failed, falling back to inline processing", {
          error: error instanceof Error ? error.message : String(error),
        });
        res.sendStatus(200);
        processWebhookDeliveryInline("whatsapp", req.body);
        return;
      }

      res.sendStatus(200);
      scheduleWebhookIngressDrain();
      return;
    }

    try {
      facebookWebhookPayloadSchema.parse(req.body);
    } catch (error) {
      if (error instanceof ZodError) {
        console.warn("[messenger webhook] POST rejected: invalid payload shape");
        res.status(400).json({ error: "Invalid webhook payload" });
        return;
      }

      throw error;
    }

    console.log("[messenger webhook] POST delivery received");
    if (!isWebhookIngressQueueEnabled()) {
      res.sendStatus(200);
      processWebhookDeliveryInline("facebook", req.body);
      return;
    }

    try {
      await enqueueWebhookIngressDelivery("facebook", req.body);
    } catch (error) {
      console.error("[messenger webhook] durable enqueue failed, falling back to inline processing", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.sendStatus(200);
      processWebhookDeliveryInline("facebook", req.body);
      return;
    }

    res.sendStatus(200);
    scheduleWebhookIngressDrain();
  };

  app.post("/webhook", webhookDeliveryLimiter, handleWebhookPost);
  app.post("/webhook/facebook", webhookDeliveryLimiter, handleWebhookPost);
  app.post("/webhook/whatsapp", webhookDeliveryLimiter, handleWebhookPost); // NIEUW
}
