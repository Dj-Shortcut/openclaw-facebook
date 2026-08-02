import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { TextDecoder } from "node:util";
import {
  ConversationIdentityError,
  resolveConversationSenderId,
  resolveMessengerWebhookEndpoint,
  resolveWhatsAppEndpoint,
  type ConversationEndpoint,
  type ConversationSenderId,
  type MessengerEndpoint,
  type WhatsAppEndpoint,
} from "../conversationEndpoint";
import type { ConversationBoundaryPayloadKindV2 } from "../conversationBoundaryEnvelope";
import type { WebhookReplayEventIdentityV2 } from "../webhookReplayProtectionV2";

const MAX_CONVERSATION_UNITS_PER_DELIVERY = 100;
const MAX_PROVIDER_ARRAY_ITEMS = 100;
const MAX_VERIFIED_WEBHOOK_BODY_BYTES = 10 * 1_024 * 1_024;
const MAX_ATTACHMENTS_PER_MESSAGE = 20;
const MAX_CANONICAL_PAYLOAD_BYTES = 256 * 1_024;
const MAX_MESSAGE_ID_BYTES = 1_024;
const MAX_TEXT_BYTES = 32 * 1_024;
const MAX_ACTION_PAYLOAD_BYTES = 4 * 1_024;
const MAX_URL_BYTES = 8 * 1_024;
const MAX_MIME_TYPE_BYTES = 256;
const MAX_LOCALE_BYTES = 64;
const MAX_TYPE_BYTES = 64;
const VISIBLE_ASCII_PATTERN = /^[\x21-\x7e]+$/;
const WHATSAPP_TIMESTAMP_PATTERN = /^(0|[1-9][0-9]{0,15})$/;

const MESSENGER_ATTACHMENT_TYPES = new Set<MessengerAttachmentTypeV2>([
  "image",
  "audio",
  "video",
  "file",
  "file_share",
  "link",
  "share",
  "fallback",
  "sticker",
  "unknown",
]);

const verifiedMetaWebhookBodyBrand: unique symbol = Symbol(
  "verifiedMetaWebhookBodyV2"
);
const authenticatedMetaWebhookBodies = new WeakSet<object>();

export type VerifiedMetaWebhookBodyV2 = Readonly<{
  signatureProvider: "messenger" | "whatsapp";
  payload: unknown;
  readonly [verifiedMetaWebhookBodyBrand]: true;
}>;

export type MessengerAttachmentTypeV2 =
  | "image"
  | "audio"
  | "video"
  | "file"
  | "file_share"
  | "link"
  | "share"
  | "fallback"
  | "sticker"
  | "unknown";

export type MessengerIngressAttachmentV2 = Readonly<{
  type: MessengerAttachmentTypeV2;
  url?: string;
  mimeType?: string;
}>;

export type MessengerIngressEventV2 =
  | Readonly<{
      kind: "message";
      messageId?: string;
      timestamp?: number;
      locale?: string;
      text?: string;
      quickReplyPayload?: string;
      replyToMessageId?: string;
      attachments: readonly MessengerIngressAttachmentV2[];
    }>
  | Readonly<{
      kind: "postback";
      timestamp: number;
      locale?: string;
      payload?: string;
    }>;

export type MessengerConversationIngressPayloadV2 = Readonly<{
  version: 2;
  channel: "messenger";
  endpoint: Readonly<{ pageId: MessengerEndpoint["pageId"] }>;
  senderId: ConversationSenderId;
  event: MessengerIngressEventV2;
}>;

export type WhatsAppIngressEventV2 = Readonly<{
  kind: "text" | "interactive" | "image" | "audio" | "unknown";
  messageId?: string;
  timestamp?: number;
  textBody?: string;
  interactiveReplyId?: string;
  interactiveReplyTitle?: string;
  mediaId?: string;
}>;

export type WhatsAppConversationIngressPayloadV2 = Readonly<{
  version: 2;
  channel: "whatsapp";
  endpoint: Readonly<{
    wabaId: WhatsAppEndpoint["wabaId"];
    phoneNumberId: WhatsAppEndpoint["phoneNumberId"];
  }>;
  senderId: ConversationSenderId;
  event: WhatsAppIngressEventV2;
}>;

export type MetaConversationIngressPayloadV2 =
  MessengerConversationIngressPayloadV2 | WhatsAppConversationIngressPayloadV2;

export type IgnoredMetaEventCountsV2 = Readonly<{
  messengerEchoes: number;
  messengerDeliveries: number;
  messengerReads: number;
  messengerReferrals: number;
  whatsappStatuses: number;
  otherProviderNotifications: number;
}>;

export type ExtractedMetaConversationCandidateV2 = Readonly<{
  payloadKind: ConversationBoundaryPayloadKindV2;
  endpoint: ConversationEndpoint;
  senderId: ConversationSenderId;
  canonicalPayload: string;
  eventIdentity: WebhookReplayEventIdentityV2;
}>;

