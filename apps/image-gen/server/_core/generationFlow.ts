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
import type { Style } from "./messengerStyles";
import type { DirectorMode } from "./image-generation/director/directorTypes";
import { storageGet, storageKeyFromPublicUrl } from "../storage";

type GenerationProof = {
  incomingLen: number;
  incomingSha256: string;
  openaiInputLen: number;
  openaiInputSha256: string;
};

type GenerationMetrics = NonNullable<ReturnType<typeof getGenerationMetrics>> | {
  totalMs: number;
  fbImageFetchMs?: number;
  openAiMs?: number;
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
  style: Style;
  userId: string;
  reqId: string;
  promptHint?: string;
  directorMode?: DirectorMode;
  directorInstruction?: string;
  directorPhotoAnalysis?: string;
  sourceImageUrl?: string;
  lastPhotoUrl?: string | null;
  lastPhotoSource?: SourceImageOrigin | null;
};

async function resolveStoredRuntimeSourceUrl(input: {
  sourceImageUrl?: string;
  lastPhotoUrl?: string | null;
  lastPhotoSource?: SourceImageOrigin | null;
}): Promise<{
  resolvedSourceImageUrl?: string;
  trustedSourceImageUrl: boolean;
}> {
  const originalSourceImageUrl =
    input.sourceImageUrl ?? input.lastPhotoUrl ?? undefined;
  const isStoredLastPhoto =
    originalSourceImageUrl !== undefined &&
    originalSourceImageUrl === input.lastPhotoUrl &&
    input.lastPhotoSource === "stored";

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
    console.warn("stored_source_image_url_refresh_failed", {
      storageKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      resolvedSourceImageUrl: originalSourceImageUrl,
      trustedSourceImageUrl: true,
    };
  }
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

  return "generation_failed";
}

export async function executeGenerationFlow(
  input: ExecuteGenerationFlowInput
): Promise<GenerationFlowResult> {
  const { resolvedSourceImageUrl, trustedSourceImageUrl } =
    await resolveStoredRuntimeSourceUrl(input);

  if (!resolvedSourceImageUrl) {
    return {
      kind: "error",
      errorKind: "missing_source_image",
      error: new MissingInputImageError("Missing source image"),
      trustedSourceImageUrl,
    };
  }

  if (!trustedSourceImageUrl) {
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
      style: input.style,
      sourceImageUrl: resolvedSourceImageUrl,
      trustedSourceImageUrl,
      sourceImageProvenance: trustedSourceImageUrl ? "storeInbound" : undefined,
      promptHint: input.promptHint,
      directorMode: input.directorMode,
      directorInstruction: input.directorInstruction,
      directorPhotoAnalysis: input.directorPhotoAnalysis,
      userKey: input.userId,
      reqId: input.reqId,
    });

    return {
      kind: "success",
      imageUrl,
      metrics,
      proof,
      mode,
      resolvedSourceImageUrl,
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

