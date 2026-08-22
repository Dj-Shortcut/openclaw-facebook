import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  billingNotificationReceiverOutbox,
  billingNotificationReceipts,
  billingNotificationSchedulerTenants,
} from "../../../drizzle/schema";
import { getDatabaseOrThrow } from "../../db";
import express from "express";
import {
  isBillingNotificationReason,
  type BillingNotificationAudience,
} from "./billingNotificationDelivery";

const REPLAY_WINDOW_SECONDS = 5 * 60;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RECEIVER_PATH = "/api/internal/billing/notifications/:audience";

export function registerBillingNotificationReceiverRoute(
  app: express.Express
): void {
  app.post(
    RECEIVER_PATH,
    express.raw({ type: "application/json", limit: "16kb" }),
    (req, res, next) => {
      const audience = String(req.params.audience ?? "");
      const publicOrigin = parsePublicOrigin();
      const path = `/api/internal/billing/notifications/${audience}`;
      void receiveBillingNotification({
        rawBody: Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "",
        method: "POST",
        originAndPath: `${publicOrigin}${path}`,
        routeAudience: audience,
        headers: {
          audience: String(req.header("X-Leaderbot-Audience") ?? ""),
          keyId: String(req.header("X-Leaderbot-Key-Id") ?? ""),
          timestamp: String(req.header("X-Leaderbot-Timestamp") ?? ""),
          signature: String(req.header("X-Leaderbot-Signature") ?? ""),
          idempotencyKey: String(req.header("Idempotency-Key") ?? ""),
        },
      })
        .then(result => {
          res.status(result === "accepted" ? 202 : 200).json({ ok: true });
        })
        .catch(error => {
          if (error instanceof BillingNotificationReceiverError) {
            res
              .status(error.statusCode)
              .json({ error: "notification rejected" });
            return;
          }
          next(error);
        });
    }
  );
}

function parsePublicOrigin(): string {
  const value = process.env.BILLING_NOTIFICATION_RECEIVER_PUBLIC_ORIGIN?.trim();
  if (!value) throw new BillingNotificationReceiverError(401);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BillingNotificationReceiverError(401);
  }
  if (
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new BillingNotificationReceiverError(401);
  }
  return url.origin;
}

export class BillingNotificationReceiverError extends Error {
  constructor(readonly statusCode: 400 | 401 | 409) {
    super("billing_notification_receiver_rejected");
  }
}

type ReceiverHeaders = Readonly<{
  audience: string;
  keyId: string;
  timestamp: string;
  signature: string;
  idempotencyKey: string;
}>;

