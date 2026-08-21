import { executeGenerationFlow } from "../generationFlow";
import { getGenerationMetrics } from "../image-generation/openAiImageClient";
import type { GenerationKind } from "../image-generation/generationTypes";
import { runGuardedGeneration } from "../generationGuard";
import { t, type Lang } from "../i18n";
import type { SourceImageOrigin } from "../messengerState";
import {
  canUseImageGeneration,
  commitImageGenerationUsage,
  MessengerQuotaReservationCommitError,
  releaseImageGenerationUsage,
  reserveImageGenerationUsage,
} from "../limits/generationQuota";
import {
  clearPendingImageState,
  getOrCreateState,
  setFlowState,
  setLastGenerated,
  setLastGenerationContext,
} from "../messengerState";
import {
  sendWhatsAppImageReplyWithReceipt,
  sendWhatsAppTextReply,
} from "../whatsappResponseService";
import { summarizeSensitiveUrl } from "../utils/urlSummarizer";
import { safeLog } from "../logger";
import { CostLedgerScopeError, type CostLedgerScope } from "../costLedger";
import {
  finalizeWhatsAppProviderAttemptFence,
  markWhatsAppProviderAttemptStarted,
  reserveWhatsAppProviderAttemptFence,
  type WhatsAppProviderAttemptFence,
} from "../whatsappProviderAttemptFence";
import {
  createMessengerGenerationPublishHooks,
  markMessengerGenerationCompleted,
  markMessengerGenerationDelivered,
  scheduleMessengerGenerationArtifactCleanup,
  type MessengerGenerationCompletionFence,
} from "../messengerGenerationCompletion";
import {
  getMessengerRequestOwnership,
  getMessengerRequestPageId,
  getMessengerRequestPrivacySubject,
} from "../messengerRequestContext";

type ImageGenerationInput = {
  senderId: string;
  userId: string;
  reqId: string;
  lang: Lang;
  sourceImageUrl?: string;
  promptHint?: string;
  generationKind?: GenerationKind;
  costLedgerScope: CostLedgerScope;
};

type GenerationResult = Awaited<ReturnType<typeof executeGenerationFlow>>;
type GenerationFailure = Extract<GenerationResult, { kind: "error" }>;

function resolvedSourceHost(url?: string): string | undefined {
  if (!url) {
    return undefined;
  }

  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function logGenerationRequested(input: {
  userId: string;
  promptHint?: string;
  resolvedSourceImageUrl?: string;
  trustedSourceImageUrl: boolean;
}): void {
  safeLog("whatsapp_generation_requested", {
    user: input.userId,
    hasPromptHint: Boolean(input.promptHint?.trim()),
    sourceImageUrlHost: resolvedSourceHost(input.resolvedSourceImageUrl),
    trustedSourceImageUrl: input.trustedSourceImageUrl,
  });
}

async function sendQuotaExceededReply(
  senderId: string,
  lang: Lang
): Promise<void> {
  await sendWhatsAppTextReply(
    senderId,
    lang === "en"
      ? "You used your free credits for today. Come back tomorrow."
      : "Je hebt je gratis credits voor vandaag opgebruikt. Kom morgen terug."
  );
  await setFlowState(senderId, "AWAITING_EDIT_PROMPT");
}

async function prepareGeneration(input: ImageGenerationInput): Promise<{
  lastPhotoUrl?: string | null;
  lastPhotoSource?: SourceImageOrigin | null;
}> {
  const state = await Promise.resolve(getOrCreateState(input.senderId));
  const resolvedSourceImageUrl =
    input.sourceImageUrl ?? state.lastPhotoUrl ?? undefined;

  logGenerationRequested({
    userId: input.userId,
    promptHint: input.promptHint,
    resolvedSourceImageUrl,
    trustedSourceImageUrl:
      resolvedSourceImageUrl !== undefined &&
      resolvedSourceImageUrl === state.lastPhotoUrl &&
      state.lastPhotoSource === "stored",
  });

  await setFlowState(input.senderId, "PROCESSING");
  await sendWhatsAppTextReply(
    input.senderId,
    t(input.lang, "generatingImagePrompt")
  );

  return {
    lastPhotoUrl: state.lastPhotoUrl,
    lastPhotoSource: state.lastPhotoSource,
  };
}

async function handleGenerationSuccess(input: {
  senderId: string;
  lang: Lang;
  generationKind?: GenerationKind;
  promptHint?: string;
  imageUrl: string;
  reqId: string;
  userKey: string;
  completionFence?: MessengerGenerationCompletionFence;
}): Promise<void> {
  // Inventory the exact tenant/privacy-owned object before Graph can accept
  // its URL. A crash after delivery can then never make GDPR erasure depend
  // on the fallible conversation-state writes below.
  await markMessengerGenerationCompleted(
    input.reqId,
    input.imageUrl,
    input.userKey,
    Date.now(),
    input.completionFence
  );
  try {
    await sendWhatsAppImageReplyWithReceipt(
      input.senderId,
      input.imageUrl,
      input.reqId
    );
  } catch (error) {
    const outcome = readWhatsAppDeliveryFailureOutcome(error);
    if (outcome === "pre_transport" || outcome === "known_rejected") {
      try {
        if (!input.completionFence) {
          throw new Error(
            "WhatsApp generation artifact cleanup fence is unavailable"
          );
        }
        await scheduleMessengerGenerationArtifactCleanup({
          reqId: input.reqId,
          imageUrl: input.imageUrl,
          userKey: input.userKey,
          fence: input.completionFence,
          reason: "pre_transport_rejected",
        });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "WhatsApp generation artifact cleanup could not be scheduled",
          { cause: error }
        );
      }
    }
    throw error;
  }
  await markMessengerGenerationDelivered(
    input.reqId,
    input.imageUrl,
    input.userKey,
    Date.now(),
    input.completionFence
  );
  await setLastGenerated(input.senderId, input.imageUrl);
  await setLastGenerationContext(input.senderId, {
    prompt: input.promptHint,
  });
  await setFlowState(input.senderId, "RESULT_READY");
  await sendWhatsAppTextReply(
    input.senderId,
    `${t(input.lang, "success")}\n${t(input.lang, "whatsappGenerationFollowup")}`
  );
}

