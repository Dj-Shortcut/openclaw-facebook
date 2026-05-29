import { handleSharedTextMessage } from "../sharedTextHandler";
import {
  getOrCreateState,
  markIntroSeen,
  setFlowState,
  type ConversationState,
} from "../messengerState";
import { resolveStateReplyPayload } from "../stateResponseText";
import { toLogUser } from "../privacy";
import { sendWhatsAppBotStateResponse } from "../whatsappResponseService";
import { DIRECTOR_GENERATION_STYLE } from "../image-generation/director/directorModes";
import {
  handleWhatsAppPayloadSelection,
  parseWhatsAppCategorySelection,
  parseWhatsAppDirectorSelection,
  parseWhatsAppStyleSelection,
  sendWhatsAppStyleCategoryPrompt,
  sendWhatsAppStyleOptions,
} from "../whatsappFlows/styleSelectionFlow";
import { runWhatsAppStyleGeneration } from "../whatsappFlows/styleGenerationFlow";
import type { NormalizedWhatsAppEvent, WhatsAppHandlerContext } from "../whatsappTypes";
import { runWhatsAppTextFeatures } from "./textContext";

export async function handleWhatsAppTextEvent(
  event: NormalizedWhatsAppEvent,
  context: WhatsAppHandlerContext
): Promise<void> {
  const state = await Promise.resolve(getOrCreateState(event.senderId));
  const textBody = event.textBody?.trim() ?? "";
  const normalizedText = textBody.toLowerCase();
  const selectedCategory = state.selectedStyleCategory ?? null;

  if (
    state.lastPhotoUrl &&
    (normalizedText === "nieuwe stijl" || normalizedText === "new style")
  ) {
    console.info("[whatsapp webhook] reopening style picker", {
      user: toLogUser(event.userId),
    });
    await setFlowState(event.senderId, "AWAITING_STYLE");
    await sendWhatsAppStyleCategoryPrompt(event.senderId, context.lang);
    return;
  }

  if (textBody) {
    const selectedPayload = resolveStateReplyPayload(
      state.stage,
      textBody,
      context.lang
    );
    if (
      selectedPayload &&
      (await handleWhatsAppPayloadSelection({
        payload: selectedPayload,
        senderId: event.senderId,
        userId: event.userId,
        reqId: context.reqId,
        lang: context.lang,
      }))
    ) {
      return;
    }

    const selectedDirectorMode = parseWhatsAppDirectorSelection(
      textBody,
      selectedCategory
    );
    if (selectedDirectorMode && state.lastPhotoUrl) {
      console.info("[whatsapp webhook] director mode selected", {
        user: toLogUser(event.userId),
        directorMode: selectedDirectorMode,
        selectedCategory,
        textBody,
      });
      await runWhatsAppStyleGeneration({
        senderId: event.senderId,
        userId: event.userId,
        style: DIRECTOR_GENERATION_STYLE,
        directorMode: selectedDirectorMode,
        reqId: context.reqId,
        lang: context.lang,
      });
      return;
    }

    const selectedStyle = parseWhatsAppStyleSelection(
      textBody,
      selectedCategory === "director" ? null : selectedCategory
    );
    if (selectedStyle && state.lastPhotoUrl) {
      console.info("[whatsapp webhook] style selected", {
        user: toLogUser(event.userId),
        style: selectedStyle,
        selectedCategory,
        textBody,
      });
      await runWhatsAppStyleGeneration({
        senderId: event.senderId,
        userId: event.userId,
        style: selectedStyle,
        reqId: context.reqId,
        lang: context.lang,
      });
      return;
    }

    const selectedStyleCategory = parseWhatsAppCategorySelection(textBody);
    if (selectedStyleCategory && state.lastPhotoUrl) {
      console.info("[whatsapp webhook] style category selected", {
        user: toLogUser(event.userId),
        category: selectedStyleCategory,
        textBody,
      });
      await sendWhatsAppStyleOptions(
        event.senderId,
        selectedStyleCategory,
        context.lang
      );
      return;
    }
  }

  const result = await handleSharedTextMessage({
    message: event,
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
      runWhatsAppTextFeatures(event, context, {
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
    result.replyState,
    context.lang
  );
  if (result.afterSend === "markIntroSeen") {
    await Promise.resolve(markIntroSeen(event.senderId));
  }
}
