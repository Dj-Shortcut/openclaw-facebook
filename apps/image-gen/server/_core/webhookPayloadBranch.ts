import {
  declineFaceMemory,
  getOrCreateState,
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
import { renderMessengerQuickReplies } from "./messengerActionRenderer";
import { buildQuickStartResponse } from "./conversationActions";
import { safeLog } from "./messengerApi";
import { toLogUser } from "./privacy";
import { type FacebookWebhookEvent } from "./webhookHelpers";
import type { HandlerContext } from "./webhookHandlers";
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
  await ctx.sendLoggedQuickReplies(
    input.psid,
    response.text ?? "",
    renderMessengerQuickReplies(response.actions),
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
    maybeSendInFlightMessage: async (userPsid, requestId) =>
      (await ctx.maybeSendInFlightMessage(userPsid, requestId)).handled,
    getState: userPsid => Promise.resolve(getOrCreateState(userPsid)),
    getFeatures: getBotFeatures,
    createFeaturePayloadContext: ctx.createFeaturePayloadContext,
    sendUnknownPayloadLog: unknownUserId => {
      safeLog("unknown_payload", { user: toLogUser(unknownUserId) });
    },
  });
}
