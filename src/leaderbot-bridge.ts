import { createHash, randomUUID } from "node:crypto";

import {
  IMAGE_GEN_REQUEST_TIMEOUT_MS,
  resolveImageGenRequestConfig,
} from "./leaderbot-bridge-config.js";

export {
  DEFAULT_IMAGE_GEN_URL,
  IMAGE_GEN_REQUEST_TIMEOUT_MS,
  resolveImageGenRequestConfig,
  type LeaderbotImageGenRequestConfig,
} from "./leaderbot-bridge-config.js";
export {
  forwardLeaderbotMessengerEvent,
  requestLeaderbotImageGeneration,
  type LeaderbotBridgeStageLogger,
  type LeaderbotBridgeTrace,
} from "./leaderbot-bridge-http.js";

export const DEFAULT_MESSENGER_CUSTOMER_PORTAL_URL = "https://leaderbot.live/";
export const DEFAULT_MESSENGER_PRIVACY_CONTACT = "privacy@leaderbot.live";
export const MESSENGER_CUSTOMER_PORTAL_NAME = "Leaderbot";

const AI_ANSWER_ENFORCEMENT_ENABLED_VALUE = "true";
const AI_ANSWER_QUOTA_PROTOCOL = "leaderbot-ai-answer-quota-v1";
const AI_ANSWER_QUOTA_HEARTBEAT_INTERVAL_MS = 60_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type LeaderbotAiAnswerQuotaReadiness = {
  protocol: typeof AI_ANSWER_QUOTA_PROTOCOL;
  preflightReady: true;
  admissionEnabled: boolean;
  drainEnabled: boolean;
};

export type LeaderbotAiAnswerQuotaLease = {
  reservationId: string;
  ownerToken: string;
};

export type LeaderbotAiAnswerQuotaHeartbeat = {
  renewBeforeDelivery: () => Promise<boolean>;
  stop: () => Promise<void>;
};

export type LeaderbotAiAnswerQuotaReservation =
  | { status: "not_applicable" }
  | ({ status: "reserved" } & LeaderbotAiAnswerQuotaLease)
  | { status: "duplicate" }
  | { status: "exhausted" }
  | { status: "unavailable" };

export function isLeaderbotAiAnswerEnforcementEnabled(): boolean {
  return (
    process.env.LEADERBOT_AI_ANSWER_ENFORCEMENT_ENABLED ===
    AI_ANSWER_ENFORCEMENT_ENABLED_VALUE
  );
}

export function createLeaderbotAiAnswerQuotaToken(): string {
  return randomUUID();
}

export async function getLeaderbotAiAnswerQuotaReadiness(): Promise<LeaderbotAiAnswerQuotaReadiness | null> {
  const response = await requestAiAnswerQuota("readiness");
  if (
    response?.protocol !== AI_ANSWER_QUOTA_PROTOCOL ||
    response.preflightReady !== true ||
    typeof response.admissionEnabled !== "boolean" ||
    typeof response.drainEnabled !== "boolean"
  ) {
    return null;
  }
  return {
    protocol: AI_ANSWER_QUOTA_PROTOCOL,
    preflightReady: true,
    admissionEnabled: response.admissionEnabled,
    drainEnabled: response.drainEnabled,
  };
}

export function createLeaderbotAiAnswerIdempotencyKey(input: {
  accountId: string;
  pageId: string;
  messageId?: string;
  traceRequestId: string;
  timestamp: number;
}): string {
  const messageId = input.messageId?.trim();
  const eventIdentity =
    messageId || `${input.traceRequestId}:${input.timestamp}`;
  const digest = createHash("sha256")
    .update(input.accountId)
    .update("\0")
    .update(input.pageId)
    .update("\0")
    .update(eventIdentity)
    .digest("hex");
  return `messenger_ai_answer:${digest}`;
}

export async function reserveLeaderbotAiAnswerQuota(input: {
  pageId: string;
  idempotencyKey: string;
  ownerToken: string;
}): Promise<LeaderbotAiAnswerQuotaReservation> {
  if (!isUuid(input.ownerToken)) return { status: "unavailable" };
  const response = await requestAiAnswerQuota("reserve", input);
  if (!response) return { status: "unavailable" };
  if (
    response.status === "not_applicable" ||
    response.status === "duplicate" ||
    response.status === "exhausted"
  ) {
    return { status: response.status };
  }
  if (
    response.status === "reserved" &&
    typeof response.reservationId === "string" &&
    isUuid(response.reservationId)
  ) {
    return {
      status: "reserved",
      reservationId: response.reservationId,
      ownerToken: input.ownerToken,
    };
  }
  return { status: "unavailable" };
}

