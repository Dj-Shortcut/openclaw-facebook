import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveMessengerAccount } from "./accounts.js";
import type { OpenClawConfig } from "./channel-api.js";
import { stripFacebookTargetPrefix } from "./naming.js";
import { createMessengerSendReceipt } from "./send-receipt.js";
import type { MessengerSendResult } from "./types.js";

const DEFAULT_GRAPH_API_VERSION = "v20.0";
const MESSENGER_SEND_TIMEOUT_MS = 10_000;
const MESSENGER_TEXT_MAX_LENGTH = 2000;

type FetchLike = typeof fetch;

function resolveGraphApiVersion(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed || DEFAULT_GRAPH_API_VERSION;
}

function formatMessengerApiError(body: unknown): string {
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  if (!error || typeof error !== "object") {
    return "Messenger API request failed";
  }
  const details = error as { message?: string; code?: number; error_subcode?: number };
  const message = details.message?.trim() || "Messenger API request failed";
  if (details.code === 190) {
    return `Messenger Page access token is invalid or expired: ${message}`;
  }
  if (details.code === 4 || details.code === 613) {
    return `Messenger API rate limit reached: ${message}`;
  }
  if (details.code === 10 && details.error_subcode === 2534022) {
    return `Messenger cannot send outside the 24-hour response window: ${message}`;
  }
  if (details.code === 200) {
    return `Messenger permission or app review issue: ${message}`;
  }
  if (details.code === 551 || details.error_subcode === 1545041) {
    return `Messenger recipient is unavailable: ${message}`;
  }
  return `Messenger API error${details.code ? ` ${details.code}` : ""}: ${message}`;
}

function normalizeMessengerText(text: string): string {
  if (text.length <= MESSENGER_TEXT_MAX_LENGTH) {
    return text;
  }
  return text.slice(0, MESSENGER_TEXT_MAX_LENGTH);
}

export async function sendMessengerText(
  to: string,
  text: string,
  opts: {
    cfg: OpenClawConfig;
    accountId?: string;
    fetch?: FetchLike;
  },
): Promise<MessengerSendResult> {
  const account = resolveMessengerAccount({ cfg: opts.cfg, accountId: opts.accountId });
  if (!account.pageId.trim()) {
    throw new Error(`Messenger pageId missing for account "${account.accountId}".`);
  }
  if (!account.pageAccessToken.trim()) {
    throw new Error(`Messenger Page access token missing for account "${account.accountId}".`);
  }
  const normalizedTo = stripFacebookTargetPrefix(to) || to.trim();
  if (!normalizedTo) {
    throw new Error(`Messenger recipient id missing for account "${account.accountId}".`);
  }
  const fetchImpl = opts.fetch ?? fetch;
  const normalizedText = normalizeMessengerText(text);
  const version = resolveGraphApiVersion(account.config.graphApiVersion);
  const url = `https://graph.facebook.com/${version}/${encodeURIComponent(account.pageId)}/messages`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MESSENGER_SEND_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${account.pageAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: { id: normalizedTo },
        messaging_type: "RESPONSE",
        message: { text: normalizedText },
      }),
    });
  } catch (error) {
    throw new Error(`Messenger send failed: ${formatErrorMessage(error)}`, { cause: error });
  } finally {
    clearTimeout(timeout);
  }
  const body = (await response.json().catch(() => null)) as {
    message_id?: string;
    recipient_id?: string;
  } | null;
  if (!response.ok) {
    throw new Error(formatMessengerApiError(body));
  }
  const result = body as { message_id?: string; recipient_id?: string };
  const messageId = result.message_id?.trim();
  const recipientId = result.recipient_id?.trim();
  if (!messageId || !recipientId) {
    throw new Error(
      "Messenger send succeeded but response did not include message_id and recipient_id.",
    );
  }
  return {
    messageId,
    recipientId,
    receipt: createMessengerSendReceipt({ messageId, recipientId }),
  };
}

export async function sendMessengerSenderAction(
  to: string,
  senderAction: "typing_on" | "typing_off" | "mark_seen",
  opts: {
    cfg: OpenClawConfig;
    accountId?: string;
    fetch?: FetchLike;
  },
): Promise<void> {
  const account = resolveMessengerAccount({ cfg: opts.cfg, accountId: opts.accountId });
  if (!account.pageId.trim()) {
    throw new Error(`Messenger pageId missing for account "${account.accountId}".`);
  }
  if (!account.pageAccessToken.trim()) {
    throw new Error(`Messenger Page access token missing for account "${account.accountId}".`);
  }
  const normalizedTo = stripFacebookTargetPrefix(to) || to.trim();
  if (!normalizedTo) {
    throw new Error(`Messenger recipient id missing for account "${account.accountId}".`);
  }
  const fetchImpl = opts.fetch ?? fetch;
  const version = resolveGraphApiVersion(account.config.graphApiVersion);
  const url = `https://graph.facebook.com/${version}/${encodeURIComponent(account.pageId)}/messages`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MESSENGER_SEND_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${account.pageAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: { id: normalizedTo },
        sender_action: senderAction,
      }),
    });
  } catch (error) {
    throw new Error(`Messenger sender action failed: ${formatErrorMessage(error)}`, {
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new Error(formatMessengerApiError(body));
  }
}

