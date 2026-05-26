import { createHash, randomUUID } from "node:crypto";
import { normalizeLang, t } from "./i18n";
import { getOrCreateState, setLastUserMessageAt } from "./messengerState";
import { toLogUser } from "./privacy";
import { handleWhatsAppConsentGate } from "./consentService";
import { extractWhatsAppEvents, logWhatsAppWebhookPayload } from "./inbound/whatsappInbound";
import { handleWhatsAppImageEvent } from "./whatsappHandlers/imageHandler";
import { handleWhatsAppInteractiveEvent } from "./whatsappHandlers/interactiveHandler";
import { handleWhatsAppTextEvent } from "./whatsappHandlers/textHandler";
import { handleWhatsAppExperienceRouting } from "./whatsappRouting";
import { sendWhatsAppButtonsReply, sendWhatsAppTextReply } from "./whatsappResponseService";
import type { NormalizedWhatsAppEvent } from "./whatsappTypes";

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
  console.warn("[whatsapp webhook] unsupported inbound message type", {
    user: toLogUser(event.userId),
    rawMessageType: event.rawMessageType,
  });
  await sendWhatsAppTextReply(event.senderId, t(lang, "unsupportedMedia"));
}

async function dispatchWhatsAppEvent(
  event: NormalizedWhatsAppEvent,
  context: ReturnType<typeof createWhatsAppEventContext>
): Promise<void> {
  if (await handleWhatsAppExperienceRouting(event)) {
    return;
  }

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

  console.warn("[whatsapp webhook] no handler for inbound event", {
    user: toLogUser(event.userId),
    messageType: event.messageType,
    rawMessageType: event.rawMessageType,
  });
}

async function processSingleWhatsAppEvent(
  event: NormalizedWhatsAppEvent
): Promise<void> {
  const context = createWhatsAppEventContext(event);
  const state = await Promise.resolve(getOrCreateState(event.senderId));

  console.log("[whatsapp webhook] normalized inbound event", {
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

async function safelyProcessSingleWhatsAppEvent(
  event: NormalizedWhatsAppEvent
): Promise<void> {
  const lang = DEFAULT_LANG;
  try {
    await processSingleWhatsAppEvent(event);
  } catch (error) {
    console.error("[whatsapp webhook] reply failed", {
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
    console.log("[whatsapp webhook] no inbound messages found");
    return;
  }

  for (const event of events) {
    await safelyProcessSingleWhatsAppEvent(event);
  }
}
