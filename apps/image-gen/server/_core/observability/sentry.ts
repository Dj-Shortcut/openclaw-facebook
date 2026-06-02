import * as Sentry from "@sentry/node";
import { safeLog } from "../logger";

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
    tracesSampleRate: 0.05,
    sendDefaultPii: false,
    beforeSend(event) {
      // scrub gevoelige data
      if (event.request) {
        delete event.request.headers;
        delete event.request.data;
      }
      return event;
    },
  });

  safeLog("sentry_initialized", { hasDsn: true });
}

export function captureException(
  error: unknown,
  context?: Record<string, unknown>
) {
  if (!process.env.SENTRY_DSN) return;

  Sentry.withScope((scope) => {
    if (context) {
      for (const [key, value] of Object.entries(context)) {
        scope.setExtra(key, value);
      }
    }
    Sentry.captureException(error);
  });
}