export type ExtractedMetaConversationBatchV2 = Readonly<{
  candidates: readonly ExtractedMetaConversationCandidateV2[];
  ignored: IgnoredMetaEventCountsV2;
}>;

export type DecodedMetaConversationPayloadV2 = Readonly<{
  payload: MetaConversationIngressPayloadV2;
  endpoint: ConversationEndpoint;
  senderId: ConversationSenderId;
  eventIdentity: WebhookReplayEventIdentityV2;
}>;

export type MetaConversationIngressV2ErrorCode =
  | "signature_verification_failed"
  | "provider_mismatch"
  | "invalid_root"
  | "batch_too_large"
  | "invalid_entry"
  | "invalid_endpoint_context"
  | "invalid_sender"
  | "invalid_event"
  | "payload_too_large"
  | "invalid_payload_encoding"
  | "noncanonical_payload"
  | "invalid_unit"
  | "unit_authentication_failed"
  | "key_unavailable"
  | "identity_rejected"
  | "identity_unavailable"
  | "claim_id_unavailable";

export class MetaConversationIngressV2Error extends Error {
  readonly code: MetaConversationIngressV2ErrorCode;
  readonly retryable: boolean;

  constructor(code: MetaConversationIngressV2ErrorCode, retryable = false) {
    super("Meta conversation ingress is unavailable");
    this.name = "MetaConversationIngressV2Error";
    this.code = code;
    this.retryable = retryable;
  }
}

type MutableIgnoredCounts = {
  -readonly [K in keyof IgnoredMetaEventCountsV2]: number;
};

function ingressError(code: MetaConversationIngressV2ErrorCode): never {
  throw new MetaConversationIngressV2Error(code);
}

function freezeJsonValue(value: unknown): unknown {
  if (!isRecord(value) && !Array.isArray(value)) {
    return value;
  }
  const pending: object[] = [value];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);
    for (const nested of Object.values(current)) {
      if (isRecord(nested) || Array.isArray(nested)) {
        pending.push(nested);
      }
    }
    Object.freeze(current);
  }
  return value;
}

export function authenticateMetaWebhookBodyV2(input: {
  signatureProvider: "messenger" | "whatsapp";
  rawBody: Uint8Array;
  signatureHeader: string;
}): VerifiedMetaWebhookBodyV2 {
  if (
    (input.signatureProvider !== "messenger" &&
      input.signatureProvider !== "whatsapp") ||
    !(input.rawBody instanceof Uint8Array) ||
    input.rawBody.byteLength === 0 ||
    input.rawBody.byteLength > MAX_VERIFIED_WEBHOOK_BODY_BYTES ||
    typeof input.signatureHeader !== "string" ||
    !/^sha256=[0-9a-f]{64}$/.test(input.signatureHeader)
  ) {
    ingressError("signature_verification_failed");
  }

  const messengerSecret = process.env.FB_APP_SECRET?.trim() ?? "";
  const appSecret =
    input.signatureProvider === "whatsapp"
      ? process.env.WHATSAPP_APP_SECRET?.trim() || messengerSecret
      : messengerSecret;
  if (!appSecret) {
    ingressError("signature_verification_failed");
  }

  const rawBody = Buffer.from(input.rawBody);
  let expectedDigest: Buffer;
  try {
    expectedDigest = createHmac("sha256", appSecret).update(rawBody).digest();
  } catch {
    ingressError("signature_verification_failed");
  }
  const suppliedDigest = Buffer.from(
    input.signatureHeader.slice("sha256=".length),
    "hex"
  );
  if (
    suppliedDigest.length !== expectedDigest.length ||
    !timingSafeEqual(suppliedDigest, expectedDigest)
  ) {
    ingressError("signature_verification_failed");
  }

  let payload: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
    payload = JSON.parse(text) as unknown;
  } catch {
    ingressError("signature_verification_failed");
  }
  if (!isRecord(payload)) {
    ingressError("signature_verification_failed");
  }
  const verified = {
    signatureProvider: input.signatureProvider,
    payload: freezeJsonValue(payload),
  } as VerifiedMetaWebhookBodyV2;
  Object.defineProperty(verified, verifiedMetaWebhookBodyBrand, {
    value: true,
  });
  Object.freeze(verified);
  authenticatedMetaWebhookBodies.add(verified);
  return verified;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function ownRecord(
  value: Record<string, unknown>,
  key: string,
  code: MetaConversationIngressV2ErrorCode = "invalid_event"
): Record<string, unknown> {
  const nested = value[key];
  if (!isRecord(nested)) {
    ingressError(code);
  }
  return nested;
}

function ownArray(
  value: Record<string, unknown>,
  key: string,
  code: MetaConversationIngressV2ErrorCode,
  required: boolean
): unknown[] {
  if (!hasOwn(value, key)) {
    if (required) {
      ingressError(code);
    }
    return [];
  }
  const nested = value[key];
  if (!Array.isArray(nested) || nested.length > MAX_PROVIDER_ARRAY_ITEMS) {
    ingressError(Array.isArray(nested) ? "batch_too_large" : code);
  }
  return nested;
}

function hasInvalidUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function validateString(
  value: unknown,
  maxBytes: number,
  code: MetaConversationIngressV2ErrorCode = "invalid_event"
): string {
  if (
    typeof value !== "string" ||
    hasInvalidUnicode(value) ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    ingressError(code);
  }
  return value;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  maxBytes: number
): string | undefined {
  if (!hasOwn(value, key)) {
    return undefined;
  }
  return validateString(value[key], maxBytes);
}

function validateProviderMessageId(value: unknown): string {
  const messageId = validateString(value, MAX_MESSAGE_ID_BYTES);
  if (!VISIBLE_ASCII_PATTERN.test(messageId)) {
    ingressError("invalid_event");
  }
  return messageId;
}

function optionalProviderMessageId(
  value: Record<string, unknown>,
  key: string
): string | undefined {
  return hasOwn(value, key) ? validateProviderMessageId(value[key]) : undefined;
}

function validateMessengerTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    ingressError("invalid_event");
  }
  return value;
}

function optionalMessengerTimestamp(
  value: Record<string, unknown>,
  key: string
): number | undefined {
  return hasOwn(value, key)
    ? validateMessengerTimestamp(value[key])
    : undefined;
}

function optionalWhatsAppTimestamp(
  message: Record<string, unknown>
): number | undefined {
  if (!hasOwn(message, "timestamp")) {
    return undefined;
  }
  const raw = validateString(message.timestamp, 16);
  if (!WHATSAPP_TIMESTAMP_PATTERN.test(raw)) {
    ingressError("invalid_event");
  }
  const seconds = Number(raw);
  const milliseconds = seconds * 1_000;
  if (!Number.isSafeInteger(milliseconds)) {
    ingressError("invalid_event");
  }
  return milliseconds;
}

function safeMessengerEndpoint(
  entryId: unknown,
  recipientId: unknown
): MessengerEndpoint {
  try {
    return resolveMessengerWebhookEndpoint({ entryId, recipientId });
  } catch (error) {
    if (error instanceof ConversationIdentityError) {
      ingressError("invalid_endpoint_context");
    }
    throw error;
  }
}

function safeWhatsAppEndpoint(
  wabaId: unknown,
  phoneNumberId: unknown
): WhatsAppEndpoint {
  try {
    return resolveWhatsAppEndpoint({ wabaId, phoneNumberId });
  } catch (error) {
    if (error instanceof ConversationIdentityError) {
      ingressError("invalid_endpoint_context");
    }
    throw error;
  }
}

function safeSenderId(value: unknown): ConversationSenderId {
  try {
    return resolveConversationSenderId(value);
  } catch (error) {
    if (error instanceof ConversationIdentityError) {
      ingressError("invalid_sender");
    }
    throw error;
  }
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (
    required.some(key => !hasOwn(value, key)) ||
    keys.some(key => !allowed.has(key))
  ) {
    ingressError("noncanonical_payload");
  }
}

function normalizeAttachmentType(value: unknown): MessengerAttachmentTypeV2 {
  if (value === undefined) {
    return "unknown";
  }
  const normalized = validateString(value, MAX_TYPE_BYTES).trim().toLowerCase();
  return MESSENGER_ATTACHMENT_TYPES.has(normalized as MessengerAttachmentTypeV2)
    ? (normalized as MessengerAttachmentTypeV2)
    : "unknown";
}

function projectMessengerAttachments(
  message: Record<string, unknown>
): readonly MessengerIngressAttachmentV2[] {
  if (!hasOwn(message, "attachments")) {
    return Object.freeze([]);
  }
  const attachments = message.attachments;
  if (
    !Array.isArray(attachments) ||
    attachments.length > MAX_ATTACHMENTS_PER_MESSAGE
  ) {
    ingressError(
      Array.isArray(attachments) ? "batch_too_large" : "invalid_event"
    );
  }
  return Object.freeze(
    attachments.map(value => {
      if (!isRecord(value)) {
        ingressError("invalid_event");
      }
      const payload = hasOwn(value, "payload")
        ? ownRecord(value, "payload")
        : undefined;
      const url = payload
        ? optionalString(payload, "url", MAX_URL_BYTES)
        : undefined;
      const mimeType = payload
        ? optionalString(payload, "mime_type", MAX_MIME_TYPE_BYTES)
        : undefined;
      return Object.freeze({
        type: normalizeAttachmentType(value.type),
        ...(url === undefined ? {} : { url }),
        ...(mimeType === undefined ? {} : { mimeType }),
      });
    })
  );
}

