import { createHash } from "node:crypto";
import { normalizeLang, t, type Lang } from "./i18n";
import {
  getStyleRepliesForCategory,
  getQuickRepliesForState,
  type ConversationState,
} from "./messengerState";
import {
  type Style,
  type StyleCategory,
  STYLE_CATEGORY_CONFIGS,
} from "./messengerStyles";

export type FacebookWebhookEvent = {
  sender?: { id?: string; locale?: string };
  referral?: { ref?: string };
  message?: {
    mid?: string;
    is_echo?: boolean;
    text?: string;
    quick_reply?: { payload?: string };
    attachments?: Array<{ type?: string; payload?: { url?: string } }>;
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

export const STYLE_OPTIONS: Style[] = [
  "caricature",
  "storybook-anime",
  "afroman-americana",
  "petals",
  "gold",
  "cinematic",
  "oil-paint",
  "cyberpunk",
  "norman-blackwell",
  "disco",
  "clouds",
];

export const STYLE_LABELS: Record<Style, string> = {
  caricature: "Caricature",
  "storybook-anime": "Storybook Anime",
  "afroman-americana": "Afroman",
  petals: "Petals",
  gold: "Gold",
  cinematic: "Cinematic",
  "oil-paint": "Oil Paint",
  cyberpunk: "Cyberpunk",
  "norman-blackwell": "Norman Blackwell",
  disco: "Disco",
  clouds: "Clouds",
};

export const STYLE_CATEGORY_LABELS: Record<StyleCategory, string> = {
  illustrated: "Illustrated",
  atmosphere: "Atmosphere",
  bold: "Bold",
};

const STYLE_ALIASES: Record<string, Style> = {
  afroman: "afroman-americana",
  "afroman americana": "afroman-americana",
  "afroman-americana": "afroman-americana",
  ghibli: "storybook-anime",
  "ghibli style": "storybook-anime",
  "studio ghibli": "storybook-anime",
  "storybook anime": "storybook-anime",
  "whimsical anime": "storybook-anime",
  whimsical: "storybook-anime",
  "oil paint": "oil-paint",
  "oil painting": "oil-paint",
  "oil-paint": "oil-paint",
  "norman blackwell": "norman-blackwell",
  blackwell: "norman-blackwell",
};

function normalizeStyleToken(input: string): string {
  return input.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

export type AckKind = "like" | "ok" | "thanks" | "emoji";

type GreetingResponse =
  | { mode: "text"; text: string }
  | { mode: "quick_replies"; state: ConversationState; text: string };

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
    case "AWAITING_STYLE":
      return {
        mode: "quick_replies",
        state: "AWAITING_STYLE",
        text: t(lang, "styleCategoryPicker"),
      };
    case "RESULT_READY":
      return {
        mode: "quick_replies",
        state: "RESULT_READY",
        text: t(lang, "success"),
      };
    case "FAILURE":
      return {
        mode: "quick_replies",
        state: "FAILURE",
        text: t(lang, "failure"),
      };
    case "AWAITING_PHOTO":
      return { mode: "text", text: t(lang, "textWithoutPhoto") };
    case "IDLE":
    default:
      return {
        mode: "quick_replies",
        state: "IDLE",
        text: t(lang, "flowExplanation"),
      };
  }
}

export function normalizeStyle(input: string): Style | undefined {
  const normalized = normalizeStyleToken(input);
  const alias = STYLE_ALIASES[normalized];
  if (alias) {
    return alias;
  }

  return STYLE_OPTIONS.find(style => normalizeStyleToken(style) === normalized);
}

export function stylePayloadToStyle(payload: string): Style | undefined {
  const canonicalPayloadStyle = normalizeStyle(payload);
  if (canonicalPayloadStyle) {
    return canonicalPayloadStyle;
  }

  if (!payload.startsWith("STYLE_")) {
    return undefined;
  }

  const styleKey = payload
    .slice("STYLE_".length)
    .toLowerCase()
    .replace(/_/g, "-");
  return normalizeStyle(styleKey);
}

export function parseStyle(text: string): Style | undefined {
  return normalizeStyle(text);
}

export function styleCategoryPayloadToCategory(
  payload: string
): StyleCategory | undefined {
  const category = STYLE_CATEGORY_CONFIGS.find(item => item.payload === payload);
  return category?.category;
}

export function parseReferralStyle(ref: string | undefined): Style | undefined {
  if (!ref?.startsWith("style_")) {
    return undefined;
  }

  return normalizeStyle(ref.slice("style_".length));
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

export function toMessengerReplies(state: ConversationState) {
  return getQuickRepliesForState(state).map(reply => ({
    content_type: "text" as const,
    title: reply.title,
    payload: reply.payload,
  }));
}

export function toMessengerStyleReplies(category: StyleCategory, lang: Lang) {
  return getStyleRepliesForCategory(category).map(reply => ({
    content_type: "text" as const,
    title:
      reply.payload === "CHOOSE_STYLE" ? t(lang, "backToCategories") : reply.title,
    payload: reply.payload,
  }));
}
