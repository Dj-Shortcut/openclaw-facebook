import { MAX_SOURCE_IMAGES, type GenerationKind } from "./generationTypes";
import {
  buildSourceImageEditPrompt,
  buildTextToImagePrompt,
} from "./promptBuilder";
import {
  prepareSourceImage,
  type DownloadedSourceImage,
} from "./sourceImageFetcher";
import {
  resolveSourceImageFetchConfig,
  type SourceImageFetchConfig,
} from "./sourceImageFetchConfig";
import { safeLog } from "../logger";

export type GenerationInputPreparationInput = {
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
  reqId: string;
};

export type PreparedGenerationInput = {
  hasSourceImage: boolean;
  prompt: string;
  sourceImage: DownloadedSourceImage;
  sourceImages: DownloadedSourceImage[];
  promptBuildMs: number;
};

function buildPromptForGeneration(
  input: GenerationInputPreparationInput
): string {
  if (input.generationKind === "text_to_image") {
    return buildTextToImagePrompt(input.promptHint ?? "");
  }

  return buildSourceImageEditPrompt(
    input.promptHint ?? "",
    input.sourceImageUrls?.length ??
      (input.sourceImageUrl || input.sourceImageData ? 1 : 0)
  );
}

export async function prepareGenerationInput(
  input: GenerationInputPreparationInput,
  sourceImageFetchConfig: SourceImageFetchConfig = resolveSourceImageFetchConfig()
): Promise<PreparedGenerationInput> {
  const sourceImageUrls = input.sourceImageUrls?.length
    ? Array.from(new Set(input.sourceImageUrls)).slice(0, MAX_SOURCE_IMAGES)
    : input.sourceImageUrl
      ? [input.sourceImageUrl]
      : [];
  const sourceImages =
    sourceImageUrls.length === 1 && !input.sourceImageUrls?.length
      ? [await prepareSourceImage(input, sourceImageFetchConfig)]
      : sourceImageUrls.length
        ? await Promise.all(
            sourceImageUrls.map((sourceImageUrl, index) =>
              prepareSourceImage(
                {
                  ...input,
                  sourceImageUrl,
                  reqId:
                    sourceImageUrls.length === 1
                      ? input.reqId
                      : `${input.reqId}-source-${index + 1}`,
                },
                sourceImageFetchConfig
              )
            )
          )
        : [await prepareSourceImage(input, sourceImageFetchConfig)];
  const sourceImage = sourceImages[0];
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
    hasSourceImage: Boolean(sourceImageUrls.length || input.sourceImageData),
    prompt,
    sourceImage,
    sourceImages,
    promptBuildMs,
  };
}
