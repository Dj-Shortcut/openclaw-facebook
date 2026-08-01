const getOptionalEnvString = (value: unknown): string | undefined => {
  return typeof value === "string" ? value : undefined;
};

const OAUTH_STATE_COOKIE_NAME = "lb_oauth_state_nonce";
const PUBLIC_CONFIG_PATH = "/api/public/config";

type OAuthBrowserConfig = {
  portalUrl: string;
  appId: string;
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
  const portalUrl = normalizeOAuthPortalUrl(
    import.meta.env.VITE_OAUTH_PORTAL_URL
  );
  const appId = getOptionalEnvString(import.meta.env.VITE_APP_ID)?.trim();
  return portalUrl && appId ? { portalUrl, appId } : null;
}

function parsePublicRuntimeConfig(value: unknown): OAuthBrowserConfig | null {
  if (!value || typeof value !== "object") return null;
  const oauth = (value as { oauth?: unknown }).oauth;
  if (!oauth || typeof oauth !== "object") return null;
  const candidate = oauth as Record<string, unknown>;
  if (candidate.configured !== true) return null;

  const portalUrl = normalizeOAuthPortalUrl(candidate.portalUrl);
  const appId = getOptionalEnvString(candidate.appId)?.trim();
  return portalUrl && appId ? { portalUrl, appId } : null;
}

function getOAuthBrowserConfig(): OAuthBrowserConfig | null {
  return runtimeOAuthConfig === undefined
    ? getBuildTimeOAuthConfig()
    : runtimeOAuthConfig;
}

export async function loadPublicRuntimeConfig(
  fetcher: typeof globalThis.fetch = globalThis.fetch
): Promise<void> {
  try {
    const response = await fetcher(PUBLIC_CONFIG_PATH, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return;
    runtimeOAuthConfig = parsePublicRuntimeConfig(await response.json());
  } catch {
    // Keep the build-time fallback for local development and fail closed when
    // neither source supplies complete public OAuth configuration.
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

function encodeOAuthState(
  redirectUri: string,
  nonce: string,
  returnTo?: string
): string {
  const safeReturnTo = getSafeReturnTo(returnTo);
  return btoa(
    JSON.stringify({
      redirectUri,
      nonce,
      ...(safeReturnTo ? { returnTo: safeReturnTo } : {}),
    })
  );
}

function persistOAuthStateNonce(nonce: string): void {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${OAUTH_STATE_COOKIE_NAME}=${encodeURIComponent(nonce)}; Path=/api/oauth/callback; Max-Age=600; SameSite=Lax${secure}`;
}

export function isLoginConfigured(): boolean {
  return Boolean(getOAuthBrowserConfig());
}

// Generate login URL at runtime so redirect URI reflects the current origin.
export const getLoginUrl = (returnTo?: string) => {
  const oauthConfig = getOAuthBrowserConfig();
  const redirectUri = `${window.location.origin}/api/oauth/callback`;

  if (!oauthConfig) {
    return null;
  }

  const nonce = createOAuthNonce();
  const state = encodeOAuthState(redirectUri, nonce, returnTo);
  persistOAuthStateNonce(nonce);

  const url = new URL(`${oauthConfig.portalUrl}/app-auth`);
  url.searchParams.set("appId", oauthConfig.appId);
  url.searchParams.set("redirectUri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("type", "signIn");

  return url.toString();
};
