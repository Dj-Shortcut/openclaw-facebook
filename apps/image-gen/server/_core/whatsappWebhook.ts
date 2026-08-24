import { createHash } from "node:crypto";
import { normalizeLang, t } from "./i18n";
import { getOrCreateState, setLastUserMessageAt } from "./messengerState";
import { toLogUser } from "./privacy";
import {
  deleteUserDataAndSendResult,
  handleWhatsAppConsentGate,
  isDeleteCommand,
  isWhatsAppPrivacyOrConsentControl,
} from "./consentService";
import { GDPR_DELETE_CONFIRM } from "./consentActionIds";
import {
  extractWhatsAppEvents,
  logWhatsAppWebhookPayload,
} from "./inbound/whatsappInbound";
import { handleWhatsAppImageEvent } from "./whatsappHandlers/imageHandler";
import { handleWhatsAppAudioEvent } from "./whatsappHandlers/audioHandler";
import { handleWhatsAppInteractiveEvent } from "./whatsappHandlers/interactiveHandler";
import { handleWhatsAppTextEvent } from "./whatsappHandlers/textHandler";
import {
  sendWhatsAppErasureControlTextReply,
  sendWhatsAppButtonsReply,
  sendWhatsAppTextReply,
} from "./whatsappResponseService";
import { claimWebhookReplayKey } from "./webhookReplayProtection";
import type { NormalizedWhatsAppEvent } from "./whatsappTypes";
import type { WhatsAppHandlerContext } from "./whatsappTypes";
import {
  admitWhatsAppGenerationScope,
  resolveWhatsAppGenerationOwnership,
  WhatsAppGenerationScopeError,
  type WhatsAppGenerationOwnership,
} from "./whatsappGenerationScope";
import {
  runWithMessengerErasureControlDelivery,
  runWithMessengerRequestContext,
  setMessengerRequestErasurePrivacySubject,
  setMessengerRequestOperationId,
  setMessengerRequestPrivacySubject,
} from "./messengerRequestContext";
import {
  getErasingMessengerPrivacySubject,
  type MessengerErasingPrivacySubject,
} from "./messengerPrivacySubject";
import { safeLog } from "./logger";

const DEFAULT_LANG = normalizeLang(process.env.DEFAULT_MESSENGER_LANG);

type WhatsAppEventContext = WhatsAppHandlerContext &
  Readonly<{ erasure?: MessengerErasingPrivacySubject }>;

function normalizeWhatsAppEvents(payload: unknown): NormalizedWhatsAppEvent[] {
  return extractWhatsAppEvents(payload).filter(
    (event): event is NormalizedWhatsAppEvent => event.channel === "whatsapp"
  );
}

function getStableWhatsAppEventId(event: NormalizedWhatsAppEvent): string {
  return (
    event.messageId?.trim() ||
    createHash("sha256")
      .update(
        [
          event.senderId,
          event.timestamp ?? "no-ts",
          event.rawMessageType ?? "unknown",
          event.imageId ?? event.audioId ?? event.textBody ?? "no-body",
        ].join(":"),
        "utf8"
      )
      .digest("hex")
  );
}

function createNonReversibleReqId(
  event: NormalizedWhatsAppEvent,
  ownership: WhatsAppGenerationOwnership
): string {
  return createHash("sha256")
    .update("whatsapp:req:v2", "utf8")
    .update("\0")
    .update(String(ownership.workspaceId))
    .update("\0")
    .update(String(ownership.channelConnectionId))
    .update("\0")
    .update(String(ownership.bindingEpoch))
    .update("\0")
    .update(ownership.userKey)
    .update("\0")
    .update(getStableWhatsAppEventId(event))
    .digest("hex");
}

