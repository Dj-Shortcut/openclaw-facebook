/** @public */
export type LogLevel = "debug" | "info" | "warn" | "error";

type LogFields = Record<string, unknown>;

type LoggerOptions = {
  reqId?: string;
  debugEnabled?: boolean;
};

const RAW_URL_KEYS = new Set([
  "url",
  "rawurl",
  "originalurl",
  "sourceurl",
  "sourceimageurl",
  "inboundimageurl",
]);

const SUMMARIZED_URL_KEYS = new Set([
  "imageurl",
  "publicurl",
  "thumbnailurl",
  "outputurl",
]);

function emit(level: LogLevel, fields: LogFields): void {
  const payload = { level, ...fields };
  const serialized = JSON.stringify(payload);

  if (level === "error") {
    console.error(serialized);
    return;
  }

  if (level === "warn") {
    console.warn(serialized);
    return;
  }

  console.log(serialized);
}

/** @public */
export function createLogger({ reqId, debugEnabled = false }: LoggerOptions) {
  function withReq(fields: LogFields): LogFields {
    if (!reqId || fields.reqId) {
      return fields;
    }

    return { reqId, ...fields };
  }

  return {
    debug(fields: LogFields): void {
      if (!debugEnabled) {
        return;
      }

      emit("debug", withReq(fields));
    },
    info(fields: LogFields): void {
      emit("info", withReq(fields));
    },
    warn(fields: LogFields): void {
      emit("warn", withReq(fields));
    },
    error(fields: LogFields): void {
      emit("error", withReq(fields));
    },
  };
}

function shouldDropLogKey(key: string): boolean {
  const lowered = key.toLowerCase();
  if (lowered === "hash" || lowered.endsWith("hash") || lowered.endsWith("_hash")) {
    return false;
  }

  const normalized = lowered.replace(/[_-]/g, "");
  if (SUMMARIZED_URL_KEYS.has(normalized)) {
    return false;
  }

  if (RAW_URL_KEYS.has(normalized)) {
    return true;
  }

  return [
    "token",
    "psid",
    "text",
    "payload",
    "attachment",
    "message",
    "sender",
    "body",
  ].some(fragment => lowered.includes(fragment));
}

function sanitizeString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:access_)?token=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/https?:\/\/[^\s)]+/gi, "[URL_REDACTED]");
}

function normalizeLogValue(
  value: unknown,
  seen: WeakSet<object> = new WeakSet()
): unknown {
  if (typeof value === "string") {
    return sanitizeString(value);
  }

  if (value instanceof Error) {
    const normalized: Record<string, unknown> = {
      name: value.name,
      message: sanitizeString(value.message),
    };

    if (value.stack) {
      normalized.stack = sanitizeString(value.stack);
    }

    if (value.cause !== undefined) {
      normalized.cause = normalizeLogValue(value.cause, seen);
    }

    return normalized;
  }

  if (Array.isArray(value)) {
    return value.map(item => normalizeLogValue(item, seen));
  }

  if (value && typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }

    seen.add(value);
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !shouldDropLogKey(key))
        .map(([key, nested]) => [key, normalizeLogValue(nested, seen)])
    );
  }

  return value;
}

function redactLogDetails(
  details: LogFields
): LogFields {
  return Object.fromEntries(
    Object.entries(details)
      .filter(([key]) => !shouldDropLogKey(key))
      .map(([key, value]) => {
        if (typeof value === "string" && key === "user") {
          return [key, value.slice(0, 8)];
        }

        return [key, normalizeLogValue(value)];
      })
  );
}

function resolveLogLevel(details: LogFields): LogLevel {
  return details.level === "debug" ||
    details.level === "info" ||
    details.level === "warn" ||
    details.level === "error"
    ? details.level
    : "info";
}

/** @public */
export function safeLog(
  event: string,
  details: LogFields = {}
): void {
  const level = resolveLogLevel(details);
  const { level: _level, ...rest } = details;
  emit(level, { event, ...redactLogDetails(rest) });
}
