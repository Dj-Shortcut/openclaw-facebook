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
  sendWhatsAppImageReply,
  sendWhatsAppTextReply,
} from "../whatsappResponseService";
import { summarizeSensitiveUrl } from "../utils/urlSummarizer";
import { safeLog } from "../logger";

type ImageGenerationInput = {
  senderId: string;
  userId: string;
  reqId: string;
  lang: Lang;
  sourceImageUrl?: string;
  promptHint?: string;
  generationKind?: GenerationKind;
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
}): Promise<void> {
  await sendWhatsAppImageReply(input.senderId, input.imageUrl);
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
  const didRun = await runGuardedGeneration(input.senderId, () =>
    runWhatsAppImageGenerationOnce(input)
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

  let quotaCommitted = false;
  const commitProviderAttemptQuota = async () => {
    if (quotaCommitted) {
      return;
    }

    const committed = await commitImageGenerationUsage({
      ...quotaInput,
      reservation: quotaReservation,
    });
    if (!committed) {
      throw new MessengerQuotaReservationCommitError();
    }

    quotaCommitted = true;
    safeLog("whatsapp_quota_decision", {
      action: "commit_provider_attempt",
      user: userId,
      generationKind: generationKind ?? null,
      allowed: true,
    });
  };

  try {
    const generationContext = await prepareGeneration(input);

    const result = await executeGenerationFlow({
      userId,
      reqId,
      generationKind,
      promptHint,
      sourceImageUrl,
      lastPhotoUrl: generationContext.lastPhotoUrl,
      lastPhotoSource: generationContext.lastPhotoSource,
      onProviderAttempt: commitProviderAttemptQuota,
    });

    if (result.kind === "success") {
      await commitProviderAttemptQuota();
      await handleGenerationSuccess({
        senderId,
        lang,
        generationKind,
        promptHint,
        imageUrl: result.imageUrl,
        reqId,
      });
      return;
    }

    await handleGenerationFailure({
      senderId,
      userId,
      lang,
      sourceImageUrl,
      lastPhotoUrl: generationContext.lastPhotoUrl,
      result,
    });
  } finally {
    if (!quotaCommitted) {
      await releaseImageGenerationUsage({
        ...quotaInput,
        reservation: quotaReservation,
      });
    }
  }
}
