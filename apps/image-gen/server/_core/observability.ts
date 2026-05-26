import { randomBytes, randomUUID } from "node:crypto";
import type express from "express";

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

const requestCounters = new Map<string, number>();
const durationSums = new Map<string, number>();
const durationCounts = new Map<string, number>();
const durationBuckets = new Map<string, number>();
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

function renderPrometheusMetrics(): string {
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

  return `${lines.join("\n")}\n`;
}

export function registerMetricsRoute(app: express.Express): void {
  app.get("/metrics", (_req, res) => {
    res.type("text/plain; version=0.0.4").send(renderPrometheusMetrics());
  });
}

function resetObservabilityMetrics(): void {
  requestCounters.clear();
  durationSums.clear();
  durationCounts.clear();
  durationBuckets.clear();
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