export async function receiveBillingNotification(input: {
  rawBody: string;
  method: "POST";
  originAndPath: string;
  routeAudience: string;
  headers: ReceiverHeaders;
  now?: Date;
}): Promise<"accepted" | "duplicate"> {
  const now = input.now ?? new Date();
  const audience = input.headers.audience;
  if (audience !== "customer" && audience !== "operator") {
    throw new BillingNotificationReceiverError(400);
  }
  if (input.routeAudience !== audience) {
    throw new BillingNotificationReceiverError(400);
  }
  const prefix = `BILLING_NOTIFICATION_RECEIVER_${audience.toUpperCase()}`;
  const expectedKeyId = required(`${prefix}_KEY_ID`);
  const secret = required(`${prefix}_SIGNING_SECRET`);
  if (secret.length < 32 || input.headers.keyId !== expectedKeyId) {
    throw new BillingNotificationReceiverError(401);
  }
  const timestamp = Number(input.headers.timestamp);
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(Math.floor(now.getTime() / 1_000) - timestamp) >
      REPLAY_WINDOW_SECONDS
  ) {
    throw new BillingNotificationReceiverError(401);
  }
  const bodyDigest = createHash("sha256").update(input.rawBody).digest("hex");
  const canonical = [
    "v1",
    input.method,
    input.originAndPath,
    audience,
    input.headers.keyId,
    input.headers.timestamp,
    input.headers.idempotencyKey,
    bodyDigest,
  ].join("\n");
  const expected = createHmac("sha256", secret).update(canonical).digest("hex");
  const signatureMatch = /^v1=([0-9a-f]{64})$/.exec(input.headers.signature);
  const supplied = signatureMatch?.[1] ?? "";
  if (
    !/^[0-9a-f]{64}$/.test(supplied) ||
    !timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(supplied, "hex"))
  ) {
    throw new BillingNotificationReceiverError(401);
  }
  const payload = parsePayload(input.rawBody, audience);
  const sourceId = parseIdempotencyKey(
    input.headers.idempotencyKey,
    payload.mode,
    payload.deliveryId
  );
  if (sourceId !== required("BILLING_NOTIFICATION_RECEIVER_SOURCE_ID")) {
    throw new BillingNotificationReceiverError(401);
  }
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const existing = await tx
      .select()
      .from(billingNotificationReceipts)
      .where(
        and(
          eq(billingNotificationReceipts.sourceId, sourceId),
          eq(billingNotificationReceipts.mode, payload.mode),
          eq(billingNotificationReceipts.deliveryId, payload.deliveryId)
        )
      )
      .limit(1)
      .for("update");
    if (existing[0]) {
      if (
        existing[0].bodyDigest !== bodyDigest ||
        existing[0].audience !== audience
      ) {
        throw new BillingNotificationReceiverError(409);
      }
      return "duplicate" as const;
    }
    const insertResult = await tx.insert(billingNotificationReceipts).values({
      sourceId,
      mode: payload.mode,
      deliveryId: payload.deliveryId,
      workspaceId: payload.workspaceId,
      audience,
      bodyDigest,
      receivedAt: now,
    });
    const metadata = Array.isArray(insertResult)
      ? insertResult[0]
      : insertResult;
    const receiptId = Number((metadata as { insertId?: number }).insertId);
    if (!Number.isSafeInteger(receiptId) || receiptId <= 0) {
      throw new Error("notification receipt insert identity unavailable");
    }
    await tx.insert(billingNotificationReceiverOutbox).values({
      receiptId,
      workspaceId: payload.workspaceId,
      mode: payload.mode,
      audience,
      eventType: payload.eventType,
      reason: payload.reason,
      status: "pending",
    });
    await tx
      .insert(billingNotificationSchedulerTenants)
      .values({
        workspaceId: payload.workspaceId,
        mode: payload.mode,
        nextDueAt: now,
        pendingWorkCount: 1,
      })
      .onDuplicateKeyUpdate({
        set: {
          nextDueAt: sql`LEAST(${billingNotificationSchedulerTenants.nextDueAt}, ${now})`,
          pendingWorkCount: sql`${billingNotificationSchedulerTenants.pendingWorkCount} + 1`,
        },
      });
    return "accepted" as const;
  });
}

function parsePayload(rawBody: string, audience: BillingNotificationAudience) {
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    throw new BillingNotificationReceiverError(400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BillingNotificationReceiverError(400);
  }
  const payload = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "schema",
    "deliveryId",
    "workspaceId",
    "mode",
    "eventType",
    "reason",
    "occurredAt",
  ]);
  const eventType =
    audience === "customer" ? "payment_warning" : "manual_review";
  const occurredAt =
    typeof payload.occurredAt === "string" ? payload.occurredAt : "";
  if (
    Object.keys(payload).some(key => !allowedKeys.has(key)) ||
    payload.schema !== "leaderbot.billing.notification.v1" ||
    !UUID_V4.test(String(payload.deliveryId)) ||
    !Number.isSafeInteger(payload.workspaceId) ||
    Number(payload.workspaceId) <= 0 ||
    (payload.mode !== "test" && payload.mode !== "live") ||
    payload.eventType !== eventType ||
    !isBillingNotificationReason(audience, payload.reason) ||
    occurredAt.length > 32 ||
    !Number.isFinite(Date.parse(occurredAt)) ||
    new Date(occurredAt).toISOString() !== occurredAt
  ) {
    throw new BillingNotificationReceiverError(400);
  }
  return {
    deliveryId: String(payload.deliveryId),
    workspaceId: Number(payload.workspaceId),
    mode: payload.mode,
    eventType,
    reason: payload.reason,
  } as const;
}

function parseIdempotencyKey(
  value: string,
  mode: "test" | "live",
  deliveryId: string
): string {
  const suffix = `:${mode}:${deliveryId}`;
  if (!value.startsWith("billing-notification:") || !value.endsWith(suffix)) {
    throw new BillingNotificationReceiverError(400);
  }
  const sourceId = value.slice("billing-notification:".length, -suffix.length);
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(sourceId)) {
    throw new BillingNotificationReceiverError(400);
  }
  return sourceId;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new BillingNotificationReceiverError(401);
  return value;
}