export async function heartbeatLeaderbotAiAnswerQuota(
  input: LeaderbotAiAnswerQuotaLease,
): Promise<boolean> {
  if (!isQuotaLease(input)) return false;
  const response = await requestAiAnswerQuota("heartbeat", input);
  return response?.status === "lease_renewed";
}

export function startLeaderbotAiAnswerQuotaHeartbeat(
  lease: LeaderbotAiAnswerQuotaLease,
  options: {
    intervalMs?: number;
    heartbeat?: (input: LeaderbotAiAnswerQuotaLease) => Promise<boolean>;
  } = {},
): LeaderbotAiAnswerQuotaHeartbeat {
  const heartbeat = options.heartbeat ?? heartbeatLeaderbotAiAnswerQuota;
  const intervalMs =
    options.intervalMs ?? AI_ANSWER_QUOTA_HEARTBEAT_INTERVAL_MS;
  let stopped = false;
  let failed = false;
  let inFlight = Promise.resolve();

  const renew = (): Promise<void> => {
    if (stopped || failed) return inFlight;
    inFlight = inFlight
      .then(async () => {
        if (stopped || failed) return;
        if (!(await heartbeat(lease))) failed = true;
      })
      .catch(() => {
        failed = true;
      });
    return inFlight;
  };
  const timer = setInterval(() => {
    void renew();
  }, intervalMs);
  timer.unref?.();

  const stopTimer = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };

  return {
    renewBeforeDelivery: async () => {
      stopTimer();
      await inFlight;
      if (failed) return false;
      const renewed = await heartbeat(lease).catch(() => false);
      if (!renewed) failed = true;
      return renewed;
    },
    stop: async () => {
      stopTimer();
      await inFlight;
    },
  };
}

type LeaderbotAiAnswerQuotaDeliveryAttempt = LeaderbotAiAnswerQuotaLease & {
  pageId: string;
  deliveryAttemptToken: string;
};

export async function markLeaderbotAiAnswerDeliveryStarted(
  input: LeaderbotAiAnswerQuotaDeliveryAttempt,
): Promise<boolean> {
  if (!isQuotaDeliveryAttempt(input)) return false;
  const response = await requestAiAnswerQuota("delivery-started", input);
  return response?.status === "delivery_started";
}

export async function markLeaderbotAiAnswerDeliveryKnownRejected(
  input: LeaderbotAiAnswerQuotaDeliveryAttempt,
): Promise<boolean> {
  if (!isQuotaDeliveryAttempt(input)) return false;
  const response = await requestAiAnswerQuota("delivery-known-rejected", input);
  return response?.status === "delivery_known_rejected";
}

export async function finalizeLeaderbotAiAnswerQuota(input: {
  pageId: string;
  reservationId: string;
  ownerToken: string;
  outcome: "committed" | "released";
}): Promise<boolean> {
  if (!isQuotaLease(input)) return false;
  const response = await requestAiAnswerQuota("finalize", input);
  return response?.status === "finalized";
}

async function requestAiAnswerQuota(
  operation:
    | "readiness"
    | "reserve"
    | "heartbeat"
    | "delivery-started"
    | "delivery-known-rejected"
    | "finalize",
  body?: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const config = resolveImageGenRequestConfig({ leaderbotBridgeEnabled: true });
  if (!config.ok) return null;

  const endpoint = new URL(
    `/internal/messenger/ai-answer-quota/${operation}`,
    config.endpoint,
  );
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    IMAGE_GEN_REQUEST_TIMEOUT_MS,
  );
  try {
    const response = await fetch(endpoint, {
      method: operation === "readiness" ? "GET" : "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isQuotaLease(input: {
  reservationId?: unknown;
  ownerToken?: unknown;
}): input is LeaderbotAiAnswerQuotaLease {
  return isUuid(input.reservationId) && isUuid(input.ownerToken);
}

function isQuotaDeliveryAttempt(
  input: LeaderbotAiAnswerQuotaDeliveryAttempt,
): boolean {
  return isQuotaLease(input) && isUuid(input.deliveryAttemptToken);
}
