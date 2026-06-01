import { randomBytes, randomUUID } from "node:crypto";
import type express from "express";
import { isDebugLogEnabled } from "./logLevel";
import {
  getMessengerDailyImageBudgetConfig,
  getMessengerGenerationGlobalLimitStats,
} from "./generationGuard";
import {
  getMessengerGenerationQueueStats,
  isMessengerGenerationInlineFallbackEnabled,
  isMessengerGenerationWorkerMode,
  isMessengerGenerationWorkerOnlyMode,
} from "./messengerGenerationQueue";
import { getTodayRuntimeStats } from "./botRuntimeStats";

type RequestWithId = express.Request & {
  requestId?: string;
  traceContext?: {
    traceId: string;
    spanId: string;
    traceparent: string;
  };
};

type MetricKey = {
  method: string;
  path: string;
  status: string;
};

type WebhookAckMetricKey = {
  channel: string;
  mode: string;
};

const requestCounters = new Map<string, number>();
const durationSums = new Map<string, number>();
const durationCounts = new Map<string, number>();
const durationBuckets = new Map<string, number>();
const webhookAckDurationSums = new Map<string, number>();
const webhookAckDurationCounts = new Map<string, number>();
const webhookAckDurationBuckets = new Map<string, number>();
const latencyBucketBoundariesMs = [50, 100, 250, 500, 1000, 2500, 5000];
const TRACEPARENT_REGEX = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function normalizePath(path: string): string {
  return path || "/";
}

function metricLabelKey({ method, path, status }: MetricKey): string {
  return `method="${escapeLabelValue(method)}",path="${escapeLabelValue(path)}",status="${escapeLabelValue(status)}"`;
}

function durationBucketKey(method: string, path: string, le: string): string {
  return `method="${escapeLabelValue(method)}",path="${escapeLabelValue(path)}",le="${escapeLabelValue(le)}"`;
}

function webhookAckMetricLabelKey({ channel, mode }: WebhookAckMetricKey): string {
  return `channel="${escapeLabelValue(channel)}",mode="${escapeLabelValue(mode)}"`;
}

function webhookAckDurationBucketKey(channel: string, mode: string, le: string): string {
  return `channel="${escapeLabelValue(channel)}",mode="${escapeLabelValue(mode)}",le="${escapeLabelValue(le)}"`;
}

function incrementMetric(map: Map<string, number>, key: string, delta = 1): void {
  map.set(key, (map.get(key) ?? 0) + delta);
}

export function attachRequestTracing(): express.RequestHandler {
  return (req, res, next) => {
    const incomingRequestId = req.header("X-Request-Id")?.trim();
    const requestId = incomingRequestId || randomUUID();
    const traceContext = parseOrCreateTraceContext(req.header("traceparent"));

    (req as RequestWithId).requestId = requestId;
    (req as RequestWithId).traceContext = traceContext;
    res.setHeader("X-Request-Id", requestId);
    res.setHeader("traceparent", traceContext.traceparent);
    res.setHeader("X-Trace-Id", traceContext.traceId);
    next();
  };
}

export function getRequestId(req: express.Request): string | undefined {
  return (req as RequestWithId).requestId;
}

export function getTraceContext(req: express.Request):
  | {
      traceId: string;
      spanId: string;
      traceparent: string;
    }
  | undefined {
  return (req as RequestWithId).traceContext;
}

export function recordHttpRequestMetric(method: string, path: string, statusCode: number, durationMs: number): void {
  const normalizedPath = normalizePath(path);
  const status = String(statusCode);
  const labels = metricLabelKey({ method, path: normalizedPath, status });
  incrementMetric(requestCounters, labels);
  incrementMetric(durationSums, labels, durationMs / 1000);
  incrementMetric(durationCounts, labels);

  for (const bucketMs of latencyBucketBoundariesMs) {
    if (durationMs <= bucketMs) {
      incrementMetric(durationBuckets, durationBucketKey(method, normalizedPath, String(bucketMs / 1000)));
    }
  }
  incrementMetric(durationBuckets, durationBucketKey(method, normalizedPath, "+Inf"));
}

