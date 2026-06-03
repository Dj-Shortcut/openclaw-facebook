import {
  declineFaceMemory,
  getOrCreateState,
  clearPendingScreenshotIntentContinuation,
  rememberFaceSourceImage,
  setFaceMemoryConsentGiven,
  setFlowState,
} from "./messengerState";
import {
  FACE_MEMORY_CONSENT_NO,
  FACE_MEMORY_CONSENT_YES,
  isFaceMemoryEnabled,
} from "./faceMemory";
import { getBotFeatures } from "./bot/features";
import { handleMessengerPayload } from "./messengerPayloadRouting";
import { buildQuickStartResponse } from "./conversationActions";
import { safeLog } from "./messengerApi";
import { t } from "./i18n";
import { toLogUser } from "./privacy";
import { type FacebookWebhookEvent } from "./webhookHelpers";
import type { HandlerContext } from "./webhookHandlerTypes";
import type { Lang } from "./i18n";

type PostbackEventInput = {
  psid: string;
  userId: string;
  event: FacebookWebhookEvent;
  reqId: string;
  lang: Lang;
};

type PayloadFlowInput = {
  psid: string;
  userId: string;
  payload: string;
  reqId: string;
  lang: Lang;
};

async function continueAfterFaceMemoryChoice(
  ctx: HandlerContext,
  input: PayloadFlowInput
): Promise<void> {
  const state = await getOrCreateState(input.psid);
  if (state.pendingScreenshotIntentContinuation) {
    const sourceImageUrl = state.pendingImageUrl ?? state.lastPhotoUrl;
    const priorPrompt = state.lastPrompt;
    await clearPendingScreenshotIntentContinuation(input.psid);
    await setFlowState(input.psid, "AWAITING_EDIT_PROMPT");
    if (sourceImageUrl && priorPrompt) {
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
      return;
    }
  }

  await setFlowState(input.psid, "AWAITING_EDIT_PROMPT");
  await ctx.sendPhotoReceivedPrompt(input.psid, input.lang, input.reqId);
}

async function handleDisabledFaceMemoryPayload(
  ctx: HandlerContext,
  input: PayloadFlowInput
): Promise<void> {
  const state = await getOrCreateState(input.psid);
  if (state.pendingImageUrl ?? state.lastPhotoUrl) {
    await continueAfterFaceMemoryChoice(ctx, input);
    return;
  }

  await setFlowState(input.psid, "IDLE");
  const response = buildQuickStartResponse(input.lang);
  await ctx.sendLoggedActions(
    input.psid,
    response.text ?? "",
    response.actions ?? [],
    input.reqId
  );
}

export async function handlePostbackEvent(
  ctx: HandlerContext,
  input: PostbackEventInput
): Promise<boolean> {
  if (input.event.postback?.payload) {
    await handlePayload(ctx, {
      psid: input.psid,
      userId: input.userId,
      payload: input.event.postback.payload,
      reqId: input.reqId,
      lang: input.lang,
    });
    return true;
  }

  return false;
}

export async function handlePayload(
  ctx: HandlerContext,
  input: PayloadFlowInput
): Promise<void> {
  if (
    (input.payload === FACE_MEMORY_CONSENT_YES ||
      input.payload === FACE_MEMORY_CONSENT_NO) &&
    !isFaceMemoryEnabled()
  ) {
    await handleDisabledFaceMemoryPayload(ctx, input);
    return;
  }

  if (input.payload === FACE_MEMORY_CONSENT_YES) {
    const state = await getOrCreateState(input.psid);
    const sourceImageUrl = state.pendingImageUrl ?? state.lastPhotoUrl;
    if (sourceImageUrl) {
      await rememberFaceSourceImage(input.psid, sourceImageUrl);
    } else {
      await setFaceMemoryConsentGiven(input.psid);
    }
    await continueAfterFaceMemoryChoice(ctx, input);
    return;
  }

  if (input.payload === FACE_MEMORY_CONSENT_NO) {
    await declineFaceMemory(input.psid);
    await continueAfterFaceMemoryChoice(ctx, input);
    return;
  }

  await handleMessengerPayload({
    psid: input.psid,
    userId: input.userId,
    payload: input.payload,
    reqId: input.reqId,
    lang: input.lang,
    maybeSendInFlightMessage: async (userPsid, requestId, payloadLang) =>
      (await ctx.maybeSendInFlightMessage(userPsid, requestId, payloadLang))
        .handled,
    getState: userPsid => Promise.resolve(getOrCreateState(userPsid)),
    getFeatures: getBotFeatures,
    createFeaturePayloadContext: ctx.createFeaturePayloadContext,
    sendUnknownPayloadLog: unknownUserId => {
      safeLog("unknown_payload", { user: toLogUser(unknownUserId) });
    },
  });
}
