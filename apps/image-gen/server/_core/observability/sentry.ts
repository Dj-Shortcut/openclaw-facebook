import * as Sentry from "@sentry/node";
import { safeLog } from "../logger";
import { isDebugLogEnabled } from "../logLevel";

const SAFE_CONTEXT_VALUES: Record<string, ReadonlySet<string>> = {
  area: new Set(["webhook"]),
  eventType: new Set(["message", "postback", "unknown"]),
};
const SAFE_CONTEXT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

function logDroppedContextKey(key: string): void {
  if (!isDebugLogEnabled()) {
    return;
  }

  safeLog("sentry_context_value_dropped", {
    level: "debug",
    fieldKey: SAFE_CONTEXT_KEY_PATTERN.test(key) ? key : "invalid_context_key",
  });
}

function getSafeErrorClass(error: unknown): string {
  const candidate =
    error instanceof Error ? error.constructor.name : "UnknownError";
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(candidate)
    ? candidate
    : "UnknownError";
}

function getSafeContextValue(key: string, value: unknown): unknown {
  if (!SAFE_CONTEXT_KEY_PATTERN.test(key)) {
    logDroppedContextKey(key);
    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }
  if (
    key === "reqId" &&
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
  ) {
    return value;
  }
  if (typeof value === "string" && SAFE_CONTEXT_VALUES[key]?.has(value)) {
    return value;
  }
  if (
    key === "errorClass" &&
    typeof value === "string" &&
    /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)
  ) {
    return value;
  }
  logDroppedContextKey(key);
  return undefined;
}

function scrubSentryEvent<
  T extends {
    breadcrumbs?: unknown;
    contexts?: unknown;
    exception?: {
      values?: Array<{
        type?: string;
        value?: string;
        mechanism?: { data?: unknown };
        stacktrace?: {
          frames?: Array<{
            vars?: unknown;
            pre_context?: unknown;
            context_line?: unknown;
            post_context?: unknown;
          }>;
        };
      }>;
    };
    extra?: Record<string, unknown>;
    fingerprint?: unknown;
    message?: unknown;
    request?: unknown;
    tags?: unknown;
    transaction?: unknown;
    user?: unknown;
  },
>(event: T): T {
  delete event.request;
  delete event.user;
  delete event.breadcrumbs;
  delete event.contexts;
  delete event.tags;
  delete event.fingerprint;
  delete event.transaction;
  delete event.message;

  if (event.extra) {
    event.extra = Object.fromEntries(
      Object.entries(event.extra).flatMap(([key, value]) => {
        const safeValue = getSafeContextValue(key, value);
        return safeValue === undefined ? [] : [[key, safeValue]];
      })
    );
  }

  for (const exception of event.exception?.values ?? []) {
    exception.type =
      typeof exception.type === "string" &&
      /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(exception.type)
        ? exception.type
        : "UnknownError";
    exception.value = "Application exception";
    if (exception.mechanism) {
      delete exception.mechanism.data;
    }
    for (const frame of exception.stacktrace?.frames ?? []) {
      delete frame.vars;
      delete frame.pre_context;
      delete frame.context_line;
      delete frame.post_context;
    }
  }

  return event;
}

export function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    safeLog("sentry_disabled", { reason: "missing_dsn" });
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || "development",
    release: process.env.SENTRY_RELEASE,
    // Explicitly override SENTRY_TRACES_SAMPLE_RATE and inherited sampled
    // parents. Automatic Redis/provider spans can contain customer identifiers
    // or content and must never be exported.
    tracesSampleRate: 0,
    tracesSampler: () => 0,
    beforeSendTransaction() {
      return null;
    },
    sendDefaultPii: false,
    beforeSend(event) {
      return scrubSentryEvent(event);
    },
  });

  safeLog("sentry_initialized", { hasDsn: true });
}

export function captureException(
  error: unknown,
  context?: Record<string, unknown>
) {
  if (!process.env.SENTRY_DSN) return;

  const errorClass = getSafeErrorClass(error);

  Sentry.withScope(scope => {
    if (context) {
      for (const [key, value] of Object.entries(context)) {
        const safeValue = getSafeContextValue(key, value);
        if (safeValue !== undefined) {
          scope.setExtra(key, safeValue);
        }
      }
    }
    scope.setExtra("errorClass", errorClass);
    Sentry.captureException(error);
  });
}
