import { sendImage, sendQuickReplies, sendText, safeLog } from "./messengerApi";
import type { MessengerSendOutcome } from "./messengerApi";
import {
  buildFaceMemoryConsentResponse,
  buildPhotoReceivedResponse,
} from "./conversationActions";
import { renderMessengerQuickReplies } from "./messengerActionRenderer";
import {
  anonymizePsid,
  clearPendingImageState,
  setFlowState,
} from "./messengerState";
import { t, type Lang } from "./i18n";
import { toLogUser } from "./privacy";
import { claimWebhookReplayKey } from "./webhookReplayProtection";
import { type FacebookWebhookEvent, getEventDedupeKey } from "./webhookHelpers";
import { hasInFlightGeneration } from "./generationGuard";
import { isDebugLogEnabled } from "./logLevel";
import { getTodayRuntimeStats } from "./botRuntimeStats";
import type { BotLogger, BotPayloadContext } from "./botContext";
import type { GenerationKind } from "./image-generation/generationTypes";
import type { MaybeInFlightMessageResult } from "./webhookFallback";
import type { HandlerContext, MessengerState } from "./webhookHandlerTypes";

type FeatureContextBase = Omit<BotPayloadContext, "payload">;

type CreateHandlerContextInput = {
  defaultLang: Lang;
  runImageGeneration: HandlerContext["runImageGeneration"];
};

const IN_FLIGHT_NOTICE_COOLDOWN_MS = 30_000;
const inFlightNoticeSent = new Map<string, number>();
const MESSENGER_CAPABILITIES = Object.freeze({
  quickReplies: true,
  richTemplates: true,
});

