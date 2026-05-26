import type express from "express";
import { ensureRedisReady, getRedisClient, isRedisEnabled } from "./redis";

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS = 120;
const DEFAULT_MAX_KEYS = 20_000;
const RATE_LIMIT_KEY_PREFIX = "http-rate-limit:";

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, RateLimitBucket>();

function getWindowMs(): number {
  const parsed = Number(process.env.HTTP_RATE_LIMIT_WINDOW_MS);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }

  return DEFAULT_WINDOW_MS;
}

function getMaxRequests(): number {
  const parsed = Number(process.env.HTTP_RATE_LIMIT_MAX_REQUESTS);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }

  return DEFAULT_MAX_REQUESTS;
}

function isRedisHttpRateLimitEnabled(): boolean {
  return isRedisEnabled();
}

function getClientIp(req: express.Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function shouldSkipRateLimit(req: express.Request): boolean {
  return req.path === "/health" || req.path === "/healthz";
}

function pruneBuckets(now: number): void {
  buckets.forEach((bucket, key) => {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  });

  while (buckets.size > DEFAULT_MAX_KEYS) {
    const oldestKey = buckets.keys().next().value;
    if (!oldestKey) {
      break;
    }

    buckets.delete(oldestKey);
  }
}

export function createGlobalHttpRateLimiter(): express.RequestHandler {
  return (req, res, next) => {
    if (shouldSkipRateLimit(req)) {
      next();
      return;
    }

    void applyRateLimit(req, res, next);
  };
}

async function applyRateLimit(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  try {
    const now = Date.now();
    const windowMs = getWindowMs();
    const maxRequests = getMaxRequests();
    const key = `${req.method}:${getClientIp(req)}`;

    if (isRedisHttpRateLimitEnabled()) {
      const windowBucket = Math.floor(now / windowMs);
      const redisKey = `${RATE_LIMIT_KEY_PREFIX}${key}:${windowBucket}`;
      const redis = await getRedisClient();
      const count = await redis.incr(redisKey);

      if (count === 1) {
        await redis.expire(redisKey, Math.max(1, Math.ceil(windowMs / 1000)));
      }

      const resetAt = (windowBucket + 1) * windowMs;
      const remaining = Math.max(0, maxRequests - count);
      res.setHeader("X-RateLimit-Limit", String(maxRequests));
      res.setHeader("X-RateLimit-Remaining", String(remaining));
      res.setHeader("X-RateLimit-Reset", String(Math.ceil(resetAt / 1000)));

      if (count > maxRequests) {
        const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
        res.setHeader("Retry-After", String(retryAfterSeconds));
        res.status(429).json({
          error: "Too Many Requests",
          message: "Global HTTP rate limit exceeded. Please retry shortly.",
        });
        return;
      }

      next();
      return;
    }

    pruneBuckets(now);

    const current = buckets.get(key);
    if (!current || current.resetAt <= now) {
      buckets.set(key, {
        count: 1,
        resetAt: now + windowMs,
      });
      next();
      return;
    }

    current.count += 1;

    const remaining = Math.max(0, maxRequests - current.count);
    res.setHeader("X-RateLimit-Limit", String(maxRequests));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(current.resetAt / 1000)));

    if (current.count > maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({
        error: "Too Many Requests",
        message: "Global HTTP rate limit exceeded. Please retry shortly.",
      });
      return;
    }

    next();
  } catch (error) {
    next(error);
  }
}

function resetGlobalHttpRateLimiter(): void {
  buckets.clear();
}

export async function ensureHttpRateLimiterReady(): Promise<void> {
  await ensureRedisReady();
}

export { DEFAULT_MAX_REQUESTS, DEFAULT_WINDOW_MS, isRedisHttpRateLimitEnabled };
