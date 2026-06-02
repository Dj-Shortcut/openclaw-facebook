export type LogLevel = "debug" | "info" | "warn" | "error";

type LogFields = Record<string, unknown>;

type LoggerOptions = {
  reqId?: string;
  debugEnabled?: boolean;
};

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

  return [
    "token",
    "psid",
    "text",
    "url",
    "payload",
    "attachment",
    "message",
    "sender",
    "body",
  ].some(fragment => lowered.includes(fragment));
}

function normalizeLogValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    };
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

export function safeLog(
  event: string,
  details: LogFields = {}
): void {
  const level = resolveLogLevel(details);
  const { level: _level, ...rest } = details;
  emit(level, { event, ...redactLogDetails(rest) });
}
