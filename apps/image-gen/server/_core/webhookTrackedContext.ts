import type { MessengerSendOutcome } from "./messengerApi";
import { safeLog } from "./messengerApi";
import { toLogUser, toUserKey } from "./privacy";
import type { HandlerContext } from "./webhookHandlers";
import type { BotImageContext, BotPayloadContext, BotTextContext } from "./botContext";
import type { Lang } from "./i18n";

function logMessengerWebhookTrace(
  stage: "before_send" | "after_send",
  details: Record<string, unknown>
): void {
  safeLog("messenger_response_window_trace", { stage, ...details });
}

type FeatureContext = BotImageContext | BotPayloadContext | BotTextContext;

function decorateFeatureContext<TContext extends FeatureContext>(
  featureCtx: TContext,
  trackedCtx: HandlerContext,
  userPsid: string,
  featureUserId: string,
  requestId: string,
  userLang: Lang
): TContext {
  return {
    ...featureCtx,
    sendText: async text => {
      await trackedCtx.sendLoggedText(userPsid, text, requestId);
    },
    sendImage: async imageUrl => {
      await trackedCtx.sendLoggedImage(userPsid, imageUrl, requestId);
    },
    sendQuickReplies: async (text, replies) => {
      await trackedCtx.sendLoggedQuickReplies(userPsid, text, replies, requestId);
    },
    sendStateQuickReplies: async (nextState, text) => {
      await trackedCtx.sendStateQuickReplies(
        userPsid,
        nextState,
        text,
        requestId
      );
    },
    chooseStyle: async style => {
      await trackedCtx.handleStyleSelection(
        userPsid,
        featureUserId,
        style,
        requestId,
        userLang
      );
    },
    runStyleGeneration: async (style, sourceImageUrl, promptHint, directorMode) => {
      await trackedCtx.runStyleGeneration(
        userPsid,
        featureUserId,
        style,
        requestId,
        userLang,
        sourceImageUrl,
        promptHint,
        directorMode
      );
    },
  };
}