function projectMessengerMessage(
  event: Record<string, unknown>,
  message: Record<string, unknown>
): MessengerIngressEventV2 {
  const messageId = optionalProviderMessageId(message, "mid");
  const timestamp = optionalMessengerTimestamp(event, "timestamp");
  if (!messageId && timestamp === undefined) {
    ingressError("invalid_event");
  }
  const sender = ownRecord(event, "sender");
  const locale = optionalString(sender, "locale", MAX_LOCALE_BYTES);
  const text = optionalString(message, "text", MAX_TEXT_BYTES);
  const quickReply = hasOwn(message, "quick_reply")
    ? ownRecord(message, "quick_reply")
    : undefined;
  const replyTo = hasOwn(message, "reply_to")
    ? ownRecord(message, "reply_to")
    : undefined;
  const quickReplyPayload = quickReply
    ? optionalString(quickReply, "payload", MAX_ACTION_PAYLOAD_BYTES)
    : undefined;
  const replyToMessageId = replyTo
    ? optionalProviderMessageId(replyTo, "mid")
    : undefined;
  return Object.freeze({
    kind: "message",
    ...(messageId === undefined ? {} : { messageId }),
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(locale === undefined ? {} : { locale }),
    ...(text === undefined ? {} : { text }),
    ...(quickReplyPayload === undefined ? {} : { quickReplyPayload }),
    ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
    attachments: projectMessengerAttachments(message),
  });
}

function projectMessengerPostback(
  event: Record<string, unknown>,
  postback: Record<string, unknown>
): MessengerIngressEventV2 {
  const sender = ownRecord(event, "sender");
  const timestamp = hasOwn(event, "timestamp")
    ? validateMessengerTimestamp(event.timestamp)
    : ingressError("invalid_event");
  const locale = optionalString(sender, "locale", MAX_LOCALE_BYTES);
  const payload = optionalString(postback, "payload", MAX_ACTION_PAYLOAD_BYTES);
  return Object.freeze({
    kind: "postback",
    timestamp,
    ...(locale === undefined ? {} : { locale }),
    ...(payload === undefined ? {} : { payload }),
  });
}

function messengerPayload(
  endpoint: MessengerEndpoint,
  senderId: ConversationSenderId,
  event: MessengerIngressEventV2
): MessengerConversationIngressPayloadV2 {
  return Object.freeze({
    version: 2 as const,
    channel: "messenger" as const,
    endpoint: Object.freeze({ pageId: endpoint.pageId }),
    senderId,
    event,
  });
}

function whatsAppPayload(
  endpoint: WhatsAppEndpoint,
  senderId: ConversationSenderId,
  event: WhatsAppIngressEventV2
): WhatsAppConversationIngressPayloadV2 {
  return Object.freeze({
    version: 2 as const,
    channel: "whatsapp" as const,
    endpoint: Object.freeze({
      wabaId: endpoint.wabaId,
      phoneNumberId: endpoint.phoneNumberId,
    }),
    senderId,
    event,
  });
}

function encodeMessengerEvent(event: MessengerIngressEventV2): object {
  if (event.kind === "postback") {
    return {
      kind: event.kind,
      timestamp: event.timestamp,
      ...(event.locale === undefined ? {} : { locale: event.locale }),
      ...(event.payload === undefined ? {} : { payload: event.payload }),
    };
  }
  return {
    kind: event.kind,
    ...(event.messageId === undefined ? {} : { messageId: event.messageId }),
    ...(event.timestamp === undefined ? {} : { timestamp: event.timestamp }),
    ...(event.locale === undefined ? {} : { locale: event.locale }),
    ...(event.text === undefined ? {} : { text: event.text }),
    ...(event.quickReplyPayload === undefined
      ? {}
      : { quickReplyPayload: event.quickReplyPayload }),
    ...(event.replyToMessageId === undefined
      ? {}
      : { replyToMessageId: event.replyToMessageId }),
    attachments: event.attachments.map(attachment => ({
      type: attachment.type,
      ...(attachment.url === undefined ? {} : { url: attachment.url }),
      ...(attachment.mimeType === undefined
        ? {}
        : { mimeType: attachment.mimeType }),
    })),
  };
}

function encodeWhatsAppEvent(event: WhatsAppIngressEventV2): object {
  return {
    kind: event.kind,
    ...(event.messageId === undefined ? {} : { messageId: event.messageId }),
    ...(event.timestamp === undefined ? {} : { timestamp: event.timestamp }),
    ...(event.textBody === undefined ? {} : { textBody: event.textBody }),
    ...(event.interactiveReplyId === undefined
      ? {}
      : { interactiveReplyId: event.interactiveReplyId }),
    ...(event.interactiveReplyTitle === undefined
      ? {}
      : { interactiveReplyTitle: event.interactiveReplyTitle }),
    ...(event.mediaId === undefined ? {} : { mediaId: event.mediaId }),
  };
}