function readWhatsAppDeliveryFailureOutcome(
  error: unknown
): "pre_transport" | "known_rejected" | "ambiguous" | null {
  if (error && typeof error === "object") {
    const outcome = (error as { outcome?: unknown }).outcome;
    if (
      outcome === "pre_transport" ||
      outcome === "known_rejected" ||
      outcome === "ambiguous"
    ) {
      return outcome;
    }
    if (error instanceof AggregateError) {
      for (const nested of error.errors) {
        const nestedOutcome = readWhatsAppDeliveryFailureOutcome(nested);
        if (nestedOutcome) return nestedOutcome;
      }
    }
  }
  return null;
}

function resolveWhatsAppCompletionFence(
  scope: CostLedgerScope,
  userKey: string
): MessengerGenerationCompletionFence | undefined {
  const pageId = getMessengerRequestPageId();
  const ownership = getMessengerRequestOwnership();
  const privacy = getMessengerRequestPrivacySubject();
  if (!pageId || !ownership || !privacy) {
    if (process.env.NODE_ENV === "production") {
      throw new CostLedgerScopeError();
    }
    return undefined;
  }
  if (
    privacy.userKey !== userKey ||
    ownership.workspaceId !== scope.workspaceId ||
    ownership.channelConnectionId !== scope.channelConnectionId ||
    ownership.bindingEpoch !== scope.bindingEpoch ||
    privacy.privacyEpoch !== scope.privacyEpoch
  ) {
    throw new CostLedgerScopeError();
  }
  return Object.freeze({
    pageId,
    userKey,
    workspaceId: ownership.workspaceId,
    channelConnectionId: ownership.channelConnectionId,
    bindingEpoch: ownership.bindingEpoch,
    privacyEpoch: privacy.privacyEpoch,
    channel: "whatsapp" as const,
  });
}

function logGenerationFailure(input: {
  userId: string;
  result: GenerationFailure;
}): void {
  const metrics =
    input.result.metrics ?? getGenerationMetrics(input.result.error);
  safeLog("whatsapp_generation_failed", {
    level: "error",
    user: input.userId,
    totalMs: metrics?.totalMs,
    error:
      input.result.error instanceof Error
        ? input.result.error.message
        : String(input.result.error),
  });
}

