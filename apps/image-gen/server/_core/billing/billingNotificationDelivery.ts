import { createHash, createHmac } from "node:crypto";
import type { BillingOutboxItem } from "../../../drizzle/schema";

export class BillingNotificationConfigurationError extends Error {}
export class BillingNotificationTransientError extends Error {}

const OPERATOR_REASONS = new Set([
  "billing_customer_id_conflict",
  "billing_profile_changed_during_payment_creation",
  "billing_profile_ineligible_at_payment",
  "chargeback",
  "checkout_provider_response_mismatch",
  "duplicate_recurring_cycle",
  "historical_full_refund",
  "historical_payment_update",
  "invalid_amount",
  "invalid_provider_timestamp",
  "late_paid_superseded_replacement",
  "paid_after_terminal_subscription",
  "paid_period_missing",
  "paid_snapshot_state_review",
  "partial_refund",
  "payment_failed",
  "payment_mismatch",
  "pending_refund",
  "provider_payment_created_after_checkout_superseded",
  "reconciliation_subscription_mismatch",
  "recurring_payment_failed",
  "remote_subscription_mismatch",
  "startpilot_subscription_conflict",
  "subscription_cancellation_exhausted",
  "subscription_creation_outcome_unknown",
  "subscription_provisioning_failed",
  "customer_notification_delivery_failed",
  "billing_profile_expired",
  "billing_profile_revoked",
  "billing_profile_containment_retry_exhausted",
  "subscription_provider_ambiguous_after_disable",
  "payment_provider_ambiguous_after_disable",
  "billing_customer_created_after_disable",
  "subscription_cancellation_local_scope_mismatch",
  "subscription_cancellation_provider_scope_mismatch",
  "payment_cancellation_failed",
]);
const CUSTOMER_REASONS = new Set([
  "payment_failed",
  "recurring_payment_failed",
]);

export type BillingNotificationAudience = "customer" | "operator";

/** The signed notification receiver is an independent, provider-key-free plane. */
export function isBillingNotificationPlaneEnabled(): boolean {
  return process.env.BILLING_NOTIFICATION_PLANE_ENABLED === "true";
}

