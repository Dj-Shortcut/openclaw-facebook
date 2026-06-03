import { createHash } from "node:crypto";
import { normalizeLang, t, type Lang } from "./i18n";
import type { ConversationState } from "./messengerState";

export type FacebookWebhookEvent = {
  sender?: { id?: string; locale?: string };
  referral?: { ref?: string };
  message?: {
    mid?: string;
    is_echo?: boolean;
    text?: string;
    quick_reply?: { payload?: string };
    attachments?: Array<{ type?: string; payload?: { url?: string } }>;
    reply_to?: { mid?: string };
  };
  postback?: {
    title?: string;
    payload?: string;
    referral?: { ref?: string };
  };
  timestamp?: number;
};

export type FacebookWebhookEntry = {
  id?: string;
  messaging?: FacebookWebhookEvent[];
};

export type WebhookSummaryEvent = {
  type: "message" | "postback" | "read" | "delivery" | "unknown";
  hasText: boolean;
  attachmentTypes: string[];
  isEcho: boolean;
  hasRead: boolean;
  hasDelivery: boolean;
  hasPostback: boolean;
};

export type WebhookSummary = {
  object?: string;
  entryCount: number;
  events: WebhookSummaryEvent[];
};

export type AckKind = "like" | "ok" | "thanks" | "emoji";

type GreetingResponse =
  | { mode: "text"; text: string };

export function getEventDedupeKey(
  event: FacebookWebhookEvent,
  userKey: string,
  entryId?: string
): string | undefined {
  const messageId = event.message?.mid?.trim();
  if (messageId) {
    return `mid:${messageId}`;
  }

  const hashToken = (value: string | undefined): string => {
    const normalizedValue = value?.trim();
    if (!normalizedValue) {
      return "none";
    }

    return createHash("sha256")
      .update(normalizedValue)
      .digest("hex")
      .slice(0, 12);
  };

  const eventType = event.message
    ? "message"
    : event.postback
      ? "postback"
      : "other";
  const postbackPayloadHash = hashToken(event.postback?.payload);
  const quickReplyPayloadHash = hashToken(event.message?.quick_reply?.payload);
  const hasText = event.message?.text?.trim() ? "1" : "0";
  const attachmentTypeCounts = (() => {
    const counts = new Map<string, number>();
    for (const attachment of event.message?.attachments ?? []) {
      const type = attachment.type?.trim() || "unknown";
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }

    return (
      Array.from(counts.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([type, count]) => `${type}:${count}`)
        .join(",") || "none"
    );
  })();
  const fallbackEventFingerprint = [
    eventType,
    `postback:${postbackPayloadHash}`,
    `quickReply:${quickReplyPayloadHash}`,
    `hasText:${hasText}`,
    `attachments:${attachmentTypeCounts}`,
  ].join("|");

  const timestamp = event.timestamp;
  const normalizedEntryId = entryId?.trim();
  if (normalizedEntryId && Number.isFinite(timestamp)) {
    return `entry:${normalizedEntryId}:user:${userKey}:ts:${timestamp}:event:${fallbackEventFingerprint}`;
  }

  if (Number.isFinite(timestamp)) {
    return `fallback:${userKey}:${timestamp}:event:${fallbackEventFingerprint}`;
  }

  return undefined;
}



export function getGreetingResponse(
  state: ConversationState,
  lang: Lang = normalizeLang(process.env.DEFAULT_MESSENGER_LANG)
): GreetingResponse {
  switch (state) {
    case "PROCESSING":
      return { mode: "text", text: t(lang, "processingBlocked") };
    case "AWAITING_EDIT_PROMPT":
      return { mode: "text", text: t(lang, "editImagePrompt") };
    case "RESULT_READY":
      return { mode: "text", text: t(lang, "success") };
    case "FAILURE":
      return { mode: "text", text: t(lang, "failure") };
    case "AWAITING_PHOTO":
      return { mode: "text", text: t(lang, "textWithoutPhoto") };
    case "IDLE":
    default:
      return { mode: "text", text: t(lang, "flowExplanation") };
  }
}

export function detectAck(raw: string | undefined | null): AckKind | null {
  if (!raw) {
    return null;
  }

  const text = raw.trim();
  if (!text) {
    return null;
  }

  const lower = text.toLowerCase();

  if (/^\(\s*y\s*\)$/.test(lower)) {
    return "like";
  }

  if (/^(ok|oke|k|kk|yes|yep|ja|jep)$/.test(lower)) {
    return "ok";
  }

  if (/^(thanks|thx|merci|tks)$/.test(lower)) {
    return "thanks";
  }

  if (
    text.length > 0 &&
    Array.from(text).every(char => /[\p{Extended_Pictographic}\s]/u.test(char))
  ) {
    return "emoji";
  }

  return null;
}