export function createHandlerContext({
  defaultLang,
  runImageGeneration,
}: CreateHandlerContextInput): HandlerContext {
  function debugWebhookLog(message: Record<string, unknown>): void {
    if (!isDebugLogEnabled()) {
      return;
    }

    const event =
      typeof message.msg === "string" ? message.msg : "webhook_debug";
    safeLog(event, { level: "debug", ...message });
  }

  function getAttachmentHostname(url: string): string | null {
    try {
      return new URL(url).hostname || null;
    } catch {
      return null;
    }
  }

  async function maybeSendInFlightMessage(
    psid: string,
    reqId: string,
    lang: Lang
  ): Promise<MaybeInFlightMessageResult> {
    if (!(await hasInFlightGeneration(psid))) {
      inFlightNoticeSent.delete(psid);
      return { handled: false };
    }

    const now = Date.now();
    const lastNoticeSentAt = inFlightNoticeSent.get(psid);
    if (
      lastNoticeSentAt !== undefined &&
      now - lastNoticeSentAt < IN_FLIGHT_NOTICE_COOLDOWN_MS
    ) {
      return { handled: true };
    }

    const outcome = await sendLoggedText(
      psid,
      t(lang, "inFlightMessage"),
      reqId
    );
    inFlightNoticeSent.set(psid, now);
    return { handled: true, outcome };
  }

  function logIncomingMessage(
    psid: string,
    userId: string,
    event: FacebookWebhookEvent,
    reqId: string
  ): void {
    debugWebhookLog({
      level: "debug",
      msg: "incoming_message",
      reqId,
      user: toLogUser(userId),
      psidHash: anonymizePsid(psid).slice(0, 12),
      isEcho: Boolean(event.message?.is_echo),
      text: event.message?.text ?? null,
      quickReplyPayload: event.message?.quick_reply?.payload ?? null,
      attachments:
        event.message?.attachments?.map(attachment => ({
          type: attachment.type,
          hasUrl: Boolean(attachment.payload?.url),
        })) ?? [],
      postbackPayload: event.postback?.payload ?? null,
      referralRef: event.postback?.referral?.ref ?? event.referral?.ref ?? null,
    });
  }

  function logUserState(
    psid: string,
    userId: string,
    state: MessengerState,
    reqId: string,
    context: string
  ): void {
    debugWebhookLog({
      level: "debug",
      msg: "user_state",
      context,
      reqId,
      user: toLogUser(userId),
      psidHash: anonymizePsid(psid).slice(0, 12),
      stage: state.stage,
      hasSeenIntro: state.hasSeenIntro,
      hasLastPhoto: Boolean(state.lastPhotoUrl),
      preferredLang: state.preferredLang ?? null,
    });
  }

  async function sendLoggedText(
    psid: string,
    text: string,
    reqId: string
  ): Promise<MessengerSendOutcome> {
    debugWebhookLog({
      level: "debug",
      msg: "outgoing_message",
      kind: "text",
      reqId,
      psidHash: anonymizePsid(psid).slice(0, 12),
      text,
    });
    return await sendText(psid, text);
  }

  async function sendLoggedQuickReplies(
    psid: string,
    text: string,
    replies: Parameters<typeof sendQuickReplies>[2],
    reqId: string
  ): Promise<MessengerSendOutcome> {
    debugWebhookLog({
      level: "debug",
      msg: "outgoing_message",
      kind: "quick_replies",
      reqId,
      psidHash: anonymizePsid(psid).slice(0, 12),
      text,
      quickReplies: replies.map(reply => ({
        title: reply.title,
        payload: reply.payload,
      })),
    });
    return await sendQuickReplies(psid, text, replies);
  }

  async function sendLoggedImage(
    psid: string,
    imageUrl: string,
    reqId: string
  ): Promise<MessengerSendOutcome> {
    debugWebhookLog({
      level: "debug",
      msg: "outgoing_message",
      kind: "image",
      reqId,
      psidHash: anonymizePsid(psid).slice(0, 12),
      imageUrl,
    });
    return await sendImage(psid, imageUrl);
  }

  function createFeatureLogger(userId: string): BotLogger {
    return {
      info(event, details = {}) {
        safeLog(event, { user: toLogUser(userId), ...details });
      },
      warn(event, details = {}) {
        safeLog(event, { level: "warn", user: toLogUser(userId), ...details });
      },
      error(event, details = {}) {
        safeLog(event, { level: "error", user: toLogUser(userId), ...details });
      },
    };
  }

  function createFeatureContextBase(
    psid: string,
    userId: string,
    reqId: string,
    lang: Lang,
    state: MessengerState
  ): FeatureContextBase {
    return {
      channel: "messenger",
      capabilities: MESSENGER_CAPABILITIES,
      senderId: psid,
      userId,
      reqId,
      lang,
      state,
      sendText: async text => {
        await sendLoggedText(psid, text, reqId);
      },
      sendImage: async imageUrl => {
        await sendLoggedImage(psid, imageUrl, reqId);
      },
      sendActions: async (text, actions) => {
        await sendLoggedQuickReplies(
          psid,
          text,
          renderMessengerQuickReplies(actions),
          reqId
        );
      },
      setFlowState: async nextState => {
        await setFlowState(psid, nextState);
        if (userId !== psid) {
          await setFlowState(userId, nextState);
        }
      },
      clearImageContext: async () => {
        await clearPendingImageState(psid);
        if (userId !== psid) {
          await clearPendingImageState(userId);
        }
      },
      runImageGeneration: async (
        sourceImageUrl,
        promptHint,
        generationKind
      ) => {
        await runImageGeneration(
          psid,
          userId,
          reqId,
          lang,
          sourceImageUrl,
          promptHint,
          generationKind
        );
      },
      getRuntimeStats: () => getTodayRuntimeStats(),
      logger: createFeatureLogger(userId),
    };
  }

  async function claimEventReplayOrLog(
    event: FacebookWebhookEvent,
    entryId: string | undefined,
    userId: string
  ): Promise<boolean> {
    const dedupeKey = getEventDedupeKey(event, userId, entryId);
    if (!dedupeKey) {
      return true;
    }

    const claimed = await claimWebhookReplayKey(dedupeKey);
    if (claimed) {
      return true;
    }

    safeLog("webhook_replay_ignored", {
      user: toLogUser(userId),
      eventId: dedupeKey,
    });
    return false;
  }

  function logImageFlowDecision(input: {
    psid: string;
    userId: string;
    reqId: string;
    stage: string;
    hadPreviousPhoto: boolean;
    incomingImageUrl: string;
    action: "request_edit_prompt";
  }): void {
    safeLog("messenger_image_flow_decision", {
      reqId: input.reqId,
      user: toLogUser(input.userId),
      psidHash: anonymizePsid(input.psid).slice(0, 12),
      stage: input.stage,
      hadPreviousPhoto: input.hadPreviousPhoto,
      incomingImageHost: getAttachmentHostname(input.incomingImageUrl),
      action: input.action,
    });
  }

  async function sendPhotoReceivedPrompt(
    psid: string,
    lang: Lang,
    reqId: string
  ): Promise<MessengerSendOutcome> {
    const response = buildPhotoReceivedResponse(lang);
    return await sendLoggedQuickReplies(
      psid,
      response.text ?? "",
      renderMessengerQuickReplies(response.actions),
      reqId
    );
  }

  async function sendFaceMemoryConsentPrompt(
    psid: string,
    lang: Lang,
    reqId: string
  ): Promise<MessengerSendOutcome> {
    const response = buildFaceMemoryConsentResponse(lang);
    return await sendLoggedQuickReplies(
      psid,
      response.text ?? "",
      renderMessengerQuickReplies(response.actions),
      reqId
    );
  }

  return {
    defaultLang,
    claimEventReplayOrLog,
    createFeatureImageContext: (
      psid,
      userId,
      reqId,
      lang,
      state,
      imageUrl
    ) => ({
      ...createFeatureContextBase(psid, userId, reqId, lang, state),
      imageUrl,
    }),
    createFeaturePayloadContext: (
      psid,
      userId,
      reqId,
      lang,
      state,
      payload
    ) => ({
      ...createFeatureContextBase(psid, userId, reqId, lang, state),
      payload,
    }),
    createFeatureTextContext: (
      psid,
      userId,
      reqId,
      lang,
      state,
      messageText,
      normalizedText,
      hasPhoto
    ) => ({
      ...createFeatureContextBase(psid, userId, reqId, lang, state),
      messageText,
      normalizedText,
      hasPhoto,
    }),
    debugWebhookLog,
    getAttachmentHostname,
    logImageFlowDecision,
    logIncomingMessage,
    logUserState,
    maybeSendInFlightMessage,
    runImageGeneration,
    sendFaceMemoryConsentPrompt,
    sendFlowExplanation: (userPsid, userLang, requestId) =>
      sendLoggedText(userPsid, t(userLang, "flowExplanation"), requestId),
    sendLoggedImage,
    sendLoggedQuickReplies,
    sendLoggedText,
    sendPhotoReceivedPrompt,
  };
}

export function clearInFlightNotice(psid: string): void {
  inFlightNoticeSent.delete(psid);
}
