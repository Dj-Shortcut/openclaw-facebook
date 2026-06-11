import { sendMessengerBotResponse } from "./botResponseAdapters";
import { getBotFeatures } from "./bot/features";
import { t, type Lang } from "./i18n";
import type { NormalizedInboundMessage } from "./normalizedInboundMessage";
import { resolveConversationActionInput } from "./conversationActionSelection";
import { safeLog } from "./messengerApi";
import {
  getOrCreateState,
  getPendingConversationActionsForMessage,
  markIntroSeen,
  setFlowState,
  setPendingConversationActions,
} from "./messengerState";
import { toLogUser } from "./privacy";
import { handleSharedTextMessage } from "./sharedTextHandler";
import { isMessengerVideoGenerationEnabled } from "./video-generation/videoConfig";
import type { HandlerContext } from "./webhookHandlerTypes";

type TextMessageInput = {
  psid: string;
  userId: string;
  reqId: string;
  lang: Lang;
  text: string;
  replyToMessageId?: string;
  timestamp?: number;
};

/** Normalizes and routes Messenger text through the shared conversation layer. */
export async function handleTextMessage(
  ctx: HandlerContext,
  input: TextMessageInput
): Promise<void> {
  const resolvedInput = await resolvePendingActionText(input);
  const normalizedMessage = createNormalizedTextMessage(resolvedInput);
  logNormalizedTextHandoff(input, normalizedMessage);

  const result = await handleSharedMessengerText(
    ctx,
    resolvedInput,
    normalizedMessage
  );
  await sendSharedMessengerTextResponse(ctx, resolvedInput, result);
  await applyTextAfterSend(result, resolvedInput);
}

async function resolvePendingActionText(
  input: TextMessageInput
): Promise<TextMessageInput> {
  const state = await getOrCreateState(input.psid);
  const replyActions = getPendingConversationActionsForMessage(
    state,
    input.replyToMessageId
  );
  const actionInput = resolveConversationActionInput(
    input.text,
    replyActions ?? state.pendingConversationActions
  );
  if (!actionInput) {
    return input;
  }

  await Promise.resolve(setPendingConversationActions(input.psid, undefined));
  return {
    ...input,
    text: actionInput,
  };
}

function createNormalizedTextMessage(
  input: TextMessageInput
): NormalizedInboundMessage {
  return {
    channel: "messenger",
    senderId: input.psid,
    userId: input.userId,
    messageType: "text",
    textBody: input.text,
    timestamp: input.timestamp ?? Date.now(),
  };
}

function logNormalizedTextHandoff(
  input: TextMessageInput,
  normalizedMessage: NormalizedInboundMessage
): void {
  safeLog("messenger_normalized_event_handoff", {
    channel: normalizedMessage.channel,
    reqId: input.reqId,
    user: toLogUser(input.userId),
    messageType: normalizedMessage.messageType,
  });
}

async function handleSharedMessengerText(
  ctx: HandlerContext,
  input: TextMessageInput,
  normalizedMessage: NormalizedInboundMessage
) {
  return await handleSharedTextMessage({
    message: normalizedMessage,
    reqId: input.reqId,
    lang: input.lang,
    getState: () => Promise.resolve(getOrCreateState(input.psid)),
    setFlowState: nextState =>
      Promise.resolve(setFlowState(input.psid, nextState)),
    runTextFeatures: async ({
      state,
      messageText,
      normalizedText,
      hasPhoto,
    }) => {
      for (const feature of getBotFeatures()) {
        const result = await feature.onText?.(
          ctx.createFeatureTextContext(
            input.psid,
            input.userId,
            input.reqId,
            input.lang,
            state,
            messageText,
            normalizedText,
            hasPhoto
          )
        );
        if (result?.handled) {
          return true;
        }
      }

      return false;
    },
    runVideoAnimationIntent: async ({ state, messageText, hasPhoto }) => {
      if (!isMessengerVideoGenerationEnabled()) {
        return false;
      }

      if (!hasPhoto) {
        await ctx.sendLoggedText(
          input.psid,
          t(input.lang, "videoGenerationRequiresPhoto"),
          input.reqId
        );
        return true;
      }

      const sourceImageUrl =
        state.lastPhotoUrl ??
        state.lastPhoto ??
        state.lastGeneratedUrl ??
        state.lastImageUrl;
      if (!sourceImageUrl || !ctx.runVideoGeneration) {
        await ctx.sendLoggedText(
          input.psid,
          t(input.lang, "videoGenerationUnavailable"),
          input.reqId
        );
        return true;
      }

      await ctx.sendLoggedText(
        input.psid,
        t(input.lang, "videoGenerationQueued"),
        input.reqId
      );
      setTimeout(() => {
        void ctx.runVideoGeneration?.(
          input.psid,
          input.userId,
          input.reqId,
          input.lang,
          sourceImageUrl,
          messageText
        ).catch(error => {
          safeLog("messenger_video_generation_background_failed", {
            level: "error",
            reqId: input.reqId,
            errorCode: error instanceof Error ? error.name : "UnknownError",
          });
        });
      }, 0);
      return true;
    },
    logState: (state, context) => {
      ctx.logUserState(input.psid, input.userId, state, input.reqId, context);
    },
    logAckIgnored: ack => {
      safeLog("ack_ignored", { ack });
    },
  });
}

async function sendSharedMessengerTextResponse(
  ctx: HandlerContext,
  input: TextMessageInput,
  result: Awaited<ReturnType<typeof handleSharedMessengerText>>
): Promise<void> {
  await sendMessengerBotResponse(result.response, {
    replyState: result.replyState,
    sendText: async text => {
      await ctx.sendLoggedText(input.psid, text, input.reqId);
    },
    sendActionPrompt: async (text, actions) => {
      const outcome = await ctx.sendLoggedActions(
        input.psid,
        text,
        actions,
        input.reqId
      );
      await Promise.resolve(
        setPendingConversationActions(
          input.psid,
          actions,
          outcome?.sent ? outcome.messageId : undefined
        )
      );
    },
  });
}

async function applyTextAfterSend(
  result: Awaited<ReturnType<typeof handleSharedMessengerText>>,
  input: TextMessageInput
): Promise<void> {
  if (result.afterSend === "markIntroSeen") {
    await Promise.resolve(markIntroSeen(input.psid));
  }
}
