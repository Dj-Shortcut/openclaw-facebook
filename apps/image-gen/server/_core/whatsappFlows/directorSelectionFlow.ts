import {
  DIRECTOR_MODE_CONFIGS,
  directorPayloadToMode,
} from "../image-generation/director/directorModes";
import type { DirectorMode } from "../image-generation/director/directorTypes";

function normalizeDirectorToken(text: string): string {
  return text.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

export function parseWhatsAppDirectorSelection(
  text: string
): DirectorMode | undefined {
  const payloadMode = directorPayloadToMode(text);
  if (payloadMode) {
    return payloadMode;
  }

  const normalizedToken = normalizeDirectorToken(text);
  return DIRECTOR_MODE_CONFIGS.find(
    mode =>
      normalizeDirectorToken(mode.mode) === normalizedToken ||
      normalizeDirectorToken(mode.label) === normalizedToken
  )?.mode;
}
