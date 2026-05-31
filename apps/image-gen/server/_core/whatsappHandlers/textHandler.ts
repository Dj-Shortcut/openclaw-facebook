import { handleSharedTextMessage } from "../sharedTextHandler";
import {
  getOrCreateState,
  markIntroSeen,
  setPendingConversationActions,
  setFlowState,
  type ConversationState,
} from "../messengerState";
import { resolveConversationActionInput } from "../conversationActionSelection";
import { toLogUser } from "../privacy";
import { sendWhatsAppBotStateResponse } from "../whatsappResponseService";
import type { NormalizedWhatsAppEvent, WhatsAppHandlerContext } from "../whatsappTypes";
import { runWhatsAppTextFeatures } from "./textContext";

export async function handleWhatsAppTextEvent(
  event: NormalizedWhatsAppEvent,
  context: WhatsAppHandlerContext
): Promise<void> {
  const state = await Promise.resolve(getOrCreateState(event.senderId));
  let textBody = event.textBody?.trim() ?? "";
  let normalizedText = textBody.toLowerCase();
  let sharedEvent = event;

  const selectedActionInput = resolveConversationActionInput(
    normalizedText,
    state.pendingConversationActions
  );
  if (selectedActionInput) {
    await Promise.resolve(setPendingConversationActions(event.senderId, undefined));
    textBody = selectedActionInput;
    normalizedText = textBody.toLowerCase();
    sharedEvent = {
      ...event,
      messageType: "text",
      textBody,
    };
  }

  const result = await handleSharedTextMessage({
    message: sharedEvent,
    reqId: context.reqId,
    lang: context.lang,
    getState: () => Promise.resolve(getOrCreateState(event.senderId)),
    setFlowState: (nextState: ConversationState) =>
      Promise.resolve(setFlowState(event.senderId, nextState)),
    runTextFeatures: async ({
      state: currentState,
      messageText,
      normalizedText: currentNormalizedText,
      hasPhoto,
    }) =>
      runWhatsAppTextFeatures(sharedEvent, context, {
        state: currentState,
        messageText,
        normalizedText: currentNormalizedText,
        hasPhoto,
      }),
    logState: (currentState, logContext) => {
      console.log("[whatsapp webhook] shared state", {
        context: logContext,
        user: toLogUser(event.userId),
        stage: currentState.stage,
        hasPhoto: Boolean(currentState.lastPhotoUrl),
      });
    },
  });

  await sendWhatsAppBotStateResponse(
    event.senderId,
    result.response,
    result.replyState
  );
  if (result.afterSend === "markIntroSeen") {
    await Promise.resolve(markIntroSeen(event.senderId));
  }
}
