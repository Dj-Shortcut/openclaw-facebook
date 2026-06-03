import type { MessengerSendOutcome } from "./messengerApi";
import { recordActiveUserToday } from "./botRuntimeStats";
import { classifyInboundEvent } from "./messengerInboundClassification";
import { recordInboundUserActivity } from "./messengerInboundActivity";
import { getOrCreateState } from "./messengerState";
import { normalizeLang, type Lang } from "./i18n";
import { toUserKey } from "./privacy";
import type { FacebookWebhookEvent } from "./webhookHelpers";
import { createTrackedHandlerContext } from "./webhookTrackedContext";
import {
  createResponseSentTracker,
  sendFallbackTextIfNeeded,
} from "./webhookFallback";
import type { HandlerContext } from "./webhookHandlerTypes";

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
  const reqId = `${psid}-${Date.now()}`;
  const responseTracker = createResponseSentTracker();
  const trackedCtx = createTrackedHandlerContext(
    ctx,
    responseTracker.markResponseSentFromOutcome
  );

  if (!(await ctx.claimEventReplayOrLog(event, entryId, userId))) {
    return null;
  }

  recordActiveUserToday(userId);
  const senderLocale = event.sender?.locale?.trim();
  const localeLang = senderLocale
    ? normalizeLang(senderLocale)
    : ctx.defaultLang;
  const state = await getOrCreateState(psid);
  const lang = state.preferredLang || localeLang || ctx.defaultLang;
  const classification = classifyInboundEvent(event);
  await recordInboundUserActivity(psid, event, classification);
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
    responseSent: responseTracker.responseSent,
    markResponseSentFromOutcome: responseTracker.markResponseSentFromOutcome,
    sendFallbackIfNeeded,
    trackedCtx,
  };
}
