import { safeLog } from "./messengerApi";
import {
  isFaceMemoryEnabled,
  updateConsentedFaceMemorySource,
} from "./faceMemory";
import { t, type Lang } from "./i18n";
import {
  getStoredMessengerImageDecision,
  normalizeMessengerInboundImage,
} from "./messengerImageIngress";
import { getBotFeatures } from "./bot/features";
import { handleSharedTextMessage } from "./sharedTextHandler";
import type { NormalizedInboundMessage } from "./normalizedInboundMessage";
import { sendMessengerBotResponse } from "./botResponseAdapters";
import { decodeMessengerActionInput } from "./messengerActionPayload";
import { resolveConversationActionInput } from "./conversationActionSelection";
import {
  isExplicitSourceImageEditRequest,
  isImageGenerationRequest,
  isSourceImageTransformRequest,
  isScreenshotUploadCaption,
  isVisualCorrectionRequest,
} from "./imageIntent";
import {
  anonymizePsid,
  clearPendingImageState,
  getPendingConversationActionsForMessage,
  getOrCreateState,
  markIntroSeen,
  setPendingScreenshotIntentContinuation,
  setFlowState,
  setPendingConversationActions,
  setPendingStoredImage,
} from "./messengerState";
import { toLogUser } from "./privacy";
import { type FacebookWebhookEvent } from "./webhookHelpers";
import { handlePayload } from "./webhookPayloadBranch";
import type { HandlerContext } from "./webhookHandlerTypes";

type FacebookWebhookMessage = NonNullable<FacebookWebhookEvent["message"]>;

export type MessageEventInput = {
  psid: string;
  userId: string;
  event: FacebookWebhookEvent;
  reqId: string;
  lang: Lang;
};

export type ImageMessageInput = {
  psid: string;
  userId: string;
  reqId: string;
  lang: Lang;
  attachments: FacebookWebhookMessage["attachments"];
  text?: string;
  timestamp?: number;
};

export type TextMessageInput = {
  psid: string;
  userId: string;
  reqId: string;
  lang: Lang;
  text: string;
  replyToMessageId?: string;
  timestamp?: number;
};

/** Handles a non-echo Messenger message event and dispatches payload, image, or text flows. */
export async function handleMessageEvent(
  ctx: HandlerContext,
  input: MessageEventInput
): Promise<void> {
  const message = input.event.message;
  if (!message || message.is_echo) return;

  if (
    (await ctx.maybeSendInFlightMessage(input.psid, input.reqId, input.lang))
      .handled
  ) {
    return;
  }

  const quickPayload = message.quick_reply?.payload;
  if (quickPayload) {
    const actionInput = decodeMessengerActionInput(quickPayload);
    if (actionInput) {
      await handleTextMessage(ctx, {
        psid: input.psid,
        userId: input.userId,
        reqId: input.reqId,
        lang: input.lang,
        text: actionInput,
        replyToMessageId: message.reply_to?.mid,
        timestamp: input.event.timestamp ?? Date.now(),
      });
      return;
    }

    await handlePayload(ctx, {
      psid: input.psid,
      userId: input.userId,
      payload: quickPayload,
      reqId: input.reqId,
      lang: input.lang,
    });
    return;
  }

  if (
    await tryHandleImageMessage(ctx, {
      psid: input.psid,
      userId: input.userId,
      reqId: input.reqId,
      lang: input.lang,
      attachments: message.attachments,
      text: message.text,
      timestamp: input.event.timestamp ?? Date.now(),
    })
  ) {
    return;
  }

  const text = message.text;
  const trimmedText = text?.trim();
  if (!trimmedText) {
    return;
  }

  await handleTextMessage(ctx, {
    psid: input.psid,
    userId: input.userId,
    reqId: input.reqId,
    lang: input.lang,
    text: trimmedText,
    replyToMessageId: message.reply_to?.mid,
    timestamp: input.event.timestamp ?? Date.now(),
  });
}

