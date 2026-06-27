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

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function htmlValue(value: unknown): string {
  return escapeHtml(value);
}

function renderSummaryBuckets(
  title: string,
  buckets: Record<string, { attempts: number; estimatedCostUsd: number; finalCostUsd: number }>
): string {
  const entries = Object.entries(buckets).sort((left, right) => {
    const byCost = right[1].estimatedCostUsd - left[1].estimatedCostUsd;
    return byCost || left[0].localeCompare(right[0]);
  });
  const rows = entries.length
    ? entries
        .map(
          ([label, bucket]) => `<tr>
            <td>${escapeHtml(label)}</td>
            <td>${htmlValue(bucket.attempts)}</td>
            <td>${htmlValue(formatUsd(bucket.estimatedCostUsd))}</td>
            <td>${htmlValue(formatUsd(bucket.finalCostUsd))}</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="4">No entries</td></tr>`;

  return `<section>
    <h2>${escapeHtml(title)}</h2>
    <table>
      <thead>
        <tr><th>Name</th><th>Attempts</th><th>Estimated</th><th>Final</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

function renderStatusList(summary: CostLedgerSummary): string {
  return Object.entries(summary.byStatus)
    .map(([status, count]) => `<li><span>${escapeHtml(status)}</span><strong>${htmlValue(count)}</strong></li>`)
    .join("");
}

function renderAdminCostDashboardHtml(params: {
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
      ? `${runtimeStats.deliveryFailureCountToday} Messenger delivery failures today`
      : null,
    runtimeStats.duplicateSkipCountToday > 0
      ? `${runtimeStats.duplicateSkipCountToday} duplicate generation skips today`
      : null,
    queueHealth.failed > 0 ? `${queueHealth.failed} failed queue jobs` : null,
    "available" in queueHealth && queueHealth.available === false
      ? "queue health unavailable"
      : null,
  ].filter((item): item is string => Boolean(item));

  const attentionMarkup = attentionItems.length
    ? attentionItems.map(item => `<li>${escapeHtml(item)}</li>`).join("")
    : "<li>No immediate cost or queue attention items.</li>";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Leaderbot Cost Dashboard</title>
    <style>
      :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
      body { margin: 0; padding: 24px; background: #101318; color: #f6f7f9; }
      main { max-width: 1040px; margin: 0 auto; display: grid; gap: 20px; }
      header, section { border: 1px solid #2d3542; border-radius: 8px; padding: 18px; background: #171c24; }
      h1, h2 { margin: 0 0 12px; }
      p { color: #b8c0cc; }
      .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
      .metric { border: 1px solid #2d3542; border-radius: 6px; padding: 12px; }
      .metric span { display: block; color: #b8c0cc; font-size: 13px; }
      .metric strong { display: block; margin-top: 6px; font-size: 24px; }
      ul { margin: 0; padding-left: 20px; }
      .status { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; padding-left: 0; list-style: none; }
      .status li { display: flex; justify-content: space-between; border-bottom: 1px solid #2d3542; padding: 8px 0; }
      table { width: 100%; border-collapse: collapse; }
      th, td { border-bottom: 1px solid #2d3542; padding: 10px 8px; text-align: left; }
      th { color: #b8c0cc; font-weight: 600; }
      code { color: #d6e2ff; }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>Leaderbot Cost Dashboard</h1>
        <p>Period <code>${escapeHtml(summary.period)}</code>. Aggregate owner view only; no prompts, raw PSIDs, tokens, or generated content are included.</p>
      </header>

      <section class="metrics" aria-label="Cost summary metrics">
        <div class="metric"><span>Estimated spend</span><strong>${htmlValue(formatUsd(summary.estimatedCostUsd))}</strong></div>
        <div class="metric"><span>Final spend</span><strong>${htmlValue(formatUsd(summary.finalCostUsd))}</strong></div>
        <div class="metric"><span>Ledger entries</span><strong>${htmlValue(summary.totalEntries)}</strong></div>
        <div class="metric"><span>Unique users</span><strong>${htmlValue(summary.uniqueUserCount)}</strong></div>
        <div class="metric"><span>Open attempts</span><strong>${htmlValue(summary.openAttemptEntries)}</strong></div>
        <div class="metric"><span>Failed attempts</span><strong>${htmlValue(summary.failedAttemptEntries)}</strong></div>
        <div class="metric"><span>Blocked attempts</span><strong>${htmlValue(summary.blockedEntries)}</strong></div>
        <div class="metric"><span>Delivery failures today</span><strong>${htmlValue(runtimeStats.deliveryFailureCountToday)}</strong></div>
        <div class="metric"><span>Duplicate skips today</span><strong>${htmlValue(runtimeStats.duplicateSkipCountToday)}</strong></div>
        <div class="metric"><span>Queue failed</span><strong>${htmlValue(queueHealth.failed)}</strong></div>
      </section>

      <section>
        <h2>Needs Attention</h2>
        <ul>${attentionMarkup}</ul>
      </section>

      <section>
        <h2>Queue Health</h2>
        <ul class="status">
          <li><span>Enabled</span><strong>${htmlValue(queueHealth.enabled ? "yes" : "no")}</strong></li>
          <li><span>Queued</span><strong>${htmlValue(queueHealth.queued)}</strong></li>
          <li><span>Processing</span><strong>${htmlValue(queueHealth.processing)}</strong></li>
          <li><span>Failed/dead-lettered</span><strong>${htmlValue(queueHealth.failed)}</strong></li>
        </ul>
      </section>

      <section>
        <h2>Status Counts</h2>
        <ul class="status">${renderStatusList(summary)}</ul>
      </section>

      ${renderSummaryBuckets("Operations", summary.byOperation)}
      ${renderSummaryBuckets("Providers", summary.byProvider)}
    </main>
  </body>
</html>`;
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
        res.setHeader("content-type", "text/html; charset=utf-8");
        return res.status(200).send(renderAdminCostDashboardHtml({ summary, queueHealth }));
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
