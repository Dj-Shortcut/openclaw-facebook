import { incrementExpiringCounter } from "./stateStore";

export type FeatureRateLimitConfig = {
  enabled: boolean;
  maxAttempts: number;
  windowSeconds: number;
};

export type FeatureRateLimitDecision = {
  allowed: boolean;
  count: number;
  config: FeatureRateLimitConfig;
};

function readNonNegativeInt(names: string[], fallback: number): number {
  for (const name of names) {
    const configured = Number.parseInt(process.env[name] ?? "", 10);
    if (Number.isFinite(configured) && configured >= 0) {
      return Math.floor(configured);
    }
  }

  return fallback;
}

function envKeyFromFeatureName(featureName: string): string {
  return featureName
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

export function getFeatureRateLimitConfig(input: {
  featureName: string;
  defaultMaxAttempts: number;
  defaultWindowSeconds: number;
  maxEnv?: string;
  windowSecondsEnv?: string;
}): FeatureRateLimitConfig {
  const featureEnvKey = envKeyFromFeatureName(input.featureName);
  const maxAttempts = readNonNegativeInt(
    [
      input.maxEnv,
      `FEATURE_RATE_LIMIT_${featureEnvKey}_MAX`,
    ].filter((name): name is string => Boolean(name)),
    input.defaultMaxAttempts
  );
  const windowSeconds = Math.max(
    1,
    readNonNegativeInt(
      [
        input.windowSecondsEnv,
        `FEATURE_RATE_LIMIT_${featureEnvKey}_WINDOW_SECONDS`,
      ].filter((name): name is string => Boolean(name)),
      input.defaultWindowSeconds
    )
  );

  return {
    enabled: maxAttempts > 0,
    maxAttempts,
    windowSeconds,
  };
}

export async function checkFeatureRateLimit(input: {
  scope: string;
  featureName: string;
  subjectId: string;
  defaultMaxAttempts: number;
  defaultWindowSeconds: number;
  maxEnv?: string;
  windowSecondsEnv?: string;
}): Promise<FeatureRateLimitDecision> {
  const config = getFeatureRateLimitConfig(input);
  if (!config.enabled) {
    return { allowed: true, count: 0, config };
  }

  const key = `feature-rate:${input.scope}:${input.featureName}:${input.subjectId}`;
  const nextCount = await incrementExpiringCounter(key, config.windowSeconds);

  return {
    allowed: nextCount <= config.maxAttempts,
    count: nextCount,
    config,
  };
}