function logRejectedSourceImage(input: {
  userId: string;
  result: GenerationFailure;
}): void {
  if (
    input.result.errorKind !== "invalid_source_image" ||
    !input.result.resolvedSourceImageUrl
  ) {
    return;
  }

  safeLog("whatsapp_source_image_rejected", {
    level: "error",
    user: input.userId,
    sourceImageLocation: summarizeSensitiveUrl(
      input.result.resolvedSourceImageUrl
    ),
  });
}

async function resolveGenerationFailure(input: {
  senderId: string;
  userId: string;
  lang: Lang;
  sourceImageUrl?: string;
  lastPhotoUrl?: string | null;
  result: GenerationFailure;
}): Promise<string> {
  if (input.result.errorKind === "missing_source_image") {
    await setFlowState(input.senderId, "AWAITING_PHOTO");
    return t(input.lang, "editRequiresPhoto");
  }

  if (
    input.result.errorKind === "invalid_source_image" ||
    input.result.errorKind === "missing_input_image"
  ) {
    if (
      input.result.errorKind === "invalid_source_image" &&
      (!input.sourceImageUrl ||
        input.result.resolvedSourceImageUrl === input.lastPhotoUrl)
    ) {
      await clearPendingImageState(input.senderId);
    }
    await setFlowState(input.senderId, "AWAITING_PHOTO");
    logRejectedSourceImage(input);
    return t(input.lang, "missingInputImage");
  }

  if (input.result.errorKind === "generation_unavailable") {
    await setFlowState(input.senderId, "AWAITING_EDIT_PROMPT");
    return t(input.lang, "generationUnavailable");
  }

  if (input.result.errorKind === "generation_timeout") {
    await setFlowState(input.senderId, "AWAITING_EDIT_PROMPT");
    return t(input.lang, "generationTimeout");
  }

  if (input.result.errorKind === "generation_budget_reached") {
    await setFlowState(input.senderId, "AWAITING_EDIT_PROMPT");
    return t(input.lang, "generationBudgetReached");
  }

  await setFlowState(input.senderId, "FAILURE");
  return t(input.lang, "generationGenericFailure");
}

async function handleGenerationFailure(input: {
  senderId: string;
  userId: string;
  lang: Lang;
  sourceImageUrl?: string;
  lastPhotoUrl?: string | null;
  result: GenerationFailure;
}): Promise<void> {
  logGenerationFailure(input);
  const failureText = await resolveGenerationFailure(input);
  await sendWhatsAppTextReply(input.senderId, failureText);
}

export async function runWhatsAppImageGeneration(
  input: ImageGenerationInput
): Promise<void> {
  const scopedInput = {
    ...input,
    costLedgerScope: requireWhatsAppCostLedgerScope(input.costLedgerScope),
  };
  const didRun = await runGuardedGeneration(input.senderId, () =>
    runWhatsAppImageGenerationOnce(scopedInput)
  );
  if (didRun === null) {
    await sendWhatsAppTextReply(
      input.senderId,
      input.lang === "en"
        ? "Hang tight, I am still working on your image."
        : "Even geduld, ik ben nog bezig met je beeld."
    );
  }
}

function requireWhatsAppCostLedgerScope(
  scope: CostLedgerScope | undefined
): CostLedgerScope {
  if (
    !scope ||
    !Number.isSafeInteger(scope.workspaceId) ||
    scope.workspaceId <= 0 ||
    !Number.isSafeInteger(scope.channelConnectionId) ||
    scope.channelConnectionId <= 0 ||
    !Number.isSafeInteger(scope.bindingEpoch) ||
    scope.bindingEpoch <= 0 ||
    !Number.isSafeInteger(scope.privacyEpoch) ||
    scope.privacyEpoch <= 0
  ) {
    throw new CostLedgerScopeError();
  }
  return Object.freeze({ ...scope });
}

