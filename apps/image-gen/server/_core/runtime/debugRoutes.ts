import type express from "express";
import { z } from "zod";
import { createAdminAuthRateLimiter, verifyAdminToken } from "../adminAuth";
import { isRedisHttpRateLimitEnabled } from "../httpRateLimit";
import { isRedisReplayProtectionEnabled } from "../webhookReplayProtection";

type VersionPayload = {
  gitSha: string;
  timestamp: string;
};

const debugBuildHeadersSchema = z.object({
  "x-admin-token": z.string().min(1).optional(),
});

export function buildVersionPayload(
  gitSha: string,
  bootTimestamp: string
): VersionPayload {
  return {
    gitSha,
    timestamp: bootTimestamp,
  };
}

export function registerVersionRoute(
  app: express.Express,
  getVersionPayload: () => VersionPayload
) {
  app.get("/__version", (_req, res) => {
    res.status(200).json(getVersionPayload());
  });
}

export function registerSentryDebugRoute(app: express.Express) {
  if (process.env.NODE_ENV !== "production") {
    app.get("/debug/sentry", () => {
      throw new Error("Sentry smoke test");
    });
  }
}

export function registerDebugRoutes(app: express.Express, gitSha: string) {
  app.get(
    "/debug/build",
    createAdminAuthRateLimiter({ eventName: "debug_build_auth_rate_limited" }),
    (req, res) => {
      const parsedHeaders = debugBuildHeadersSchema.safeParse(req.headers);
      const providedToken = parsedHeaders.success
        ? parsedHeaders.data["x-admin-token"]
        : undefined;

      if (
        !verifyAdminToken({
          providedToken,
          eventName: "debug_build_auth_failed",
        })
      ) {
        return res.sendStatus(403);
      }

      return res.status(200).json({
        name: "leaderbot-images",
        version: gitSha,
        uptime_s: Math.floor(process.uptime()),
        node: process.version,
        envFlags: {
          hasFbVerifyToken: Boolean(process.env.FB_VERIFY_TOKEN),
          hasFbPageAccessToken: Boolean(process.env.FB_PAGE_ACCESS_TOKEN),
          hasFbAppSecret: Boolean(process.env.FB_APP_SECRET),
          hasAdminToken: Boolean(process.env.ADMIN_TOKEN),
          hasAppBaseUrl: Boolean(process.env.APP_BASE_URL),
        },
        securityStatus: {
          webhookSignatureVerificationEnabled: Boolean(
            process.env.FB_APP_SECRET
          ),
          verifyTokenConfigured: Boolean(process.env.FB_VERIFY_TOKEN),
          webhookReplayProtectionEnabled: true,
          webhookReplayProtectionRedisBacked: isRedisReplayProtectionEnabled(),
          globalHttpRateLimiterEnabled: true,
          globalHttpRateLimiterRedisBacked: isRedisHttpRateLimitEnabled(),
          metricsEndpointEnabled: true,
          requestTracingEnabled: true,
          traceparentPropagationEnabled: true,
        },
      });
    }
  );
}
