import { timingSafeEqual } from "node:crypto";
import type express from "express";
import { safeLog } from "./messengerApi";
import { getRedisClient, isRedisEnabled } from "./redis";

const ADMIN_AUTH_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_AUTH_MAX_ATTEMPTS = 5;
const ADMIN_AUTH_KEY_PREFIX = "admin-auth-rate-limit:";

type AdminAuthBucket = {
  count: number;
  resetAt: number;
};

const adminAuthBuckets = new Map<string, AdminAuthBucket>();

function getClientIp(req: express.Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function getAdminAuthBucketKey(req: express.Request): string {
  return `${req.method}:${req.path}:${getClientIp(req)}`;
}

function getAdminAuthRedisKey(req: express.Request): string {
  return `${ADMIN_AUTH_KEY_PREFIX}${getAdminAuthBucketKey(req)}`;
}

function sendAdminAuthRateLimitExceeded(
  res: express.Response,
  eventName: string,
  retryAfterSeconds: number
): void {
  res.setHeader("Retry-After", String(retryAfterSeconds));
  safeLog(eventName, { reason: "rate_limited" });
  res.status(429).json({
    error: "Too Many Requests",
    message: "Admin authentication rate limit exceeded.",
  });
}

function pruneAdminAuthBuckets(now: number): void {
  for (const [key, bucket] of adminAuthBuckets.entries()) {
    if (bucket.resetAt <= now) {
      adminAuthBuckets.delete(key);
    }
  }
}

export function createAdminAuthRateLimiter(input: {
  eventName: string;
}): express.RequestHandler {
  return (req, res, next) => {
    void applyAdminAuthRateLimit(req, res, next, input.eventName);
  };
}

async function applyAdminAuthRateLimit(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
  eventName: string
): Promise<void> {
  try {
    const now = Date.now();

    if (isRedisEnabled()) {
      const redis = await getRedisClient();
      const key = getAdminAuthRedisKey(req);
      const count = await redis.incr(key);

      if (count === 1) {
        await redis.expire(key, Math.ceil(ADMIN_AUTH_WINDOW_MS / 1000));
      }

      if (count > ADMIN_AUTH_MAX_ATTEMPTS) {
        const ttlSeconds = await redis.ttl(key);
        const retryAfterSeconds = Math.max(
          1,
          ttlSeconds > 0 ? ttlSeconds : Math.ceil(ADMIN_AUTH_WINDOW_MS / 1000)
        );
        sendAdminAuthRateLimitExceeded(res, eventName, retryAfterSeconds);
        return;
      }

      next();
      return;
    }

    pruneAdminAuthBuckets(now);

    const key = getAdminAuthBucketKey(req);
    const current = adminAuthBuckets.get(key);
    if (!current || current.resetAt <= now) {
      adminAuthBuckets.set(key, {
        count: 1,
        resetAt: now + ADMIN_AUTH_WINDOW_MS,
      });
      next();
      return;
    }

    current.count += 1;
    if (current.count > ADMIN_AUTH_MAX_ATTEMPTS) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((current.resetAt - now) / 1000)
      );
      sendAdminAuthRateLimitExceeded(res, eventName, retryAfterSeconds);
      return;
    }

    next();
  } catch (error) {
    next(error);
  }
}

export function verifyAdminToken(input: {
  providedToken: string | undefined;
  eventName: string;
}): boolean {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken || !input.providedToken) {
    safeLog(input.eventName, { reason: "missing_token" });
    return false;
  }

  const expected = Buffer.from(adminToken);
  const provided = Buffer.from(input.providedToken);
  if (expected.length !== provided.length) {
    safeLog(input.eventName, { reason: "length_mismatch" });
    return false;
  }

  const ok = timingSafeEqual(expected, provided);
  if (!ok) {
    safeLog(input.eventName, { reason: "token_mismatch" });
  }
  return ok;
}

export function resetAdminAuthRateLimiterForTests(): void {
  adminAuthBuckets.clear();
}