async function runWhatsAppImageGenerationOnce(
  input: ImageGenerationInput
): Promise<void> {
  const {
    senderId,
    userId,
    reqId,
    lang,
    sourceImageUrl,
    promptHint,
    generationKind,
  } = input;
  const quotaInput = { channel: "whatsapp" as const, senderId };
  if (!(await canUseImageGeneration(quotaInput))) {
    await sendQuotaExceededReply(senderId, lang);
    return;
  }

  const quotaReservation = await reserveImageGenerationUsage(quotaInput);
  if (!quotaReservation) {
    await sendQuotaExceededReply(senderId, lang);
    return;
  }

  let pendingQuotaReservation: typeof quotaReservation | null =
    quotaReservation;
  let providerAttemptsCommitted = 0;
  const providerFences: WhatsAppProviderAttemptFence[] = [];
  const finalizeKnownProviderSuccess = async (): Promise<void> => {
    const fences = providerFences.splice(0, providerFences.length);
    await Promise.all(
      fences.map(fence =>
        finalizeWhatsAppProviderAttemptFence(fence, "succeeded")
      )
    );
  };
  const commitProviderAttemptQuota = async () => {
    const reservationForAttempt =
      pendingQuotaReservation ??
      (await reserveImageGenerationUsage(quotaInput));
    if (!reservationForAttempt) {
      throw new MessengerQuotaReservationCommitError();
    }
    const providerFence = await reserveWhatsAppProviderAttemptFence({
      reqId,
      userKey: userId,
      providerOperation: "whatsapp_openai_image",
      expectedScope: input.costLedgerScope,
    });
    let terminal = false;
    return {
      markTransportStarted: async () => {
        if (terminal) {
          throw new Error("WhatsApp provider attempt admission is terminal");
        }
        // The durable tenant/privacy fence is the last reversible local gate.
        // Only consume customer quota after that exact pre-transport CAS wins.
        await markWhatsAppProviderAttemptStarted(providerFence);
        const committed = await commitImageGenerationUsage({
          ...quotaInput,
          reservation: reservationForAttempt,
        });
        if (!committed) {
          throw new MessengerQuotaReservationCommitError();
        }

        providerAttemptsCommitted += 1;
        if (pendingQuotaReservation?.token === reservationForAttempt.token) {
          pendingQuotaReservation = null;
        }
        providerFences.push(providerFence);
        terminal = true;
        safeLog("whatsapp_quota_decision", {
          action: "commit_provider_attempt",
          user: userId,
          generationKind: generationKind ?? null,
          allowed: true,
        });
      },
      abortBeforeTransport: async () => {
        if (terminal) return;
        await finalizeWhatsAppProviderAttemptFence(
          providerFence,
          "known_failed"
        );
        terminal = true;
      },
    };
  };

  try {
    const generationContext = await prepareGeneration(input);
    const completionFence = resolveWhatsAppCompletionFence(
      input.costLedgerScope,
      userId
    );

    const result = await executeGenerationFlow({
      userId,
      reqId,
      generationKind,
      promptHint,
      sourceImageUrl,
      lastPhotoUrl: generationContext.lastPhotoUrl,
      lastPhotoSource: generationContext.lastPhotoSource,
      onProviderAttempt: commitProviderAttemptQuota,
      onProviderSuccess: finalizeKnownProviderSuccess,
      costLedgerScope: input.costLedgerScope,
      generatedImagePublishHooks: completionFence
        ? createMessengerGenerationPublishHooks(completionFence)
        : undefined,
    });

    if (result.kind === "success") {
      if (providerAttemptsCommitted === 0) {
        const admission = await commitProviderAttemptQuota();
        await admission.markTransportStarted();
      }
      // The billable image provider operation has a known successful outcome
      // before channel delivery begins. Persist it now so a later Graph or
      // state failure cannot misclassify provider spend as ambiguous.
      // Kept as an idempotent fallback for injected test generators; the real
      // image service closes this immediately on provider 2xx.
      await finalizeKnownProviderSuccess();
      await handleGenerationSuccess({
        senderId,
        lang,
        generationKind,
        promptHint,
        imageUrl: result.imageUrl,
        reqId,
        userKey: userId,
        completionFence,
      });
      return;
    }

    await Promise.all(
      providerFences.map(fence =>
        finalizeWhatsAppProviderAttemptFence(fence, "ambiguous")
      )
    );
    providerFences.length = 0;

    await handleGenerationFailure({
      senderId,
      userId,
      lang,
      sourceImageUrl,
      lastPhotoUrl: generationContext.lastPhotoUrl,
      result,
    });
  } finally {
    await Promise.all(
      providerFences.map(fence =>
        finalizeWhatsAppProviderAttemptFence(fence, "ambiguous")
      )
    );
    if (pendingQuotaReservation) {
      await releaseImageGenerationUsage({
        ...quotaInput,
        reservation: pendingQuotaReservation,
      });
    }
  }
}
