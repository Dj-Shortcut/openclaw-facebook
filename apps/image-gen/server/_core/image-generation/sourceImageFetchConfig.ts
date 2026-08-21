export type SourceImageFetchConfig = {
  allowedHosts: readonly string[];
  retryLimit: number;
  timeoutMs: number;
};

const SOURCE_IMAGE_FETCH_TIMEOUT_MS_DEFAULT = 10_000;
const SOURCE_IMAGE_FETCH_RETRY_LIMIT_DEFAULT = 1;

function parseAllowedHosts(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map(host => host.trim().toLowerCase())
    .filter(Boolean);
}

function parsePositiveInteger(
  raw: string | undefined,
  fallback: number
): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveSourceImageFetchConfig(
  env: NodeJS.ProcessEnv = process.env
): SourceImageFetchConfig {
  return {
    allowedHosts: parseAllowedHosts(env.SOURCE_IMAGE_ALLOWED_HOSTS),
    retryLimit: SOURCE_IMAGE_FETCH_RETRY_LIMIT_DEFAULT,
    timeoutMs: parsePositiveInteger(
      env.FB_IMAGE_FETCH_TIMEOUT_MS,
      SOURCE_IMAGE_FETCH_TIMEOUT_MS_DEFAULT
    ),
  };
}
