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
import {
  anonymizePsid,
  clearPendingImageState,
  getOrCreateState,
  markIntroSeen,
  setChosenStyle,
  setFlowState,
  setPendingStoredImage,
  setPreselectedStyle,
} from "./messengerState";
import { toLogUser } from "./privacy";
import { type FacebookWebhookEvent } from "./webhookHelpers";
import { handlePayload } from "./webhookPayloadBranch";
import type { HandlerContext } from "./webhookHandlers";

type FacebookWebhookMessage = NonNullable<FacebookWebhookEvent["message"]>;

type MessageEventInput = {
  psid: string;
  userId: string;
  event: FacebookWebhookEvent;
  reqId: string;
  lang: Lang;
};

type ImageMessageInput = {
  psid: string;
  userId: string;
  reqId: string;
  lang: Lang;
  attachments: FacebookWebhookMessage["attachments"];
};

type TextMessageInput = {
  psid: string;
  userId: string;
  reqId: string;
  lang: Lang;
  text: string;
  timestamp?: number;
};

export async function handleMessageEvent(
  ctx: HandlerContext,
  input: MessageEventInput
): Promise<void> {
  const message = input.event.message;
  if (!message || message.is_echo) return;

  if ((await ctx.maybeSendInFlightMessage(input.psid, input.reqId)).handled) {
    return;
  }

  const quickPayload = message.quick_reply?.payload;
  if (quickPayload) {
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
    timestamp: input.event.timestamp ?? Date.now(),
  });
}

async function tryHandleImageMessage(
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
  if (
    await promptForFaceMemoryConsent(
      ctx,
      input,
      state,
      imageDecision.action,
      storedSourceImageUrl
    )
  ) {
    return true;
  }

  logImageDecision(ctx, input, state, imageDecision);
  return await handleImageDecision(ctx, input, imageDecision);
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
  console.info(
    JSON.stringify({
      level: "info",
      msg: "messenger_image_message_parsed",
      reqId: input.reqId,
      psidHash,
      attachmentHostname,
    })
  );
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
    selectedStyle: state.selectedStyle,
    preselectedStyle: state.preselectedStyle,
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
  storedSourceImageUrl: string
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

  if (imageAction === "show_style_picker") {
    await setPreselectedStyle(input.psid, null);
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
    selectedStyle: state.selectedStyle,
    preselectedStyle: imageDecision.styleToRun,
    action: imageDecision.action,
  });
}

async function handleImageDecision(
  ctx: HandlerContext,
  input: ImageMessageInput,
  imageDecision: ReturnType<typeof getStoredMessengerImageDecision>
): Promise<boolean> {
  if (imageDecision.action === "show_style_picker") {
    await setFlowState(input.psid, "AWAITING_STYLE");
    await ctx.sendPhotoReceivedPrompt(input.psid, input.lang, input.reqId);
    return true;
  }

  await setPreselectedStyle(input.psid, null);
  await setChosenStyle(input.psid, imageDecision.styleToRun);
  await ctx.runStyleGeneration(
    input.psid,
    input.userId,
    imageDecision.styleToRun,
    input.reqId,
    input.lang
  );
  return true;
}

async function handleTextMessage(
  ctx: HandlerContext,
  input: TextMessageInput
): Promise<void> {
  const normalizedMessage = createNormalizedTextMessage(input);
  logNormalizedTextHandoff(input, normalizedMessage);

  const result = await handleSharedMessengerText(ctx, input, normalizedMessage);
  await sendSharedMessengerTextResponse(ctx, input, result);
  await applyTextAfterSend(result, input);
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
  console.log("[messenger webhook] normalized event handoff", {
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
    sendStateText: async (stateName, text) => {
      await ctx.sendStateQuickReplies(input.psid, stateName, text, input.reqId);
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
