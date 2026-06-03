import type { MessengerSendOutcome } from "./messengerApi";
import { safeLog } from "./messengerApi";
import {
  inferConversationActions,
  inferNumberedConversationActions,
  stripNumberedConversationChoices,
} from "./conversationActionInference";
import { renderMessengerQuickReplies } from "./messengerActionRenderer";
import { setPendingConversationActions } from "./messengerState";
import { toLogUser, toUserKey } from "./privacy";
import type { HandlerContext } from "./webhookHandlerTypes";
import type {
  BotImageContext,
  BotPayloadContext,
  BotTextContext,
} from "./botContext";
import type { Lang } from "./i18n";

function logMessengerWebhookTrace(
  stage: "before_send" | "after_send",
  details: Record<string, unknown>
): void {
  safeLog("messenger_response_window_trace", { stage, ...details });
}

type FeatureContext = BotImageContext | BotPayloadContext | BotTextContext;

async function sendFeatureActions(
  trackedCtx: HandlerContext,
  input: {
    userPsid: string;
    requestId: string;
    text: string;
    actions: ReturnType<typeof inferNumberedConversationActions>;
  }
): Promise<void> {
  const outcome = await trackedCtx.sendLoggedQuickReplies(
    input.userPsid,
    input.text,
    renderMessengerQuickReplies(input.actions),
    input.requestId
  );
  await Promise.resolve(
    setPendingConversationActions(
      input.userPsid,
      input.actions,
      outcome?.sent ? outcome.messageId : undefined
    )
  );
}

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
      const inferredActions = inferConversationActions(text);
      if (inferredActions.length) {
        await sendFeatureActions(trackedCtx, {
          userPsid,
          requestId,
          text: stripNumberedConversationChoices(text),
          actions: inferredActions,
        });
        return;
      }

      await trackedCtx.sendLoggedText(userPsid, text, requestId);
    },
    sendImage: async imageUrl => {
      await trackedCtx.sendLoggedImage(userPsid, imageUrl, requestId);
    },
    sendActions: async (text, actions) => {
      await sendFeatureActions(trackedCtx, {
        userPsid,
        requestId,
        text,
        actions,
      });
    },
    clearImageContext: featureCtx.clearImageContext
      ? async () => {
          await featureCtx.clearImageContext?.();
        }
      : undefined,
    runImageGeneration: async (sourceImageUrl, promptHint, generationKind) => {
      await trackedCtx.runImageGeneration(
        userPsid,
        featureUserId,
        requestId,
        userLang,
        sourceImageUrl,
        promptHint,
        generationKind
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
    maybeSendInFlightMessage: async (userPsid, requestId) => {
      const result = await ctx.maybeSendInFlightMessage(userPsid, requestId);
      if (result.handled && "outcome" in result && result.outcome) {
        markResponseSentFromOutcome(result.outcome);
      }
      return result;
    },
    runImageGeneration: async (
      userPsid,
      featureUserId,
      requestId,
      userLang,
      sourceImageUrl,
      promptHint,
      generationKind
    ) => {
      const outcome = await ctx.runImageGeneration(
        userPsid,
        featureUserId,
        requestId,
        userLang,
        sourceImageUrl,
        promptHint,
        generationKind
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
      const outcome = await ctx.sendFlowExplanation(
        userPsid,
        userLang,
        requestId
      );
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
  };

  return trackedCtx;
}
