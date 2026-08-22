import { randomUUID } from "node:crypto";
import {
  deleteUserDataAndSendResult,
  handleMessengerConsentGate,
  isDeleteCommand,
} from "./consentService";
import { GDPR_DELETE_CONFIRM } from "./consentActionIds";
import { safeLog } from "./messengerApi";
import { setPreferredLang } from "./messengerState";
import { normalizeLang } from "./i18n";
import { toLogUser, toUserKey } from "./privacy";
import { captureException } from "./observability/sentry";
import { handlePostbackEvent } from "./webhookPayloadBranch";
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
import {
  getMessengerRequestOwnership,
  runWithMessengerErasureControlDelivery,
  runWithMessengerRequestContext,
  setMessengerRequestOperationId,
  setMessengerRequestPrivacySubject,
} from "./messengerRequestContext";
import { recordInboundUserActivity } from "./messengerInboundActivity";
import { resolveMessengerGenerationOwnership } from "./workspaceEntitlementRuntime";
import { getErasingMessengerPrivacySubjectEpoch } from "./messengerPrivacySubject";

/** Routes every Messenger event in a Facebook webhook entry. */
export async function handleEntry(
  ctx: HandlerContext,
  entry: FacebookWebhookEntry
): Promise<void> {
  const pageId = typeof entry?.id === "string" ? entry.id.trim() : "";
  if (!pageId) {
    logMessengerWebhookTrace("webhook_entry_skipped", {
      reason: "missing_receiving_page",
    });
    return;
  }

  const events = Array.isArray(entry?.messaging) ? entry.messaging : [];
  const ownership = await resolveMessengerGenerationOwnership(pageId);
  if (!ownership && process.env.NODE_ENV === "production") {
    logMessengerWebhookTrace("webhook_entry_skipped", {
      reason: "page_ownership_unavailable",
    });
    return;
  }
  for (const event of events) {
    await runWithMessengerRequestContext(
      pageId,
      () => handleEvent(ctx, event, pageId),
      ownership ?? undefined
    );
  }
}

async function handleEvent(
  ctx: HandlerContext,
  event: FacebookWebhookEvent,
  entryId?: string
): Promise<void> {
  if (await resumePendingMessengerErasure(ctx, event, entryId)) return;
  const eventContext = await createTrackedEventContext(ctx, event, entryId);
  if (!eventContext) return;

  const { psid, userId, reqId, state, trackedCtx } = eventContext;

  logMessengerWebhookTrace("webhook_received", {
    reqId,
    user: toLogUser(userId),
    hasReceivingPageContext: Boolean(entryId?.trim()),
    hasMessage: Boolean(event.message),
    hasPostback: Boolean(event.postback),
    isEcho: Boolean(event.message?.is_echo),
  });

  try {
    trackedCtx.logIncomingMessage(psid, userId, event, reqId);
    trackedCtx.logUserState(psid, userId, state, reqId, "handle_event");

    if (eventContext.senderLocale) {
      if (
        eventContext.lang !== state.preferredLang ||
        state.preferredLangSource !== "sender_locale"
      ) {
        await setPreferredLang(psid, eventContext.lang, "sender_locale");
      }
    } else if (
      state.preferredLangSource !== "sender_locale" &&
      (eventContext.lang !== state.preferredLang ||
        state.preferredLangSource !== "account_default")
    ) {
      await setPreferredLang(psid, eventContext.lang, "account_default");
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
      reqId,
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

async function resumePendingMessengerErasure(
  ctx: HandlerContext,
  event: FacebookWebhookEvent,
  entryId?: string
): Promise<boolean> {
  const psid = event.sender?.id;
  const payload =
    event.message?.quick_reply?.payload ?? event.postback?.payload;
  if (
    !psid ||
    (!isDeleteCommand(event.message?.text) && payload !== GDPR_DELETE_CONFIRM)
  ) {
    return false;
  }
  const ownership = getMessengerRequestOwnership();
  if (!ownership) return false;
  const userId = toUserKey(psid);
  const privacyEpoch = await getErasingMessengerPrivacySubjectEpoch({
    workspaceId: ownership.workspaceId,
    channelConnectionId: ownership.channelConnectionId,
    userKey: userId,
  });
  if (!privacyEpoch) return false;

  const reqId = randomUUID();
  setMessengerRequestOperationId(reqId);
  setMessengerRequestPrivacySubject({ userKey: userId, privacyEpoch });
  if (!(await ctx.claimEventReplayOrLog(event, entryId, userId, reqId))) {
    return true;
  }
  const senderLocale = event.sender?.locale?.trim();
  const lang = senderLocale ? normalizeLang(senderLocale) : ctx.defaultLang;
  await deleteUserDataAndSendResult(psid, lang, text =>
    runWithMessengerErasureControlDelivery(async () => {
      const outcome = await ctx.sendLoggedText(psid, text, reqId);
      return outcome?.sent === true;
    })
  );
  return true;
}

/** Selects the consent, postback, or message branch for a tracked event. */
export async function routeTrackedEvent(
  context: TrackedEventContext,
  event: FacebookWebhookEvent
): Promise<void> {
  const { psid, userId, reqId, lang, trackedCtx } = context;
  if (await routeConsentGate(context, event)) return;
  await recordInboundUserActivity(psid, event, context.classification, {
    entryId: context.entryId,
    allowPaidRecovery: true,
  });

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
  const { psid, userId, lang, reqId, state, classification, trackedCtx } =
    context;
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
      const outcome = await trackedCtx.sendLoggedText(psid, text, reqId);
      return outcome?.sent === true;
    },
    sendDeletionOutcome: text =>
      runWithMessengerErasureControlDelivery(async () => {
        const outcome = await trackedCtx.sendLoggedText(psid, text, reqId);
        return outcome?.sent === true;
      }),
    sendActions: async (text, actions) => {
      const outcome = await trackedCtx.sendLoggedActions(
        psid,
        text,
        actions,
        reqId
      );
      return outcome?.sent === true;
    },
    onConsentControlsError: error => {
      safeLog("messenger_consent_controls_failed", {
        level: "warn",
        reqId,
        user: toLogUser(userId),
        errorCode:
          error instanceof Error ? error.constructor.name : "UnknownError",
      });
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
