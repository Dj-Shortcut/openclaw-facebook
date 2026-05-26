export type LogLevel = "debug" | "info" | "error";

type LogFields = Record<string, unknown>;

type LoggerOptions = {
  reqId?: string;
  debugEnabled?: boolean;
};

function emit(level: Exclude<LogLevel, "debug"> | "debug", fields: LogFields): void {
  const payload = { level, ...fields };
  const serialized = JSON.stringify(payload);

  if (level === "error") {
    console.error(serialized);
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
    error(fields: LogFields): void {
      emit("error", withReq(fields));
    },
  };
}
