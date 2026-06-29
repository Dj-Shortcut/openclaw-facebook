const DEFAULT_IMAGE_GENERATION_DAILY_LIMIT = 20;
const DEFAULT_AUDIO_TRANSCRIPTION_DAILY_LIMIT = 5;
const DEFAULT_VIDEO_GENERATION_DAILY_LIMIT = 1;
export const DEFAULT_BOT_TEXT_RATE_LIMIT_MAX = 30;
export const DEFAULT_BOT_TEXT_RATE_LIMIT_WINDOW_SECONDS = 60;

function readNonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim() === "") {
    return fallback;
  }

  const configured = Number(raw);
  if (Number.isFinite(configured) && configured >= 0) {
    return Math.floor(configured);
  }

  return fallback;
}

export function getImageGenerationDailyLimit(): number {
  return readNonNegativeInt(
    "MESSENGER_FREE_DAILY_LIMIT",
    DEFAULT_IMAGE_GENERATION_DAILY_LIMIT
  );
}

export function getAudioTranscriptionDailyLimit(): number {
  return readNonNegativeInt(
    "MESSENGER_AUDIO_TRANSCRIPTION_DAILY_LIMIT",
    DEFAULT_AUDIO_TRANSCRIPTION_DAILY_LIMIT
  );
}

export function getVideoGenerationDailyLimit(): number {
  return readNonNegativeInt(
    "MESSENGER_VIDEO_GENERATION_DAILY_LIMIT",
    DEFAULT_VIDEO_GENERATION_DAILY_LIMIT
  );
}

export function getBotTextRateLimitMax(): number {
  return readNonNegativeInt("BOT_TEXT_RATE_LIMIT_MAX", DEFAULT_BOT_TEXT_RATE_LIMIT_MAX);
}

export function getBotTextRateLimitWindowSeconds(): number {
  return readNonNegativeInt(
    "BOT_TEXT_RATE_LIMIT_WINDOW_SECONDS",
    DEFAULT_BOT_TEXT_RATE_LIMIT_WINDOW_SECONDS
  );
}
