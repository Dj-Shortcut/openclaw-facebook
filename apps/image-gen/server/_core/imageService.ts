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
import {
  buildSourceImageEditPrompt,
  buildTextToImagePrompt,
} from "./image-generation/promptBuilder";
import {
  type DownloadedSourceImage,
  logSourceImageFetchStart,
  resolveStoredSourceImage,
} from "./image-generation/sourceImageFetcher";
import {
  getConfiguredBaseUrl,
  hasObjectStorageConfig,
} from "./image-generation/imageServiceConfig";
import { estimateOpenAiImageRequestCost } from "./image-generation/imageCostEstimate";
import {
  appendCostLedgerEntry,
  safelyUpdateCostLedgerEntry,
  type CostLedgerScope,
  type CostLedgerSubjectScope,
} from "./costLedger";
import {
  publishGeneratedImage,
  type GeneratedImagePublishHooks,
} from "./image-generation/generatedImagePublisher";
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

export type ProviderAttemptAdmission = Readonly<{
  markTransportStarted: () => Promise<void>;
  abortBeforeTransport: () => Promise<void>;
}>;

interface ImageGenerator {
  generate(input: {
    generationKind?: GenerationKind;
    sourceImageUrl?: string;
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
    onProviderAttempt?: () => Promise<ProviderAttemptAdmission | void>;
    onProviderSuccess?: () => Promise<void>;
    costLedgerScope?: CostLedgerScope;
    userKey: string;
    reqId: string;
    generatedImagePublishHooks?: GeneratedImagePublishHooks;
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
  onProviderAttempt?: () => Promise<ProviderAttemptAdmission | void>;
  onProviderSuccess?: () => Promise<void>;
  costLedgerScope?: CostLedgerScope;
  userKey: string;
  reqId: string;
  generatedImagePublishHooks?: GeneratedImagePublishHooks;
};

type PreparedGenerationInput = {
  hasSourceImage: boolean;
  prompt: string;
  sourceImage: DownloadedSourceImage;
  promptBuildMs: number;
};

function ensureGeneratedImageBuffer(buffer: Buffer): Buffer {
  return buffer;
}

function buildPromptForGeneration(input: GeneratorInput): string {
  if (input.generationKind === "text_to_image") {
    return buildTextToImagePrompt(input.promptHint ?? "");
  }

  if (input.generationKind === "source_image_edit") {
    return buildSourceImageEditPrompt(input.promptHint ?? "");
  }

  return buildSourceImageEditPrompt(input.promptHint ?? "");
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

async function prepareGenerationInput(
  input: GeneratorInput
): Promise<PreparedGenerationInput> {
  // TODO: collapse this orchestration into a dedicated ImageService once prompt and source-image paths are fully extracted.
  logSourceImageFetchStart(input);
  const sourceImage = await resolveStoredSourceImage(input);
  const promptStartedAt = Date.now();
  const prompt = buildPromptForGeneration(input);
  const promptBuildMs = Date.now() - promptStartedAt;
  safeLog("image_prompt_built", {
    reqId: input.reqId,
    generationKind: input.generationKind ?? null,
    durationMs: promptBuildMs,
    promptChars: prompt.length,
  });

  return {
    hasSourceImage: computeHasSourceImage(input),
    prompt,
    sourceImage,
    promptBuildMs,
  };
}

function computeHasSourceImage(input: GeneratorInput): boolean {
  return Boolean(input.sourceImageUrl || input.sourceImageData);
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

function resolveCostLedgerSubject(
  input: GeneratorInput
): CostLedgerSubjectScope {
  if (input.costLedgerScope) {
    return { ...input.costLedgerScope, userKey: input.userKey };
  }
  // Existing provider-unit tests intentionally exercise this service without
  // a channel runtime. Production never receives a synthetic tenant scope:
  // an unbound channel path fails closed before the provider boundary.
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
    return {
      workspaceId: 1,
      channelConnectionId: 1,
      bindingEpoch: 1,
      privacyEpoch: 1,
      userKey: input.userKey,
    };
  }
  throw new Error("Tenant-scoped cost ledger ownership is required");
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
    let providerResponseAccepted = false;
    const preTransportAdmissionFailures = new Set<unknown>();
    if (!process.env.OPENAI_API_KEY) {
      throw new MissingOpenAiApiKeyError("OPENAI_API_KEY is missing");
    }
    const costLedgerSubject = resolveCostLedgerSubject(input);
    const costLedgerScope: CostLedgerScope = {
      workspaceId: costLedgerSubject.workspaceId,
      channelConnectionId: costLedgerSubject.channelConnectionId,
      bindingEpoch: costLedgerSubject.bindingEpoch,
      privacyEpoch: costLedgerSubject.privacyEpoch,
    };

    try {
      const provider = getImageProvider();
      const preparedInput = await prepareGenerationInput(input);
      logImageProviderUsed(input, provider, preparedInput.hasSourceImage);
      const sourceImage = preparedInput.sourceImage;
      partialMetrics.fbImageFetchMs = sourceImage.fbImageFetchMs;
      partialMetrics.promptBuildMs = preparedInput.promptBuildMs;

      const incomingLen = preparedInput.hasSourceImage
        ? sourceImage.incomingLen
        : 0;
      const incomingSha256 = preparedInput.hasSourceImage
        ? sourceImage.incomingSha256
        : sha256(Buffer.from([]));
      const openAiInputHash = preparedInput.hasSourceImage
        ? sha256(sourceImage.buffer)
        : incomingSha256;
      const openAiInputByteLen = preparedInput.hasSourceImage
        ? safeLen(sourceImage.buffer)
        : 0;

      const requestBuildStartedAt = Date.now();
      const requestContext = buildOpenAiRequest({
        prompt: preparedInput.prompt,
        sourceImage,
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
          await assertMessengerDailyImageBudgetAvailable({
            reqId: input.reqId,
            now: budgetNow,
          });
          try {
            await admitMessengerProviderSpend({
              reqId: input.reqId,
              attemptId: costLedgerEntryId,
              scope: costLedgerScope,
              userKey: input.userKey,
              estimatedCostUsd: costEstimate.estimatedCostUsd ?? null,
              estimatedOutputCostUsd:
                costEstimate.estimatedOutputCostUsd ?? null,
              costEstimateComplete: costEstimate.costEstimateComplete,
              now: budgetNow,
              recordAttempt: async () => {
                const admission = await input.onProviderAttempt?.();
                let ledgerEntryRecorded = false;
                try {
                  if (lastCostLedgerEntryId && lastCostLedgerEntryRecordedAt) {
                    await safelyUpdateCostLedgerEntry(
                      costLedgerSubject,
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
                      scope: costLedgerScope,
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
                  ledgerEntryRecorded = true;
                  lastCostLedgerEntryId = costLedgerEntryId;
                  lastCostLedgerEntryRecordedAt = budgetNow;

                  // This is the final local boundary before fetch. The tenant
                  // fence is not started until durable cost admission exists.
                  await admission?.markTransportStarted();
                } catch (error) {
                  const cleanupErrors: unknown[] = [];
                  if (ledgerEntryRecorded) {
                    try {
                      await safelyUpdateCostLedgerEntry(
                        costLedgerSubject,
                        costLedgerEntryId,
                        {
                          status: "provider_attempt_failed",
                          finalCostUsd: null,
                        },
                        budgetNow
                      );
                    } catch (cleanupError) {
                      cleanupErrors.push(cleanupError);
                    }
                  }
                  try {
                    await admission?.abortBeforeTransport();
                  } catch (cleanupError) {
                    cleanupErrors.push(cleanupError);
                  }
                  if (cleanupErrors.length > 0) {
                    const cleanupFailure = new AggregateError(
                      [error, ...cleanupErrors],
                      "Provider admission cleanup failed",
                      { cause: error }
                    );
                    preTransportAdmissionFailures.add(cleanupFailure);
                    throw cleanupFailure;
                  }
                  preTransportAdmissionFailures.add(error);
                  throw error;
                }
              },
            });
          } catch (error) {
            await releaseMessengerDailyImageBudgetReservation({
              now: budgetNow,
            });
            throw error;
          }
        },
      });
      // A 2xx response proves the billable provider operation completed.
      // Persist that outcome before parsing or object storage: either of those
      // local steps may fail after the provider has already incurred cost.
      providerResponseAccepted = true;
      if (lastCostLedgerEntryId && lastCostLedgerEntryRecordedAt) {
        await safelyUpdateCostLedgerEntry(
          costLedgerSubject,
          lastCostLedgerEntryId,
          {
            status: "provider_attempt_succeeded",
            finalCostUsd: estimateFinalCostUsd(costEstimate),
          },
          lastCostLedgerEntryRecordedAt
        );
      }
      await input.onProviderSuccess?.();
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
        input.reqId,
        input.generatedImagePublishHooks
      );
      const uploadOrServeMs = Date.now() - uploadStartedAt;
      partialMetrics.uploadOrServeMs = uploadOrServeMs;

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
      if (
        !providerResponseAccepted &&
        lastCostLedgerEntryId &&
        lastCostLedgerEntryRecordedAt
      ) {
        await safelyUpdateCostLedgerEntry(
          costLedgerSubject,
          lastCostLedgerEntryId,
          {
            status: "provider_attempt_failed",
            finalCostUsd: null,
          },
          lastCostLedgerEntryRecordedAt
        );
      }
      if (
        (error as { name?: string })?.name === "AbortError" &&
        !preTransportAdmissionFailures.has(error)
      ) {
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
