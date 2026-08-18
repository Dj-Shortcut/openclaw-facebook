import { ensureDefaultBotFeaturesRegistered } from "./bot/defaultFeatures";
import type { FacebookWebhookEntry } from "./webhookHelpers";
import { handleEntry } from "./webhookEventRouter";
import { createHandlerContext } from "./webhookHandlerContext";
import { createMessengerGenerationJobRunner } from "./webhookGenerationJobs";
import { createMessengerVideoGenerationRunner } from "./videoGenerationFlow";
import {
  enqueueOrRunMessengerGenerationJob,
} from "./messengerGenerationQueue";
import { getMessengerRequestPageId } from "./messengerRequestContext";
import { MESSENGER_ASYNC_RESPONSE_QUEUED } from "./webhookFallback";
import type { MessengerGenerationJob } from "./messengerGenerationJob";
import type { MessengerSendOutcome } from "./messengerApi";
import type { Lang } from "./i18n";
import { createInternalMessengerImageRequestHandler } from "./webhookInternalImageRequest";
import type {
  HandlerContext,
  HandlerDeps,
  InternalMessengerImageRequestInput,
} from "./webhookHandlerTypes";

export type {
  HandlerContext,
  HandlerDeps,
  InternalMessengerImageRequestInput,
} from "./webhookHandlerTypes";

/** Creates the public Messenger webhook handlers while delegating work to focused modules. */
export function createWebhookHandlers({ defaultLang }: HandlerDeps) {
  ensureDefaultBotFeaturesRegistered();

  // The createMessengerGenerationJobRunner wrappers capture ctx but must stay
  // deferred: createMessengerGenerationJobRunner, createHandlerContext, and
  // createInternalMessengerImageRequestHandler must not invoke them during
  // construction. generationRunner.runImageGeneration is wired into
  // createHandlerContext below, then ctx is assigned before runtime calls.
  let ctx: HandlerContext;
  const generationRunner = createMessengerGenerationJobRunner({
    maybeSendInFlightMessage: (psid, reqId, lang) =>
      ctx.maybeSendInFlightMessage(psid, reqId, lang),
    sendLoggedImage: (psid, imageUrl, reqId) =>
      ctx.sendLoggedImage(psid, imageUrl, reqId),
    sendLoggedActions: (psid, text, actions, reqId) =>
      ctx.sendLoggedActions(psid, text, actions, reqId),
    sendLoggedText: (psid, text, reqId) =>
      ctx.sendLoggedText(psid, text, reqId),
  });
  const videoGenerationRunner = createMessengerVideoGenerationRunner({
    maybeSendInFlightMessage: (psid, reqId, lang) =>
      ctx.maybeSendInFlightMessage(psid, reqId, lang),
    sendLoggedText: (psid, text, reqId) =>
      ctx.sendLoggedText(psid, text, reqId),
    sendLoggedVideo: (psid, videoUrl, reqId) => {
      if (!ctx.sendLoggedVideo) {
        throw new Error("Messenger video sender is not configured");
      }
      return ctx.sendLoggedVideo(psid, videoUrl, reqId);
    },
  });
  const processVideoGenerationJob = async (
    job: MessengerGenerationJob
  ) =>
    await videoGenerationRunner(
      job.psid,
      job.userId,
      job.reqId,
      job.lang,
      job.sourceImageUrl ?? "",
      job.promptHint ?? ""
    );
  const runVideoGeneration = async (
    psid: string,
    userId: string,
    reqId: string,
    lang: Lang,
    sourceImageUrl: string,
    promptHint: string
  ): Promise<MessengerSendOutcome> => {
    const result = await enqueueOrRunMessengerGenerationJob(
      {
        operation: "video",
        psid,
        userId,
        pageId: getMessengerRequestPageId(),
        reqId,
        lang,
        sourceImageUrl,
        promptHint,
      },
      processVideoGenerationJob,
      { onDeadLetter: processVideoGenerationJobDeadLetter }
    );
    return result.mode === "inline"
      ? (result.outcome as MessengerSendOutcome)
      : MESSENGER_ASYNC_RESPONSE_QUEUED;
  };
  const processVideoGenerationJobDeadLetter = async (
    job: MessengerGenerationJob
  ) => {
    await ctx.sendLoggedText(
      job.psid,
      "Ik kan die video nu niet maken. Probeer het later opnieuw.",
      job.reqId
    );
    return MESSENGER_ASYNC_RESPONSE_QUEUED;
  };
  ctx = createHandlerContext({
    defaultLang,
    runImageGeneration: generationRunner.runImageGeneration,
    runVideoGeneration,
  });
  const internalRequestHandler =
    createInternalMessengerImageRequestHandler(ctx);

  async function processFacebookWebhookPayload(
    payload: unknown
  ): Promise<void> {
    const entries = getWebhookEntries(payload);
    for (const entry of entries) {
      await handleEntry(ctx, entry);
    }
  }

  return {
    processFacebookWebhookPayload,
    acceptInternalMessengerImageRequest:
      internalRequestHandler.acceptInternalMessengerImageRequest,
    processInternalMessengerImageRequest:
      internalRequestHandler.processInternalMessengerImageRequest,
    processMessengerGenerationJob: async (job: MessengerGenerationJob) =>
      job.operation === "video"
        ? await processVideoGenerationJob(job)
        : await generationRunner.processMessengerGenerationJob(job),
    processMessengerGenerationJobDeadLetter: async (job: MessengerGenerationJob) =>
      job.operation === "video"
        ? await processVideoGenerationJobDeadLetter(job)
        : await generationRunner.processMessengerGenerationJobDeadLetter(job),
  };
}

function getWebhookEntries(payload: unknown): FacebookWebhookEntry[] {
  return Array.isArray(
    (payload as { entry?: unknown[] } | null | undefined)?.entry
  )
    ? ((payload as { entry: FacebookWebhookEntry[] }).entry ?? [])
    : [];
}
