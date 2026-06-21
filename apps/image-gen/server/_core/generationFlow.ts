import {
  createImageGenerator,
  type ImageProvider,
} from "./imageService";
import {
  GenerationTimeoutError,
  MissingAppBaseUrlError,
  MissingObjectStorageConfigError,
  MissingOpenAiApiKeyError,
} from "./image-generation/imageServiceErrors";
import {
  getGenerationMetrics,
  OpenAiBudgetExceededError,
} from "./image-generation/openAiImageClient";
import {
  InvalidSourceImageUrlError,
  MissingInputImageError,
} from "./image-generation/sourceImageFetcher";
import type { SourceImageOrigin } from "./messengerState";
import type { GenerationKind } from "./image-generation/generationTypes";
import { summarizeSensitiveUrl } from "./utils/urlSummarizer";
import { storageGet, storageKeyFromPublicUrl } from "../storage";
import {
  MessengerDailyImageBudgetExceededError,
  MessengerDailySpendBudgetExceededError,
} from "./generationGuard";
import { MessengerQuotaReservationCommitError } from "./messengerQuota";
import { safeLog } from "./logger";

type GenerationProof = {
  incomingLen: number;
  incomingSha256: string;
  openaiInputLen: number;
  openaiInputSha256: string;
};

type GenerationMetrics = NonNullable<ReturnType<typeof getGenerationMetrics>> | {
  totalMs: number;
  fbImageFetchMs?: number;
  promptBuildMs?: number;
  openAiPayloadBuildMs?: number;
  openAiMs?: number;
  openAiParseMs?: number;
  uploadOrServeMs?: number;
};

type GenerationFlowSuccess = {
  kind: "success";
  imageUrl: string;
  metrics: GenerationMetrics;
  proof: GenerationProof;
  mode: ImageProvider;
  resolvedSourceImageUrl: string;
  trustedSourceImageUrl: boolean;
};

type GenerationFlowFailureKind =
  | "missing_source_image"
  | "invalid_source_image"
  | "missing_input_image"
  | "generation_unavailable"
  | "generation_timeout"
  | "generation_budget_reached"
  | "generation_failed";

type GenerationFlowFailure = {
  kind: "error";
  errorKind: GenerationFlowFailureKind;
  error: unknown;
  metrics?: GenerationMetrics;
  resolvedSourceImageUrl?: string;
  trustedSourceImageUrl: boolean;
};

type GenerationFlowResult =
  | GenerationFlowSuccess
  | GenerationFlowFailure;

type ExecuteGenerationFlowInput = {
  generationKind?: GenerationKind;
  userId: string;
  reqId: string;
  promptHint?: string;
  sourceImageUrl?: string;
  lastPhotoUrl?: string | null;
  lastPhotoSource?: SourceImageOrigin | null;
  onProviderAttempt?: () => Promise<void>;
};

type RuntimeSourceInput = {
  sourceImageUrl?: string;
  lastPhotoUrl?: string | null;
  lastPhotoSource?: SourceImageOrigin | null;
};

function hasStoredLastPhoto(input: RuntimeSourceInput): boolean {
  return typeof input.lastPhotoUrl === "string" && input.lastPhotoSource === "stored";
}

function logIgnoredSourceImageOverride(input: RuntimeSourceInput & { reqId: string }): void {
  if (
    hasStoredLastPhoto(input) &&
    input.sourceImageUrl &&
    input.sourceImageUrl !== input.lastPhotoUrl
  ) {
    safeLog("generation_source_image_override_ignored", {
      level: "warn",
      reqId: input.reqId,
    });
  }
}

function selectOriginalSourceImageUrl(input: RuntimeSourceInput): string | undefined {
  return hasStoredLastPhoto(input)
    ? input.lastPhotoUrl ?? undefined
    : input.sourceImageUrl ?? input.lastPhotoUrl ?? undefined;
}

function isOriginalStoredLastPhoto(
  originalSourceImageUrl: string | undefined,
  input: RuntimeSourceInput
): boolean {
  return (
    originalSourceImageUrl !== undefined &&
    originalSourceImageUrl === input.lastPhotoUrl &&
    input.lastPhotoSource === "stored"
  );
}

