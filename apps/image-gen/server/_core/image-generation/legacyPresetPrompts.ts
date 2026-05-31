import { type Style } from "../messengerStyles";
import { buildSourceImageEditPrompt } from "./promptBuilder";

function styleToNaturalLanguage(style: Style): string {
  return style.replace(/-/g, " ");
}

export function buildLegacyPresetPrompt(style: Style, promptHint?: string): string {
  const trimmedPromptHint = promptHint?.trim();
  return buildSourceImageEditPrompt(
    trimmedPromptHint ||
      `Apply ${styleToNaturalLanguage(style)} as natural-language visual direction.`
  );
}
