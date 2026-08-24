import {
  createImageGenerator,
  type ImageProvider,
  type ProviderAttemptAdmission,
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
import { safeLog } from "./logger";
import type { OpenAiImageQuality } from "./image-generation/openAiImageClient";
import type { CostLedgerTenantScope } from "./costLedger";
import { hashStorageObjectKeyForLog } from "./messengerStorageObject";
import { isLocalGeneratedImageUrl } from "./generatedImageStore";

type GenerationProof = {
  incomingLen: number;
  incomingSha256: string;
  openaiInputLen: number;
  openaiInputSha256: string;
};

type GenerationMetrics =
  | NonNullable<ReturnType<typeof getGenerationMetrics>>
  | {
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
  resolvedSourceImageUrls: string[];
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

type GenerationFlowResult = GenerationFlowSuccess | GenerationFlowFailure;

type ExecuteGenerationFlowInput = {
  generationKind?: GenerationKind;
  userId: string;
  reqId: string;
  promptHint?: string;
  sourceImageUrl?: string;
  sourceImageUrls?: string[];
  lastPhotoUrl?: string | null;
  lastPhotoSource?: SourceImageOrigin | null;
  onProviderAttempt?: () => Promise<ProviderAttemptAdmission | void>;
  onProviderSuccess?: () => Promise<void>;
  bypassBudgetLimits?: boolean;
  costLedgerChannel?: string;
  costLedgerScope?: CostLedgerTenantScope;
  imageModel?: string;
  imageQuality?: OpenAiImageQuality;
};

type RuntimeSourceInput = {
  sourceImageUrl?: string;
  sourceImageUrls?: string[];
  lastPhotoUrl?: string | null;
  lastPhotoSource?: SourceImageOrigin | null;
};

function hasStoredLastPhoto(input: RuntimeSourceInput): boolean {
  return (
    typeof input.lastPhotoUrl === "string" && input.lastPhotoSource === "stored"
  );
}

function logIgnoredSourceImageOverride(
  input: RuntimeSourceInput & { reqId: string }
): void {
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

function selectOriginalSourceImageUrl(
  input: RuntimeSourceInput
): string | undefined {
  return hasStoredLastPhoto(input)
    ? (input.lastPhotoUrl ?? undefined)
    : (input.sourceImageUrl ?? input.lastPhotoUrl ?? undefined);
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
  sourceImageUrls?: string[];
  lastPhotoUrl?: string | null;
  lastPhotoSource?: SourceImageOrigin | null;
  reqId: string;
}): Promise<{
  resolvedSourceImageUrl?: string;
  resolvedSourceImageUrls: string[];
  trustedSourceImageUrl: boolean;
}> {
  if (input.sourceImageUrls?.length) {
    const sourceImageUrls = Array.from(new Set(input.sourceImageUrls));
    const storageKeys = sourceImageUrls.map(storageKeyFromPublicUrl);
    const trustedLocalUrls = sourceImageUrls.map(isLocalGeneratedImageUrl);
    if (
      storageKeys.some((key, index) => !key && trustedLocalUrls[index] !== true)
    ) {
      return {
        resolvedSourceImageUrl: sourceImageUrls.at(-1),
        resolvedSourceImageUrls: sourceImageUrls,
        trustedSourceImageUrl: false,
      };
    }

    if (!process.env.BUILT_IN_FORGE_API_URL?.trim()) {
      return {
        resolvedSourceImageUrl: sourceImageUrls.at(-1),
        resolvedSourceImageUrls: sourceImageUrls,
        trustedSourceImageUrl: true,
      };
    }

    try {
      const refreshedUrls = await Promise.all(
        storageKeys.map(async (key, index) =>
          key ? (await storageGet(key)).url : sourceImageUrls[index]
        )
      );
      return {
        resolvedSourceImageUrl: refreshedUrls.at(-1),
        resolvedSourceImageUrls: refreshedUrls,
        trustedSourceImageUrl: true,
      };
    } catch (error) {
      safeLog("stored_source_image_urls_refresh_failed", {
        level: "warn",
        reqId: input.reqId,
        sourceImageCount: sourceImageUrls.length,
        error,
      });
      return {
        resolvedSourceImageUrl: sourceImageUrls.at(-1),
        resolvedSourceImageUrls: sourceImageUrls,
        trustedSourceImageUrl: true,
      };
    }
  }

  logIgnoredSourceImageOverride(input);

  const originalSourceImageUrl = selectOriginalSourceImageUrl(input);
  const isStoredLastPhoto = isOriginalStoredLastPhoto(
    originalSourceImageUrl,
    input
  );

  if (!originalSourceImageUrl || !isStoredLastPhoto) {
    return {
      resolvedSourceImageUrl: originalSourceImageUrl,
      resolvedSourceImageUrls: originalSourceImageUrl
        ? [originalSourceImageUrl]
        : [],
      trustedSourceImageUrl: false,
    };
  }

  const storageKey = storageKeyFromPublicUrl(originalSourceImageUrl);
  if (!storageKey) {
    const trustedLocalUrl = isLocalGeneratedImageUrl(originalSourceImageUrl);
    return {
      resolvedSourceImageUrl: originalSourceImageUrl,
      resolvedSourceImageUrls: [originalSourceImageUrl],
      trustedSourceImageUrl: trustedLocalUrl,
    };
  }

  if (!process.env.BUILT_IN_FORGE_API_URL?.trim()) {
    return {
      resolvedSourceImageUrl: originalSourceImageUrl,
      resolvedSourceImageUrls: [originalSourceImageUrl],
      trustedSourceImageUrl: true,
    };
  }

  try {
    const refreshed = await storageGet(storageKey);
    return {
      resolvedSourceImageUrl: refreshed.url,
      resolvedSourceImageUrls: [refreshed.url],
      trustedSourceImageUrl: true,
    };
  } catch (error) {
    safeLog("stored_source_image_url_refresh_failed", {
      level: "warn",
      reqId: input.reqId,
      objectKeyHash: hashStorageObjectKeyForLog(storageKey),
      error,
    });
    return {
      resolvedSourceImageUrl: originalSourceImageUrl,
      resolvedSourceImageUrls: [originalSourceImageUrl],
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

  return "generation_failed";
}

export async function executeGenerationFlow(
  input: ExecuteGenerationFlowInput
): Promise<GenerationFlowResult> {
  const {
    resolvedSourceImageUrl,
    resolvedSourceImageUrls,
    trustedSourceImageUrl,
  } = await resolveStoredRuntimeSourceUrl(input);
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
    sourceImageCount: resolvedSourceImageUrls.length,
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
      sourceImageUrls: resolvedSourceImageUrls.length
        ? resolvedSourceImageUrls
        : undefined,
      trustedSourceImageUrl,
      sourceImageProvenance: trustedSourceImageUrl ? "storeInbound" : undefined,
      promptHint: input.promptHint,
      onProviderAttempt: input.onProviderAttempt,
      onProviderSuccess: input.onProviderSuccess,
      bypassBudgetLimits: input.bypassBudgetLimits,
      costLedgerChannel: input.costLedgerChannel,
      costLedgerScope: input.costLedgerScope,
      model: input.imageModel,
      quality: input.imageQuality,
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
      resolvedSourceImageUrls,
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