export function encodeMetaConversationPayloadV2(
  payload: MetaConversationIngressPayloadV2
): string {
  const encoded =
    payload.channel === "messenger"
      ? JSON.stringify({
          version: payload.version,
          channel: payload.channel,
          endpoint: { pageId: payload.endpoint.pageId },
          senderId: payload.senderId,
          event: encodeMessengerEvent(payload.event),
        })
      : JSON.stringify({
          version: payload.version,
          channel: payload.channel,
          endpoint: {
            wabaId: payload.endpoint.wabaId,
            phoneNumberId: payload.endpoint.phoneNumberId,
          },
          senderId: payload.senderId,
          event: encodeWhatsAppEvent(payload.event),
        });
  if (Buffer.byteLength(encoded, "utf8") > MAX_CANONICAL_PAYLOAD_BYTES) {
    ingressError("payload_too_large");
  }
  return encoded;
}

function eventIdentity(
  messageId: string | undefined,
  canonicalPayload: string
): WebhookReplayEventIdentityV2 {
  if (messageId) {
    return Object.freeze({ kind: "meta_message_id", id: messageId });
  }
  return Object.freeze({
    kind: "canonical_fallback_sha256",
    digest: createHash("sha256").update(canonicalPayload, "utf8").digest("hex"),
  });
}

function payloadMessageId(
  payload: MetaConversationIngressPayloadV2
): string | undefined {
  if (payload.channel === "whatsapp") {
    return payload.event.messageId;
  }
  return payload.event.kind === "message" ? payload.event.messageId : undefined;
}

function candidateFromPayload(
  payload: MetaConversationIngressPayloadV2,
  endpoint: ConversationEndpoint,
  senderId: ConversationSenderId
): ExtractedMetaConversationCandidateV2 {
  const canonicalPayload = encodeMetaConversationPayloadV2(payload);
  return Object.freeze({
    payloadKind:
      payload.channel === "messenger"
        ? "meta_messenger_event"
        : "meta_whatsapp_message",
    endpoint,
    senderId,
    canonicalPayload,
    eventIdentity: eventIdentity(payloadMessageId(payload), canonicalPayload),
  });
}

function projectWhatsAppEvent(
  message: Record<string, unknown>
): WhatsAppIngressEventV2 {
  const rawType = validateString(message.type, MAX_TYPE_BYTES);
  if (!rawType) {
    ingressError("invalid_event");
  }
  const messageId = optionalProviderMessageId(message, "id");
  const timestamp = optionalWhatsAppTimestamp(message);
  if (!messageId && timestamp === undefined) {
    ingressError("invalid_event");
  }

  let kind: WhatsAppIngressEventV2["kind"] = "unknown";
  let textBody: string | undefined;
  let interactiveReplyId: string | undefined;
  let interactiveReplyTitle: string | undefined;
  let mediaId: string | undefined;

  if (rawType === "text") {
    kind = "text";
    const text = ownRecord(message, "text");
    textBody = optionalString(text, "body", MAX_TEXT_BYTES);
  } else if (rawType === "interactive") {
    kind = "interactive";
    const interactive = ownRecord(message, "interactive");
    const hasButton = hasOwn(interactive, "button_reply");
    const hasList = hasOwn(interactive, "list_reply");
    if (hasButton === hasList) {
      ingressError("invalid_event");
    }
    const reply = ownRecord(
      interactive,
      hasButton ? "button_reply" : "list_reply"
    );
    interactiveReplyId = optionalString(reply, "id", MAX_ACTION_PAYLOAD_BYTES);
    interactiveReplyTitle = optionalString(reply, "title", MAX_TEXT_BYTES);
  } else if (rawType === "image") {
    kind = "image";
    mediaId = validateString(
      ownRecord(message, "image").id,
      MAX_MESSAGE_ID_BYTES
    );
    if (!mediaId) {
      ingressError("invalid_event");
    }
  } else if (rawType === "audio" || rawType === "voice" || rawType === "ptt") {
    kind = "audio";
    mediaId = validateString(
      ownRecord(message, rawType).id,
      MAX_MESSAGE_ID_BYTES
    );
    if (!mediaId) {
      ingressError("invalid_event");
    }
  }

  if (kind === "unknown" && messageId === undefined) {
    ingressError("invalid_event");
  }

  return Object.freeze({
    kind,
    ...(messageId === undefined ? {} : { messageId }),
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(textBody === undefined ? {} : { textBody }),
    ...(interactiveReplyId === undefined ? {} : { interactiveReplyId }),
    ...(interactiveReplyTitle === undefined ? {} : { interactiveReplyTitle }),
    ...(mediaId === undefined ? {} : { mediaId }),
  });
}

function emptyIgnoredCounts(): MutableIgnoredCounts {
  return {
    messengerEchoes: 0,
    messengerDeliveries: 0,
    messengerReads: 0,
    messengerReferrals: 0,
    whatsappStatuses: 0,
    otherProviderNotifications: 0,
  };
}

function freezeIgnoredCounts(
  counts: MutableIgnoredCounts
): IgnoredMetaEventCountsV2 {
  return Object.freeze({ ...counts });
}

