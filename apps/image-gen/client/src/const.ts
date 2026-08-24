const getOptionalEnvString = (value: unknown): string | undefined => {
  return typeof value === "string" ? value : undefined;
};

const PUBLIC_CONFIG_PATH = "/api/public/config";
const PUBLIC_CONFIG_TIMEOUT_MS = 5_000;

type OAuthBrowserConfig = {
  loginUrl: string;
};

let runtimeOAuthConfig: OAuthBrowserConfig | null | undefined;

function normalizeOAuthPortalUrl(value: unknown): string | undefined {
  const raw = getOptionalEnvString(value)?.trim();
  if (!raw) return undefined;

  try {
    const url = new URL(raw);
    const localHttp =
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if (url.protocol !== "https:" && !localHttp) return undefined;
    if (url.username || url.password) return undefined;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function getBuildTimeOAuthConfig(): OAuthBrowserConfig | null {
  // OAUTH_PORTAL_URL is served at runtime through PUBLIC_CONFIG_PATH. This
  // Vite-prefixed value is an explicit local/build fallback when that request
  // is unavailable; Vite does not expose unprefixed server environment values.
  const portalUrl = normalizeOAuthPortalUrl(
    import.meta.env.VITE_OAUTH_PORTAL_URL
  );
  const appId = getOptionalEnvString(import.meta.env.VITE_APP_ID)?.trim();
  return portalUrl && appId ? { loginUrl: "/api/oauth/start" } : null;
}

function parsePublicRuntimeConfig(value: unknown): OAuthBrowserConfig | null {
  if (!value || typeof value !== "object") return null;
  const oauth = (value as { oauth?: unknown }).oauth;
  if (!oauth || typeof oauth !== "object") return null;
  const candidate = oauth as Record<string, unknown>;
  if (candidate.configured !== true) return null;

  const loginUrl = getOptionalEnvString(candidate.loginUrl)?.trim();
  if (
    loginUrl === "/api/oauth/start" ||
    loginUrl === "/api/oauth/facebook/start"
  ) {
    return { loginUrl: "/api/oauth/start" };
  }
  if (!loginUrl) return null;
  try {
    const url = new URL(loginUrl);
    const localHttp =
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if (
      (url.protocol === "https:" || localHttp) &&
      !url.username &&
      !url.password &&
      url.pathname === "/api/oauth/start" &&
      !url.search &&
      !url.hash
    ) {
      return { loginUrl: url.toString() };
    }
  } catch {
    // Fail closed for malformed or non-canonical login URLs.
  }
  return null;
}

function getOAuthBrowserConfig(): OAuthBrowserConfig | null {
  return runtimeOAuthConfig === undefined
    ? getBuildTimeOAuthConfig()
    : runtimeOAuthConfig;
}

export async function loadPublicRuntimeConfig(
  fetcher: typeof globalThis.fetch = globalThis.fetch
): Promise<void> {
  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(),
    PUBLIC_CONFIG_TIMEOUT_MS
  );

  try {
    const response = await fetcher(PUBLIC_CONFIG_PATH, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal: abortController.signal,
    });
    if (!response.ok) return;
    runtimeOAuthConfig = parsePublicRuntimeConfig(await response.json());
  } catch {
    // Keep the build-time fallback for local development and fail closed when
    // neither source supplies complete public OAuth configuration.
  } finally {
    clearTimeout(timeout);
  }
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("");
}

export function createOAuthNonce(): string {
  const webCrypto = globalThis.crypto;

  if (typeof webCrypto?.randomUUID === "function") {
    return webCrypto.randomUUID();
  }

  if (typeof webCrypto?.getRandomValues === "function") {
    const nonceBytes = new Uint8Array(16);
    webCrypto.getRandomValues(nonceBytes);
    return bytesToHex(nonceBytes);
  }

  throw new Error("Secure random generator unavailable for OAuth state nonce");
}

function getSafeReturnTo(returnTo?: string): string | undefined {
  if (!returnTo) return undefined;
  if (!returnTo.startsWith("/") || returnTo.startsWith("//")) return undefined;
  if (returnTo.includes("\\")) return undefined;
  return returnTo.slice(0, 200);
}

export function isLoginConfigured(): boolean {
  return Boolean(getOAuthBrowserConfig());
}

// Generate login URL at runtime so redirect URI reflects the current origin.
export const getLoginUrl = (returnTo?: string) => {
  const oauthConfig = getOAuthBrowserConfig();
  if (!oauthConfig) {
    return null;
  }

  const url = new URL(oauthConfig.loginUrl, window.location.origin);
  const safeReturnTo = getSafeReturnTo(returnTo);
  if (safeReturnTo) url.searchParams.set("returnTo", safeReturnTo);
  return url.toString();
};
