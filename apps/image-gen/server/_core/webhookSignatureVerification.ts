import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

type MetaWebhookRequest = Request & { rawBody?: Buffer };

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
  const appSecret = process.env.FB_APP_SECRET;

  // Fail closed if app secret is not configured
  if (!appSecret) {
    console.error("[meta webhook] signature validation failed: FB_APP_SECRET not configured");
    res.status(500).json({ error: "Server misconfiguration" });
    return;
  }

  // Require signature header
  if (!signature || typeof signature !== "string") {
    console.warn("[meta webhook] signature validation failed: missing or invalid X-Hub-Signature-256 header");
    res.status(403).json({ error: "Signature verification failed" });
    return;
  }

  // Get raw body (must be captured before JSON parsing)
  const rawBody = (req as MetaWebhookRequest).rawBody;
  if (!rawBody) {
    console.error("[meta webhook] signature validation failed: raw body unavailable");
    res.status(500).json({ error: "Server misconfiguration" });
    return;
  }

  // Enforce expected Meta signature format
  if (!signature.startsWith("sha256=")) {
    console.warn("[meta webhook] signature validation failed: invalid X-Hub-Signature-256 format");
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
    console.warn("[meta webhook] signature validation failed: digest mismatch");
    res.status(403).json({ error: "Signature verification failed" });
    return;
  }

  // Signature is valid, proceed
  console.log("[meta webhook] POST signature validated");
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
  if (!req.originalUrl.startsWith("/webhook")) {
    return;
  }

  if (!buf.length) {
    return;
  }

  (req as MetaWebhookRequest).rawBody = Buffer.from(buf);
}
