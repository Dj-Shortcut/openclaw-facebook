import type { BotFeature } from "../features";
import { readScopedState, writeScopedState } from "../../stateStore";

const RATE_WINDOW_SECONDS = 60;
const RATE_LIMIT = 10;

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

export const rateLimitFeature: BotFeature = {
  name: "rateLimit",
  async onText(context) {
    if (!context.messageText.trim()) {
      return { handled: false };
    }

    const key = `rate:${context.senderId}`;
    const now = Date.now();
    const current =
      (await Promise.resolve(readScopedState<RateLimitBucket>("bot", key))) ?? null;
    const activeBucket =
      current && current.resetAt > now
        ? current
        : { count: 0, resetAt: now + RATE_WINDOW_SECONDS * 1000 };
    const nextCount = activeBucket.count + 1;

    await Promise.resolve(
      writeScopedState(
        "bot",
        key,
        {
          count: nextCount,
          resetAt: activeBucket.resetAt,
        },
        RATE_WINDOW_SECONDS
      )
    );

    if (nextCount <= RATE_LIMIT) {
      return { handled: false };
    }

    context.logger.warn("bot_feature_rate_limited", {
      user: context.userId,
      count: nextCount,
    });
    await context.sendText("⏳ Slow down a bit.");
    return { handled: true };
  },
};