/** Attempts to persist and route an inbound Messenger image attachment. */
export async function tryHandleImageMessage(
  ctx: HandlerContext,
  input: ImageMessageInput
): Promise<boolean> {
  const inboundImageUrl = getInboundImageUrl(input.attachments);
  if (!inboundImageUrl) {
    return false;
  }

  logParsedImageMessage(ctx, input, inboundImageUrl);
  const storedSourceImageUrl = await persistInboundImage(
    input,
    inboundImageUrl
  );
  if (!storedSourceImageUrl) {
    await handleMissingStoredImage(ctx, input);
    return true;
  }

  const state = await getOrCreateState(input.psid);
  if (await runImageFeatures(ctx, input, state, storedSourceImageUrl)) {
    return true;
  }

  const imageDecision = await prepareStoredImageDecision(
    ctx,
    input,
    state,
    storedSourceImageUrl
  );
  await setPendingScreenshotIntentContinuation(input.psid, false);

  if (
    await promptForFaceMemoryConsent(
      ctx,
      input,
      state,
      imageDecision.action,
      storedSourceImageUrl,
      shouldContinueImageIntentAfterScreenshot({
        text: input.text,
        state,
        storedSourceImageUrl,
      })
    )
  ) {
    return true;
  }

  if (
    shouldContinueImageIntentAfterScreenshot({
      text: input.text,
      state,
      storedSourceImageUrl,
    })
  ) {
    await handleScreenshotIntentContinuation(
      ctx,
      input,
      storedSourceImageUrl,
      state.lastPrompt
    );
    return true;
  }

  if (shouldHandleImageCaptionAsConversation(input.text)) {
    await handleTextMessage(ctx, {
      psid: input.psid,
      userId: input.userId,
      reqId: input.reqId,
      lang: input.lang,
      text: input.text.trim(),
      timestamp: input.timestamp,
    });
    return true;
  }

  if (isScreenshotUploadCaption(input.text ?? "")) {
    await ctx.sendLoggedText(
      input.psid,
      t(input.lang, "screenshotClarifyPrompt"),
      input.reqId
    );
    return true;
  }

  logImageDecision(ctx, input, state, imageDecision);
  return await handleImageDecision(ctx, input, imageDecision);
}

function shouldHandleImageCaptionAsConversation(
  text: string | undefined
): text is string {
  const caption = text?.trim();
  if (!caption) {
    return false;
  }

  return (
    isImageGenerationRequest(caption) ||
    isExplicitSourceImageEditRequest(caption) ||
    isSourceImageTransformRequest(caption) ||
    isVisualCorrectionRequest(caption)
  );
}

type ScreenshotIntentContinuationInput = {
  text?: string;
  state: Awaited<ReturnType<typeof getOrCreateState>>;
  storedSourceImageUrl: string;
};

function shouldContinueImageIntentAfterScreenshot(
  input: ScreenshotIntentContinuationInput
): boolean {
  if (!input.text) {
    return false;
  }

  if (!isScreenshotUploadCaption(input.text)) {
    return false;
  }

  if (shouldHandleImageCaptionAsConversation(input.text)) {
    return false;
  }

  if (!input.state.lastPrompt) {
    return false;
  }

  return input.state.stage === "AWAITING_EDIT_PROMPT";
}

async function handleScreenshotIntentContinuation(
  ctx: HandlerContext,
  input: ImageMessageInput,
  sourceImageUrl: string,
  priorPrompt?: string
): Promise<void> {
  if (!priorPrompt) {
    return;
  }

  await ctx.sendLoggedText(
    input.psid,
    t(input.lang, "screenshotIntentContinuation"),
    input.reqId
  );
  await ctx.runImageGeneration(
    input.psid,
    input.userId,
    input.reqId,
    input.lang,
    sourceImageUrl,
    priorPrompt,
    "source_image_edit"
  );
}

function getInboundImageUrl(
  attachments: ImageMessageInput["attachments"]
): string | null {
  const imageAttachment = attachments?.find(
    att => att.type === "image" && att.payload?.url
  );
  return imageAttachment?.payload?.url ?? null;
}