function extractMessengerBatch(
  root: Record<string, unknown>
): ExtractedMetaConversationBatchV2 {
  const candidates: ExtractedMetaConversationCandidateV2[] = [];
  const ignored = emptyIgnoredCounts();
  const entries = ownArray(root, "entry", "invalid_root", true);
  if (entries.length === 0) {
    ingressError("invalid_root");
  }

  for (const entryValue of entries) {
    if (!isRecord(entryValue)) {
      ingressError("invalid_entry");
    }
    const events = ownArray(entryValue, "messaging", "invalid_entry", false);
    if (events.length === 0) {
      ignored.otherProviderNotifications += 1;
      continue;
    }
    for (const eventValue of events) {
      if (!isRecord(eventValue)) {
        ingressError("invalid_event");
      }
      const hasMessage = hasOwn(eventValue, "message");
      const hasPostback = hasOwn(eventValue, "postback");
      const hasDelivery = hasOwn(eventValue, "delivery");
      const hasRead = hasOwn(eventValue, "read");
      const primaryCount = [
        hasMessage,
        hasPostback,
        hasDelivery,
        hasRead,
      ].filter(Boolean).length;
      if (primaryCount > 1) {
        ingressError("invalid_event");
      }
      if (hasMessage) {
        const message = ownRecord(eventValue, "message");
        if (
          hasOwn(message, "is_echo") &&
          typeof message.is_echo !== "boolean"
        ) {
          ingressError("invalid_event");
        }
        if (message.is_echo === true) {
          ignored.messengerEchoes += 1;
          continue;
        }
        const recipient = ownRecord(eventValue, "recipient");
        const sender = ownRecord(eventValue, "sender");
        const endpoint = safeMessengerEndpoint(entryValue.id, recipient.id);
        const senderId = safeSenderId(sender.id);
        const payload = messengerPayload(
          endpoint,
          senderId,
          projectMessengerMessage(eventValue, message)
        );
        candidates.push(candidateFromPayload(payload, endpoint, senderId));
      } else if (hasPostback) {
        const postback = ownRecord(eventValue, "postback");
        const recipient = ownRecord(eventValue, "recipient");
        const sender = ownRecord(eventValue, "sender");
        const endpoint = safeMessengerEndpoint(entryValue.id, recipient.id);
        const senderId = safeSenderId(sender.id);
        const payload = messengerPayload(
          endpoint,
          senderId,
          projectMessengerPostback(eventValue, postback)
        );
        candidates.push(candidateFromPayload(payload, endpoint, senderId));
      } else if (hasDelivery) {
        ignored.messengerDeliveries += 1;
      } else if (hasRead) {
        ignored.messengerReads += 1;
      } else if (hasOwn(eventValue, "referral")) {
        ignored.messengerReferrals += 1;
      } else {
        ignored.otherProviderNotifications += 1;
      }
      if (candidates.length > MAX_CONVERSATION_UNITS_PER_DELIVERY) {
        ingressError("batch_too_large");
      }
    }
  }
  return Object.freeze({
    candidates: Object.freeze(candidates),
    ignored: freezeIgnoredCounts(ignored),
  });
}

function extractWhatsAppBatch(
  root: Record<string, unknown>
): ExtractedMetaConversationBatchV2 {
  const candidates: ExtractedMetaConversationCandidateV2[] = [];
  const ignored = emptyIgnoredCounts();
  const entries = ownArray(root, "entry", "invalid_root", true);
  if (entries.length === 0) {
    ingressError("invalid_root");
  }

  for (const entryValue of entries) {
    if (!isRecord(entryValue)) {
      ingressError("invalid_entry");
    }
    const changes = ownArray(entryValue, "changes", "invalid_entry", true);
    for (const changeValue of changes) {
      if (!isRecord(changeValue)) {
        ingressError("invalid_entry");
      }
      const value = ownRecord(changeValue, "value", "invalid_entry");
      const messages = ownArray(value, "messages", "invalid_entry", false);
      const statuses = ownArray(value, "statuses", "invalid_entry", false);
      ignored.whatsappStatuses += statuses.length;
      if (messages.length === 0) {
        if (statuses.length === 0) {
          ignored.otherProviderNotifications += 1;
        }
        continue;
      }
      if (changeValue.field !== "messages") {
        ingressError("invalid_entry");
      }
      const metadata = ownRecord(value, "metadata", "invalid_entry");
      const endpoint = safeWhatsAppEndpoint(
        entryValue.id,
        metadata.phone_number_id
      );
      for (const messageValue of messages) {
        if (!isRecord(messageValue)) {
          ingressError("invalid_event");
        }
        const senderId = safeSenderId(messageValue.from);
        const payload = whatsAppPayload(
          endpoint,
          senderId,
          projectWhatsAppEvent(messageValue)
        );
        candidates.push(candidateFromPayload(payload, endpoint, senderId));
        if (candidates.length > MAX_CONVERSATION_UNITS_PER_DELIVERY) {
          ingressError("batch_too_large");
        }
      }
    }
  }
  return Object.freeze({
    candidates: Object.freeze(candidates),
    ignored: freezeIgnoredCounts(ignored),
  });
}

