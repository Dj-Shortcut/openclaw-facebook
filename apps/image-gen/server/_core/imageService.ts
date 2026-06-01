import { safeLen, sha256 } from "./imageProof";
import {
  attachGenerationMetrics,
  buildOpenAiRequest,
  fetchOpenAiImageResponse,
  finalizeGenerationMetrics,
  getGenerationMetrics,
  parseOpenAiImageResponse,
  type GenerationMetrics,
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
import { publishGeneratedImage } from "./image-generation/generatedImagePublisher";
import type { GenerationKind } from "./image-generation/generationTypes";
import {
  GenerationTimeoutError,
  MissingOpenAiApiKeyError,
} from "./image-generation/imageServiceErrors";
import {
  assertMessengerDailyImageBudgetAvailable,
  getMessengerDailyImageBudgetConfig,
  getMessengerGenerationGlobalLimitConfig,
} from "./generationGuard";
import {
  isMessengerGenerationInlineFallbackEnabled,
  isMessengerGenerationQueueEnabled,
  isMessengerGenerationWorkerMode,
  isMessengerGenerationWorkerOnlyMode,
} from "./messengerGenerationQueue";
import { createLogger } from "./logger";

const OPENAI_IMAGES_PROVIDER = "openai-images" as const;

export type ImageProvider = typeof OPENAI_IMAGES_PROVIDER;

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
  trustedSourceImageUrl?: boolean;
  sourceImageProvenance?: "storeInbound";
  sourceImageData?: {
    buffer: Buffer;
    contentType: string;
  };
  promptHint?: string;
  previousResponseId?: string;
  userKey: string;
  reqId: string;
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

  return buildSourceImageEditPrompt(
    input.promptHint ?? ""
  );
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
  console.info(
    JSON.stringify({
      level: "info",
      msg: "image_prompt_built",
      reqId: input.reqId,
      generationKind: input.generationKind ?? null,
      durationMs: promptBuildMs,
      promptChars: prompt.length,
    })
  );

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
    if (!process.env.OPENAI_API_KEY) {
      throw new MissingOpenAiApiKeyError("OPENAI_API_KEY is missing");
    }

    try {
      const provider = getImageProvider();
      const preparedInput = await prepareGenerationInput(input);
      logImageProviderUsed(input, provider, preparedInput.hasSourceImage);
      const sourceImage = preparedInput.sourceImage;
      partialMetrics.fbImageFetchMs = sourceImage.fbImageFetchMs;
      partialMetrics.promptBuildMs = preparedInput.promptBuildMs;

      const incomingLen = preparedInput.hasSourceImage ? sourceImage.incomingLen : 0;
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
      });
      const openAiPayloadBuildMs = Date.now() - requestBuildStartedAt;
      partialMetrics.openAiPayloadBuildMs = openAiPayloadBuildMs;
      const payloadBytes =
        typeof requestContext.requestInit.body === "string"
          ? Buffer.byteLength(requestContext.requestInit.body)
          : undefined;
      console.info(
        JSON.stringify({
          level: "info",
          msg: "openai_image_payload_built",
          reqId: input.reqId,
          durationMs: openAiPayloadBuildMs,
          promptChars: preparedInput.prompt.length,
          sourceImageBytes: openAiInputByteLen,
          payloadBytes,
        })
      );

      await assertMessengerDailyImageBudgetAvailable({ reqId: input.reqId });
      const response = await fetchOpenAiImageResponse(requestContext, {
        reqId: input.reqId,
        startedAt,
        partialMetrics,
      });

      const parseStartedAt = Date.now();
      const imageBufferResult = await parseOpenAiImageResponse(response, input.reqId);
      partialMetrics.openAiParseMs = Date.now() - parseStartedAt;

      const generatedImageBuffer = ensureGeneratedImageBuffer(imageBufferResult);
      const uploadStartedAt = Date.now();
      const imageUrl = await publishGeneratedImage(
        generatedImageBuffer,
        input.reqId
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

export function createImageGenerator(provider: ImageProvider = getImageProvider()): {
  mode: ImageProvider;
  generator: ImageGenerator;
} {
  return { mode: provider, generator: new OpenAiImageGenerator() };
}
