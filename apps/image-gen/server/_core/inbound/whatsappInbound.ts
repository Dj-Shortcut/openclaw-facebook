import { toUserKey } from "../privacy";
import type { NormalizedInboundMessage } from "../normalizedInboundMessage";

export function isWhatsAppWebhookPayload(
  payload: unknown
): payload is { object: "whatsapp_business_account" } {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { object?: unknown }).object === "whatsapp_business_account"
  );
}

export function logWhatsAppWebhookPayload(payload: unknown): void {
  const entries = Array.isArray((payload as { entry?: unknown[] } | null)?.entry)
    ? (payload as { entry: unknown[] }).entry.length
    : 0;
  const summary =
    typeof payload === "object" && payload !== null
      ? {
          object: (payload as { object?: unknown }).object ?? null,
          entryCount: entries,
        }
      : { object: null, entryCount: 0 };

  if (process.env.WEBHOOK_DEBUG_LOGS === "1") {
    console.log("[whatsapp webhook] inbound payload", summary);
    return;
  }

  console.log("[whatsapp webhook] inbound payload summary", summary);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function arrayProperty(value: unknown, key: string): unknown[] {
  const object = objectValue(value);
  return Array.isArray(object?.[key]) ? (object[key] as unknown[]) : [];
}

function stringProperty(value: unknown, key: string): string | null {
  const object = objectValue(value);
  const property = object?.[key];
  return typeof property === "string" ? property : null;
}

function getNestedObject(
  value: unknown,
  key: string
): Record<string, unknown> | null {
  return objectValue(objectValue(value)?.[key]);
}

function firstString(...values: Array<string | null>): string | null {
  return values.find((value): value is string => value !== null) ?? null;
}

function readInteractiveReply(message: unknown): {
  id: string | null;
  title: string | null;
} {
  const interactive = getNestedObject(message, "interactive");
  const buttonReply = objectValue(interactive?.button_reply);
  const listReply = objectValue(interactive?.list_reply);

  return {
    id: firstString(
      stringProperty(buttonReply, "id"),
      stringProperty(listReply, "id")
    ),
    title: firstString(
      stringProperty(buttonReply, "title"),
      stringProperty(listReply, "title")
    ),
  };
}

function readMessageTimestamp(message: unknown): number | undefined {
  const rawTimestamp = stringProperty(message, "timestamp");
  const timestamp = rawTimestamp ? Number(rawTimestamp) : null;
  return Number.isFinite(timestamp) ? timestamp! * 1000 : undefined;
}

function normalizeMessageType(rawType: string): "text" | "image" | "unknown" {
  if (rawType === "text" || rawType === "interactive") {
    return "text";
  }

  return rawType === "image" ? "image" : "unknown";
}

function buildWhatsAppEvent(message: unknown): NormalizedInboundMessage | null {
  const from = stringProperty(message, "from") ?? "";
  if (!from) {
    return null;
  }

  const rawMessageType = stringProperty(message, "type") ?? "unknown";
  const textBody = stringProperty(getNestedObject(message, "text"), "body");
  const interactiveReply = readInteractiveReply(message);
  const imageId = stringProperty(getNestedObject(message, "image"), "id");

  return {
    channel: "whatsapp",
    senderId: from,
    userId: toUserKey(from),
    channelCapabilities: {
      quickReplies: false,
      richTemplates: false,
    },
    rawMessageType,
    messageType: normalizeMessageType(rawMessageType),
    textBody:
      interactiveReply.id ?? interactiveReply.title ?? textBody ?? undefined,
    imageId: imageId ?? undefined,
    timestamp: readMessageTimestamp(message),
    ...(interactiveReply.id || interactiveReply.title
      ? {
          rawEventMeta: {
            interactiveReplyId: interactiveReply.id ?? undefined,
            interactiveReplyTitle: interactiveReply.title ?? undefined,
          },
        }
      : {}),
  };
}

function extractMessagesFromChange(change: unknown): NormalizedInboundMessage[] {
  return arrayProperty(objectValue(change)?.value, "messages")
    .map(buildWhatsAppEvent)
    .filter((event): event is NormalizedInboundMessage => event !== null);
}

function extractMessagesFromEntry(entry: unknown): NormalizedInboundMessage[] {
  return arrayProperty(entry, "changes").flatMap(extractMessagesFromChange);
}

export function extractWhatsAppEvents(
  payload: unknown
): NormalizedInboundMessage[] {
  if (!objectValue(payload)) {
    return [];
  }

  return arrayProperty(payload, "entry").flatMap(extractMessagesFromEntry);
}