export function extractMetaConversationBatchV2(
  verifiedBody: VerifiedMetaWebhookBodyV2
): ExtractedMetaConversationBatchV2 {
  if (
    !isRecord(verifiedBody) ||
    !authenticatedMetaWebhookBodies.has(verifiedBody) ||
    verifiedBody[verifiedMetaWebhookBodyBrand] !== true ||
    !isRecord(verifiedBody.payload)
  ) {
    ingressError("signature_verification_failed");
  }
  const root = verifiedBody.payload;
  if (verifiedBody.signatureProvider === "messenger") {
    if (root.object !== "page") {
      ingressError("provider_mismatch");
    }
    return extractMessengerBatch(root);
  }
  if (verifiedBody.signatureProvider === "whatsapp") {
    if (root.object !== "whatsapp_business_account") {
      ingressError("provider_mismatch");
    }
    return extractWhatsAppBatch(root);
  }
  ingressError("provider_mismatch");
}

function parseDecodedMessengerEvent(
  value: Record<string, unknown>
): MessengerIngressEventV2 {
  if (value.kind === "message") {
    exactKeys(
      value,
      ["kind", "attachments"],
      [
        "messageId",
        "timestamp",
        "locale",
        "text",
        "quickReplyPayload",
        "replyToMessageId",
      ]
    );
    const attachments = value.attachments;
    if (
      !Array.isArray(attachments) ||
      attachments.length > MAX_ATTACHMENTS_PER_MESSAGE
    ) {
      ingressError("noncanonical_payload");
    }
    const parsedAttachments = Object.freeze(
      attachments.map(attachmentValue => {
        if (!isRecord(attachmentValue)) {
          ingressError("noncanonical_payload");
        }
        exactKeys(attachmentValue, ["type"], ["url", "mimeType"]);
        if (
          !MESSENGER_ATTACHMENT_TYPES.has(
            attachmentValue.type as MessengerAttachmentTypeV2
          )
        ) {
          ingressError("noncanonical_payload");
        }
        const url = optionalString(attachmentValue, "url", MAX_URL_BYTES);
        const mimeType = optionalString(
          attachmentValue,
          "mimeType",
          MAX_MIME_TYPE_BYTES
        );
        return Object.freeze({
          type: attachmentValue.type as MessengerAttachmentTypeV2,
          ...(url === undefined ? {} : { url }),
          ...(mimeType === undefined ? {} : { mimeType }),
        });
      })
    );
    const messageId = optionalProviderMessageId(value, "messageId");
    const timestamp = optionalMessengerTimestamp(value, "timestamp");
    if (!messageId && timestamp === undefined) {
      ingressError("noncanonical_payload");
    }
    const locale = optionalString(value, "locale", MAX_LOCALE_BYTES);
    const text = optionalString(value, "text", MAX_TEXT_BYTES);
    const quickReplyPayload = optionalString(
      value,
      "quickReplyPayload",
      MAX_ACTION_PAYLOAD_BYTES
    );
    const replyToMessageId = optionalProviderMessageId(
      value,
      "replyToMessageId"
    );
    return Object.freeze({
      kind: "message",
      ...(messageId === undefined ? {} : { messageId }),
      ...(timestamp === undefined ? {} : { timestamp }),
      ...(locale === undefined ? {} : { locale }),
      ...(text === undefined ? {} : { text }),
      ...(quickReplyPayload === undefined ? {} : { quickReplyPayload }),
      ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
      attachments: parsedAttachments,
    });
  }
  if (value.kind === "postback") {
    exactKeys(value, ["kind", "timestamp"], ["locale", "payload"]);
    const timestamp = validateMessengerTimestamp(value.timestamp);
    const locale = optionalString(value, "locale", MAX_LOCALE_BYTES);
    const payload = optionalString(value, "payload", MAX_ACTION_PAYLOAD_BYTES);
    return Object.freeze({
      kind: "postback",
      timestamp,
      ...(locale === undefined ? {} : { locale }),
      ...(payload === undefined ? {} : { payload }),
    });
  }
  ingressError("noncanonical_payload");
}

