import type { GenerationKind } from "./generationTypes";
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
  promptBuildMs: number;
};

function buildPromptForGeneration(
  input: GenerationInputPreparationInput
): string {
  if (input.generationKind === "text_to_image") {
    return buildTextToImagePrompt(input.promptHint ?? "");
  }

  return buildSourceImageEditPrompt(input.promptHint ?? "");
}

export async function prepareGenerationInput(
  input: GenerationInputPreparationInput,
  sourceImageFetchConfig: SourceImageFetchConfig = resolveSourceImageFetchConfig()
): Promise<PreparedGenerationInput> {
  const sourceImage = await prepareSourceImage(input, sourceImageFetchConfig);
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
    hasSourceImage: Boolean(input.sourceImageUrl || input.sourceImageData),
    prompt,
    sourceImage,
    promptBuildMs,
  };
}
