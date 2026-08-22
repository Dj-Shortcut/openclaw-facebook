import { safeLen, sha256 } from "./imageProof";
import {
  attachGenerationMetrics,
  buildOpenAiRequest,
  fetchOpenAiImageResponse,
  finalizeGenerationMetrics,
  getGenerationMetrics,
  parseOpenAiImageResponse,
  type GenerationMetrics,
  type OpenAiImageQuality,
} from "./image-generation/openAiImageClient";
import { prepareGenerationInput } from "./image-generation/generationInputPreparer";
import {
  getConfiguredBaseUrl,
  hasObjectStorageConfig,
} from "./image-generation/imageServiceConfig";
import { estimateOpenAiImageRequestCost } from "./image-generation/imageCostEstimate";
import {
  appendCostLedgerEntry,
  safelyUpdateCostLedgerEntry,
} from "./costLedger";
import { publishGeneratedImage } from "./image-generation/generatedImagePublisher";
import type { GenerationKind } from "./image-generation/generationTypes";
import {
  GenerationTimeoutError,
  MissingOpenAiApiKeyError,
} from "./image-generation/imageServiceErrors";
import {
  assertMessengerDailyImageBudgetAvailable,
  admitMessengerProviderSpend,
  getMessengerDailyImageBudgetConfig,
  getMessengerGenerationGlobalLimitConfig,
  releaseMessengerDailyImageBudgetReservation,
} from "./generationGuard";
import {
  isMessengerGenerationInlineFallbackEnabled,
  isMessengerGenerationQueueEnabled,
  isMessengerGenerationWorkerMode,
  isMessengerGenerationWorkerOnlyMode,
} from "./messengerGenerationQueue";
import { createLogger } from "./logger";
import { safeLog } from "./logger";
import { toLogUser } from "./privacy";

const OPENAI_IMAGES_PROVIDER = "openai-images" as const;

export type ImageProvider = typeof OPENAI_IMAGES_PROVIDER;

interface ImageGenerator {
  generate(input: {
    generationKind?: GenerationKind;
    sourceImageUrl?: string;
    sourceImageUrls?: string[];
    trustedSourceImageUrl?: boolean;
    sourceImageProvenance?: "storeInbound";
    sourceImageData?: {
      buffer: Buffer;
      contentType: string;
    };
    promptHint?: string;
    previousResponseId?: string;
    model?: string;
    quality?: OpenAiImageQuality;
    onProviderAttempt?: () => Promise<void>;
    bypassBudgetLimits?: boolean;
    userKey: string;
    reqId: string;
  }): Promise<{
    imageUrl: string;
    proof: {
      incomingLen: number;
      incomingSha256: string;
      openaiInputLen: number;
      openaiInputSha256: string;
    };
    metrics: GenerationMetrics;
  }>;
}

type GeneratorInput = {
  generationKind?: GenerationKind;
  sourceImageUrl?: string;
  sourceImageUrls?: string[];
  trustedSourceImageUrl?: boolean;
  sourceImageProvenance?: "storeInbound";
  sourceImageData?: {
    buffer: Buffer;
    contentType: string;
  };
  promptHint?: string;
  previousResponseId?: string;
  model?: string;
  quality?: OpenAiImageQuality;
  onProviderAttempt?: () => Promise<void>;
  bypassBudgetLimits?: boolean;
  userKey: string;
  reqId: string;
};

function ensureGeneratedImageBuffer(buffer: Buffer): Buffer {
  return buffer;
}

