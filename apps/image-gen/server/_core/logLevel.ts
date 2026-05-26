const LOG_LEVEL = (process.env.LOG_LEVEL ?? "info").toLowerCase();

export function isDebugLogEnabled(): boolean {
  return LOG_LEVEL === "debug";
}


