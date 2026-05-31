import { executeGenerationFlow } from "../generationFlow";
import {
  formatDirectorSocialCopy,
  generateDirectorSocialCopy,
} from "../image-generation/director/directorSocialCopy";
import { getDirectorModeConfig } from "../image-generation/director/directorModes";
import type { DirectorMode } from "../image-generation/director/directorTypes";
import { getGenerationMetrics } from "../image-generation/openAiImageClient";
import type { GenerationKind } from "../image-generation/generationTypes";
import { runGuardedGeneration } from "../generationGuard";
import { t, type Lang } from "../i18n";
import type { SourceImageOrigin } from "../messengerState";
import type { Style } from "../messengerStyles";
import { canGenerate, increment } from "../messengerQuota";
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

type ImageGenerationInput = {
  senderId: string;
  userId: string;
  style?: Style;
  reqId: string;
  lang: Lang;
  sourceImageUrl?: string;
  promptHint?: string;
  generationKind?: GenerationKind;
  directorMode?: DirectorMode;
  directorInstruction?: string;
  directorPhotoAnalysis?: string;
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
  style?: Style;
  directorMode?: DirectorMode;
  promptHint?: string;
  resolvedSourceImageUrl?: string;
  trustedSourceImageUrl: boolean;
}): void {
  console.info("[whatsapp webhook] generation requested", {
    user: input.userId,
    style: input.style,
    directorMode: input.directorMode,
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
  const resolvedSourceImageUrl = input.sourceImageUrl ?? state.lastPhotoUrl ?? undefined;

  logGenerationRequested({
    userId: input.userId,
    style: input.style,
    directorMode: input.directorMode,
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
  style?: Style;
  generationKind?: GenerationKind;
  directorMode?: DirectorMode;
  promptHint?: string;
  imageUrl: string;
  reqId: string;
}): Promise<void> {
  await sendWhatsAppImageReply(input.senderId, input.imageUrl);
  const socialCopy = await generateDirectorSocialCopy({
    lang: input.lang,
    directorMode: input.directorMode,
    promptHint: input.promptHint,
    reqId: input.reqId,
  });
  if (socialCopy) {
    await sendWhatsAppTextReply(input.senderId, formatDirectorSocialCopy(socialCopy));
  }
  await increment(input.senderId);
  await setLastGenerated(input.senderId, input.imageUrl);
  await setLastGenerationContext(input.senderId, {
    directorMode: input.directorMode,
    prompt: input.directorMode
      ? getDirectorModeConfig(input.directorMode).label
      : input.promptHint,
  });
  await setFlowState(input.senderId, "RESULT_READY");
  await sendWhatsAppTextReply(
    input.senderId,
    `${t(input.lang, "success")}\n${t(input.lang, "whatsappGenerationFollowup")}`
  );
}

function logGenerationFailure(input: {
  userId: string;
  style?: Style;
  result: GenerationFailure;
}): void {
  const metrics = input.result.metrics ?? getGenerationMetrics(input.result.error);
  console.error("[whatsapp webhook] generation failed", {
    user: input.userId,
    style: input.style,
    totalMs: metrics?.totalMs,
    error:
      input.result.error instanceof Error
        ? input.result.error.message
        : String(input.result.error),
  });
}

function logRejectedSourceImage(input: {
  userId: string;
  style?: Style;
  result: GenerationFailure;
}): void {
  if (
    input.result.errorKind !== "invalid_source_image" ||
    !input.result.resolvedSourceImageUrl
  ) {
    return;
  }

  console.error("[whatsapp webhook] source image rejected", {
    user: input.userId,
    style: input.style,
    sourceImageUrl: summarizeSensitiveUrl(input.result.resolvedSourceImageUrl),
  });
}

async function resolveGenerationFailure(input: {
  senderId: string;
  userId: string;
  style?: Style;
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
  style?: Style;
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
    style,
    reqId,
    lang,
    sourceImageUrl,
    promptHint,
    generationKind,
    directorMode,
    directorInstruction,
    directorPhotoAnalysis,
  } = input;
  const allowed = await canGenerate(senderId);
  if (!allowed) {
    await sendQuotaExceededReply(senderId, lang);
    return;
  }

  const generationContext = await prepareGeneration(input);

  const result = await executeGenerationFlow({
    style,
    userId,
    reqId,
    generationKind,
    promptHint,
    directorMode,
    directorInstruction,
    directorPhotoAnalysis,
    sourceImageUrl,
    lastPhotoUrl: generationContext.lastPhotoUrl,
    lastPhotoSource: generationContext.lastPhotoSource,
  });

  if (result.kind === "success") {
    await handleGenerationSuccess({
      senderId,
      lang,
      style,
      generationKind,
      directorMode,
      promptHint,
      imageUrl: result.imageUrl,
      reqId,
    });
    return;
  }

  await handleGenerationFailure({
    senderId,
    userId,
    style,
    lang,
    sourceImageUrl,
    lastPhotoUrl: generationContext.lastPhotoUrl,
    result,
  });
}
