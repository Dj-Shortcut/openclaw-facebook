import type { BotFeature } from "../features";
import {
  checkFeatureRateLimit,
  getFeatureRateLimitConfig,
} from "../../featureRateLimit";

const DEFAULT_RATE_WINDOW_SECONDS = 60;
const DEFAULT_RATE_LIMIT = 10;
const FEATURE_NAME = "botText";

export function getBotTextRateLimitConfig(): {
  enabled: boolean;
  maxMessages: number;
  windowSeconds: number;
} {
  const config = getFeatureRateLimitConfig({
    featureName: FEATURE_NAME,
    defaultMaxAttempts: DEFAULT_RATE_LIMIT,
    defaultWindowSeconds: DEFAULT_RATE_WINDOW_SECONDS,
    maxEnv: "BOT_TEXT_RATE_LIMIT_MAX",
    windowSecondsEnv: "BOT_TEXT_RATE_LIMIT_WINDOW_SECONDS",
  });

  return {
    enabled: config.enabled,
    maxMessages: config.maxAttempts,
    windowSeconds: config.windowSeconds,
  };
}

export const rateLimitFeature: BotFeature = {
  name: "rateLimit",
  async onText(context) {
    if (!context.messageText.trim()) {
      return { handled: false };
    }

    const decision = await checkFeatureRateLimit({
      scope: "bot",
      featureName: FEATURE_NAME,
      subjectId: context.senderId,
      defaultMaxAttempts: DEFAULT_RATE_LIMIT,
      defaultWindowSeconds: DEFAULT_RATE_WINDOW_SECONDS,
      maxEnv: "BOT_TEXT_RATE_LIMIT_MAX",
      windowSecondsEnv: "BOT_TEXT_RATE_LIMIT_WINDOW_SECONDS",
    });
    if (decision.allowed) {
      return { handled: false };
    }

    context.logger.warn("bot_feature_rate_limited", {
      user: context.userId,
      count: decision.count,
      maxMessages: decision.config.maxAttempts,
      windowSeconds: decision.config.windowSeconds,
    });
    await context.sendText("Slow down a bit.");
    return { handled: true };
  },
};
