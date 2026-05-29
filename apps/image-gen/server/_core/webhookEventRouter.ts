import { safeLog } from "./messengerApi";
import { handleMessengerConsentGate } from "./consentService";
import {
  setActiveExperience,
  setFlowState,
  setLastEntryIntent,
  setPreferredLang,
  type ConversationState,
} from "./messengerState";
import { toLogUser } from "./privacy";
import {
  parseMessengerEntryIntent,
  routeMessengerActiveExperience,
  routeMessengerEntryIntent,
} from "./messengerExperienceRouting";
import type { EntryIntent } from "./entryIntent";
import type { ActiveExperience } from "./activeExperience";
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
import type { HandlerContext } from "./webhookHandlers";

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

async function routeTrackedEvent(
  context: TrackedEventContext,
  event: FacebookWebhookEvent
): Promise<void> {
  const { psid, userId, reqId, lang, localeLang, state, trackedCtx } = context;
  if (await routeConsentGate(context, event)) return;

  const routeDeps = createMessengerRouteDeps(context);
  const { referralRef, entryIntent } = parseMessengerEntryIntent({
    event,
    reqId,
    userId,
    localeLang,
    safeLog,
  });

  if (
    await routeMessengerEntryIntent({
      deps: routeDeps,
      state,
      entryIntent,
    })
  ) {
    await finishSelectedBranch(context, "entry_intent");
    return;
  }

  if (
    await routeMessengerActiveExperience({
      deps: routeDeps,
      state,
      event,
    })
  ) {
    await finishSelectedBranch(context, "active_experience");
    return;
  }

  const referralResult = await trackedCtx.handleReferralStyleEvent(
    psid,
    referralRef,
    lang,
    reqId
  );
  if (referralResult.handled) {
    context.markResponseSentFromOutcome(referralResult.outcome);
    await finishSelectedBranch(context, "referral");
    return;
  }

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
    sendQuickReplies: async (text, replies) => {
      await trackedCtx.sendLoggedQuickReplies(psid, text, replies, reqId);
    },
    sendRestyleStarterPills: async () => {
      await setFlowState(psid, "AWAITING_STYLE");
      await trackedCtx.sendStylePicker(psid, lang, reqId);
    },
  });

  if (handled) {
    await finishSelectedBranch(context, "consent_gate");
  }

  return handled;
}

function createMessengerRouteDeps(context: TrackedEventContext) {
  const { psid, userId, reqId, trackedCtx } = context;
  return {
    psid,
    userId,
    reqId,
    sendText: async (text: string) => {
      await trackedCtx.sendLoggedText(psid, text, reqId);
    },
    sendStateText: async (stateName: ConversationState, text: string) => {
      await trackedCtx.sendStateQuickReplies(psid, stateName, text, reqId);
    },
    sendOptionsPrompt: async (
      prompt: string,
      options: Array<{ id: string; title: string }>
    ) => {
      await trackedCtx.sendLoggedQuickReplies(
        psid,
        prompt,
        options.map(option => ({
          content_type: "text",
          title: option.title,
          payload: option.id,
        })),
        reqId
      );
    },
    sendImage: async (imageUrl: string) => {
      await trackedCtx.sendLoggedImage(psid, imageUrl, reqId);
    },
    safeLog,
    setLastEntryIntent: (nextEntryIntent: EntryIntent | null) =>
      Promise.resolve(setLastEntryIntent(psid, nextEntryIntent)),
    setActiveExperience: (nextActiveExperience: ActiveExperience | null) =>
      Promise.resolve(setActiveExperience(psid, nextActiveExperience)),
  };
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