export function assertBillingNotificationConfig(): void {
  const liveMode = process.env.MOLLIE_MODE === "live";
  required("BILLING_NOTIFICATION_SOURCE_ID");
  const receiverOrigin = new URL(
    required("BILLING_NOTIFICATION_RECEIVER_PUBLIC_ORIGIN")
  );
  if (
    receiverOrigin.pathname !== "/" ||
    receiverOrigin.search ||
    receiverOrigin.hash ||
    ((process.env.NODE_ENV === "production" || liveMode) &&
      receiverOrigin.protocol !== "https:")
  ) {
    throw new BillingNotificationConfigurationError(
      "notification_receiver_origin_invalid"
    );
  }
  for (const audience of ["CUSTOMER", "OPERATOR"] as const) {
    const destination = validateNotificationDestination(
      required(`BILLING_${audience}_NOTIFICATION_WEBHOOK_URL`),
      liveMode
    );
    if (
      required(`BILLING_${audience}_NOTIFICATION_SIGNING_SECRET`).length < 32
    ) {
      throw new BillingNotificationConfigurationError(
        "notification_signing_secret_invalid"
      );
    }
    if (
      !/^[A-Za-z0-9._-]{3,40}$/.test(
        required(`BILLING_${audience}_NOTIFICATION_KEY_ID`)
      )
    ) {
      throw new BillingNotificationConfigurationError(
        "notification_key_id_invalid"
      );
    }
    if (
      required(`BILLING_NOTIFICATION_RECEIVER_${audience}_SIGNING_SECRET`)
        .length < 32 ||
      !/^[A-Za-z0-9._-]{3,40}$/.test(
        required(`BILLING_NOTIFICATION_RECEIVER_${audience}_KEY_ID`)
      )
    ) {
      throw new BillingNotificationConfigurationError(
        "notification_receiver_signing_config_invalid"
      );
    }
    const expectedPath = `/api/internal/billing/notifications/${audience.toLowerCase()}`;
    if (destination.toString() !== `${receiverOrigin.origin}${expectedPath}`) {
      throw new BillingNotificationConfigurationError(
        "notification_receiver_destination_mismatch"
      );
    }
    if (
      required(`BILLING_${audience}_NOTIFICATION_KEY_ID`) !==
        required(`BILLING_NOTIFICATION_RECEIVER_${audience}_KEY_ID`) ||
      required(`BILLING_${audience}_NOTIFICATION_SIGNING_SECRET`) !==
        required(`BILLING_NOTIFICATION_RECEIVER_${audience}_SIGNING_SECRET`)
    ) {
      throw new BillingNotificationConfigurationError(
        "notification_receiver_key_mapping_mismatch"
      );
    }
  }
  if (
    required("BILLING_CUSTOMER_NOTIFICATION_KEY_ID") ===
      required("BILLING_OPERATOR_NOTIFICATION_KEY_ID") ||
    required("BILLING_CUSTOMER_NOTIFICATION_SIGNING_SECRET") ===
      required("BILLING_OPERATOR_NOTIFICATION_SIGNING_SECRET") ||
    required("BILLING_NOTIFICATION_RECEIVER_CUSTOMER_KEY_ID") ===
      required("BILLING_NOTIFICATION_RECEIVER_OPERATOR_KEY_ID") ||
    required("BILLING_NOTIFICATION_RECEIVER_CUSTOMER_SIGNING_SECRET") ===
      required("BILLING_NOTIFICATION_RECEIVER_OPERATOR_SIGNING_SECRET")
  ) {
    throw new BillingNotificationConfigurationError(
      "notification_audience_keys_must_differ"
    );
  }
  if (
    required("BILLING_NOTIFICATION_RECEIVER_SOURCE_ID") !==
    required("BILLING_NOTIFICATION_SOURCE_ID")
  ) {
    throw new BillingNotificationConfigurationError(
      "notification_receiver_source_mismatch"
    );
  }
  if (process.env.BILLING_NOTIFICATION_RECEIVER_PREFLIGHT_ACK !== "true") {
    throw new BillingNotificationConfigurationError(
      "notification_receiver_preflight_missing"
    );
  }
}

export async function deliverBillingNotification(
  job: Pick<
    BillingOutboxItem,
    | "id"
    | "deliveryId"
    | "workspaceId"
    | "mode"
    | "eventType"
    | "attemptCount"
    | "payload"
    | "createdAt"
  >,
  fetchOverride: typeof fetch = fetch
): Promise<void> {
  const audience = notificationAudience(job.eventType);
  const prefix = `BILLING_${audience.toUpperCase()}_NOTIFICATION`;
  const url = validateNotificationDestination(
    required(`${prefix}_WEBHOOK_URL`),
    job.mode === "live"
  );
  const signingSecret = required(`${prefix}_SIGNING_SECRET`);
  const keyId = required(`${prefix}_KEY_ID`);
  if (signingSecret.length < 32 || !/^[A-Za-z0-9._-]{3,40}$/.test(keyId)) {
    throw new BillingNotificationConfigurationError(
      "notification_signing_config_invalid"
    );
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      job.deliveryId
    )
  ) {
    throw new BillingNotificationConfigurationError(
      "notification_delivery_id_invalid"
    );
  }
  if (
    !(job.createdAt instanceof Date) ||
    !Number.isFinite(job.createdAt.getTime())
  ) {
    throw new BillingNotificationConfigurationError(
      "notification_occurred_at_invalid"
    );
  }
  const sourceId = required("BILLING_NOTIFICATION_SOURCE_ID");
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(sourceId)) {
    throw new BillingNotificationConfigurationError(
      "notification_source_id_invalid"
    );
  }
  const reason = readNotificationReason(job.payload, audience);
  const body = JSON.stringify({
    schema: "leaderbot.billing.notification.v1",
    deliveryId: job.deliveryId,
    workspaceId: job.workspaceId,
    mode: job.mode,
    eventType: job.eventType,
    reason,
    occurredAt: job.createdAt.toISOString(),
  });
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const idempotencyKey = `billing-notification:${sourceId}:${job.mode}:${job.deliveryId}`;
  const bodyDigest = createHash("sha256").update(body).digest("hex");
  const canonical = [
    "v1",
    "POST",
    `${url.origin}${url.pathname}`,
    audience,
    keyId,
    timestamp,
    idempotencyKey,
    bodyDigest,
  ].join("\n");
  const signature = createHmac("sha256", signingSecret)
    .update(canonical)
    .digest("hex");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetchOverride(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
        "X-Leaderbot-Audience": audience,
        "X-Leaderbot-Key-Id": keyId,
        "X-Leaderbot-Timestamp": timestamp,
        "X-Leaderbot-Signature": `v1=${signature}`,
        "X-Leaderbot-Transport-Attempt": String(job.attemptCount),
      },
      body,
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      if ([408, 425, 429].includes(response.status) || response.status >= 500) {
        throw new BillingNotificationTransientError(
          "notification_transport_retryable"
        );
      }
      throw new BillingNotificationConfigurationError(
        "notification_transport_rejected"
      );
    }
  } catch (error) {
    if (
      error instanceof BillingNotificationConfigurationError ||
      error instanceof BillingNotificationTransientError
    )
      throw error;
    throw new BillingNotificationTransientError(
      "notification_transport_unavailable"
    );
  } finally {
    clearTimeout(timeout);
  }
}

