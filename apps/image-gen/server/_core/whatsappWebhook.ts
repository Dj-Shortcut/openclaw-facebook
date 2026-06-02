import { createHash, randomUUID } from "node:crypto";
import { normalizeLang, t } from "./i18n";
import { getOrCreateState, setLastUserMessageAt } from "./messengerState";
import { toLogUser } from "./privacy";
import { handleWhatsAppConsentGate } from "./consentService";
import { extractWhatsAppEvents, logWhatsAppWebhookPayload } from "./inbound/whatsappInbound";
import { handleWhatsAppImageEvent } from "./whatsappHandlers/imageHandler";
import { handleWhatsAppInteractiveEvent } from "./whatsappHandlers/interactiveHandler";
import { handleWhatsAppTextEvent } from "./whatsappHandlers/textHandler";
import { sendWhatsAppButtonsReply, sendWhatsAppTextReply } from "./whatsappResponseService";
import { claimWebhookReplayKey } from "./webhookReplayProtection";
import type { NormalizedWhatsAppEvent } from "./whatsappTypes";
import { safeLog } from "./logger";

const DEFAULT_LANG = normalizeLang(process.env.DEFAULT_MESSENGER_LANG);

function normalizeWhatsAppEvents(payload: unknown): NormalizedWhatsAppEvent[] {
  return extractWhatsAppEvents(payload).filter(
    (event): event is NormalizedWhatsAppEvent => event.channel === "whatsapp"
  );
}

function createNonReversibleReqId(event: NormalizedWhatsAppEvent): string {
  const senderHash = createHash("sha256")
    .update(event.senderId)
    .digest("hex")
    .slice(0, 12);
  return `${senderHash}-${Date.now()}-${randomUUID()}`;
}

function createWhatsAppEventContext(event: NormalizedWhatsAppEvent) {
  return {
    reqId: createNonReversibleReqId(event),
    lang: DEFAULT_LANG,
  };
}

async function sendUnsupportedMessageReply(
  event: NormalizedWhatsAppEvent,
  lang: typeof DEFAULT_LANG
): Promise<void> {
  safeLog("whatsapp_unsupported_inbound_message_type", {
    level: "warn",
    user: toLogUser(event.userId),
    rawMessageType: event.rawMessageType,
  });
  await sendWhatsAppTextReply(event.senderId, t(lang, "unsupportedMedia"));
}

async function dispatchWhatsAppEvent(
  event: NormalizedWhatsAppEvent,
  context: ReturnType<typeof createWhatsAppEventContext>
): Promise<void> {
  if (event.messageType === "image") {
    await handleWhatsAppImageEvent(event, context);
    return;
  }

  if (event.rawMessageType === "interactive") {
    await handleWhatsAppInteractiveEvent(event, context);
    return;
  }

  if (event.messageType === "text") {
    await handleWhatsAppTextEvent(event, context);
    return;
  }

  if (event.messageType === "unknown") {
    await sendUnsupportedMessageReply(event, context.lang);
    return;
  }

  safeLog("whatsapp_no_handler_for_inbound_event", {
    level: "warn",
    user: toLogUser(event.userId),
    messageType: event.messageType,
    rawMessageType: event.rawMessageType,
  });
}

async function processSingleWhatsAppEvent(
  event: NormalizedWhatsAppEvent
): Promise<void> {
  if (!(await claimWhatsAppEventReplayOrLog(event))) {
    return;
  }

  const context = createWhatsAppEventContext(event);
  const state = await Promise.resolve(getOrCreateState(event.senderId));

  safeLog("whatsapp_normalized_inbound_event", {
    channel: event.channel,
    user: toLogUser(event.userId),
    messageType: event.messageType,
    rawMessageType: event.rawMessageType,
  });

  await Promise.resolve(
    setLastUserMessageAt(event.senderId, event.timestamp ?? Date.now())
  );

  if (
    await handleWhatsAppConsentGate({
      event,
      lang: context.lang,
      state,
      sendText: text => sendWhatsAppTextReply(event.senderId, text),
      sendButtons: (text, options) =>
        sendWhatsAppButtonsReply(event.senderId, text, options),
    })
  ) {
    return;
  }

  await dispatchWhatsAppEvent(event, context);
}

function getWhatsAppEventReplayKey(event: NormalizedWhatsAppEvent): string {
  const stableEventId =
    event.messageId?.trim() ||
    createHash("sha256")
      .update(
        [
          event.senderId,
          event.timestamp ?? "no-ts",
          event.rawMessageType ?? "unknown",
          event.imageId ?? event.textBody ?? "no-body",
        ].join(":")
      )
      .digest("hex")
      .slice(0, 32);

  return `whatsapp:${event.userId}:${stableEventId}`;
}

async function claimWhatsAppEventReplayOrLog(
  event: NormalizedWhatsAppEvent
): Promise<boolean> {
  const replayKey = getWhatsAppEventReplayKey(event);
  const claimed = await claimWebhookReplayKey(replayKey);
  if (claimed) {
    return true;
  }

  safeLog("whatsapp_replay_ignored", {
    user: toLogUser(event.userId),
  });
  return false;
}

async function safelyProcessSingleWhatsAppEvent(
  event: NormalizedWhatsAppEvent
): Promise<void> {
  const lang = DEFAULT_LANG;
  try {
    await processSingleWhatsAppEvent(event);
  } catch (error) {
    safeLog("whatsapp_reply_failed", {
      level: "error",
      user: toLogUser(event.userId),
      error: error instanceof Error ? error.message : String(error),
    });
    await sendWhatsAppTextReply(
      event.senderId,
      t(lang, "errorFallback")
    ).catch(() => undefined);
  }
}

export async function processWhatsAppWebhookPayload(
  payload: unknown
): Promise<void> {
  logWhatsAppWebhookPayload(payload);

  const events = normalizeWhatsAppEvents(payload);
  if (events.length === 0) {
    safeLog("whatsapp_no_inbound_messages_found");
    return;
  }

  for (const event of events) {
    await safelyProcessSingleWhatsAppEvent(event);
  }
}
