const DEFAULT_IMAGE_GENERATION_DAILY_LIMIT = 5;
const DEFAULT_IMAGE_GENERATION_MONTHLY_LIMIT = 20;
const DEFAULT_IMAGE_GENERATION_QUOTA_TIME_ZONE = "Europe/Brussels";
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

export function getImageGenerationMonthlyLimit(): number {
  return readNonNegativeInt(
    "MESSENGER_FREE_MONTHLY_LIMIT",
    DEFAULT_IMAGE_GENERATION_MONTHLY_LIMIT
  );
}

export function getImageGenerationQuotaTimeZone(): string {
  const configured = process.env.MESSENGER_IMAGE_QUOTA_TIME_ZONE?.trim();
  const timeZone = configured || DEFAULT_IMAGE_GENERATION_QUOTA_TIME_ZONE;

  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(0);
    return timeZone;
  } catch {
    return DEFAULT_IMAGE_GENERATION_QUOTA_TIME_ZONE;
  }
}

export function assertProductionImageQuotaConfig(): void {
  if (process.env.NODE_ENV !== "production") return;
  const expected = {
    MESSENGER_FREE_DAILY_LIMIT: String(DEFAULT_IMAGE_GENERATION_DAILY_LIMIT),
    MESSENGER_FREE_MONTHLY_LIMIT: String(
      DEFAULT_IMAGE_GENERATION_MONTHLY_LIMIT
    ),
    MESSENGER_IMAGE_QUOTA_TIME_ZONE: DEFAULT_IMAGE_GENERATION_QUOTA_TIME_ZONE,
  } as const;
  for (const [name, value] of Object.entries(expected)) {
    if (process.env[name]?.trim() !== value) {
      throw new Error(
        `${name} must be explicitly set to ${value} in production`
      );
    }
  }
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
  return readNonNegativeInt(
    "BOT_TEXT_RATE_LIMIT_MAX",
    DEFAULT_BOT_TEXT_RATE_LIMIT_MAX
  );
}

export function getBotTextRateLimitWindowSeconds(): number {
  return readNonNegativeInt(
    "BOT_TEXT_RATE_LIMIT_WINDOW_SECONDS",
    DEFAULT_BOT_TEXT_RATE_LIMIT_WINDOW_SECONDS
  );
}