function notificationAudience(eventType: string): BillingNotificationAudience {
  if (eventType === "payment_warning") return "customer";
  if (eventType === "manual_review") return "operator";
  throw new BillingNotificationConfigurationError(
    "unsupported_notification_event"
  );
}

function readNotificationReason(
  payload: unknown,
  audience: BillingNotificationAudience
): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new BillingNotificationConfigurationError(
      "notification_reason_missing"
    );
  }
  const value =
    (payload as Record<string, unknown>).reason ??
    (payload as Record<string, unknown>).code;
  if (!isBillingNotificationReason(audience, value)) {
    throw new BillingNotificationConfigurationError(
      "notification_reason_unknown"
    );
  }
  return value;
}

export function isBillingNotificationReason(
  audience: BillingNotificationAudience,
  value: unknown
): value is string {
  const reasons = audience === "customer" ? CUSTOMER_REASONS : OPERATOR_REASONS;
  return typeof value === "string" && value.length <= 80 && reasons.has(value);
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value)
    throw new BillingNotificationConfigurationError(
      "notification_configuration_missing"
    );
  return value;
}

function validateNotificationDestination(
  destination: string,
  liveMode = false
): URL {
  let url: URL;
  try {
    url = new URL(destination);
  } catch {
    throw new BillingNotificationConfigurationError(
      "notification_destination_invalid"
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    ((process.env.NODE_ENV === "production" || liveMode) &&
      url.protocol !== "https:") ||
    isPrivateNotificationHost(url.hostname)
  ) {
    throw new BillingNotificationConfigurationError(
      "notification_destination_insecure"
    );
  }
  if (process.env.NODE_ENV === "production" || liveMode) {
    const allowedOrigins = new Set(
      (process.env.BILLING_NOTIFICATION_ORIGIN_ALLOWLIST ?? "")
        .split(",")
        .map(value => value.trim().toLowerCase())
        .filter(Boolean)
    );
    if (!allowedOrigins.has(url.origin.toLowerCase())) {
      throw new BillingNotificationConfigurationError(
        "notification_destination_not_allowed"
      );
    }
  }
  return url;
}

function isPrivateNotificationHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  ) {
    return true;
  }
  if (
    host === "::1" ||
    host.startsWith("fe80:") ||
    host.startsWith("fc") ||
    host.startsWith("fd")
  ) {
    return true;
  }
  const parts = host.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    parts[0] === 0
  );
}
