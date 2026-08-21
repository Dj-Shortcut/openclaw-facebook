import { ensureDefaultBotFeaturesRegistered } from "./bot/defaultFeatures";
import type { FacebookWebhookEntry } from "./webhookHelpers";
import { handleEntry } from "./webhookEventRouter";
import { createHandlerContext } from "./webhookHandlerContext";
import { createMessengerGenerationJobRunner } from "./webhookGenerationJobs";
import { createMessengerVideoGenerationRunner } from "./videoGenerationFlow";
import { enqueueOrRunMessengerGenerationJob } from "./messengerGenerationQueue";
import {
  getMessengerRequestPageId,
  runWithMessengerRequestContext,
  setMessengerRequestOperationId,
} from "./messengerRequestContext";
import { MESSENGER_ASYNC_RESPONSE_QUEUED } from "./webhookFallback";
import type { MessengerGenerationJob } from "./messengerGenerationJob";
import { t, type Lang } from "./i18n";
import {
  assertMessengerGenerationOwnership,
  resolveMessengerGenerationOwnership,
  WorkspaceEntitlementLookupError,
} from "./workspaceEntitlementRuntime";
import {
  assertMessengerPrivacySubject,
  ensureActiveMessengerPrivacySubject,
  MessengerPrivacyFenceError,
} from "./messengerPrivacySubject";
import { createInternalMessengerImageRequestHandler } from "./webhookInternalImageRequest";
import type {
  HandlerContext,
  HandlerDeps,
  MessengerSendOutcome,
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
  // Assigned after the deferred runners close over it; a const cannot model
  // this construction order without invoking the runners too early.
  // eslint-disable-next-line prefer-const
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
  const processVideoGenerationJob = async (job: MessengerGenerationJob) => {
    const ownership =
      job.workspaceId && job.channelConnectionId && job.bindingEpoch
        ? {
            workspaceId: job.workspaceId,
            channelConnectionId: job.channelConnectionId,
            bindingEpoch: job.bindingEpoch,
            userKey: job.userId,
            privacyEpoch: job.privacyEpoch,
          }
        : undefined;
    return await runWithMessengerRequestContext(
      job.pageId,
      async () => {
        setMessengerRequestOperationId(job.reqId);
        await assertMessengerGenerationOwnership(job);
        if (job.workspaceId && job.channelConnectionId && job.privacyEpoch) {
          await assertMessengerPrivacySubject({
            workspaceId: job.workspaceId,
            channelConnectionId: job.channelConnectionId,
            userKey: job.userId,
            privacyEpoch: job.privacyEpoch,
          });
        }
        return await videoGenerationRunner(
          job.psid,
          job.userId,
          job.reqId,
          job.lang,
          job.sourceImageUrl ?? "",
          job.promptHint ?? ""
        );
      },
      ownership
    );
  };
  const runVideoGeneration = async (
    psid: string,
    userId: string,
    reqId: string,
    lang: Lang,
    sourceImageUrl: string,
    promptHint: string
  ): Promise<MessengerSendOutcome> => {
    const pageId = getMessengerRequestPageId();
    const ownership = await resolveMessengerGenerationOwnership(pageId);
    const privacyEpoch = ownership
      ? await ensureActiveMessengerPrivacySubject({
          workspaceId: ownership.workspaceId,
          channelConnectionId: ownership.channelConnectionId,
          userKey: userId,
        })
      : undefined;
    const result = await enqueueOrRunMessengerGenerationJob(
      {
        operation: "video",
        psid,
        userId,
        pageId,
        workspaceId: ownership?.workspaceId,
        channelConnectionId: ownership?.channelConnectionId,
        bindingEpoch: ownership?.bindingEpoch,
        privacyEpoch,
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
  ) =>
    await runWithMessengerRequestContext(
      job.pageId,
      async () => {
        setMessengerRequestOperationId(job.reqId);
        try {
          await assertMessengerGenerationOwnership(job);
          if (job.workspaceId && job.channelConnectionId && job.privacyEpoch) {
            await assertMessengerPrivacySubject({
              workspaceId: job.workspaceId,
              channelConnectionId: job.channelConnectionId,
              userKey: job.userId,
              privacyEpoch: job.privacyEpoch,
            });
          }
        } catch (error) {
          if (
            error instanceof MessengerPrivacyFenceError ||
            error instanceof WorkspaceEntitlementLookupError
          ) {
            return {
              sent: false,
              reason: "response_window_closed",
            } as const;
          }
          throw error;
        }
        return await ctx.sendLoggedText(
          job.psid,
          t(job.lang, "videoGenerationGenericFailure"),
          job.reqId
        );
      },
      job.workspaceId && job.channelConnectionId && job.bindingEpoch
        ? {
            workspaceId: job.workspaceId,
            channelConnectionId: job.channelConnectionId,
            bindingEpoch: job.bindingEpoch,
            userKey: job.userId,
            privacyEpoch: job.privacyEpoch,
          }
        : undefined
    );
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
    processMessengerGenerationJobDeadLetter: async (
      job: MessengerGenerationJob
    ) =>
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