function logParsedImageMessage(
  ctx: HandlerContext,
  input: ImageMessageInput,
  inboundImageUrl: string
): void {
  const psidHash = anonymizePsid(input.psid).slice(0, 12);
  const attachmentHostname = ctx.getAttachmentHostname(inboundImageUrl);
  safeLog("messenger_image_message_parsed", {
    reqId: input.reqId,
    psidHash,
    attachmentHostname,
  });
  ctx.debugWebhookLog({
    level: "debug",
    msg: "photo_received",
    reqId: input.reqId,
    psidHash,
    hasAttachments: !!input.attachments,
    attachmentHostname,
  });
}

async function persistInboundImage(
  input: ImageMessageInput,
  inboundImageUrl: string
): Promise<string | null> {
  return await normalizeMessengerInboundImage({
    inboundImageUrl,
    psidHash: anonymizePsid(input.psid).slice(0, 12),
    reqId: input.reqId,
  });
}

async function handleMissingStoredImage(
  ctx: HandlerContext,
  input: ImageMessageInput
): Promise<void> {
  await clearPendingImageState(input.psid);
  await setFlowState(input.psid, "AWAITING_PHOTO");
  await ctx.sendLoggedText(
    input.psid,
    t(input.lang, "missingInputImage"),
    input.reqId
  );
}

async function runImageFeatures(
  ctx: HandlerContext,
  input: ImageMessageInput,
  state: Awaited<ReturnType<typeof getOrCreateState>>,
  storedSourceImageUrl: string
): Promise<boolean> {
  for (const feature of getBotFeatures()) {
    const result = await feature.onImage?.(
      ctx.createFeatureImageContext(
        input.psid,
        input.userId,
        input.reqId,
        input.lang,
        state,
        storedSourceImageUrl
      )
    );
    if (result?.handled) {
      return true;
    }
  }

  return false;
}

async function prepareStoredImageDecision(
  ctx: HandlerContext,
  input: ImageMessageInput,
  state: Awaited<ReturnType<typeof getOrCreateState>>,
  storedSourceImageUrl: string
) {
  ctx.logUserState(
    input.psid,
    input.userId,
    state,
    input.reqId,
    "image_received"
  );
  const imageDecision = getStoredMessengerImageDecision({
    lastPhotoUrl: state.lastPhotoUrl,
    storedSourceImageUrl,
  });
  await setPendingStoredImage(input.psid, storedSourceImageUrl);
  return imageDecision;
}

async function promptForFaceMemoryConsent(
  ctx: HandlerContext,
  input: ImageMessageInput,
  state: Awaited<ReturnType<typeof getOrCreateState>>,
  imageAction: ReturnType<typeof getStoredMessengerImageDecision>["action"],
  storedSourceImageUrl: string,
  shouldContinueScreenshotIntent = false
): Promise<boolean> {
  if (!isFaceMemoryEnabled()) {
    return false;
  }

  if (state.faceMemoryConsent?.given) {
    await updateConsentedFaceMemorySource(input.psid, storedSourceImageUrl);
    return false;
  }

  if (state.faceMemoryConsent) {
    return false;
  }

  if (shouldContinueScreenshotIntent) {
    await setPendingScreenshotIntentContinuation(input.psid, true);
  }

  await ctx.sendFaceMemoryConsentPrompt(input.psid, input.lang, input.reqId);
  return true;
}

function logImageDecision(
  ctx: HandlerContext,
  input: ImageMessageInput,
  state: Awaited<ReturnType<typeof getOrCreateState>>,
  imageDecision: ReturnType<typeof getStoredMessengerImageDecision>
): void {
  ctx.logImageFlowDecision({
    psid: input.psid,
    userId: input.userId,
    reqId: input.reqId,
    stage: state.stage,
    hadPreviousPhoto: imageDecision.hadPreviousPhoto,
    incomingImageUrl: imageDecision.incomingImageUrl,
    action: imageDecision.action,
  });
}

async function handleImageDecision(
  ctx: HandlerContext,
  input: ImageMessageInput,
  imageDecision: ReturnType<typeof getStoredMessengerImageDecision>
): Promise<boolean> {
  if (imageDecision.action === "request_edit_prompt") {
    await setFlowState(input.psid, "AWAITING_EDIT_PROMPT");
    await ctx.sendPhotoReceivedPrompt(input.psid, input.lang, input.reqId);
    return true;
  }

  return false;
}

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
