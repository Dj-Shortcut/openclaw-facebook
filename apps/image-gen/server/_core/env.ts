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

export function getConfiguredJwtSecret(): string {
  return process.env.JWT_SECRET?.trim() ?? "";
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
    throw new Error("BUILT_IN_FORGE_API_URL must start with http:// or https://");
  }

  enforceHttpsInProduction(parsed, "BUILT_IN_FORGE_API_URL");
  return parsed.toString();
}

export function assertOutboundHttpsUrl(rawUrl: string, label = "outbound URL"): void {
  const parsed = parseUrlOrThrow(rawUrl, label);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${label} must start with http:// or https://`);
  }

  enforceHttpsInProduction(parsed, label);
}