export function getGeneratorStartupConfig(): {
  mode: ImageProvider;
  resolvedBaseUrl: string | undefined;
  objectStorageEnabled: boolean;
  requiresDurableStorageInProduction: boolean;
  messengerGenerationGlobalLimit: ReturnType<
    typeof getMessengerGenerationGlobalLimitConfig
  >;
  messengerGenerationDailyBudget: ReturnType<
    typeof getMessengerDailyImageBudgetConfig
  >;
  messengerGenerationRuntime: {
    queueEnabled: boolean;
    workerMode: boolean;
    workerOnlyMode: boolean;
    inlineFallbackEnabled: boolean;
  };
} {
  return {
    mode: getImageProvider(),
    resolvedBaseUrl: getConfiguredBaseUrl(),
    objectStorageEnabled: hasObjectStorageConfig(),
    requiresDurableStorageInProduction: true,
    messengerGenerationGlobalLimit: getMessengerGenerationGlobalLimitConfig(),
    messengerGenerationDailyBudget: getMessengerDailyImageBudgetConfig(),
    messengerGenerationRuntime: {
      queueEnabled: isMessengerGenerationQueueEnabled(),
      workerMode: isMessengerGenerationWorkerMode(),
      workerOnlyMode: isMessengerGenerationWorkerOnlyMode(),
      inlineFallbackEnabled: isMessengerGenerationInlineFallbackEnabled(),
    },
  };
}

function getImageProvider(): ImageProvider {
  const configured = process.env.IMAGE_PROVIDER?.trim();
  if (!configured) {
    return OPENAI_IMAGES_PROVIDER;
  }

  if (configured === OPENAI_IMAGES_PROVIDER) {
    return configured;
  }

  throw new Error(
    `Unsupported IMAGE_PROVIDER "${configured}". Expected "${OPENAI_IMAGES_PROVIDER}".`
  );
}

function logImageProviderUsed(
  input: GeneratorInput,
  provider: ImageProvider,
  hasSourceImage: boolean
): void {
  createLogger({ reqId: input.reqId }).info({
    msg: "image_provider_used",
    provider,
    hasSourceImage,
  });
}

function estimateFinalCostUsd(input: {
  costEstimateComplete: boolean;
  estimatedCostUsd?: number;
  estimatedOutputCostUsd?: number;
}): number | null {
  if (!input.costEstimateComplete) {
    return null;
  }
  const finalCostUsd =
    (input.estimatedCostUsd ?? 0) + (input.estimatedOutputCostUsd ?? 0);
  return Number.isFinite(finalCostUsd) ? finalCostUsd : null;
}

