import type { MessengerSendOutcome } from "./messengerApi";
import {
  anonymizePsid,
  clearPendingImageState,
  getOrCreateState,
  setFlowState,
  setLastUserMessageAt,
  setPendingStoredImages,
} from "./messengerState";
import { t, type Lang } from "./i18n";
import { toLogUser, toUserKey } from "./privacy";
import {
  cleanupNormalizedMessengerInboundImages,
  normalizeMessengerInboundImage,
} from "./messengerImageIngress";
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
import {
  runWithMessengerRequestContext,
  setMessengerRequestOperationId,
} from "./messengerRequestContext";
import { MAX_SOURCE_IMAGES } from "./image-generation/generationTypes";
import {
  admitMessengerPrivacySubjectFromMetaEvent,
  MessengerPrivacyFenceError,
} from "./messengerPrivacySubject";
import { resolveMessengerGenerationOwnership } from "./workspaceEntitlementRuntime";

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
    const userKey = toUserKey(input.psid);
    const ownership = await resolveMessengerGenerationOwnership(input.pageId);
    let privacyEpoch: number | undefined;
    if (ownership) {
      privacyEpoch = await admitMessengerPrivacySubjectFromMetaEvent({
        workspaceId: ownership.workspaceId,
        channelConnectionId: ownership.channelConnectionId,
        userKey,
        eventOccurredAt: parseInternalEventOccurredAt(input.timestamp),
        allowReactivation: false,
      });
    } else if (process.env.NODE_ENV === "production") {
      throw new MessengerPrivacyFenceError();
    }
    return await runWithMessengerRequestContext(
      input.pageId,
      () => {
        setMessengerRequestOperationId(input.reqId);
        return acceptInternalMessengerImageRequestInContext(input);
      },
      ownership
        ? {
            channel: "facebook_messenger",
            ...ownership,
            userKey,
            privacyEpoch,
          }
        : undefined
    );
  }

  async function acceptInternalMessengerImageRequestInContext(
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

    let state = await getOrCreateState(input.psid);
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

    const sourceImageLimitReached =
      Boolean(input.sourceImageUrl) &&
      getRetainedSourceImageCount(state) >= MAX_SOURCE_IMAGES;
    if (sourceImageLimitReached) {
      await deps.sendLoggedText(
        input.psid,
        t(lang, "maxSourceImagesRetained"),
        input.reqId
      );
    }
    const persistedSource = sourceImageLimitReached
      ? { storedSourceImageUrl: undefined, limitReached: false }
      : await persistOptionalSourceImage(input, lang, state);
    if (persistedSource.limitReached) {
      state = await getOrCreateState(input.psid);
    }
    const storedSourceImageUrl = persistedSource.storedSourceImageUrl;
    const effectiveSourceImageLimitReached =
      sourceImageLimitReached || persistedSource.limitReached;
    const previousEditableImageUrl =
      state.lastGeneratedUrl ??
      state.lastImageUrl ??
      state.lastPhotoUrl ??
      undefined;
    const shouldUsePreviousPhoto =
      Boolean(storedSourceImageUrl) ||
      effectiveSourceImageLimitReached ||
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
    lang: Lang,
    state: Awaited<ReturnType<typeof getOrCreateState>>
  ): Promise<{
    storedSourceImageUrl?: string;
    limitReached: boolean;
  }> {
    if (!input.sourceImageUrl) {
      return { limitReached: false };
    }

    const storedSourceImageUrl =
      (await normalizeMessengerInboundImage({
        inboundImageUrl: input.sourceImageUrl,
        psid: input.psid,
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

    try {
      const update = await setPendingStoredImages(input.psid, [
        storedSourceImageUrl,
      ]);
      if (update.rejectedIncomingImageUrls.includes(storedSourceImageUrl)) {
        if (!isAlreadyRetainedSourceImage(storedSourceImageUrl, state)) {
          await cleanupNormalizedMessengerInboundImages([
            storedSourceImageUrl,
          ]).catch(() => undefined);
        }
        await deps.sendLoggedText(
          input.psid,
          t(lang, "maxSourceImagesRetained"),
          input.reqId
        );
        return { limitReached: true };
      }
    } catch (error) {
      if (!isAlreadyRetainedSourceImage(storedSourceImageUrl, state)) {
        await cleanupNormalizedMessengerInboundImages([
          storedSourceImageUrl,
        ]).catch(() => undefined);
      }
      throw error;
    }
    return { storedSourceImageUrl, limitReached: false };
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

function parseInternalEventOccurredAt(value: number | undefined): Date {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new MessengerPrivacyFenceError();
  }
  const eventOccurredAt = new Date(value!);
  if (!Number.isSafeInteger(eventOccurredAt.getTime())) {
    throw new MessengerPrivacyFenceError();
  }
  return eventOccurredAt;
}

function getRetainedSourceImageCount(
  state: Awaited<ReturnType<typeof getOrCreateState>>
): number {
  if (state.stage !== "AWAITING_EDIT_PROMPT") {
    return 0;
  }

  return Math.min(state.pendingImageUrls?.length ?? 0, MAX_SOURCE_IMAGES);
}

function isAlreadyRetainedSourceImage(
  imageUrl: string,
  state: Awaited<ReturnType<typeof getOrCreateState>>
): boolean {
  return [
    ...(state.pendingImageUrls ?? []),
    state.pendingImageUrl,
    state.lastPhotoUrl,
    state.lastPhoto,
    state.lastSourceImageUrl,
    state.lastGeneratedUrl,
    state.lastImageUrl,
  ].some(existingUrl => existingUrl === imageUrl);
}
