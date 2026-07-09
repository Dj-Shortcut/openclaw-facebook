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
    attachments?: FacebookWebhookAttachment[];
    reply_to?: { mid?: string };
  };
  postback?: {
    title?: string;
    payload?: string;
    referral?: { ref?: string };
  };
  timestamp?: number;
};

export type FacebookWebhookAttachment = {
  type?: string;
  payload?: {
    url?: string;
    mime_type?: string;
    sticker_id?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type MessengerNormalizedAttachment = {
  type: MessengerAttachmentCategory;
  rawType: string;
  payload?: FacebookWebhookAttachment["payload"];
  url?: string;
  mimeType?: string;
};

export type MessengerNormalizedInboundMessage = {
  text?: string;
  attachments: MessengerNormalizedAttachment[];
};

export type MessengerAttachmentCategory =
  | "image"
  | "gif"
  | "audio"
  | "video"
  | "file"
  | "link"
  | "unknown";

export type MessengerAttachmentRoute =
  | "image"
  | "audio"
  | "unsupported_video"
  | "unsupported_file"
  | "unsupported_share"
  | "unsupported_sticker"
  | "unsupported_unknown";

export type MessengerAttachmentRouteDecision = {
  route: MessengerAttachmentRoute;
  rejectedReason?: string;
};

const GIF_MIME_HINT = /gif/i;
const LINK_ATTACHMENT_TYPES = new Set(["file_share", "link", "share", "fallback"]);
const EMPTY_ATTACHMENT_TYPE = "unknown";

type AttachmentLikeForCategory =
  | FacebookWebhookAttachment
  | MessengerNormalizedAttachment;

function normalizeAttachmentType(type: string | undefined): string {
  return type?.trim().toLowerCase() ?? "";
}

function resolveAttachmentPayload(
  attachment: AttachmentLikeForCategory | undefined
): FacebookWebhookAttachment["payload"] | undefined {
  return attachment?.payload;
}

function resolveAttachmentUrl(
  attachment: AttachmentLikeForCategory | undefined
): string | undefined {
  const payload = resolveAttachmentPayload(attachment);
  if (typeof payload?.url === "string") {
    return payload.url;
  }

  return typeof (attachment as MessengerNormalizedAttachment)?.url === "string"
    ? (attachment as MessengerNormalizedAttachment).url
    : undefined;
}

function resolveAttachmentMimeType(
  attachment: AttachmentLikeForCategory | undefined
): string {
  const payload = resolveAttachmentPayload(attachment);
  if (typeof payload?.mime_type === "string") {
    return payload.mime_type.trim().toLowerCase();
  }

  if (typeof (attachment as MessengerNormalizedAttachment)?.mimeType === "string") {
    return (attachment as MessengerNormalizedAttachment).mimeType!.trim().toLowerCase();
  }

  return "";
}

function isLikelyGifAttachment(attachment: AttachmentLikeForCategory): boolean {
  const mimeType = resolveAttachmentMimeType(attachment);
  if (GIF_MIME_HINT.test(mimeType)) {
    return true;
  }

  const attachmentUrl = resolveAttachmentUrl(attachment)?.trim();
  if (!attachmentUrl) {
    return false;
  }

  return attachmentUrl
    .split(/[?#]/)[0]
    .toLowerCase()
    .includes(".gif");
}

function getAttachmentCategory(
  attachment: AttachmentLikeForCategory | undefined
): MessengerAttachmentCategory {
  if (!attachment) {
    return EMPTY_ATTACHMENT_TYPE;
  }

  const rawType = normalizeAttachmentType(
    (attachment as MessengerNormalizedAttachment).rawType || attachment.type
  );
  if (rawType === "image" && isLikelyGifAttachment(attachment)) {
    return "gif";
  }

  if (rawType === "image") {
    return "image";
  }

  if (rawType === "audio") {
    return "audio";
  }

  if (rawType === "video") {
    return "video";
  }

  if (rawType === "file") {
    return "file";
  }

  if (LINK_ATTACHMENT_TYPES.has(rawType)) {
    return "link";
  }

  return EMPTY_ATTACHMENT_TYPE;
}

export function isImageAttachment(
  attachment: FacebookWebhookAttachment
): boolean {
  const category = getAttachmentCategory(attachment);
  return category === "image" || category === "gif";
}

export function normalizeMessengerInboundMessage(
  message: FacebookWebhookEvent["message"] | undefined
): MessengerNormalizedInboundMessage {
  return {
    text: message?.text,
    attachments: normalizeMessengerAttachments(message?.attachments),
  };
}

function normalizeMessengerAttachments(
  attachments: FacebookWebhookAttachment[] | undefined
): MessengerNormalizedAttachment[] {
  if (!attachments?.length) {
    return [];
  }

  return attachments.map(attachment => {
    const category = getAttachmentCategory(attachment);
    const payload = attachment.payload;
    return {
      type: category,
      rawType: normalizeAttachmentType(attachment.type),
      payload,
      url: typeof payload?.url === "string" ? payload.url : undefined,
      mimeType:
        typeof payload?.mime_type === "string" ? payload.mime_type : undefined,
    };
  });
}

export function getNormalizedAttachmentTypes(
  attachments: MessengerNormalizedAttachment[] | undefined
): MessengerAttachmentCategory[] {
  if (!attachments?.length) {
    return [];
  }

  return Array.from(new Set(attachments.map(att => att.type))).sort();
}

export function resolveMessengerAttachmentRoute(
  attachments: MessengerNormalizedAttachment[] | undefined
): MessengerAttachmentRouteDecision | null {
  if (!attachments?.length) {
    return null;
  }

  if (hasImageAttachment(attachments)) {
    return { route: "image" };
  }

  if (hasAudioAttachment(attachments)) {
    return { route: "audio" };
  }

  if (hasVideoAttachment(attachments)) {
    return { route: "unsupported_video", rejectedReason: "unsupported_video" };
  }

  if (hasFileAttachment(attachments)) {
    return { route: "unsupported_file", rejectedReason: "unsupported_file" };
  }

  if (hasLinkAttachment(attachments)) {
    return { route: "unsupported_share", rejectedReason: "unsupported_share" };
  }

  if (hasStickerAttachment(attachments)) {
    return { route: "unsupported_sticker", rejectedReason: "unsupported_sticker" };
  }

  if (hasUnknownAttachment(attachments)) {
    return {
      route: "unsupported_unknown",
      rejectedReason: "unsupported_payload",
    };
  }

  return null;
}

export function hasAttachmentUrl(
  attachments: MessengerNormalizedAttachment[] | undefined
): boolean {
  return attachments?.some(att => typeof att.url === "string" && att.url.trim() !== "")
    ?? false;
}

function hasStickerAttachment(
  attachments: MessengerNormalizedAttachment[] | undefined
): boolean {
  return (
    attachments?.some(
      att => att.type === "unknown" && att.rawType === "sticker"
    ) ?? false
  );
}

export function hasImageAttachment(
  attachments: MessengerNormalizedAttachment[] | undefined
): boolean {
  return (
    attachments?.some(att => att.type === "image" || att.type === "gif") ??
    false
  );
}

function hasAudioAttachment(
  attachments: MessengerNormalizedAttachment[] | undefined
): boolean {
  return attachments?.some(att => att.type === "audio") ?? false;
}

function hasVideoAttachment(
  attachments: MessengerNormalizedAttachment[] | undefined
): boolean {
  return attachments?.some(att => att.type === "video") ?? false;
}

function hasFileAttachment(
  attachments: MessengerNormalizedAttachment[] | undefined
): boolean {
  return attachments?.some(att => att.type === "file") ?? false;
}

function hasUnknownAttachment(
  attachments: MessengerNormalizedAttachment[] | undefined
): boolean {
  return attachments?.some(att => att.type === "unknown") ?? false;
}

function hasLinkAttachment(
  attachments: MessengerNormalizedAttachment[] | undefined
): boolean {
  return attachments?.some(att => att.type === "link") ?? false;
}

export function hasReadableImageAttachment(
  attachments: MessengerNormalizedAttachment[] | undefined
): boolean {
  return (
    attachments?.some(
      att =>
        (att.type === "image" || att.type === "gif") &&
        typeof att.url === "string" &&
        att.url.trim() !== ""
    ) ?? false
  );
}

export function getAttachmentCategorySummary(
  attachments: FacebookWebhookAttachment[] | undefined
): MessengerAttachmentCategory[] {
  if (!attachments?.length) {
    return [];
  }

  return Array.from(
    new Set(
      attachments
        .map(attachment => getAttachmentCategory(attachment))
        .filter(category => category !== "unknown")
    )
  ).sort();
}

export type FacebookWebhookEntry = {
  id?: string;
  messaging?: FacebookWebhookEvent[];
};

export type AckKind = "like" | "ok" | "thanks";

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

  return null;
}
