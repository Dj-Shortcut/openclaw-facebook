import crypto from "node:crypto";
import { getConfiguredJwtSecret } from "./env";
import {
  createFacebookConnectState,
  validateFacebookConnectState,
  type FacebookConnectState,
} from "./portalSecurity";
import { safeLog } from "./logger";
import { getRedisClient, isRedisEnabled } from "./redis";

export const REQUIRED_FACEBOOK_SCOPES = [
  "pages_show_list",
  "pages_manage_metadata",
  "pages_messaging",
] as const;

export const FACEBOOK_PAGE_CONNECT_PERMISSIONS = [
  ...REQUIRED_FACEBOOK_SCOPES,
  "business_management",
] as const;

type RequiredFacebookScope = (typeof REQUIRED_FACEBOOK_SCOPES)[number];

export type FacebookConnectPage = {
  id: string;
  name: string;
  grantedScopes: RequiredFacebookScope[];
  accessToken: string;
};

type StoredFacebookConnectState = FacebookConnectState & {
  authorizationCode?: string;
  pages?: FacebookConnectPage[];
};

const facebookConnectStates = new Map<string, StoredFacebookConnectState>();
const FACEBOOK_CONNECT_STATE_TTL_SECONDS = 10 * 60;
const FACEBOOK_GRAPH_TIMEOUT_MS = 10_000;

function getFacebookConnectKey(state: string) {
  return `portal:facebook_connect:${state}`;
}

async function readFacebookConnectState(
  state: string
): Promise<StoredFacebookConnectState | null> {
  if (!isRedisEnabled()) {
    return facebookConnectStates.get(state) ?? null;
  }

  const redis = await getRedisClient();
  const value = await redis.get(getFacebookConnectKey(state));
  if (!value) return null;
  return JSON.parse(value) as StoredFacebookConnectState;
}

async function writeFacebookConnectState(
  state: StoredFacebookConnectState
): Promise<void> {
  if (!isRedisEnabled()) {
    facebookConnectStates.set(state.state, state);
    return;
  }

  const redis = await getRedisClient();
  await redis.set(
    getFacebookConnectKey(state.state),
    JSON.stringify(state),
    "EX",
    FACEBOOK_CONNECT_STATE_TTL_SECONDS
  );
}

async function deleteFacebookConnectState(state: string): Promise<void> {
  if (!isRedisEnabled()) {
    facebookConnectStates.delete(state);
    return;
  }

  const redis = await getRedisClient();
  await redis.del(getFacebookConnectKey(state));
}

export async function startFacebookConnect(input: {
  workspaceId: number;
  userId: number;
  now?: number;
}) {
  const state = createFacebookConnectState(input);
  await writeFacebookConnectState(state);
  return state;
}

export async function storeFacebookAuthorizationCode(input: {
  state: string;
  code: string;
}) {
  const stored = await readFacebookConnectState(input.state);
  if (!stored) {
    return false;
  }

  await writeFacebookConnectState({
    ...stored,
    authorizationCode: input.code,
  });
  return true;
}

export async function validateStoredFacebookState(input: {
  state: string;
  workspaceId: number;
  userId: number;
  now?: number;
}) {
  const stored = await readFacebookConnectState(input.state);
  validateFacebookConnectState(stored, input);
  if (!stored) {
    throw new Error("invalid facebook connect state");
  }
  return stored;
}

export async function getStoredFacebookState(state: string) {
  return readFacebookConnectState(state);
}

export async function storeFacebookPages(input: {
  state: string;
  pages: FacebookConnectPage[];
}) {
  const stored = await readFacebookConnectState(input.state);
  if (!stored) {
    throw new Error("invalid facebook connect state");
  }

  await writeFacebookConnectState({
    ...stored,
    pages: input.pages,
  });
}

export async function consumeFacebookPage(input: {
  state: string;
  workspaceId: number;
  userId: number;
  pageId: string;
}) {
  const stored = await validateStoredFacebookState(input);
  const page = stored.pages?.find(candidate => candidate.id === input.pageId);
  if (!page) {
    throw new Error("facebook page was not authorized in this connect flow");
  }

  await deleteFacebookConnectState(input.state);
  return page;
}

function getFacebookApiVersion() {
  return process.env.FB_GRAPH_API_VERSION?.trim() || "v21.0";
}

function getPortalBaseUrl() {
  return (
    process.env.PORTAL_BASE_URL ??
    process.env.APP_BASE_URL ??
    "http://localhost:8080"
  ).replace(/\/$/, "");
}

function getFacebookRedirectUri() {
  return `${getPortalBaseUrl()}/api/facebook/connect/callback`;
}

export function getFacebookPageConnectConfigurationId(): string | null {
  const configurationId = process.env.FB_PAGE_CONNECT_CONFIG_ID?.trim();
  if (!configurationId) return null;
  if (!/^[1-9]\d+$/.test(configurationId)) {
    throw new Error(
      "FB_PAGE_CONNECT_CONFIG_ID must be a positive numeric Meta configuration ID"
    );
  }
  return configurationId;
}

