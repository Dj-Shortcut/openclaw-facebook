import { type Style } from "./messengerStyles";
import { safeLen, sha256 } from "./imageProof";
import { buildDirectorPrompt } from "./image-generation/director/directorPromptBuilder";
import { analyzeDirectorPhoto } from "./image-generation/director/directorPhotoAnalyzer";
import type { DirectorMode } from "./image-generation/director/directorTypes";
import {
  attachGenerationMetrics,
  buildOpenAiRequest,
  fetchOpenAiImageResponse,
  finalizeGenerationMetrics,
  getGenerationMetrics,
  parseOpenAiImageResponse,
  type GenerationMetrics,
} from "./image-generation/openAiImageClient";
import { buildStylePrompt } from "./image-generation/promptBuilder";
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
import {
  GenerationTimeoutError,
  InvalidGenerationInputError,
  MissingOpenAiApiKeyError,
} from "./image-generation/imageServiceErrors";
import { createLogger } from "./logger";

const OPENAI_IMAGES_PROVIDER = "openai-images" as const;

export type ImageProvider = typeof OPENAI_IMAGES_PROVIDER;

interface ImageGenerator {
  generate(input: {
    style: Style;
    sourceImageUrl?: string;
    trustedSourceImageUrl?: boolean;
    sourceImageProvenance?: "storeInbound";
    sourceImageData?: {
      buffer: Buffer;
      contentType: string;
    };
    promptHint?: string;
    directorMode?: DirectorMode;
    directorInstruction?: string;
    directorPhotoAnalysis?: string;
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
  style: Style;
  sourceImageUrl?: string;
  trustedSourceImageUrl?: boolean;
  sourceImageProvenance?: "storeInbound";
  sourceImageData?: {
    buffer: Buffer;
    contentType: string;
  };
  promptHint?: string;
  directorMode?: DirectorMode;
  directorInstruction?: string;
  directorPhotoAnalysis?: string;
  userKey: string;
  reqId: string;
};

type PreparedGenerationInput = {
  hasSourceImage: boolean;
  prompt: string;
  sourceImage: DownloadedSourceImage;
};

function ensureJpegBuffer(buffer: Buffer): Buffer {
  return buffer;
}

export function getGeneratorStartupConfig(): {
  mode: ImageProvider;
  resolvedBaseUrl: string | undefined;
  objectStorageEnabled: boolean;
  requiresDurableStorageInProduction: boolean;
} {
  return {
    mode: getImageProvider(),
    resolvedBaseUrl: getConfiguredBaseUrl(),
    objectStorageEnabled: hasObjectStorageConfig(),
    requiresDurableStorageInProduction: true,
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
  const photoAnalysis =
    input.directorMode && !input.directorPhotoAnalysis
      ? await analyzeDirectorPhoto(sourceImage, input.reqId)
      : input.directorPhotoAnalysis;

  return {
    hasSourceImage: computeHasSourceImage(input),
    prompt: input.directorMode
      ? buildDirectorPrompt({
          mode: input.directorMode,
          userInstruction: input.directorInstruction,
          photoAnalysis,
        })
      : buildStylePrompt(input.style, input.promptHint),
    sourceImage,
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
    if (!input.style) {
      throw new InvalidGenerationInputError("Style is required");
    }

    if (!process.env.OPENAI_API_KEY) {
      throw new MissingOpenAiApiKeyError("OPENAI_API_KEY is missing");
    }

    try {
      const provider = getImageProvider();
      const preparedInput = await prepareGenerationInput(input);
      logImageProviderUsed(input, provider, preparedInput.hasSourceImage);
      const sourceImage = preparedInput.sourceImage;
      partialMetrics.fbImageFetchMs = sourceImage.fbImageFetchMs;

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

      const response = await fetchOpenAiImageResponse(buildOpenAiRequest({
        prompt: preparedInput.prompt,
        sourceImage,
        hasSourceImage: preparedInput.hasSourceImage,
      }), {
        reqId: input.reqId,
        startedAt,
        partialMetrics,
      });

      const imageBufferResult = await parseOpenAiImageResponse(response);

      const jpegBuffer = ensureJpegBuffer(imageBufferResult);
      const uploadStartedAt = Date.now();
      const imageUrl = await publishGeneratedImage(
        jpegBuffer,
        input.style,
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
