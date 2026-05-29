import { getDirectorModeConfig } from "./directorModes";
import type { DirectorPromptInput } from "./directorTypes";

function optionalText(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

export function buildDirectorPrompt(input: DirectorPromptInput): string {
  const mode = getDirectorModeConfig(input.mode);
  const photoAnalysis = optionalText(
    input.photoAnalysis,
    "No photo analysis provided. Infer only from the uploaded image."
  );
  const userInstruction = optionalText(
    input.userInstruction,
    "No extra user instruction. Follow the selected director mode."
  );

  return [
    `Transform the uploaded photo into a ${mode.label} restyle.`,
    "",
    "Creative direction:",
    `- Vibe: ${mode.vibe}.`,
    `- Lighting: ${mode.lighting}.`,
    `- Composition: ${mode.composition}.`,
    `- Color grading: ${mode.colorGrading}.`,
    `- Background atmosphere: ${mode.background}.`,
    `- Camera feel: ${mode.cameraFeel}.`,
    `- Social-media framing: ${mode.socialFraming}.`,
    "",
    "Preserve:",
    "- the person's recognizable identity and facial structure",
    "- the subject's apparent age range",
    "- natural body proportions and realistic anatomy",
    "- the original subject as the visual hero",
    "- the subject role, expression intent, and core presence from the source image",
    "",
    "Improve:",
    "- lighting clarity and dimensionality",
    "- composition, crop, and subject hierarchy",
    "- color grading and atmosphere",
    "- background context and visual storytelling",
    "- polished social-media-ready impact while staying believable",
    "",
    "Avoid:",
    "- distorted faces or changed facial identity",
    "- extra fingers, missing fingers, or broken hands",
    "- fake plastic skin or waxy over-smoothing",
    "- unreadable logos or invented brand text",
    "- oversexualized styling",
    "- changing the person's age",
    "- turning the subject into a different person",
    "",
    "Photo analysis:",
    photoAnalysis,
    "",
    "User instruction:",
    userInstruction,
  ].join("\n");
}
