import { handleMessengerConsentGate } from "./consentService";
import { setPreferredLang } from "./messengerState";
import { toLogUser } from "./privacy";
import { captureException } from "./observability/sentry";
import { handlePayload, handlePostbackEvent } from "./webhookPayloadBranch";
import {
  type FacebookWebhookEntry,
  type FacebookWebhookEvent,
} from "./webhookHelpers";
import { logMessengerWebhookTrace } from "./webhookFallback";
import {
  createTrackedEventContext,
  type TrackedEventContext,
} from "./webhookEventContext";
import { handleMessageEvent } from "./webhookMessageRouter";
import type { HandlerContext } from "./webhookHandlerTypes";
import { renderMessengerQuickReplies } from "./messengerActionRenderer";

/** Routes every Messenger event in a Facebook webhook entry. */
export async function handleEntry(
  ctx: HandlerContext,
  entry: FacebookWebhookEntry
): Promise<void> {
  const events = Array.isArray(entry?.messaging) ? entry.messaging : [];
  for (const event of events) {
    await handleEvent(ctx, event, entry?.id);
  }
}

async function handleEvent(
  ctx: HandlerContext,
  event: FacebookWebhookEvent,
  entryId?: string
): Promise<void> {
  const eventContext = await createTrackedEventContext(ctx, event, entryId);
  if (!eventContext) return;

  const { psid, userId, reqId, state, trackedCtx } = eventContext;

  logMessengerWebhookTrace("webhook_received", {
    reqId,
    user: toLogUser(userId),
    entryId,
    hasMessage: Boolean(event.message),
    hasPostback: Boolean(event.postback),
    isEcho: Boolean(event.message?.is_echo),
  });

  try {
    trackedCtx.logIncomingMessage(psid, userId, event, reqId);
    trackedCtx.logUserState(psid, userId, state, reqId, "handle_event");

    if (
      eventContext.senderLocale &&
      eventContext.localeLang !== state.preferredLang
    ) {
      await setPreferredLang(psid, eventContext.localeLang);
    }

    await routeTrackedEvent(eventContext, event);
  } catch (error) {
    logMessengerWebhookTrace("top_level_catch", {
      reqId,
      user: toLogUser(userId),
      errorCode:
        error instanceof Error ? error.constructor.name : "UnknownError",
    });
    captureException(error, {
      area: "webhook",
      eventType: event.postback
        ? "postback"
        : event.message
          ? "message"
          : "unknown",
      hasImage: Boolean(
        event.message?.attachments?.some(
          attachment => attachment.type === "image"
        )
      ),
      hasText: Boolean(event.message?.text),
    });
    await eventContext.sendFallbackIfNeeded();
    throw error;
  }

  await eventContext.sendFallbackIfNeeded();
}

/** Selects the consent, postback, or message branch for a tracked event. */
export async function routeTrackedEvent(
  context: TrackedEventContext,
  event: FacebookWebhookEvent
): Promise<void> {
  const { psid, userId, reqId, lang, localeLang, state, trackedCtx } = context;
  if (await routeConsentGate(context, event)) return;

  if (
    await handlePostbackEvent(trackedCtx, {
      psid,
      userId,
      event,
      reqId,
      lang,
    })
  ) {
    await finishSelectedBranch(context, "postback");
    return;
  }

  await handleMessageEvent(trackedCtx, { psid, userId, event, reqId, lang });
  await finishSelectedBranch(context, "message");
}

async function routeConsentGate(
  context: TrackedEventContext,
  event: FacebookWebhookEvent
): Promise<boolean> {
  const { psid, lang, reqId, state, classification, trackedCtx } = context;
  if (!classification.isInboundUserEvent) {
    return false;
  }

  const handled = await handleMessengerConsentGate({
    psid,
    lang,
    text: event.message?.text,
    payload: classification.eventPayload,
    state,
    sendText: async text => {
      await trackedCtx.sendLoggedText(psid, text, reqId);
    },
    sendActions: async (text, actions) => {
      await trackedCtx.sendLoggedQuickReplies(
        psid,
        text,
        renderMessengerQuickReplies(actions),
        reqId
      );
    },
  });

  if (handled) {
    await finishSelectedBranch(context, "consent_gate");
  }

  return handled;
}

async function finishSelectedBranch(
  context: TrackedEventContext,
  branch: string
): Promise<void> {
  logMessengerWebhookTrace("selected_branch", {
    reqId: context.reqId,
    user: toLogUser(context.userId),
    branch,
    responseSent: context.responseSent(),
  });
  await context.sendFallbackIfNeeded();
}
