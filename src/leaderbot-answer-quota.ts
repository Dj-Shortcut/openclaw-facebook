import { createHash } from "node:crypto";

import {
  IMAGE_GEN_REQUEST_TIMEOUT_MS,
  resolveImageGenRequestConfig,
} from "./leaderbot-bridge-config.js";

const AI_ANSWER_ENFORCEMENT_ENABLED_VALUE = "true";

export type LeaderbotAiAnswerQuotaReservation =
  | { status: "not_applicable" }
  | { status: "reserved"; reservationId: string }
  | { status: "duplicate" }
  | { status: "exhausted" }
  | { status: "unavailable" };

export function isLeaderbotAiAnswerEnforcementEnabled(): boolean {
  return (
    process.env.LEADERBOT_AI_ANSWER_ENFORCEMENT_ENABLED ===
    AI_ANSWER_ENFORCEMENT_ENABLED_VALUE
  );
}

export function createLeaderbotAiAnswerIdempotencyKey(input: {
  accountId: string;
  pageId: string;
  messageId?: string;
  traceRequestId: string;
  timestamp: number;
}): string {
  const messageId = input.messageId?.trim();
  const eventIdentity = messageId || `${input.traceRequestId}:${input.timestamp}`;
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
}): Promise<LeaderbotAiAnswerQuotaReservation> {
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
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      response.reservationId,
    )
  ) {
    return { status: "reserved", reservationId: response.reservationId };
  }
  return { status: "unavailable" };
}

export async function finalizeLeaderbotAiAnswerQuota(input: {
  pageId: string;
  reservationId: string;
  outcome: "committed" | "released";
}): Promise<boolean> {
  const response = await requestAiAnswerQuota("finalize", input);
  return response?.status === "finalized";
}

async function requestAiAnswerQuota(
  operation: "reserve" | "finalize",
  body: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const config = resolveImageGenRequestConfig({ leaderbotBridgeEnabled: true });
  if (!config.ok) return null;

  const endpoint = new URL(
    `/internal/messenger/ai-answer-quota/${operation}`,
    config.endpoint,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_GEN_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
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
