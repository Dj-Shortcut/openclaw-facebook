import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { safeLog } from "./logger";
import { metaWebhookPublicPaths } from "./meta/webhookPaths";

type MetaWebhookRequest = Request & { rawBody?: Buffer };

function isWhatsAppWebhookRequest(req: Request): boolean {
  const originalPath = req.originalUrl.split("?")[0] ?? "";
  return originalPath === "/webhook/whatsapp" || originalPath.startsWith("/webhook/whatsapp/");
}

function getMetaWebhookAppSecret(req: Request): string {
  if (isWhatsAppWebhookRequest(req)) {
    return process.env.WHATSAPP_APP_SECRET?.trim() || process.env.FB_APP_SECRET?.trim() || "";
  }

  return process.env.FB_APP_SECRET?.trim() ?? "";
}

/**
 * Verifies Meta webhook signature using HMAC-SHA256
 * Protects against forged webhook events
 */
export function verifyMetaWebhookSignature(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (req.method !== "POST") {
    next();
    return;
  }

  const signature = req.headers["x-hub-signature-256"];
  const appSecret = getMetaWebhookAppSecret(req);

  // Fail closed if app secret is not configured
  if (!appSecret) {
    safeLog("meta_webhook_signature_validation_failed", {
      level: "error",
      reason: "missing_app_secret",
    });
    res.status(500).json({ error: "Server misconfiguration" });
    return;
  }

  // Require signature header
  if (!signature || typeof signature !== "string") {
    safeLog("meta_webhook_signature_validation_failed", {
      level: "warn",
      reason: "missing_or_invalid_header",
    });
    res.status(403).json({ error: "Signature verification failed" });
    return;
  }

  // Get raw body (must be captured before JSON parsing)
  const rawBody = (req as MetaWebhookRequest).rawBody;
  if (!rawBody) {
    safeLog("meta_webhook_signature_validation_failed", {
      level: "error",
      reason: "raw_body_unavailable",
    });
    res.status(500).json({ error: "Server misconfiguration" });
    return;
  }

  // Enforce expected Meta signature format
  if (!signature.startsWith("sha256=")) {
    safeLog("meta_webhook_signature_validation_failed", {
      level: "warn",
      reason: "invalid_header_format",
    });
    res.status(403).json({ error: "Signature verification failed" });
    return;
  }

  // Recreate signature
  const expectedSignature = createHmac("sha256", appSecret)
    .update(rawBody)
    .digest("hex");

  const expectedHeader = `sha256=${expectedSignature}`;

  // Compare signatures using constant-time comparison to prevent timing attacks
  const isValid = safeCompare(signature, expectedHeader);

  if (!isValid) {
    safeLog("meta_webhook_signature_validation_failed", {
      level: "warn",
      reason: "digest_mismatch",
    });
    res.status(403).json({ error: "Signature verification failed" });
    return;
  }

  // Signature is valid, proceed
  safeLog("meta_webhook_signature_validated");
  next();
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
function safeCompare(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");

  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}

export function captureMetaWebhookRawBody(
  req: Request,
  _res: Response,
  buf: Buffer
): void {
  const path = req.originalUrl;
  if (!metaWebhookPublicPaths.some(publicPath => path.startsWith(publicPath))) {
    return;
  }

  if (!buf.length) {
    return;
  }

  (req as MetaWebhookRequest).rawBody = Buffer.from(buf);
}
