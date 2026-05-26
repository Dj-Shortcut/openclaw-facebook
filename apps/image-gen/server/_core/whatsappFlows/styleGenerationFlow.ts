import { createHash } from "node:crypto";
import { executeGenerationFlow } from "../generationFlow";
import {
  formatDirectorSocialCopy,
  generateDirectorSocialCopy,
} from "../image-generation/director/directorSocialCopy";
import { getDirectorModeConfig } from "../image-generation/director/directorModes";
import type { DirectorMode } from "../image-generation/director/directorTypes";
import { getGenerationMetrics } from "../image-generation/openAiImageClient";
import { t, type Lang } from "../i18n";
import type { SourceImageOrigin } from "../messengerState";
import type { Style } from "../messengerStyles";
import { canGenerate, increment } from "../messengerQuota";
import {
  clearPendingImageState,
  getOrCreateState,
  setChosenStyle,
  setFlowState,
  setLastGenerated,
  setLastGenerationContext,
} from "../messengerState";
import { STYLE_LABELS } from "../webhookHelpers";
import {
  sendWhatsAppImageReply,
  sendWhatsAppTextReply,
} from "../whatsappResponseService";

type StyleGenerationInput = {
  senderId: string;
  userId: string;
  style: Style;
  reqId: string;
  lang: Lang;
  sourceImageUrl?: string;
  promptHint?: string;
  directorMode?: DirectorMode;
  directorInstruction?: string;
  directorPhotoAnalysis?: string;
};

type GenerationResult = Awaited<ReturnType<typeof executeGenerationFlow>>;
type GenerationFailure = Extract<GenerationResult, { kind: "error" }>;

function summarizeSensitiveUrl(url: string): { host: string; shortHash: string } {
  const shortHash = createHash("sha256").update(url).digest("hex").slice(0, 12);
  try {
    return { host: new URL(url).host || "invalid-url", shortHash };
  } catch {
    return { host: "invalid-url", shortHash };
  }
}

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
  style: Style;
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
  await setFlowState(senderId, "AWAITING_STYLE");
}

async function prepareGeneration(input: StyleGenerationInput): Promise<{
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

  await setChosenStyle(input.senderId, input.style);
  await setFlowState(input.senderId, "PROCESSING");
  await sendWhatsAppTextReply(
    input.senderId,
    t(input.lang, "generatingPrompt", {
      styleLabel: input.directorMode
        ? getDirectorModeConfig(input.directorMode).label
        : STYLE_LABELS[input.style],
    })
  );

  return {
    lastPhotoUrl: state.lastPhotoUrl,
    lastPhotoSource: state.lastPhotoSource,
  };
}

async function handleGenerationSuccess(input: {
  senderId: string;
  lang: Lang;
  style: Style;
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
    style: input.style,
    directorMode: input.directorMode,
    prompt: input.directorMode
      ? getDirectorModeConfig(input.directorMode).label
      : input.promptHint,
  });
  await setFlowState(input.senderId, "RESULT_READY");
  await sendWhatsAppTextReply(
    input.senderId,
    `${t(input.lang, "success")}\n${
      input.lang === "en"
        ? "Reply with 'new style' if you want another version."
        : "Antwoord met 'nieuwe stijl' als je nog een versie wilt."
    }`
  );
}

function logGenerationFailure(input: {
  userId: string;
  style: Style;
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
  style: Style;
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
  style: Style;
  lang: Lang;
  sourceImageUrl?: string;
  lastPhotoUrl?: string | null;
  result: GenerationFailure;
}): Promise<string> {
  if (input.result.errorKind === "missing_source_image") {
    await setFlowState(input.senderId, "AWAITING_PHOTO");
    return t(input.lang, "styleWithoutPhoto");
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
    await setFlowState(input.senderId, "AWAITING_STYLE");
    return t(input.lang, "generationUnavailable");
  }

  if (input.result.errorKind === "generation_timeout") {
    await setFlowState(input.senderId, "AWAITING_STYLE");
    return t(input.lang, "generationTimeout");
  }

  if (input.result.errorKind === "generation_budget_reached") {
    await setFlowState(input.senderId, "AWAITING_STYLE");
    return t(input.lang, "generationBudgetReached");
  }

  await setFlowState(input.senderId, "FAILURE");
  return t(input.lang, "generationGenericFailure");
}

async function handleGenerationFailure(input: {
  senderId: string;
  userId: string;
  style: Style;
  lang: Lang;
  sourceImageUrl?: string;
  lastPhotoUrl?: string | null;
  result: GenerationFailure;
}): Promise<void> {
  logGenerationFailure(input);
  const failureText = await resolveGenerationFailure(input);
  await sendWhatsAppTextReply(input.senderId, failureText);
}

export async function runWhatsAppStyleGeneration(
  input: StyleGenerationInput
): Promise<void> {
  const {
    senderId,
    userId,
    style,
    reqId,
    lang,
    sourceImageUrl,
    promptHint,
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
