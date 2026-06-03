import type { MessengerSendOutcome } from "./messengerApi";
import {
  anonymizePsid,
  clearPendingImageState,
  getOrCreateState,
  setFlowState,
  setLastUserMessageAt,
  setPendingStoredImage,
} from "./messengerState";
import { t, type Lang } from "./i18n";
import { toLogUser, toUserKey } from "./privacy";
import { normalizeMessengerInboundImage } from "./messengerImageIngress";
import { safeLog } from "./messengerApi";
import {
  isExplicitSourceImageEditRequest,
  isSourceImageTransformRequest,
  isVisualCorrectionRequest,
} from "./imageIntent";
import { MESSENGER_SEND_SKIPPED } from "./webhookFallback";
import { InternalMessengerImageRequestNotQueuedError } from "./internalImageRequestErrors";
export { InternalMessengerImageRequestNotQueuedError } from "./internalImageRequestErrors";
import type {
  HandlerContext,
  InternalMessengerImageRequestInput,
} from "./webhookHandlerTypes";

type InternalImageRequestHandlerDeps = Pick<
  HandlerContext,
  "maybeSendInFlightMessage" | "runImageGeneration" | "sendLoggedText"
> & {
  defaultLang: Lang;
};

/** Creates handlers for tenant-scoped internal Messenger image-generation requests. */
export function createInternalMessengerImageRequestHandler(
  deps: InternalImageRequestHandlerDeps
) {
  async function acceptInternalMessengerImageRequest(
    input: InternalMessengerImageRequestInput
  ): Promise<MessengerSendOutcome> {
    const lang = input.lang ?? deps.defaultLang;
    const userId = toUserKey(input.psid);
    const wantsSourceImageEdit = isExplicitSourceImageEditRequest(input.prompt);
    const wantsPersonalTransform = isSourceImageTransformRequest(input.prompt);
    const wantsVisualCorrection = isVisualCorrectionRequest(input.prompt);
    await setLastUserMessageAt(input.psid, input.timestamp ?? Date.now());

    safeLog("internal_image_request_received", {
      reqId: input.reqId,
      user: toLogUser(userId),
      psidHash: anonymizePsid(input.psid).slice(0, 12),
      hasSourceImageUrl: Boolean(input.sourceImageUrl),
    });

    const state = await getOrCreateState(input.psid);
    if (state.stage === "PROCESSING") {
      const result = await deps.maybeSendInFlightMessage(
        input.psid,
        input.reqId,
        lang
      );
      return "outcome" in result && result.outcome
        ? result.outcome
        : MESSENGER_SEND_SKIPPED;
    }

    const storedSourceImageUrl = await persistOptionalSourceImage(input, lang);
    const previousEditableImageUrl =
      state.lastGeneratedUrl ??
      state.lastImageUrl ??
      state.lastPhotoUrl ??
      undefined;
    const shouldUsePreviousPhoto =
      Boolean(storedSourceImageUrl) ||
      wantsSourceImageEdit ||
      wantsVisualCorrection ||
      (wantsPersonalTransform && Boolean(previousEditableImageUrl));
    const sourceImageUrl = shouldUsePreviousPhoto
      ? (storedSourceImageUrl ?? previousEditableImageUrl ?? undefined)
      : undefined;

    if (!sourceImageUrl) {
      if (wantsSourceImageEdit || wantsVisualCorrection) {
        await requireSourceImageForEdit(input, lang);
      }

      return await deps.runImageGeneration(
        input.psid,
        userId,
        input.reqId,
        lang,
        undefined,
        input.prompt,
        "text_to_image"
      );
    }

    return await deps.runImageGeneration(
      input.psid,
      userId,
      input.reqId,
      lang,
      sourceImageUrl,
      input.prompt,
      "source_image_edit"
    );
  }

  async function persistOptionalSourceImage(
    input: InternalMessengerImageRequestInput,
    lang: Lang
  ): Promise<string | undefined> {
    if (!input.sourceImageUrl) {
      return undefined;
    }

    const storedSourceImageUrl =
      (await normalizeMessengerInboundImage({
        inboundImageUrl: input.sourceImageUrl,
        psidHash: anonymizePsid(input.psid).slice(0, 12),
        reqId: input.reqId,
      })) ?? undefined;
    if (!storedSourceImageUrl) {
      await clearPendingImageState(input.psid);
      await setFlowState(input.psid, "AWAITING_PHOTO");
      await deps.sendLoggedText(
        input.psid,
        t(lang, "missingInputImage"),
        input.reqId
      );
      throw new InternalMessengerImageRequestNotQueuedError(
        "Internal Messenger image request source image could not be persisted"
      );
    }

    await setPendingStoredImage(input.psid, storedSourceImageUrl);
    return storedSourceImageUrl;
  }

  async function requireSourceImageForEdit(
    input: InternalMessengerImageRequestInput,
    lang: Lang
  ): Promise<never> {
    await setFlowState(input.psid, "AWAITING_PHOTO");
    await deps.sendLoggedText(
      input.psid,
      t(lang, "editRequiresPhoto"),
      input.reqId
    );
    throw new InternalMessengerImageRequestNotQueuedError(
      "Internal Messenger image request needs a source image for edit intent"
    );
  }

  return {
    acceptInternalMessengerImageRequest,
    processInternalMessengerImageRequest: acceptInternalMessengerImageRequest,
  };
}
