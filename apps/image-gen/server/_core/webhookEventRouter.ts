import { randomUUID } from "node:crypto";
import {
  deleteUserDataAndSendResult,
  handleMessengerConsentGate,
  isDeleteCommand,
} from "./consentService";
import { GDPR_DELETE_CONFIRM } from "./consentActionIds";
import { safeLog } from "./logger";
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
  getMessengerRequestPageId,
  getMessengerRequestPrivacySubject,
  runWithMessengerErasureControlDelivery,
  runWithMessengerRequestContext,
  setMessengerRequestOperationId,
  setMessengerRequestErasurePrivacySubject,
} from "./messengerRequestContext";
import { recordInboundUserActivity } from "./messengerInboundActivity";
import { resolveMessengerGenerationOwnership } from "./workspaceEntitlementRuntime";
import {
  getActiveMessengerPrivacySubjectEpoch,
  getErasingMessengerPrivacySubject,
} from "./messengerPrivacySubject";
import { confirmMessengerGenerationDeliveryReceipts } from "./messengerGenerationCompletion";
import { commitPaidCreditFromDeliveredCompletion } from "./webhookGenerationJobs";

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
  const ingressOwnership = getMessengerRequestOwnership();
  const ingressPrivacy = getMessengerRequestPrivacySubject();
  const ingressPageId = getMessengerRequestPageId();
  const ownership = await resolveMessengerGenerationOwnership(pageId);
  if (!ownership && process.env.NODE_ENV === "production") {
    logMessengerWebhookTrace("webhook_entry_skipped", {
      reason: "page_ownership_unavailable",
    });
    return;
  }
  const inheritedPrivacy =
    ingressPrivacy &&
    ingressOwnership &&
    ownership &&
    ingressPageId === pageId &&
    ingressOwnership.workspaceId === ownership.workspaceId &&
    ingressOwnership.channelConnectionId === ownership.channelConnectionId &&
    ingressOwnership.bindingEpoch === ownership.bindingEpoch
      ? ingressPrivacy
      : undefined;
  if (ingressPrivacy && !inheritedPrivacy) {
    logMessengerWebhookTrace("webhook_entry_skipped", {
      reason: "privacy_scope_mismatch",
    });
    return;
  }
  for (const event of events) {
    await runWithMessengerRequestContext(
      pageId,
      () => handleEvent(ctx, event, pageId),
      ownership
        ? {
            channel: "facebook_messenger",
            ...ownership,
            userKey: inheritedPrivacy?.userKey,
            privacyEpoch: inheritedPrivacy?.privacyEpoch,
          }
        : undefined
    );
  }
}

async function handleEvent(
  ctx: HandlerContext,
  event: FacebookWebhookEvent,
  entryId?: string
): Promise<void> {
  if (await handleMessengerDeliveryReceipt(event, entryId)) return;
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

async function handleMessengerDeliveryReceipt(
  event: FacebookWebhookEvent,
  entryId?: string
): Promise<boolean> {
  if (!event.delivery) return false;
  const rawMids = event.delivery.mids;
  if (
    !Array.isArray(rawMids) ||
    rawMids.length < 1 ||
    rawMids.length > 100 ||
    rawMids.some(
      mid =>
        typeof mid !== "string" ||
        mid.trim().length < 1 ||
        Buffer.byteLength(mid.trim(), "ascii") > 1_024 ||
        !/^[\x21-\x7e]+$/.test(mid.trim())
    )
  ) {
    safeLog("messenger_delivery_receipt_ignored", {
      reason: "invalid_message_ids",
    });
    return true;
  }
  const ownership = getMessengerRequestOwnership();
  const inheritedPrivacy = getMessengerRequestPrivacySubject();
  const pageId = getMessengerRequestPageId();
  const senderId = event.sender?.id?.trim();
  if (!ownership || !pageId || !entryId || pageId !== entryId || !senderId) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Messenger delivery receipt scope is unavailable");
    }
    return true;
  }
  const userKey = toUserKey(senderId);
  if (inheritedPrivacy && inheritedPrivacy.userKey !== userKey) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Messenger delivery receipt scope is unavailable");
    }
    return true;
  }
  const privacyEpoch =
    inheritedPrivacy?.privacyEpoch ??
    (await getActiveMessengerPrivacySubjectEpoch({ ...ownership, userKey }));
  if (!privacyEpoch) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Messenger delivery receipt scope is unavailable");
    }
    return true;
  }
  await runWithMessengerRequestContext(
    pageId,
    async () => {
      const fence = {
        ...ownership,
        privacyEpoch,
        userKey,
        pageId,
        channel: "facebook_messenger" as const,
      };
      const delivered = await confirmMessengerGenerationDeliveryReceipts(
        rawMids.map(mid => (mid as string).trim()),
        fence
      );
      for (const completion of delivered) {
        if (completion.quotaAccountingMode !== "paid_credit_delivery_v1") {
          continue;
        }
        await commitPaidCreditFromDeliveredCompletion({
          reqId: completion.reqId,
          userId: userKey,
          imageUrl: completion.imageUrl,
          completionFence: fence,
          paidCreditMode: completion.paidCreditMode,
        });
      }
      safeLog("messenger_delivery_receipt_processed", {
        receivedCount: rawMids.length,
        matchedGenerationCount: delivered.length,
      });
    },
    {
      channel: "facebook_messenger",
      ...ownership,
      userKey,
      privacyEpoch,
    }
  );
  return true;
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
  const requestPrivacy = getMessengerRequestPrivacySubject();
  if (
    requestPrivacy &&
    (requestPrivacy.userKey !== userId || requestPrivacy.privacyEpoch <= 0)
  ) {
    return true;
  }
  if (!requestPrivacy && process.env.NODE_ENV === "production") return true;
  const erasure = await getErasingMessengerPrivacySubject({
    workspaceId: ownership.workspaceId,
    channelConnectionId: ownership.channelConnectionId,
    userKey: userId,
  });
  if (!erasure) return false;
  if (requestPrivacy && requestPrivacy.privacyEpoch !== erasure.privacyEpoch) {
    return true;
  }

  const reqId = randomUUID();
  setMessengerRequestOperationId(reqId);
  setMessengerRequestErasurePrivacySubject({ userKey: userId, ...erasure });
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
