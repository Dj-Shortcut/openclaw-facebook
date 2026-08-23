import { randomUUID } from "node:crypto";
import type { MessengerSendOutcome } from "./messengerApi";
import { recordActiveUserToday } from "./botRuntimeStats";
import { classifyInboundEvent } from "./messengerInboundClassification";
import { recordInboundUserActivity } from "./messengerInboundActivity";
import {
  getOrCreateState,
  setMessengerOwnership,
  setMessengerPageId,
} from "./messengerState";
import { normalizeLang, type Lang } from "./i18n";
import { toUserKey } from "./privacy";
import type { FacebookWebhookEvent } from "./webhookHelpers";
import { createTrackedHandlerContext } from "./webhookTrackedContext";
import {
  createResponseSentTracker,
  sendFallbackTextIfNeeded,
} from "./webhookFallback";
import type { HandlerContext } from "./webhookHandlerTypes";
import {
  getMessengerRequestOwnership,
  getMessengerRequestPrivacySubject,
  setMessengerRequestOperationId,
} from "./messengerRequestContext";
import { assertMessengerPrivacySubject } from "./messengerPrivacySubject";

type MessengerState = Awaited<ReturnType<typeof getOrCreateState>>;

export type TrackedEventContext = {
  psid: string;
  userId: string;
  reqId: string;
  lang: Lang;
  localeLang: Lang;
  senderLocale?: string;
  state: MessengerState;
  classification: ReturnType<typeof classifyInboundEvent>;
  entryId?: string;
  responseSent: () => boolean;
  markResponseSentFromOutcome: (
    outcome: MessengerSendOutcome | undefined
  ) => void;
  sendFallbackIfNeeded: () => Promise<void>;
  trackedCtx: HandlerContext;
};

/** Creates per-event tracking, locale, state, and fallback context for webhook routing. */
export async function createTrackedEventContext(
  ctx: HandlerContext,
  event: FacebookWebhookEvent,
  entryId?: string
): Promise<TrackedEventContext | null> {
  const psid = event.sender?.id;
  if (!psid) return null;

  const userId = toUserKey(psid);
  const reqId = randomUUID();
  setMessengerRequestOperationId(reqId);
  const ownership = getMessengerRequestOwnership();
  if (!ownership && process.env.NODE_ENV === "production") {
    return null;
  }
  const requestPrivacy = getMessengerRequestPrivacySubject();
  if (requestPrivacy && !ownership) return null;
  let privacyEpoch: number | undefined;
  if (ownership) {
    if (!requestPrivacy) {
      if (process.env.NODE_ENV === "production") return null;
    } else if (requestPrivacy.userKey !== userId) {
      return null;
    }
    try {
      if (requestPrivacy) {
        await assertMessengerPrivacySubject({
          workspaceId: ownership.workspaceId,
          channelConnectionId: ownership.channelConnectionId,
          userKey: userId,
          privacyEpoch: requestPrivacy.privacyEpoch,
        });
        privacyEpoch = requestPrivacy.privacyEpoch;
      }
    } catch {
      return null;
    }
  }
  const responseTracker = createResponseSentTracker();
  const trackedCtx = createTrackedHandlerContext(
    ctx,
    responseTracker.markResponseSentFromOutcome
  );

  if (!(await ctx.claimEventReplayOrLog(event, entryId, userId, reqId))) {
    return null;
  }

  recordActiveUserToday(userId);
  const senderLocale = event.sender?.locale?.trim();
  const localeLang = senderLocale
    ? normalizeLang(senderLocale)
    : ctx.defaultLang;
  const state = await getOrCreateState(psid);
  if (entryId?.trim()) {
    await Promise.resolve(setMessengerPageId(psid, entryId));
    state.pageId = entryId.trim();
  }
  if (ownership && privacyEpoch) {
    await Promise.resolve(
      setMessengerOwnership(psid, { ...ownership, privacyEpoch })
    );
    Object.assign(state, ownership, { privacyEpoch });
  }
  const storedSenderLanguage =
    state.preferredLangSource === "sender_locale"
      ? state.preferredLang
      : undefined;
  const lang = senderLocale
    ? localeLang
    : storedSenderLanguage || ctx.defaultLang;
  const classification = classifyInboundEvent(event);
  await recordInboundUserActivity(psid, event, classification, {
    entryId,
    allowPaidRecovery: false,
  });
  const sendFallbackIfNeeded = () =>
    sendFallbackTextIfNeeded({
      isInboundUserEvent: classification.isInboundUserEvent,
      isIntentionalSilentAck: classification.isIntentionalSilentAck,
      isIntentionalSilentUnknownPayload:
        classification.isIntentionalSilentUnknownPayload,
      responseSent: responseTracker.responseSent,
      sendLoggedText: trackedCtx.sendLoggedText,
      psid,
      lang,
      reqId,
    });

  return {
    psid,
    userId,
    reqId,
    lang,
    localeLang,
    senderLocale,
    state,
    classification,
    entryId,
    responseSent: responseTracker.responseSent,
    markResponseSentFromOutcome: responseTracker.markResponseSentFromOutcome,
    sendFallbackIfNeeded,
    trackedCtx,
  };
}
