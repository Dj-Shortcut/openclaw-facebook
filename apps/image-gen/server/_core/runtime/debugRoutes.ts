import { randomUUID } from "node:crypto";
import type express from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { createAdminAuthRateLimiter, verifyAdminToken } from "../adminAuth";
import { getTodayRuntimeStats } from "../botRuntimeStats";
import { summarizeCostLedgerPeriod, type CostLedgerSummary } from "../costLedger";
import { isRedisHttpRateLimitEnabled } from "../httpRateLimit";
import { safeLog } from "../messengerApi";
import {
  getMessengerGenerationQueueStats,
  type MessengerGenerationQueueStats,
} from "../messengerGenerationQueue";
import { isRedisReplayProtectionEnabled } from "../webhookReplayProtection";

type VersionPayload = {
  gitSha: string;
  timestamp: string;
};

const debugBuildHeadersSchema = z.object({
  "x-admin-token": z.string().min(1).optional(),
});
function isValidUtcPeriod(period: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(period)) {
    return false;
  }
  const date = new Date(`${period}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === period;
}

const costSummaryQuerySchema = z.object({
  period: z.string().refine(isValidUtcPeriod).optional(),
});

const adminCostSummaryRouteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

const adminCostDashboardRouteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

const debugBuildRouteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

function currentUtcPeriod(): string {
  return new Date().toISOString().slice(0, 10);
}

type AdminCostSummaryQueueHealth =
  | (MessengerGenerationQueueStats & { available?: true })
  | (MessengerGenerationQueueStats & {
      available: false;
      scrapeError: true;
    });

async function readAdminCostSummaryQueueHealth(
  period: string
): Promise<AdminCostSummaryQueueHealth> {
  try {
    return await getMessengerGenerationQueueStats();
  } catch (error) {
    safeLog("admin_cost_summary_queue_health_unavailable", {
      level: "warn",
      period,
      errorCode: error instanceof Error ? error.constructor.name : "UnknownError",
    });
    return {
      available: false,
      scrapeError: true,
      enabled: true,
      queued: 0,
      processing: 0,
      failed: 0,
    };
  }
}

function readAdminTokenHeader(req: express.Request): string | undefined {
  const parsedHeaders = debugBuildHeadersSchema.safeParse(req.headers);
  return parsedHeaders.success
    ? parsedHeaders.data["x-admin-token"]
    : undefined;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function textValue(value: unknown): string {
  return String(value)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[<>]/g, "")
    .trim();
}

function renderSummaryBucketsText(
  title: string,
  buckets: Record<string, { attempts: number; estimatedCostUsd: number; finalCostUsd: number }>
): string {
  const entries = Object.entries(buckets).sort((left, right) => {
    const byCost = right[1].estimatedCostUsd - left[1].estimatedCostUsd;
    return byCost || left[0].localeCompare(right[0]);
  });
  const rows = entries.length
    ? entries.map(
        ([label, bucket]) =>
          `- ${textValue(label)}: ${bucket.attempts} attempts, estimated ${formatUsd(
            bucket.estimatedCostUsd
          )}, final ${formatUsd(bucket.finalCostUsd)}`
      )
    : ["- No entries"];

  return [title, ...rows].join("\n");
}

function renderStatusListText(summary: CostLedgerSummary): string {
  return Object.entries(summary.byStatus)
    .map(([status, count]) => `- ${textValue(status)}: ${count}`)
    .join("\n");
}

function renderAdminCostDashboardText(params: {
  summary: CostLedgerSummary;
  queueHealth: AdminCostSummaryQueueHealth;
}): string {
  const { summary, queueHealth } = params;
  const runtimeStats = getTodayRuntimeStats();
  const attentionItems = [
    summary.openAttemptEntries > 0 ? `${summary.openAttemptEntries} open provider attempts` : null,
    summary.failedAttemptEntries > 0 ? `${summary.failedAttemptEntries} failed provider attempts` : null,
    summary.blockedEntries > 0 ? `${summary.blockedEntries} budget or quota blocks` : null,
    summary.incompleteEstimateEntries > 0
      ? `${summary.incompleteEstimateEntries} incomplete cost estimates`
      : null,
    runtimeStats.deliveryFailureCountToday > 0
      ? `${runtimeStats.deliveryFailureCountToday} process-local Messenger delivery failures today`
      : null,
    runtimeStats.duplicateSkipCountToday > 0
      ? `${runtimeStats.duplicateSkipCountToday} process-local duplicate generation skips today`
      : null,
    queueHealth.failed > 0 ? `${queueHealth.failed} failed queue jobs` : null,
    "available" in queueHealth && queueHealth.available === false
      ? "queue health unavailable"
      : null,
  ].filter((item): item is string => Boolean(item));

  const attentionLines = attentionItems.length
    ? attentionItems.map(item => `- ${textValue(item)}`)
    : ["- No immediate cost or queue attention items."];

  return [
    "Leaderbot Cost Dashboard",
    `Period: ${textValue(summary.period)}`,
    "Aggregate owner view only; no prompts, raw PSIDs, tokens, or generated content are included.",
    "",
    "Metrics",
    `- Estimated spend: ${formatUsd(summary.estimatedCostUsd)}`,
    `- Final spend: ${formatUsd(summary.finalCostUsd)}`,
    `- Ledger entries: ${summary.totalEntries}`,
    `- Unique users: ${summary.uniqueUserCount}`,
    `- Open attempts: ${summary.openAttemptEntries}`,
    `- Failed attempts: ${summary.failedAttemptEntries}`,
    `- Blocked attempts: ${summary.blockedEntries}`,
    `- Process-local delivery failures today: ${runtimeStats.deliveryFailureCountToday}`,
    `- Process-local duplicate skips today: ${runtimeStats.duplicateSkipCountToday}`,
    `- Queue failed: ${queueHealth.failed}`,
    "",
    "Needs Attention",
    ...attentionLines,
    "",
    "Queue Health",
    `- Enabled: ${queueHealth.enabled ? "yes" : "no"}`,
    `- Queued: ${queueHealth.queued}`,
    `- Processing: ${queueHealth.processing}`,
    `- Failed/dead-lettered: ${queueHealth.failed}`,
    "",
    "Status Counts",
    renderStatusListText(summary),
    "",
    renderSummaryBucketsText("Operations", summary.byOperation),
    "",
    renderSummaryBucketsText("Providers", summary.byProvider),
    "",
  ].join("\n");
}

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
    debugBuildRouteLimiter,
    createAdminAuthRateLimiter({ eventName: "debug_build_auth_rate_limited" }),
    (req, res) => {
      if (
        !verifyAdminToken({
          providedToken: readAdminTokenHeader(req),
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

  app.get(
    "/admin/cost-summary",
    adminCostSummaryRouteLimiter,
    createAdminAuthRateLimiter({ eventName: "admin_cost_summary_auth_rate_limited" }),
    async (req, res) => {
      if (
        !verifyAdminToken({
          providedToken: readAdminTokenHeader(req),
          eventName: "admin_cost_summary_auth_failed",
        })
      ) {
        return res.sendStatus(403);
      }

      const parsedQuery = costSummaryQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        return res.status(400).json({ error: "invalid period" });
      }

      const period = parsedQuery.data.period ?? currentUtcPeriod();
      try {
        const summary = await summarizeCostLedgerPeriod(period);
        const queueHealth = await readAdminCostSummaryQueueHealth(period);
        return res.status(200).json({
          ...summary,
          queueHealth,
        });
      } catch (error) {
        const requestId = `cost_summary_${randomUUID()}`;
        safeLog("admin_cost_summary_failed", {
          level: "error",
          requestId,
          period,
          errorCode: error instanceof Error ? error.constructor.name : "UnknownError",
        });
        return res.status(500).json({
          error: "Failed to summarize cost period",
          requestId,
        });
      }
    }
  );

  app.get(
    "/admin/cost-dashboard",
    adminCostDashboardRouteLimiter,
    createAdminAuthRateLimiter({ eventName: "admin_cost_dashboard_auth_rate_limited" }),
    async (req, res) => {
      if (
        !verifyAdminToken({
          providedToken: readAdminTokenHeader(req),
          eventName: "admin_cost_dashboard_auth_failed",
        })
      ) {
        return res.sendStatus(403);
      }

      const parsedQuery = costSummaryQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        return res.status(400).send("invalid period");
      }

      const period = parsedQuery.data.period ?? currentUtcPeriod();
      try {
        const summary = await summarizeCostLedgerPeriod(period);
        const queueHealth = await readAdminCostSummaryQueueHealth(period);
        res.setHeader("cache-control", "no-store");
        res.setHeader("content-type", "text/plain; charset=utf-8");
        return res.status(200).send(renderAdminCostDashboardText({ summary, queueHealth }));
      } catch (error) {
        const requestId = `cost_dashboard_${randomUUID()}`;
        safeLog("admin_cost_dashboard_failed", {
          level: "error",
          requestId,
          period,
          errorCode: error instanceof Error ? error.constructor.name : "UnknownError",
        });
        return res.status(500).send(`Failed to render cost dashboard. Request id: ${requestId}`);
      }
    }
  );
}
