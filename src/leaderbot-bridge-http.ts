import type { MessengerWebhookMessaging } from "./types.js";
import {
  IMAGE_GEN_REQUEST_TIMEOUT_MS,
  resolveImageGenRequestConfig,
} from "./leaderbot-bridge-config.js";

export type LeaderbotBridgeTrace = {
  reqId: string;
  psidHash: string;
  accountId: string;
  startedAt: number;
};

export type LeaderbotBridgeStageLogger = (
  trace: LeaderbotBridgeTrace,
  stage: string,
  fields?: Record<string, string | number | boolean | undefined>,
) => void;

function logLeaderbotBridgeStage(
  params: { trace: LeaderbotBridgeTrace; logStage?: LeaderbotBridgeStageLogger },
  stage: string,
  fields?: Record<string, string | number | boolean | undefined>,
): void {
  params.logStage?.(params.trace, stage, fields);
}

export async function requestLeaderbotImageGeneration(params: {
  psid: string;
  prompt: string;
  reqId: string;
  timestamp: number;
  trace: LeaderbotBridgeTrace;
  leaderbotBridgeEnabled?: boolean;
  sourceImageUrl?: string;
  logStage?: LeaderbotBridgeStageLogger;
}): Promise<boolean> {
  const config = resolveImageGenRequestConfig({
    leaderbotBridgeEnabled: params.leaderbotBridgeEnabled,
  });
  if (!config.ok) {
    logLeaderbotBridgeStage(params, "image_gen_request_skipped", {
      reason: config.reason,
    });
    return false;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_GEN_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        psid: params.psid,
        prompt: params.prompt,
        reqId: params.reqId,
        lang: "nl",
        timestamp: params.timestamp,
        sourceImageUrl: params.sourceImageUrl,
      }),
    });
    logLeaderbotBridgeStage(params, "image_gen_request_sent", {
      status: response.status,
    });
    return response.ok;
  } catch (error) {
    logLeaderbotBridgeStage(params, "image_gen_request_failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function forwardLeaderbotMessengerEvent(params: {
  event: MessengerWebhookMessaging;
  trace: LeaderbotBridgeTrace;
  leaderbotBridgeEnabled?: boolean;
  logStage?: LeaderbotBridgeStageLogger;
}): Promise<boolean> {
  const config = resolveImageGenRequestConfig({
    leaderbotBridgeEnabled: params.leaderbotBridgeEnabled,
  });
  if (!config.ok) {
    logLeaderbotBridgeStage(params, "messenger_event_forward_skipped", {
      reason: config.reason,
    });
    return false;
  }

  const endpoint = new URL("/internal/messenger/webhook-event", config.endpoint);
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
      body: JSON.stringify({ event: params.event }),
    });
    logLeaderbotBridgeStage(params, "messenger_event_forward_sent", {
      status: response.status,
    });
    return response.ok;
  } catch (error) {
    logLeaderbotBridgeStage(params, "messenger_event_forward_failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