export function createRequestMetricsMiddleware(): express.RequestHandler {
  return (req, res, next) => {
    const startTime = process.hrtime.bigint();

    res.on("finish", () => {
      const durationMs =
        Number(process.hrtime.bigint() - startTime) / 1_000_000;
      const log = {
        reqId: getRequestId(req),
        traceId: getTraceContext(req)?.traceId,
        spanId: getTraceContext(req)?.spanId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Number(durationMs.toFixed(1)),
      };
      recordHttpRequestMetric(req.method, req.path, res.statusCode, durationMs);

      // Keep info logs compact: skip webhook and health checks unless debug logging is enabled.
      const shouldLogAtInfo =
        !req.path.startsWith("/webhook") &&
        req.path !== "/healthz" &&
        req.path !== "/health" &&
        req.path !== "/metrics";
      if (isDebugLogEnabled() || shouldLogAtInfo) {
        console.log(JSON.stringify(log));
      }
    });

    next();
  };
}

export function recordWebhookAckMetric(channel: string, mode: string, durationMs: number): void {
  const labels = webhookAckMetricLabelKey({ channel, mode });
  incrementMetric(webhookAckDurationSums, labels, durationMs / 1000);
  incrementMetric(webhookAckDurationCounts, labels);

  for (const bucketMs of latencyBucketBoundariesMs) {
    if (durationMs <= bucketMs) {
      incrementMetric(webhookAckDurationBuckets, webhookAckDurationBucketKey(channel, mode, String(bucketMs / 1000)));
    }
  }
  incrementMetric(webhookAckDurationBuckets, webhookAckDurationBucketKey(channel, mode, "+Inf"));
}

async function renderMessengerGenerationQueueMetrics(): Promise<string[]> {
  try {
    const stats = await getMessengerGenerationQueueStats();
    const globalLimitStats = await getMessengerGenerationGlobalLimitStats();
    const dailyBudget = getMessengerDailyImageBudgetConfig();
    return [
      "# HELP messenger_generation_queue_enabled Whether the Messenger generation queue is enabled",
      "# TYPE messenger_generation_queue_enabled gauge",
      `messenger_generation_queue_enabled ${stats.enabled ? 1 : 0}`,
      "# HELP messenger_generation_worker_mode Whether this process runs the Messenger generation worker loop",
      "# TYPE messenger_generation_worker_mode gauge",
      `messenger_generation_worker_mode ${isMessengerGenerationWorkerMode() ? 1 : 0}`,
      "# HELP messenger_generation_worker_only_mode Whether this process runs only the Messenger generation worker without HTTP",
      "# TYPE messenger_generation_worker_only_mode gauge",
      `messenger_generation_worker_only_mode ${isMessengerGenerationWorkerOnlyMode() ? 1 : 0}`,
      "# HELP messenger_generation_inline_fallback_enabled Whether this process may drain queued Messenger generation jobs inline",
      "# TYPE messenger_generation_inline_fallback_enabled gauge",
      `messenger_generation_inline_fallback_enabled ${isMessengerGenerationInlineFallbackEnabled() ? 1 : 0}`,
      "# HELP messenger_generation_queue_jobs Messenger generation queue depth by state",
      "# TYPE messenger_generation_queue_jobs gauge",
      `messenger_generation_queue_jobs{state="queued"} ${stats.queued}`,
      `messenger_generation_queue_jobs{state="processing"} ${stats.processing}`,
      `messenger_generation_queue_jobs{state="failed"} ${stats.failed}`,
      "# HELP messenger_generation_global_slots Messenger generation global concurrency slots",
      "# TYPE messenger_generation_global_slots gauge",
      `messenger_generation_global_slots{state="active"} ${globalLimitStats.active}`,
      `messenger_generation_global_slots{state="max"} ${globalLimitStats.max}`,
      "# HELP messenger_generation_global_slots_redis_backed Whether global generation slots are Redis-backed",
      "# TYPE messenger_generation_global_slots_redis_backed gauge",
      `messenger_generation_global_slots_redis_backed ${globalLimitStats.redisBacked ? 1 : 0}`,
      "# HELP messenger_generation_daily_budget_enabled Whether the optional daily Messenger image budget cap is enabled",
      "# TYPE messenger_generation_daily_budget_enabled gauge",
      `messenger_generation_daily_budget_enabled ${dailyBudget.enabled ? 1 : 0}`,
      "# HELP messenger_generation_daily_budget_cap Configured optional daily Messenger image request cap, or 0 when disabled",
      "# TYPE messenger_generation_daily_budget_cap gauge",
      `messenger_generation_daily_budget_cap ${dailyBudget.cap ?? 0}`,
      "# HELP messenger_generation_queue_scrape_error Whether queue metric collection failed",
      "# TYPE messenger_generation_queue_scrape_error gauge",
      "messenger_generation_queue_scrape_error 0",
    ];
  } catch {
    return [
      "# HELP messenger_generation_queue_scrape_error Whether queue metric collection failed",
      "# TYPE messenger_generation_queue_scrape_error gauge",
      "messenger_generation_queue_scrape_error 1",
    ];
  }
}

