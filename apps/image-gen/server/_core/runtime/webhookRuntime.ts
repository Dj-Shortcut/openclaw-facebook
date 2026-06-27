import type express from "express";
import { registerInternalImageRequestRoutes } from "../internalImageRequestRoutes";
import { safeLog } from "../logger";
import { scheduleWebhookIngressDrain } from "../meta/webhookIngressQueue";
import { metaWebhookPublicPaths } from "../meta/webhookPaths";
import { registerBotRoutes, verifyBotWebhookSignature } from "../bot";

export function registerWebhookRuntime(app: express.Express) {
  app.use(metaWebhookPublicPaths, (req, _res, next) => {
    if (req.method === "POST") {
      safeLog("meta_webhook_inbound_post_hit", {
        path: req.path,
        contentType: req.headers["content-type"],
        hasSignatureHeader:
          typeof req.headers["x-hub-signature-256"] === "string",
      });
    }
    next();
  });

  // Verify webhook signature for all Meta webhook deliveries on supported callback paths.
  app.use(metaWebhookPublicPaths, verifyBotWebhookSignature);

  // Register webhook routes AFTER signature verification middleware
  // but BEFORE static files and catch-all routes.
  registerBotRoutes(app);
  registerInternalImageRequestRoutes(app);
  scheduleWebhookIngressDrain();
}
