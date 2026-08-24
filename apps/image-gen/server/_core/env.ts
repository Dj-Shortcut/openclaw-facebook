export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
};

const MIN_SESSION_SECRET_LENGTH = 32;

export const FACEBOOK_CONNECT_STORAGE_MODES = [
  "legacy_compat",
  "sealed_compat",
  "sealed_only",
] as const;

export type FacebookConnectStorageMode =
  (typeof FACEBOOK_CONNECT_STORAGE_MODES)[number];

export function getConfiguredJwtSecret(): string {
  return process.env.JWT_SECRET?.trim() ?? "";
}

export function getFacebookConnectStorageMode(): FacebookConnectStorageMode {
  const configured = process.env.FACEBOOK_CONNECT_STORAGE_MODE?.trim();
  if (!configured) return "legacy_compat";
  if (
    (FACEBOOK_CONNECT_STORAGE_MODES as readonly string[]).includes(configured)
  ) {
    return configured as FacebookConnectStorageMode;
  }
  throw new Error(
    `FACEBOOK_CONNECT_STORAGE_MODE must be one of ${FACEBOOK_CONNECT_STORAGE_MODES.join(", ")}`
  );
}

export function getEnv(name: string): string {
  const value = process.env[name]?.trim() ?? "";

  if (!value) {
    throw new Error(`${name} is missing`);
  }

  return value;
}

export function assertAuthConfig(): void {
  const secret = getConfiguredJwtSecret();

  if (secret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET must be set and at least ${MIN_SESSION_SECRET_LENGTH} characters long`
    );
  }

  // This is a rolling-deploy safety boundary. An invalid value must stop the
  // process before any instance can write a storage shape its peers cannot read.
  void getFacebookConnectStorageMode();
}

export function assertPortalDatabaseConfig(): void {
  if (process.env.NODE_ENV !== "production") {
    return;
  }

  const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required for the production customer portal"
    );
  }

  const parsed = parseUrlOrThrow(databaseUrl, "DATABASE_URL");
  if (parsed.protocol !== "mysql:" && parsed.protocol !== "mysql2:") {
    throw new Error("DATABASE_URL must use a MySQL-compatible URL");
  }
}

export function assertWhatsAppConfig(): void {
  getEnv("WHATSAPP_ACCESS_TOKEN");
  getEnv("WHATSAPP_PHONE_NUMBER_ID");
}

function parseUrlOrThrow(rawUrl: string, envName: string): URL {
  try {
    return new URL(rawUrl);
  } catch {
    throw new Error(`${envName} must be a valid absolute URL`);
  }
}

function enforceHttpsInProduction(url: URL, label: string): void {
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error(`${label} must use HTTPS in production`);
  }
}

export function getForgeApiBaseUrlOrThrow(): string {
  const raw = (process.env.BUILT_IN_FORGE_API_URL ?? "").trim();

  if (!raw) {
    throw new Error("BUILT_IN_FORGE_API_URL is not configured");
  }

  const parsed = parseUrlOrThrow(raw, "BUILT_IN_FORGE_API_URL");
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(
      "BUILT_IN_FORGE_API_URL must start with http:// or https://"
    );
  }

  enforceHttpsInProduction(parsed, "BUILT_IN_FORGE_API_URL");
  return parsed.toString();
}
