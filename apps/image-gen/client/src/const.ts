const getOptionalEnvString = (value: unknown): string | undefined => {
  return typeof value === "string" ? value : undefined;
};

const OAUTH_STATE_COOKIE_NAME = "lb_oauth_state_nonce";

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
  document.cookie =
    `${OAUTH_STATE_COOKIE_NAME}=${encodeURIComponent(nonce)}; Path=/api/oauth/callback; Max-Age=600; SameSite=Lax${secure}`;
}

export function isLoginConfigured(): boolean {
  return Boolean(
    getOptionalEnvString(import.meta.env.VITE_OAUTH_PORTAL_URL) &&
      getOptionalEnvString(import.meta.env.VITE_APP_ID)
  );
}

// Generate login URL at runtime so redirect URI reflects the current origin.
export const getLoginUrl = (returnTo?: string) => {
  const oauthPortalUrl = getOptionalEnvString(import.meta.env.VITE_OAUTH_PORTAL_URL);
  const appId = getOptionalEnvString(import.meta.env.VITE_APP_ID);
  const redirectUri = `${window.location.origin}/api/oauth/callback`;

  if (!oauthPortalUrl || !appId) {
    return null;
  }

  const nonce = createOAuthNonce();
  const state = encodeOAuthState(redirectUri, nonce, returnTo);
  persistOAuthStateNonce(nonce);

  const url = new URL(`${oauthPortalUrl}/app-auth`);
  url.searchParams.set("appId", appId);
  url.searchParams.set("redirectUri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("type", "signIn");

  return url.toString();
};