function parseDecodedWhatsAppEvent(
  value: Record<string, unknown>
): WhatsAppIngressEventV2 {
  if (
    value.kind !== "text" &&
    value.kind !== "interactive" &&
    value.kind !== "image" &&
    value.kind !== "audio" &&
    value.kind !== "unknown"
  ) {
    ingressError("noncanonical_payload");
  }
  const optionalKeys =
    value.kind === "text"
      ? ["messageId", "timestamp", "textBody"]
      : value.kind === "interactive"
        ? [
            "messageId",
            "timestamp",
            "interactiveReplyId",
            "interactiveReplyTitle",
          ]
        : value.kind === "image" || value.kind === "audio"
          ? ["messageId", "timestamp", "mediaId"]
          : ["messageId", "timestamp"];
  exactKeys(value, ["kind"], optionalKeys);
  const messageId = optionalProviderMessageId(value, "messageId");
  const timestamp = optionalMessengerTimestamp(value, "timestamp");
  if (!messageId && timestamp === undefined) {
    ingressError("noncanonical_payload");
  }
  const textBody =
    value.kind === "text"
      ? optionalString(value, "textBody", MAX_TEXT_BYTES)
      : undefined;
  const interactiveReplyId =
    value.kind === "interactive"
      ? optionalString(value, "interactiveReplyId", MAX_ACTION_PAYLOAD_BYTES)
      : undefined;
  const interactiveReplyTitle =
    value.kind === "interactive"
      ? optionalString(value, "interactiveReplyTitle", MAX_TEXT_BYTES)
      : undefined;
  const mediaId =
    value.kind === "image" || value.kind === "audio"
      ? optionalString(value, "mediaId", MAX_MESSAGE_ID_BYTES)
      : undefined;
  if (
    ((value.kind === "image" || value.kind === "audio") && !mediaId) ||
    (value.kind === "unknown" && messageId === undefined)
  ) {
    ingressError("noncanonical_payload");
  }
  return Object.freeze({
    kind: value.kind,
    ...(messageId === undefined ? {} : { messageId }),
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(textBody === undefined ? {} : { textBody }),
    ...(interactiveReplyId === undefined ? {} : { interactiveReplyId }),
    ...(interactiveReplyTitle === undefined ? {} : { interactiveReplyTitle }),
    ...(mediaId === undefined ? {} : { mediaId }),
  });
}

function parseDecodedPayload(value: unknown): Readonly<{
  payload: MetaConversationIngressPayloadV2;
  endpoint: ConversationEndpoint;
}> {
  if (!isRecord(value)) {
    ingressError("noncanonical_payload");
  }
  exactKeys(value, ["version", "channel", "endpoint", "senderId", "event"]);
  if (
    value.version !== 2 ||
    !isRecord(value.endpoint) ||
    !isRecord(value.event)
  ) {
    ingressError("noncanonical_payload");
  }
  if (value.channel === "messenger") {
    exactKeys(value.endpoint, ["pageId"]);
    const endpoint = safeMessengerEndpoint(
      value.endpoint.pageId,
      value.endpoint.pageId
    );
    const senderId = safeSenderId(value.senderId);
    return Object.freeze({
      payload: messengerPayload(
        endpoint,
        senderId,
        parseDecodedMessengerEvent(value.event)
      ),
      endpoint,
    });
  }
  if (value.channel === "whatsapp") {
    exactKeys(value.endpoint, ["wabaId", "phoneNumberId"]);
    const endpoint = safeWhatsAppEndpoint(
      value.endpoint.wabaId,
      value.endpoint.phoneNumberId
    );
    const senderId = safeSenderId(value.senderId);
    return Object.freeze({
      payload: whatsAppPayload(
        endpoint,
        senderId,
        parseDecodedWhatsAppEvent(value.event)
      ),
      endpoint,
    });
  }
  ingressError("noncanonical_payload");
}

export function decodeMetaConversationPayloadV2(
  payloadKind: ConversationBoundaryPayloadKindV2,
  payloadBytes: Uint8Array
): DecodedMetaConversationPayloadV2 {
  if (
    !(payloadBytes instanceof Uint8Array) ||
    payloadBytes.byteLength === 0 ||
    payloadBytes.byteLength > MAX_CANONICAL_PAYLOAD_BYTES
  ) {
    ingressError("payload_too_large");
  }
  if (
    payloadKind !== "meta_messenger_event" &&
    payloadKind !== "meta_whatsapp_message"
  ) {
    ingressError("noncanonical_payload");
  }
  if (
    payloadBytes[0] === 0xef &&
    payloadBytes[1] === 0xbb &&
    payloadBytes[2] === 0xbf
  ) {
    ingressError("noncanonical_payload");
  }
  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
    parsed = JSON.parse(text) as unknown;
  } catch {
    ingressError("invalid_payload_encoding");
  }
  const { payload, endpoint } = parseDecodedPayload(parsed);
  if (
    (payloadKind === "meta_messenger_event" &&
      payload.channel !== "messenger") ||
    (payloadKind === "meta_whatsapp_message" &&
      payload.channel !== "whatsapp") ||
    encodeMetaConversationPayloadV2(payload) !== text
  ) {
    ingressError("noncanonical_payload");
  }
  return Object.freeze({
    payload,
    endpoint,
    senderId: payload.senderId,
    eventIdentity: eventIdentity(payloadMessageId(payload), text),
  });
}