export function getFacebookOAuthUrl(state: string) {
  const appId = process.env.FB_APP_ID;
  if (!appId) return null;

  const url = new URL(
    `https://www.facebook.com/${getFacebookApiVersion()}/dialog/oauth`
  );
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", getFacebookRedirectUri());
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  const configurationId = getFacebookPageConnectConfigurationId();
  if (configurationId) {
    // Facebook Login for Business configurations own the permission set.
    // Meta recommends config_id instead of a caller-controlled scope list.
    url.searchParams.set("config_id", configurationId);
    url.searchParams.set("override_default_response_type", "true");
  } else {
    url.searchParams.set("scope", FACEBOOK_PAGE_CONNECT_PERMISSIONS.join(","));
  }
  return url.toString();
}

type FacebookTokenResponse = {
  access_token?: string;
};

type FacebookGraphErrorResponse = {
  error?: {
    code?: unknown;
    error_subcode?: unknown;
  };
};

async function readFacebookGraphErrorMetadata(response: Response) {
  let errorCode: number | null = null;
  let errorSubcode: number | null = null;
  try {
    const errorResponse = (await response.json()) as FacebookGraphErrorResponse;
    errorCode = Number.isInteger(errorResponse.error?.code)
      ? (errorResponse.error?.code as number)
      : null;
    errorSubcode = Number.isInteger(errorResponse.error?.error_subcode)
      ? (errorResponse.error?.error_subcode as number)
      : null;
  } catch {
    // Only structured numeric error metadata is safe to record.
  }
  return { errorCode, errorSubcode };
}

type FacebookAccountsResponse = {
  data?: FacebookPageResponse[];
};

type FacebookPermissionsResponse = {
  data?: Array<{ permission?: string; status?: string }>;
};

type FacebookPageResponse = {
  id?: string;
  name?: string;
  access_token?: string;
  perms?: string[];
  tasks?: string[];
};

function toFacebookConnectPage(
  page: FacebookPageResponse
): FacebookConnectPage | null {
  if (!page.id || !page.name || !page.access_token) return null;

  const permissions = new Set([...(page.perms ?? []), ...(page.tasks ?? [])]);
  return {
    id: page.id,
    name: page.name,
    accessToken: page.access_token,
    grantedScopes: REQUIRED_FACEBOOK_SCOPES.filter(scope => {
      if (scope === "pages_show_list") return true;
      if (scope === "pages_manage_metadata")
        return permissions.has("MANAGE") || permissions.has("MODERATE");
      if (scope === "pages_messaging") return permissions.has("MESSAGING");
      return false;
    }),
  };
}

async function fetchFacebookPageAccess(
  page: FacebookPageResponse,
  accessToken: string
): Promise<FacebookConnectPage | null> {
  if (!page.id || !page.name) return null;

  const pageUrl = new URL(
    `https://graph.facebook.com/${getFacebookApiVersion()}/${encodeURIComponent(page.id)}`
  );
  pageUrl.searchParams.set("fields", "id,name,access_token,tasks");

  const pageResponse = await fetch(pageUrl, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    signal: AbortSignal.timeout(FACEBOOK_GRAPH_TIMEOUT_MS),
  });
  if (!pageResponse.ok) {
    safeLog("facebook_page_access_lookup_failed", {
      level: "warn",
      status: pageResponse.status,
    });
    return null;
  }

  const resolvedPage = (await pageResponse.json()) as FacebookPageResponse;
  if (resolvedPage.id !== page.id) {
    safeLog("facebook_page_access_lookup_mismatch", { level: "warn" });
    return null;
  }
  return toFacebookConnectPage(resolvedPage);
}

async function logFacebookPagePermissionState(accessToken: string) {
  const permissionsUrl = new URL(
    `https://graph.facebook.com/${getFacebookApiVersion()}/me/permissions`
  );
  permissionsUrl.searchParams.set("fields", "permission,status");
  const response = await fetch(permissionsUrl, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    signal: AbortSignal.timeout(FACEBOOK_GRAPH_TIMEOUT_MS),
  });
  if (!response.ok) {
    safeLog("facebook_page_permission_lookup_failed", {
      level: "warn",
      status: response.status,
    });
    return;
  }

  const permissions = (await response.json()) as FacebookPermissionsResponse;
  const granted = new Set(
    (permissions.data ?? [])
      .filter(item => item.status === "granted" && item.permission)
      .map(item => item.permission)
  );
  safeLog("facebook_page_permission_state", {
    pagesShowListGranted: granted.has("pages_show_list"),
    pagesManageMetadataGranted: granted.has("pages_manage_metadata"),
    pagesMessagingGranted: granted.has("pages_messaging"),
    pagesReadEngagementGranted: granted.has("pages_read_engagement"),
    businessManagementGranted: granted.has("business_management"),
  });
}

