import {
  declineFaceMemory,
  getOrCreateState,
  rememberFaceSourceImage,
  setFaceMemoryConsentGiven,
  setFlowState,
  setPreselectedStyle,
  setSelectedStyleCategory,
} from "./messengerState";
import {
  FACE_MEMORY_CONSENT_NO,
  FACE_MEMORY_CONSENT_YES,
  isFaceMemoryEnabled,
} from "./faceMemory";
import { getBotFeatures } from "./bot/features";
import { handleMessengerPayload } from "./messengerPayloadRouting";
import { safeLog } from "./messengerApi";
import { toLogUser } from "./privacy";
import { normalizeStyle, type FacebookWebhookEvent } from "./webhookHelpers";
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
  const state = await getOrCreateState(input.psid);
  const preselectedStyle = normalizeStyle(state.preselectedStyle ?? "");
  if (preselectedStyle && state.lastPhotoUrl) {
    await setPreselectedStyle(input.psid, null);
    await ctx.handleStyleSelection(
      input.psid,
      input.userId,
      preselectedStyle,
      input.reqId,
      input.lang
    );
    return;
  }

  await setFlowState(input.psid, "AWAITING_STYLE");
  await ctx.sendPhotoReceivedPrompt(input.psid, input.lang, input.reqId);
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
    await ctx.sendPhotoReceivedPrompt(input.psid, input.lang, input.reqId);
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
    runStyleGeneration: async (userPsid, inputUserId, style, requestId, userLang) => {
      await ctx.runStyleGeneration(
        userPsid,
        inputUserId,
        style,
        requestId,
        userLang
      );
    },
    handleStyleSelection: async (
      userPsid,
      inputUserId,
      style,
      requestId,
      userLang
    ) => {
      await ctx.handleStyleSelection(
        userPsid,
        inputUserId,
        style,
        requestId,
        userLang
      );
    },
    showStylePicker: async (userPsid, userLang, requestId) => {
      await setPreselectedStyle(userPsid, null);
      await setSelectedStyleCategory(userPsid, null);
      await setFlowState(userPsid, "AWAITING_STYLE");
      await ctx.sendStylePicker(userPsid, userLang, requestId);
    },
    showStyleCategory: async (userPsid, category, userLang, requestId) => {
      await setSelectedStyleCategory(userPsid, category);
      await setFlowState(userPsid, "AWAITING_STYLE");
      await ctx.sendStyleOptionsForCategory(
        userPsid,
        category,
        userLang,
        requestId
      );
    },
    sendFlowExplanation: async (userPsid, userLang, requestId) => {
      await ctx.sendFlowExplanation(userPsid, userLang, requestId);
    },
    sendPrivacyInfo: async (userPsid, userLang, requestId) => {
      await ctx.sendPrivacyInfo(userPsid, userLang, requestId);
    },
    sendUnknownPayloadLog: unknownUserId => {
      safeLog("unknown_payload", { user: toLogUser(unknownUserId) });
    },
  });
}
