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
import { buildImageUploadFailureResponse } from "./conversationActions";
import { getBotFeatures } from "./bot/features";
import { summarizeSensitiveUrl } from "./utils/urlSummarizer";
import { handleTextMessage } from "./webhookTextMessageRouter";
import { runScreenshotIntentContinuation } from "./screenshotIntentContinuation";
import {
  isExplicitSourceImageEditRequest,
  isImageGenerationRequest,
  isSourceImageTransformRequest,
  isScreenshotUploadCaption,
  isVisualCorrectionRequest,
} from "./imageIntent";
import {
  anonymizePsid,
  getOrCreateState,
  setPendingScreenshotIntentContinuation,
  setFlowState,
  setPendingStoredImage,
} from "./messengerState";
import {
  getAttachmentCategorySummary,
  isImageAttachment,
  type FacebookWebhookEvent,
} from "./webhookHelpers";
import type { HandlerContext } from "./webhookHandlerTypes";

type FacebookWebhookMessage = NonNullable<FacebookWebhookEvent["message"]>;

type ImageMessageInput = {
  psid: string;
  userId: string;
  reqId: string;
  lang: Lang;
  attachments: FacebookWebhookMessage["attachments"];
  text?: string;
  timestamp?: number;
};

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

  const shouldContinueScreenshotIntent = shouldContinueImageIntentAfterScreenshot({
    text: input.text,
    state,
    storedSourceImageUrl,
  });

  if (
    isScreenshotUploadCaption(input.text ?? "") &&
    !shouldContinueScreenshotIntent &&
    !shouldHandleImageCaptionAsConversation(input.text)
  ) {
    await setFlowState(input.psid, "AWAITING_EDIT_PROMPT");
    await ctx.sendLoggedText(
      input.psid,
      t(input.lang, "screenshotClarifyPrompt"),
      input.reqId
    );
    return true;
  }

  if (
    await promptForFaceMemoryConsent(
      ctx,
      input,
      state,
      imageDecision.action,
      storedSourceImageUrl,
      shouldContinueScreenshotIntent
    )
  ) {
    return true;
  }

  if (shouldContinueScreenshotIntent && state.lastPrompt) {
    await runScreenshotIntentContinuation(
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

function getInboundImageUrl(
  attachments: ImageMessageInput["attachments"]
): string | null {
  const imageAttachment = attachments?.find(
    att => isImageAttachment(att) && att.payload?.url
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
  const attachmentType = input.attachments?.find(
    att => isImageAttachment(att) && att.payload?.url === inboundImageUrl
  )?.type;
  const attachmentPayloadUrl = summarizeSensitiveUrl(inboundImageUrl);
  safeLog("messenger_image_message_parsed", {
    reqId: input.reqId,
    psidHash,
    attachmentType,
    attachmentHostname,
    attachmentPayloadUrl,
    attachmentCategories: getAttachmentCategorySummary(input.attachments),
    textLength: input.text?.trim().length ?? 0,
    hasCaptionText: Boolean(input.text?.trim()),
  });
  ctx.debugWebhookLog({
    level: "debug",
    msg: "photo_received",
    reqId: input.reqId,
    psidHash,
    hasAttachments: !!input.attachments,
    attachmentType,
    attachmentHostname,
    attachmentPayloadUrl,
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
  const state = await getOrCreateState(input.psid);
  const hasEditableImage = Boolean(
    state.lastPhotoUrl ??
      state.lastPhoto ??
      state.lastGeneratedUrl ??
      state.lastImageUrl
  );
  await setFlowState(
    input.psid,
    hasEditableImage ? "AWAITING_EDIT_PROMPT" : "AWAITING_PHOTO"
  );
  const response = buildImageUploadFailureResponse(input.lang, hasEditableImage);
  await ctx.sendLoggedActions(
    input.psid,
    response.text ?? "",
    response.actions ?? [],
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
