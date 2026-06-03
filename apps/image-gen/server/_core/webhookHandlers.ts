import { ensureDefaultBotFeaturesRegistered } from "./bot/defaultFeatures";
import type { FacebookWebhookEntry } from "./webhookHelpers";
import { handleEntry } from "./webhookEventRouter";
import { createHandlerContext } from "./webhookHandlerContext";
import { createMessengerGenerationJobRunner } from "./webhookGenerationJobs";
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

export function createWebhookHandlers({ defaultLang }: HandlerDeps) {
  ensureDefaultBotFeaturesRegistered();

  let ctx: HandlerContext;
  const generationRunner = createMessengerGenerationJobRunner({
    maybeSendInFlightMessage: (psid, reqId) =>
      ctx.maybeSendInFlightMessage(psid, reqId),
    sendLoggedImage: (psid, imageUrl, reqId) =>
      ctx.sendLoggedImage(psid, imageUrl, reqId),
    sendLoggedQuickReplies: (psid, text, replies, reqId) =>
      ctx.sendLoggedQuickReplies(psid, text, replies, reqId),
    sendLoggedText: (psid, text, reqId) =>
      ctx.sendLoggedText(psid, text, reqId),
  });
  ctx = createHandlerContext({
    defaultLang,
    runImageGeneration: generationRunner.runImageGeneration,
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
    processMessengerGenerationJob:
      generationRunner.processMessengerGenerationJob,
    processMessengerGenerationJobDeadLetter:
      generationRunner.processMessengerGenerationJobDeadLetter,
  };
}

function getWebhookEntries(payload: unknown): FacebookWebhookEntry[] {
  return Array.isArray(
    (payload as { entry?: unknown[] } | null | undefined)?.entry
  )
    ? ((payload as { entry: FacebookWebhookEntry[] }).entry ?? [])
    : [];
}