async function renderPrometheusMetrics(): Promise<string> {
  const runtimeStats = getTodayRuntimeStats();
  const lines: string[] = [
    "# HELP http_requests_total Total HTTP requests handled by the server",
    "# TYPE http_requests_total counter",
  ];

  for (const [labels, value] of requestCounters.entries()) {
    lines.push(`http_requests_total{${labels}} ${value}`);
  }

  lines.push("# HELP http_request_duration_seconds HTTP request duration in seconds");
  lines.push("# TYPE http_request_duration_seconds histogram");

  for (const [labels, value] of durationBuckets.entries()) {
    lines.push(`http_request_duration_seconds_bucket{${labels}} ${value}`);
  }

  for (const [labels, value] of durationSums.entries()) {
    lines.push(`http_request_duration_seconds_sum{${labels}} ${value.toFixed(6)}`);
  }

  for (const [labels, value] of durationCounts.entries()) {
    lines.push(`http_request_duration_seconds_count{${labels}} ${value}`);
  }

  lines.push("# HELP webhook_ack_duration_seconds Webhook acknowledgement latency in seconds");
  lines.push("# TYPE webhook_ack_duration_seconds histogram");

  for (const [labels, value] of webhookAckDurationBuckets.entries()) {
    lines.push(`webhook_ack_duration_seconds_bucket{${labels}} ${value}`);
  }

  for (const [labels, value] of webhookAckDurationSums.entries()) {
    lines.push(`webhook_ack_duration_seconds_sum{${labels}} ${value.toFixed(6)}`);
  }

  for (const [labels, value] of webhookAckDurationCounts.entries()) {
    lines.push(`webhook_ack_duration_seconds_count{${labels}} ${value}`);
  }

  lines.push(...await renderMessengerGenerationQueueMetrics());
  lines.push("# HELP messenger_generation_today_total Successful Messenger image generations recorded by this process today");
  lines.push("# TYPE messenger_generation_today_total gauge");
  lines.push(`messenger_generation_today_total ${runtimeStats.imagesGeneratedToday}`);
  lines.push("# HELP messenger_generation_errors_today_total Failed Messenger image generations recorded by this process today");
  lines.push("# TYPE messenger_generation_errors_today_total gauge");
  lines.push(`messenger_generation_errors_today_total ${runtimeStats.errorCountToday}`);
  lines.push("# HELP messenger_generation_active_users_today Active Messenger users recorded by this process today");
  lines.push("# TYPE messenger_generation_active_users_today gauge");
  lines.push(`messenger_generation_active_users_today ${runtimeStats.activeUsersToday}`);
  lines.push("# HELP messenger_generation_kinds_used_today Distinct generation kinds recorded by this process today");
  lines.push("# TYPE messenger_generation_kinds_used_today gauge");
  lines.push(`messenger_generation_kinds_used_today ${runtimeStats.generationKindsUsedToday}`);
  lines.push("# HELP messenger_generation_average_latency_seconds Average successful Messenger image generation latency recorded by this process today");
  lines.push("# TYPE messenger_generation_average_latency_seconds gauge");
  lines.push(`messenger_generation_average_latency_seconds ${
    runtimeStats.averageGenerationLatencyMs === null
      ? 0
      : (runtimeStats.averageGenerationLatencyMs / 1000).toFixed(6)
  }`);

  return `${lines.join("\n")}\n`;
}

export function registerMetricsRoute(app: express.Express): void {
  app.get("/metrics", async (_req, res) => {
    res.type("text/plain; version=0.0.4").send(await renderPrometheusMetrics());
  });
}

function resetObservabilityMetrics(): void {
  requestCounters.clear();
  durationSums.clear();
  durationCounts.clear();
  durationBuckets.clear();
  webhookAckDurationSums.clear();
  webhookAckDurationCounts.clear();
  webhookAckDurationBuckets.clear();
}

function parseOrCreateTraceContext(traceparentHeader: string | undefined) {
  const parsed = traceparentHeader ? TRACEPARENT_REGEX.exec(traceparentHeader.trim()) : null;
  const traceId = parsed?.[1]?.toLowerCase() ?? randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  const traceFlags = parsed?.[3]?.toLowerCase() ?? "01";

  return {
    traceId,
    spanId,
    traceparent: `00-${traceId}-${spanId}-${traceFlags}`,
  };
}