export class OpenAiImageGenerator implements ImageGenerator {
  async generate(input: GeneratorInput): Promise<{
    imageUrl: string;
    proof: {
      incomingLen: number;
      incomingSha256: string;
      openaiInputLen: number;
      openaiInputSha256: string;
    };
    metrics: GenerationMetrics;
  }> {
    const startedAt = Date.now();
    const partialMetrics: Omit<GenerationMetrics, "totalMs"> = {};
    let lastCostLedgerEntryId: string | null = null;
    let lastCostLedgerEntryRecordedAt: Date | null = null;
    if (!process.env.OPENAI_API_KEY) {
      throw new MissingOpenAiApiKeyError("OPENAI_API_KEY is missing");
    }

    try {
      const provider = getImageProvider();
      const preparedInput = await prepareGenerationInput(input);
      logImageProviderUsed(input, provider, preparedInput.hasSourceImage);
      const sourceImage = preparedInput.sourceImage;
      const sourceImages = preparedInput.sourceImages;
      partialMetrics.fbImageFetchMs = sourceImages.reduce(
        (total, image) => total + image.fbImageFetchMs,
        0
      );
      partialMetrics.promptBuildMs = preparedInput.promptBuildMs;

      const combinedSourceBuffer = preparedInput.hasSourceImage
        ? Buffer.concat(sourceImages.map(image => image.buffer))
        : Buffer.from([]);
      const incomingLen = preparedInput.hasSourceImage
        ? sourceImages.reduce((total, image) => total + image.incomingLen, 0)
        : 0;
      const incomingSha256 = preparedInput.hasSourceImage
        ? sha256(combinedSourceBuffer)
        : sha256(Buffer.from([]));
      const openAiInputHash = preparedInput.hasSourceImage
        ? sha256(combinedSourceBuffer)
        : incomingSha256;
      const openAiInputByteLen = preparedInput.hasSourceImage
        ? safeLen(combinedSourceBuffer)
        : 0;

      const requestBuildStartedAt = Date.now();
      const requestContext = buildOpenAiRequest({
        prompt: preparedInput.prompt,
        sourceImage,
        sourceImages,
        hasSourceImage: preparedInput.hasSourceImage,
        previousResponseId: input.previousResponseId,
        model: input.model,
        quality: input.quality,
      });
      const openAiPayloadBuildMs = Date.now() - requestBuildStartedAt;
      partialMetrics.openAiPayloadBuildMs = openAiPayloadBuildMs;
      const costEstimate = estimateOpenAiImageRequestCost({
        model: requestContext.model,
        ...requestContext.imageCostOptions,
        hasSourceImage: preparedInput.hasSourceImage,
      });
      const payloadBytes =
        typeof requestContext.requestInit.body === "string"
          ? Buffer.byteLength(requestContext.requestInit.body)
          : undefined;
      safeLog("openai_image_payload_built", {
        reqId: input.reqId,
        durationMs: openAiPayloadBuildMs,
        promptChars: preparedInput.prompt.length,
        sourceImageBytes: openAiInputByteLen,
        sourceImageCount: preparedInput.hasSourceImage
          ? sourceImages.length
          : 0,
        payloadBytes,
      });

      let providerAttemptCount = 0;
      const response = await fetchOpenAiImageResponse(requestContext, {
        reqId: input.reqId,
        startedAt,
        partialMetrics,
        onProviderAttempt: async () => {
          const budgetNow = new Date();
          providerAttemptCount += 1;
          const costLedgerEntryId = `${input.reqId}:openai-image:${providerAttemptCount}`;
          const recordAttempt = async () => {
            await input.onProviderAttempt?.();
            if (lastCostLedgerEntryId && lastCostLedgerEntryRecordedAt) {
              await safelyUpdateCostLedgerEntry(
                lastCostLedgerEntryId,
                {
                  status: "provider_attempt_failed",
                  finalCostUsd: null,
                },
                lastCostLedgerEntryRecordedAt
              );
            }
            await appendCostLedgerEntry(
              {
                id: costLedgerEntryId,
                channel: "image_gen",
                operation: "image_generation",
                provider,
                model: costEstimate.model,
                providerUsage: {
                  pricingModel: costEstimate.pricingModel,
                  generationKind: input.generationKind ?? null,
                  hasSourceImage: preparedInput.hasSourceImage,
                  size: costEstimate.size,
                  quality: costEstimate.quality,
                  inputFidelity: costEstimate.inputFidelity ?? null,
                  ...(input.bypassBudgetLimits
                    ? { budgetBypassApplied: true }
                    : {}),
                },
                userKey: input.userKey,
                reqId: input.reqId,
                status: "provider_attempt_started",
                estimatedCostUsd: costEstimate.estimatedCostUsd ?? null,
                estimatedOutputCostUsd:
                  costEstimate.estimatedOutputCostUsd ?? null,
                finalCostUsd: null,
                costEstimateComplete: costEstimate.costEstimateComplete,
                estimateSource: costEstimate.estimateSource,
                unpricedCostComponents:
                  costEstimate.unpricedCostComponents ?? [],
              },
              budgetNow
            );
            lastCostLedgerEntryId = costLedgerEntryId;
            lastCostLedgerEntryRecordedAt = budgetNow;
          };
          let dailyImageBudgetReserved = false;
          try {
            if (!input.bypassBudgetLimits) {
              await assertMessengerDailyImageBudgetAvailable({
                reqId: input.reqId,
                now: budgetNow,
              });
              dailyImageBudgetReserved = true;
            }
            await admitMessengerProviderSpend({
              reqId: input.reqId,
              attemptId: costLedgerEntryId,
              userKey: input.userKey,
              estimatedCostUsd: costEstimate.estimatedCostUsd ?? null,
              estimatedOutputCostUsd:
                costEstimate.estimatedOutputCostUsd ?? null,
              costEstimateComplete: costEstimate.costEstimateComplete,
              now: budgetNow,
              budgetClass: input.bypassBudgetLimits
                ? "owner_emergency"
                : "customer",
              recordAttempt,
            });
          } catch (error) {
            if (dailyImageBudgetReserved) {
              await releaseMessengerDailyImageBudgetReservation({
                now: budgetNow,
              });
            }
            throw error;
          }
        },
      });
      safeLog("image_generation_cost_estimate", {
        reqId: input.reqId,
        user: toLogUser(input.userKey),
        provider,
        model: costEstimate.model,
        pricingModel: costEstimate.pricingModel,
        generationKind: input.generationKind ?? null,
        hasSourceImage: preparedInput.hasSourceImage,
        size: costEstimate.size,
        quality: costEstimate.quality,
        inputFidelity: costEstimate.inputFidelity ?? null,
        estimatedCostUsd: costEstimate.estimatedCostUsd ?? null,
        estimatedOutputCostUsd: costEstimate.estimatedOutputCostUsd ?? null,
        costEstimateComplete: costEstimate.costEstimateComplete,
        unpricedCostComponents: costEstimate.unpricedCostComponents ?? [],
        estimateSource: costEstimate.estimateSource,
        status: "provider_response_received",
      });

      const parseStartedAt = Date.now();
      const imageBufferResult = await parseOpenAiImageResponse(
        response,
        input.reqId
      );
      partialMetrics.openAiParseMs = Date.now() - parseStartedAt;

      const generatedImageBuffer =
        ensureGeneratedImageBuffer(imageBufferResult);
      const uploadStartedAt = Date.now();
      const imageUrl = await publishGeneratedImage(
        generatedImageBuffer,
        input.reqId
      );
      const uploadOrServeMs = Date.now() - uploadStartedAt;
      partialMetrics.uploadOrServeMs = uploadOrServeMs;
      if (lastCostLedgerEntryId && lastCostLedgerEntryRecordedAt) {
        await safelyUpdateCostLedgerEntry(
          lastCostLedgerEntryId,
          {
            status: "provider_attempt_succeeded",
            finalCostUsd: estimateFinalCostUsd(costEstimate),
          },
          lastCostLedgerEntryRecordedAt
        );
      }

      return {
        imageUrl,
        proof: {
          incomingLen,
          incomingSha256,
          openaiInputLen: openAiInputByteLen,
          openaiInputSha256: openAiInputHash,
        },
        metrics: finalizeGenerationMetrics(startedAt, partialMetrics),
      };
    } catch (error) {
      if (lastCostLedgerEntryId && lastCostLedgerEntryRecordedAt) {
        await safelyUpdateCostLedgerEntry(
          lastCostLedgerEntryId,
          {
            status: "provider_attempt_failed",
            finalCostUsd: null,
          },
          lastCostLedgerEntryRecordedAt
        );
      }
      if ((error as { name?: string })?.name === "AbortError") {
        throw attachGenerationMetrics(
          new GenerationTimeoutError("OpenAI generation timed out"),
          finalizeGenerationMetrics(startedAt, partialMetrics)
        );
      }

      throw attachGenerationMetrics(
        error,
        finalizeGenerationMetrics(
          startedAt,
          getGenerationMetrics(error) ?? partialMetrics
        )
      );
    }
  }
}

export function createImageGenerator(
  provider: ImageProvider = getImageProvider()
): {
  mode: ImageProvider;
  generator: ImageGenerator;
} {
  return { mode: provider, generator: new OpenAiImageGenerator() };
}
