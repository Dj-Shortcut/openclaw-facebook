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

function encodeOAuthState(redirectUri: string, nonce: string): string {
  return btoa(JSON.stringify({ redirectUri, nonce }));
}

function persistOAuthStateNonce(nonce: string): void {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie =
    `${OAUTH_STATE_COOKIE_NAME}=${encodeURIComponent(nonce)}; Path=/api/oauth/callback; Max-Age=600; SameSite=Lax${secure}`;
}

// Generate login URL at runtime so redirect URI reflects the current origin.
export const getLoginUrl = () => {
  const oauthPortalUrl = getOptionalEnvString(import.meta.env.VITE_OAUTH_PORTAL_URL);
  const appId = getOptionalEnvString(import.meta.env.VITE_APP_ID);
  const redirectUri = `${window.location.origin}/api/oauth/callback`;

  if (!oauthPortalUrl || !appId) {
    return redirectUri;
  }

  const nonce = createOAuthNonce();
  const state = encodeOAuthState(redirectUri, nonce);
  persistOAuthStateNonce(nonce);

  const url = new URL(`${oauthPortalUrl}/app-auth`);
  url.searchParams.set("appId", appId);
  url.searchParams.set("redirectUri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("type", "signIn");

  return url.toString();
};
