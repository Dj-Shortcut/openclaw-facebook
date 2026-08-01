import { createHash } from "node:crypto";
import type express from "express";
import { getRedisClient, isRedisEnabled } from "./redis";

const INCREMENT_WITH_EXPIRY_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
return count
`;

type SharedRedisRateLimitOptions = Readonly<{
  keyPrefix: string;
  windowMs: number;
  operationTimeoutMs: number;
  limit: () => number;
  keyGenerator: (req: express.Request) => string;
  onLimited: (
    req: express.Request,
    res: express.Response,
    retryAfterSeconds: number
  ) => void;
  onUnavailable: (
    error: unknown,
    req: express.Request,
    res: express.Response
  ) => void;
}>;

export function createSharedRedisRateLimiter(
  options: SharedRedisRateLimitOptions
): express.RequestHandler {
  return (req, res, next) => {
    void applySharedRedisRateLimit(options, req, res, next);
  };
}

async function applySharedRedisRateLimit(
  options: SharedRedisRateLimitOptions,
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): Promise<void> {
  try {
    if (!isRedisEnabled()) {
      throw new Error("shared rate limiter requires Redis");
    }

    const now = Date.now();
    const limit = options.limit();
    if (
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      options.windowMs <= 0 ||
      !Number.isSafeInteger(options.operationTimeoutMs) ||
      options.operationTimeoutMs <= 0
    ) {
      throw new Error("shared rate limiter configuration is invalid");
    }

    const windowBucket = Math.floor(now / options.windowMs);
    const resetAt = (windowBucket + 1) * options.windowMs;
    // Persist only a deterministic digest; never place source IPs or tenant data
    // in Redis rate-limit keys.
    const sourceHash = createHash("sha256")
      .update(options.keyGenerator(req))
      .digest("hex");
    const redisKey = `${options.keyPrefix}${sourceHash}:${windowBucket}`;
    const redis = await withOperationTimeout(
      getRedisClient(),
      options.operationTimeoutMs
    );
    const ttlSeconds = Math.max(1, Math.ceil((resetAt - now) / 1_000));
    const count = Number(
      await withOperationTimeout(
        redis.eval(INCREMENT_WITH_EXPIRY_SCRIPT, 1, redisKey, ttlSeconds),
        options.operationTimeoutMs
      )
    );
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new Error("shared rate limiter returned an invalid count");
    }

    res.setHeader(
      "RateLimit-Policy",
      `${limit};w=${Math.ceil(options.windowMs / 1_000)}`
    );
    res.setHeader("RateLimit-Limit", String(limit));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, limit - count)));
    res.setHeader("RateLimit-Reset", String(ttlSeconds));

    if (count > limit) {
      options.onLimited(req, res, ttlSeconds);
      return;
    }

    next();
  } catch (error) {
    options.onUnavailable(error, req, res);
  }
}

async function withOperationTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error("shared rate limiter Redis operation timed out"));
    }, timeoutMs);
    timeout.unref();
  });

  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