export function createTrackedHandlerContext(
  ctx: HandlerContext,
  markResponseSentFromOutcome: (
    outcome: MessengerSendOutcome | undefined
  ) => void
): HandlerContext {
  const trackedCtx: HandlerContext = {
    ...ctx,
    createFeatureImageContext: (
      userPsid,
      featureUserId,
      requestId,
      userLang,
      featureState,
      imageUrl
    ) => {
      const featureCtx = ctx.createFeatureImageContext(
        userPsid,
        featureUserId,
        requestId,
        userLang,
        featureState,
        imageUrl
      );
      return decorateFeatureContext(
        featureCtx,
        trackedCtx,
        userPsid,
        featureUserId,
        requestId,
        userLang
      );
    },
    createFeaturePayloadContext: (
      userPsid,
      featureUserId,
      requestId,
      userLang,
      featureState,
      payload
    ) => {
      const featureCtx = ctx.createFeaturePayloadContext(
        userPsid,
        featureUserId,
        requestId,
        userLang,
        featureState,
        payload
      );
      return decorateFeatureContext(
        featureCtx,
        trackedCtx,
        userPsid,
        featureUserId,
        requestId,
        userLang
      );
    },
    createFeatureTextContext: (
      userPsid,
      featureUserId,
      requestId,
      userLang,
      featureState,
      messageText,
      normalizedText,
      hasPhoto
    ) => {
      const featureCtx = ctx.createFeatureTextContext(
        userPsid,
        featureUserId,
        requestId,
        userLang,
        featureState,
        messageText,
        normalizedText,
        hasPhoto
      );
      return decorateFeatureContext(
        featureCtx,
        trackedCtx,
        userPsid,
        featureUserId,
        requestId,
        userLang
      );
    },
    handleStyleSelection: async (
      userPsid,
      featureUserId,
      style,
      requestId,
      userLang
    ) => {
      const outcome = await ctx.handleStyleSelection(
        userPsid,
        featureUserId,
        style,
        requestId,
        userLang
      );
      markResponseSentFromOutcome(outcome);
      return outcome;
    },
    maybeSendInFlightMessage: async (userPsid, requestId) => {
      const result = await ctx.maybeSendInFlightMessage(userPsid, requestId);
      if (result.handled && "outcome" in result && result.outcome) {
        markResponseSentFromOutcome(result.outcome);
      }
      return result;
    },
    runStyleGeneration: async (
      userPsid,
      featureUserId,
      style,
      requestId,
      userLang,
      sourceImageUrl,
      promptHint,
      directorMode
    ) => {
      const outcome = await ctx.runStyleGeneration(
        userPsid,
        featureUserId,
        style,
        requestId,
        userLang,
        sourceImageUrl,
        promptHint,
        directorMode
      );
      markResponseSentFromOutcome(outcome);
      return outcome;
    },
    sendLoggedText: async (userPsid, text, requestId) => {
      logMessengerWebhookTrace("before_send", {
        reqId: requestId,
        user: toLogUser(toUserKey(userPsid)),
        kind: "text",
      });
      const outcome = await ctx.sendLoggedText(userPsid, text, requestId);
      markResponseSentFromOutcome(outcome);
      logMessengerWebhookTrace("after_send", {
        reqId: requestId,
        user: toLogUser(toUserKey(userPsid)),
        kind: "text",
        sent: outcome?.sent ?? false,
        ...(outcome && !outcome.sent ? { reason: outcome.reason } : {}),
      });
      return outcome;
    },
    sendLoggedQuickReplies: async (userPsid, text, replies, requestId) => {
      logMessengerWebhookTrace("before_send", {
        reqId: requestId,
        user: toLogUser(toUserKey(userPsid)),
        kind: "quick_replies",
      });
      const outcome = await ctx.sendLoggedQuickReplies(
        userPsid,
        text,
        replies,
        requestId
      );
      markResponseSentFromOutcome(outcome);
      logMessengerWebhookTrace("after_send", {
        reqId: requestId,
        user: toLogUser(toUserKey(userPsid)),
        kind: "quick_replies",
        sent: outcome?.sent ?? false,
        ...(outcome && !outcome.sent ? { reason: outcome.reason } : {}),
      });
      return outcome;
    },
    sendLoggedImage: async (userPsid, imageUrl, requestId) => {
      logMessengerWebhookTrace("before_send", {
        reqId: requestId,
        user: toLogUser(toUserKey(userPsid)),
        kind: "image",
      });
      const outcome = await ctx.sendLoggedImage(userPsid, imageUrl, requestId);
      markResponseSentFromOutcome(outcome);
      logMessengerWebhookTrace("after_send", {
        reqId: requestId,
        user: toLogUser(toUserKey(userPsid)),
        kind: "image",
        sent: outcome?.sent ?? false,
        ...(outcome && !outcome.sent ? { reason: outcome.reason } : {}),
      });
      return outcome;
    },
    sendStateQuickReplies: async (userPsid, stateName, text, requestId) => {
      logMessengerWebhookTrace("before_send", {
        reqId: requestId,
        user: toLogUser(toUserKey(userPsid)),
        kind: "state_quick_replies",
        state: stateName,
      });
      const outcome = await ctx.sendStateQuickReplies(
        userPsid,
        stateName,
        text,
        requestId
      );
      markResponseSentFromOutcome(outcome);
      logMessengerWebhookTrace("after_send", {
        reqId: requestId,
        user: toLogUser(toUserKey(userPsid)),
        kind: "state_quick_replies",
        state: stateName,
        sent: outcome?.sent ?? false,
        ...(outcome && !outcome.sent ? { reason: outcome.reason } : {}),
      });
      return outcome;
    },
    sendFaceMemoryConsentPrompt: async (userPsid, userLang, requestId) => {
      const outcome = await ctx.sendFaceMemoryConsentPrompt(
        userPsid,
        userLang,
        requestId
      );
      markResponseSentFromOutcome(outcome);
      return outcome;
    },
    sendFlowExplanation: async (userPsid, userLang, requestId) => {
      const outcome = await ctx.sendFlowExplanation(userPsid, userLang, requestId);
      markResponseSentFromOutcome(outcome);
      return outcome;
    },
    sendPhotoReceivedPrompt: async (userPsid, userLang, requestId) => {
      const outcome = await ctx.sendPhotoReceivedPrompt(
        userPsid,
        userLang,
        requestId
      );
      markResponseSentFromOutcome(outcome);
      return outcome;
    },
    sendPrivacyInfo: async (userPsid, userLang, requestId) => {
      const outcome = await ctx.sendPrivacyInfo(userPsid, userLang, requestId);
      markResponseSentFromOutcome(outcome);
      return outcome;
    },
    sendStyleOptionsForCategory: async (userPsid, category, userLang, requestId) => {
      const outcome = await ctx.sendStyleOptionsForCategory(
        userPsid,
        category,
        userLang,
        requestId
      );
      markResponseSentFromOutcome(outcome);
      return outcome;
    },
    sendStylePicker: async (userPsid, userLang, requestId) => {
      const outcome = await ctx.sendStylePicker(userPsid, userLang, requestId);
      markResponseSentFromOutcome(outcome);
      return outcome;
    },
  };

  return trackedCtx;
}