async function resolveStoredRuntimeSourceUrl(input: {
  sourceImageUrl?: string;
  lastPhotoUrl?: string | null;
  lastPhotoSource?: SourceImageOrigin | null;
  reqId: string;
}): Promise<{
  resolvedSourceImageUrl?: string;
  trustedSourceImageUrl: boolean;
}> {
  logIgnoredSourceImageOverride(input);

  const originalSourceImageUrl = selectOriginalSourceImageUrl(input);
  const isStoredLastPhoto = isOriginalStoredLastPhoto(originalSourceImageUrl, input);

  if (!originalSourceImageUrl || !isStoredLastPhoto) {
    return {
      resolvedSourceImageUrl: originalSourceImageUrl,
      trustedSourceImageUrl: false,
    };
  }

  const storageKey = storageKeyFromPublicUrl(originalSourceImageUrl);
  if (!storageKey) {
    return {
      resolvedSourceImageUrl: originalSourceImageUrl,
      trustedSourceImageUrl: false,
    };
  }

  if (!process.env.BUILT_IN_FORGE_API_URL?.trim()) {
    return {
      resolvedSourceImageUrl: originalSourceImageUrl,
      trustedSourceImageUrl: true,
    };
  }

  try {
    const refreshed = await storageGet(storageKey);
    return {
      resolvedSourceImageUrl: refreshed.url,
      trustedSourceImageUrl: true,
    };
  } catch (error) {
    safeLog("stored_source_image_url_refresh_failed", {
      level: "warn",
      reqId: input.reqId,
      storageKey,
      error,
    });
    return {
      resolvedSourceImageUrl: originalSourceImageUrl,
      trustedSourceImageUrl: true,
    };
  }
}

function resolveEffectiveGenerationKind(input: {
  generationKind?: ExecuteGenerationFlowInput["generationKind"];
  resolvedSourceImageUrl?: string;
}): NonNullable<ExecuteGenerationFlowInput["generationKind"]> {
  if (input.generationKind) {
    return input.generationKind;
  }

  return input.resolvedSourceImageUrl ? "source_image_edit" : "text_to_image";
}

function classifyGenerationError(error: unknown): GenerationFlowFailureKind {
  if (error instanceof InvalidSourceImageUrlError) {
    return "invalid_source_image";
  }

  if (error instanceof MissingInputImageError) {
    return "missing_input_image";
  }

  if (
    error instanceof MissingOpenAiApiKeyError ||
    error instanceof MissingAppBaseUrlError ||
    error instanceof MissingObjectStorageConfigError
  ) {
    return "generation_unavailable";
  }

  if (error instanceof GenerationTimeoutError) {
    return "generation_timeout";
  }

  if (error instanceof OpenAiBudgetExceededError) {
    return "generation_budget_reached";
  }

  if (
    error instanceof MessengerDailyImageBudgetExceededError ||
    error instanceof MessengerDailySpendBudgetExceededError
  ) {
    return "generation_budget_reached";
  }

  if (error instanceof MessengerQuotaReservationCommitError) {
    return "generation_budget_reached";
  }

  return "generation_failed";
}

export async function executeGenerationFlow(
  input: ExecuteGenerationFlowInput
): Promise<GenerationFlowResult> {
  const { resolvedSourceImageUrl, trustedSourceImageUrl } =
    await resolveStoredRuntimeSourceUrl(input);
  const generationKind = resolveEffectiveGenerationKind({
    generationKind: input.generationKind,
    resolvedSourceImageUrl,
  });

  safeLog("generation_source_image_selected", {
    reqId: input.reqId,
    hasExplicitSourceImageUrl: Boolean(input.sourceImageUrl),
    hasLastPhotoUrl: Boolean(input.lastPhotoUrl),
    lastPhotoSource: input.lastPhotoSource ?? null,
    resolvedSourceImageUrl: resolvedSourceImageUrl
      ? summarizeSensitiveUrl(resolvedSourceImageUrl)
      : null,
    trustedSourceImageUrl,
  });

  if (!resolvedSourceImageUrl && generationKind !== "text_to_image") {
    return {
      kind: "error",
      errorKind: "missing_source_image",
      error: new MissingInputImageError("Missing source image"),
      trustedSourceImageUrl,
    };
  }

  if (resolvedSourceImageUrl && !trustedSourceImageUrl) {
    return {
      kind: "error",
      errorKind: "invalid_source_image",
      error: new InvalidSourceImageUrlError(
        "Only stored source images are allowed in generation flow"
      ),
      resolvedSourceImageUrl,
      trustedSourceImageUrl,
    };
  }

  const { mode, generator } = createImageGenerator();

  try {
    const { imageUrl, proof, metrics } = await generator.generate({
      generationKind,
      sourceImageUrl: resolvedSourceImageUrl,
      trustedSourceImageUrl,
      sourceImageProvenance: trustedSourceImageUrl ? "storeInbound" : undefined,
      promptHint: input.promptHint,
      onProviderAttempt: input.onProviderAttempt,
      userKey: input.userId,
      reqId: input.reqId,
    });

    return {
      kind: "success",
      imageUrl,
      metrics,
      proof,
      mode,
      resolvedSourceImageUrl: resolvedSourceImageUrl ?? "",
      trustedSourceImageUrl,
    };
  } catch (error) {
    return {
      kind: "error",
      errorKind: classifyGenerationError(error),
      error,
      metrics: getGenerationMetrics(error),
      resolvedSourceImageUrl,
      trustedSourceImageUrl,
    };
  }
}