async function createWhatsAppEventContext(
  event: NormalizedWhatsAppEvent,
  privacyOrConsentControl: boolean,
  deletionRetryControl: boolean
): Promise<WhatsAppEventContext | null> {
  const ownership = await resolveWhatsAppGenerationOwnership({
    endpoint: event.endpoint,
    senderId: event.senderId,
    userKey: event.userId,
  });
  if (!(await claimWhatsAppEventReplayOrLog(event, ownership))) {
    return null;
  }
  if (deletionRetryControl) {
    const erasure = await getErasingMessengerPrivacySubject(ownership);
    if (erasure) {
      return Object.freeze({
        reqId: createNonReversibleReqId(event, ownership),
        lang: DEFAULT_LANG,
        costLedgerScope: Object.freeze({
          ...ownership,
          privacyEpoch: erasure.privacyEpoch,
        }),
        erasure,
      });
    }
  }
  const costLedgerScope = await admitWhatsAppGenerationScope({
    endpoint: event.endpoint,
    ownership,
    eventOccurredAt: new Date(event.timestamp ?? Date.now()),
    allowReactivation: !privacyOrConsentControl,
    allowCreation: true,
  });
  return Object.freeze({
    reqId: createNonReversibleReqId(event, ownership),
    lang: DEFAULT_LANG,
    costLedgerScope,
  });
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
  context: WhatsAppHandlerContext
): Promise<void> {
  if (event.messageType === "image") {
    await handleWhatsAppImageEvent(event, context);
    return;
  }

  if (event.messageType === "audio") {
    await handleWhatsAppAudioEvent(event, context);
    return;
  }

  if (event.audioId) {
    await handleWhatsAppAudioEvent(event, context);
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
  const privacyOrConsentControl = isWhatsAppPrivacyOrConsentControl(event);
  const interactiveReplyId =
    typeof event.rawEventMeta?.interactiveReplyId === "string"
      ? event.rawEventMeta.interactiveReplyId
      : undefined;
  const deletionRetryControl =
    interactiveReplyId === GDPR_DELETE_CONFIRM ||
    isDeleteCommand(event.textBody) ||
    isDeleteCommand(interactiveReplyId);
  const context = await createWhatsAppEventContext(
    event,
    privacyOrConsentControl,
    deletionRetryControl
  );
  if (!context) {
    return;
  }
  await runWithMessengerRequestContext(
    event.endpoint.phoneNumberId,
    async () => {
      setMessengerRequestOperationId(context.reqId);
      if (context.erasure) {
        setMessengerRequestErasurePrivacySubject({
          userKey: context.costLedgerScope.userKey,
          ...context.erasure,
        });
        await deleteUserDataAndSendResult(event.senderId, context.lang, text =>
          runWithMessengerErasureControlDelivery(() =>
            sendWhatsAppErasureControlTextReply(
              event.senderId,
              text,
              context.reqId
            )
          )
        );
        return;
      }
      setMessengerRequestPrivacySubject({
        userKey: event.userId,
        privacyEpoch: context.costLedgerScope.privacyEpoch,
      });
      const state = await Promise.resolve(getOrCreateState(event.senderId));

      safeLog("whatsapp_normalized_inbound_event", {
        channel: event.channel,
        user: toLogUser(event.userId),
        messageType: event.messageType,
        rawMessageType: event.rawMessageType,
      });

      if (
        await handleWhatsAppConsentGate({
          event,
          lang: context.lang,
          state,
          sendText: text => sendWhatsAppTextReply(event.senderId, text),
          sendDeletionOutcome: text =>
            runWithMessengerErasureControlDelivery(() =>
              sendWhatsAppErasureControlTextReply(
                event.senderId,
                text,
                context.reqId
              )
            ),
          sendButtons: (text, options) =>
            sendWhatsAppButtonsReply(event.senderId, text, options),
        })
      ) {
        return;
      }

      // Consent and deletion controls may be answered, but must never open
      // the paid handoff/recovery window.
      if (privacyOrConsentControl) {
        return;
      }
      await Promise.resolve(
        setLastUserMessageAt(event.senderId, event.timestamp ?? Date.now())
      );

      await dispatchWhatsAppEvent(event, context);
    },
    {
      channel: "whatsapp",
      workspaceId: context.costLedgerScope.workspaceId,
      channelConnectionId: context.costLedgerScope.channelConnectionId,
      bindingEpoch: context.costLedgerScope.bindingEpoch,
    }
  );
}

function getWhatsAppEventReplayKey(
  event: NormalizedWhatsAppEvent,
  ownership: WhatsAppGenerationOwnership
): string {
  const scopeDigest = createHash("sha256")
    .update(String(ownership.workspaceId))
    .update("\0")
    .update(String(ownership.channelConnectionId))
    .update("\0")
    .update(String(ownership.bindingEpoch))
    .update("\0")
    .update(ownership.userKey)
    .digest("hex");
  const eventDigest = createHash("sha256")
    .update(getStableWhatsAppEventId(event))
    .digest("hex");
  return `whatsapp:v2:${scopeDigest}:${eventDigest}`;
}

async function claimWhatsAppEventReplayOrLog(
  event: NormalizedWhatsAppEvent,
  ownership: WhatsAppGenerationOwnership
): Promise<boolean> {
  const replayKey = getWhatsAppEventReplayKey(event, ownership);
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
      error: error instanceof Error ? error.name : "unknown_error",
    });
    if (error instanceof WhatsAppGenerationScopeError) {
      return;
    }
    await sendWhatsAppTextReply(event.senderId, t(lang, "errorFallback")).catch(
      () => undefined
    );
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