async function fetchAssignedFacebookPages(
  accessToken: string
): Promise<FacebookPageResponse[]> {
  const assignedPagesUrl = new URL(
    `https://graph.facebook.com/${getFacebookApiVersion()}/me/assigned_pages`
  );
  assignedPagesUrl.searchParams.set("fields", "id,name,access_token,tasks");
  const response = await fetch(assignedPagesUrl, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    signal: AbortSignal.timeout(FACEBOOK_GRAPH_TIMEOUT_MS),
  });
  if (!response.ok) {
    safeLog("facebook_assigned_page_lookup_failed", {
      level: "warn",
      status: response.status,
    });
    return [];
  }

  const assignedPages = (await response.json()) as FacebookAccountsResponse;
  return assignedPages.data ?? [];
}

export async function getFacebookPagesForUserAccessToken(
  accessToken: string
): Promise<FacebookConnectPage[]> {
  if (!accessToken) {
    throw new Error("facebook user access token is required");
  }

  const accountsUrl = new URL(
    `https://graph.facebook.com/${getFacebookApiVersion()}/me/accounts`
  );
  accountsUrl.searchParams.set("fields", "id,name,access_token,tasks");

  const accountsResponse = await fetch(accountsUrl, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    signal: AbortSignal.timeout(FACEBOOK_GRAPH_TIMEOUT_MS),
  });
  let candidateSource: FacebookPageResponse[] = [];
  if (!accountsResponse.ok) {
    safeLog("facebook_page_lookup_failed", {
      level: "warn",
      status: accountsResponse.status,
      ...(await readFacebookGraphErrorMetadata(accountsResponse)),
    });
    await logFacebookPagePermissionState(accessToken);
    candidateSource = await fetchAssignedFacebookPages(accessToken);
  } else {
    const accounts =
      (await accountsResponse.json()) as FacebookAccountsResponse;
    candidateSource = accounts.data ?? [];
    if (candidateSource.length === 0) {
      await logFacebookPagePermissionState(accessToken);
      candidateSource = await fetchAssignedFacebookPages(accessToken);
    }
  }
  const candidates = candidateSource.filter(page => page.id && page.name);
  const resolvedPages: FacebookConnectPage[] = [];
  let fallbackLookupCount = 0;

  for (const candidate of candidates) {
    const embeddedPage = toFacebookConnectPage(candidate);
    if (embeddedPage) {
      resolvedPages.push(embeddedPage);
      continue;
    }

    fallbackLookupCount += 1;
    const resolvedPage = await fetchFacebookPageAccess(candidate, accessToken);
    if (resolvedPage) resolvedPages.push(resolvedPage);
  }

  safeLog("facebook_page_lookup_completed", {
    candidateCount: candidates.length,
    fallbackLookupCount,
    usablePageCount: resolvedPages.length,
  });
  return resolvedPages;
}

export async function exchangeFacebookCodeForPages(code: string) {
  const appId = process.env.FB_APP_ID;
  const appSecret = process.env.FB_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error("facebook oauth is not configured");
  }

  const tokenUrl = new URL(
    `https://graph.facebook.com/${getFacebookApiVersion()}/oauth/access_token`
  );
  tokenUrl.searchParams.set("client_id", appId);
  tokenUrl.searchParams.set("client_secret", appSecret);
  tokenUrl.searchParams.set("redirect_uri", getFacebookRedirectUri());
  tokenUrl.searchParams.set("code", code);

  const tokenResponse = await fetch(tokenUrl, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FACEBOOK_GRAPH_TIMEOUT_MS),
  });
  if (!tokenResponse.ok) {
    safeLog("facebook_token_exchange_failed", {
      level: "warn",
      status: tokenResponse.status,
      ...(await readFacebookGraphErrorMetadata(tokenResponse)),
    });
    throw new Error(`facebook token exchange failed: ${tokenResponse.status}`);
  }

  const token = (await tokenResponse.json()) as FacebookTokenResponse;
  if (!token.access_token) {
    throw new Error("facebook token exchange did not return an access token");
  }

  return getFacebookPagesForUserAccessToken(token.access_token);
}

export function sealFacebookPageToken(token: string) {
  const secret = getConfiguredJwtSecret();
  if (!secret) {
    throw new Error("JWT_SECRET is required to store Facebook page tokens");
  }

  const key = crypto.createHash("sha256").update(secret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

export function unsealFacebookPageToken(sealedToken: string): string {
  const secret = getConfiguredJwtSecret();
  if (!secret) {
    throw new Error("JWT_SECRET is required to read Facebook page tokens");
  }

  const [version, ivValue, tagValue, encryptedValue, extra] =
    sealedToken.split(":");
  if (
    version !== "v1" ||
    !ivValue ||
    !tagValue ||
    !encryptedValue ||
    extra !== undefined
  ) {
    throw new Error("Facebook page token envelope is invalid");
  }

  try {
    const key = crypto.createHash("sha256").update(secret).digest();
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(ivValue, "base64url")
    );
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Facebook page token envelope could not be opened");
  }
}
