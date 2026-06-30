import { toUserKey } from "../privacy";
import type { NormalizedInboundMessage } from "../normalizedInboundMessage";
import { safeLog } from "../logger";

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
  const statusSummary = summarizeWhatsAppStatuses(payload);
  const summary =
    typeof payload === "object" && payload !== null
      ? {
          object: (payload as { object?: unknown }).object ?? null,
          entryCount: entries,
          ...statusSummary,
        }
      : { object: null, entryCount: 0 };

  if (process.env.WEBHOOK_DEBUG_LOGS === "1") {
    safeLog("whatsapp_inbound_payload", summary);
    return;
  }

  safeLog("whatsapp_inbound_payload_summary", summary);
}

function summarizeWhatsAppStatuses(payload: unknown): {
  statusCount?: number;
  statuses?: Record<string, number>;
  errors?: Array<{ code: number | string | null; title: string | null }>;
} {
  const statuses = arrayPropertyFromPayload(payload, "statuses");
  if (statuses.length === 0) {
    return {};
  }

  const counts: Record<string, number> = {};
  const errors: Array<{ code: number | string | null; title: string | null }> = [];
  for (const status of statuses) {
    const statusName = stringProperty(status, "status") ?? "unknown";
    counts[statusName] = (counts[statusName] ?? 0) + 1;
    for (const error of arrayProperty(status, "errors")) {
      const errorObject = objectValue(error);
      const code = errorObject?.code;
      errors.push({
        code:
          typeof code === "number" || typeof code === "string"
            ? code
            : null,
        title: stringProperty(error, "title"),
      });
    }
  }

  return {
    statusCount: statuses.length,
    statuses: counts,
    ...(errors.length > 0 ? { errors: errors.slice(0, 5) } : {}),
  };
}

function arrayPropertyFromPayload(payload: unknown, key: string): unknown[] {
  return arrayProperty(payload, "entry")
    .flatMap(entry => arrayProperty(entry, "changes"))
    .flatMap(change => arrayProperty(objectValue(change)?.value, key));
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

function normalizeMessageType(
  rawType: string
): "text" | "image" | "audio" | "unknown" {
  if (rawType === "text" || rawType === "interactive") {
    return "text";
  }

  if (rawType === "image") {
    return "image";
  }

  return rawType === "audio" || rawType === "voice" || rawType === "ptt"
    ? "audio"
    : "unknown";
}

function readAudioId(message: unknown): string | null {
  return (
    stringProperty(getNestedObject(message, "audio"), "id") ??
    stringProperty(getNestedObject(message, "voice"), "id")
    ?? stringProperty(getNestedObject(message, "ptt"), "id")
  );
}

function buildWhatsAppEvent(message: unknown): NormalizedInboundMessage | null {
  const from = stringProperty(message, "from") ?? "";
  if (!from) {
    return null;
  }

  const rawMessageType = stringProperty(message, "type") ?? "unknown";
  const messageId = stringProperty(message, "id");
  const textBody = stringProperty(getNestedObject(message, "text"), "body");
  const interactiveReply = readInteractiveReply(message);
  const imageId = stringProperty(getNestedObject(message, "image"), "id");
  const audioId = readAudioId(message);

  return {
    channel: "whatsapp",
    senderId: from,
    userId: toUserKey(from),
    channelCapabilities: {
      quickReplies: false,
      richTemplates: false,
    },
    rawMessageType,
    messageId: messageId ?? undefined,
    messageType: normalizeMessageType(rawMessageType),
    textBody:
      interactiveReply.id ?? interactiveReply.title ?? textBody ?? undefined,
    imageId: imageId ?? undefined,
    audioId: audioId ?? undefined,
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
