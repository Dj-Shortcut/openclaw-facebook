import crypto from "node:crypto";
import { getConfiguredJwtSecret } from "./env";
import {
  createFacebookConnectState,
  validateFacebookConnectState,
  type FacebookConnectState,
} from "./portalSecurity";

export const REQUIRED_FACEBOOK_SCOPES = [
  "pages_show_list",
  "pages_manage_metadata",
  "pages_messaging",
] as const;

export type RequiredFacebookScope = (typeof REQUIRED_FACEBOOK_SCOPES)[number];

export type FacebookConnectPage = {
  id: string;
  name: string;
  grantedScopes: RequiredFacebookScope[];
  accessToken: string;
};

export type StoredFacebookConnectState = FacebookConnectState & {
  authorizationCode?: string;
  pages?: FacebookConnectPage[];
};

const facebookConnectStates = new Map<string, StoredFacebookConnectState>();

export function startFacebookConnect(input: {
  workspaceId: number;
  userId: number;
  now?: number;
}) {
  const state = createFacebookConnectState(input);
  facebookConnectStates.set(state.state, state);
  return state;
}

export function storeFacebookAuthorizationCode(input: {
  state: string;
  code: string;
}) {
  const stored = facebookConnectStates.get(input.state);
  if (!stored) {
    return false;
  }

  facebookConnectStates.set(input.state, {
    ...stored,
    authorizationCode: input.code,
  });
  return true;
}

export function validateStoredFacebookState(input: {
  state: string;
  workspaceId: number;
  userId: number;
  now?: number;
}) {
  validateFacebookConnectState(facebookConnectStates.get(input.state), input);
  const stored = facebookConnectStates.get(input.state);
  if (!stored) {
    throw new Error("invalid facebook connect state");
  }
  return stored;
}

export function getStoredFacebookState(state: string) {
  return facebookConnectStates.get(state) ?? null;
}

export function storeFacebookPages(input: {
  state: string;
  pages: FacebookConnectPage[];
}) {
  const stored = facebookConnectStates.get(input.state);
  if (!stored) {
    throw new Error("invalid facebook connect state");
  }

  facebookConnectStates.set(input.state, {
    ...stored,
    pages: input.pages,
  });
}

export function consumeFacebookPage(input: {
  state: string;
  workspaceId: number;
  userId: number;
  pageId: string;
}) {
  const stored = validateStoredFacebookState(input);
  const page = stored.pages?.find(candidate => candidate.id === input.pageId);
  if (!page) {
    throw new Error("facebook page was not authorized in this connect flow");
  }

  facebookConnectStates.delete(input.state);
  return page;
}

export function deleteFacebookConnectState(state: string) {
  facebookConnectStates.delete(state);
}

function getFacebookApiVersion() {
  return process.env.FB_GRAPH_API_VERSION?.trim() || "v21.0";
}

function getPortalBaseUrl() {
  return (process.env.PORTAL_BASE_URL ?? process.env.APP_BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");
}

export function getFacebookRedirectUri() {
  return `${getPortalBaseUrl()}/api/facebook/connect/callback`;
}

export function getFacebookOAuthUrl(state: string) {
  const appId = process.env.FB_APP_ID;
  if (!appId) return null;

  const url = new URL(`https://www.facebook.com/${getFacebookApiVersion()}/dialog/oauth`);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", getFacebookRedirectUri());
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", REQUIRED_FACEBOOK_SCOPES.join(","));
  return url.toString();
}

type FacebookTokenResponse = {
  access_token?: string;
};

type FacebookAccountsResponse = {
  data?: Array<{
    id?: string;
    name?: string;
    access_token?: string;
    perms?: string[];
    tasks?: string[];
  }>;
};

export async function exchangeFacebookCodeForPages(code: string) {
  const appId = process.env.FB_APP_ID;
  const appSecret = process.env.FB_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error("facebook oauth is not configured");
  }

  const tokenUrl = new URL(`https://graph.facebook.com/${getFacebookApiVersion()}/oauth/access_token`);
  tokenUrl.searchParams.set("client_id", appId);
  tokenUrl.searchParams.set("client_secret", appSecret);
  tokenUrl.searchParams.set("redirect_uri", getFacebookRedirectUri());
  tokenUrl.searchParams.set("code", code);

  const tokenResponse = await fetch(tokenUrl);
  if (!tokenResponse.ok) {
    throw new Error(`facebook token exchange failed: ${tokenResponse.status}`);
  }

  const token = (await tokenResponse.json()) as FacebookTokenResponse;
  if (!token.access_token) {
    throw new Error("facebook token exchange did not return an access token");
  }

  const accountsUrl = new URL(`https://graph.facebook.com/${getFacebookApiVersion()}/me/accounts`);
  accountsUrl.searchParams.set("fields", "id,name,access_token,perms,tasks");
  accountsUrl.searchParams.set("access_token", token.access_token);

  const accountsResponse = await fetch(accountsUrl);
  if (!accountsResponse.ok) {
    throw new Error(`facebook page lookup failed: ${accountsResponse.status}`);
  }

  const accounts = (await accountsResponse.json()) as FacebookAccountsResponse;
  return (accounts.data ?? [])
    .filter((page): page is Required<Pick<typeof page, "id" | "name" | "access_token">> & typeof page =>
      Boolean(page.id && page.name && page.access_token)
    )
    .map(page => ({
      id: page.id,
      name: page.name,
      accessToken: page.access_token,
      grantedScopes: REQUIRED_FACEBOOK_SCOPES.filter(scope => {
        const permissions = new Set([...(page.perms ?? []), ...(page.tasks ?? [])]);
        if (scope === "pages_show_list") return true;
        if (scope === "pages_manage_metadata") return permissions.has("MANAGE") || permissions.has("MODERATE");
        if (scope === "pages_messaging") return permissions.has("MESSAGING");
        return false;
      }),
    }));
}

export function sealFacebookPageToken(token: string) {
  const secret = getConfiguredJwtSecret();
  if (!secret) {
    throw new Error("JWT_SECRET is required to store Facebook page tokens");
  }

  const key = crypto.createHash("sha256").update(secret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}
