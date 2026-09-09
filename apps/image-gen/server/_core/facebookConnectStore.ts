import crypto from "node:crypto";
import {
  getConfiguredJwtSecret,
  getFacebookConnectStorageMode,
  type FacebookConnectStorageMode,
} from "./env";
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
  authorizationCodeEnvelope?: string;
  pages?: FacebookConnectPage[];
};

type ValidatedFacebookConnectState = FacebookConnectState & {
  authorizationCode?: string;
  pages?: FacebookConnectPage[];
};

const facebookConnectStates = new Map<string, StoredFacebookConnectState>();
const FACEBOOK_CONNECT_STATE_TTL_SECONDS = 10 * 60;
const FACEBOOK_GRAPH_TIMEOUT_MS = 10_000;
const FACEBOOK_CONNECT_PAGE_TOKEN_DOMAIN =
  "leaderbot.facebook-connect.page-token.v1";
const FACEBOOK_CONNECT_AUTHORIZATION_CODE_DOMAIN =
  "leaderbot.facebook-connect.authorization-code.v1";
const MIN_FACEBOOK_CONNECT_KEY_BYTES = 32;

function getFacebookConnectSecretKey(domain: string): Buffer {
  const secret = getConfiguredJwtSecret();
  if (Buffer.byteLength(secret, "utf8") < MIN_FACEBOOK_CONNECT_KEY_BYTES) {
    throw new Error(
      "JWT_SECRET must be at least 32 bytes to store Facebook connect tokens"
    );
  }

  return crypto.createHmac("sha256", secret).update(domain).digest();
}

function getFacebookConnectPageTokenAad(input: {
  state: string;
  workspaceId: number;
  userId: number;
  pageId: string;
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      domain: FACEBOOK_CONNECT_PAGE_TOKEN_DOMAIN,
      state: input.state,
      workspaceId: input.workspaceId,
      userId: input.userId,
      pageId: input.pageId,
    }),
    "utf8"
  );
}

function getFacebookConnectAuthorizationCodeAad(input: {
  state: string;
  workspaceId: number;
  userId: number;
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      domain: FACEBOOK_CONNECT_AUTHORIZATION_CODE_DOMAIN,
      state: input.state,
      workspaceId: input.workspaceId,
      userId: input.userId,
    }),
    "utf8"
  );
}

function sealFacebookConnectSecret(input: {
  value: string;
  domain: string;
  version: string;
  aad: Buffer;
  requiredMessage: string;
}): string {
  if (!input.value) {
    throw new Error(input.requiredMessage);
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    getFacebookConnectSecretKey(input.domain),
    iv
  );
  cipher.setAAD(input.aad);
  const encrypted = Buffer.concat([
    cipher.update(input.value, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${input.version}:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

function unsealFacebookConnectSecret(input: {
  envelope: string;
  domain: string;
  version: string;
  aad: Buffer;
  invalidMessage: string;
  openMessage: string;
}): string {
  const [version, ivValue, tagValue, encryptedValue, extra] =
    input.envelope.split(":");
  if (
    version !== input.version ||
    !ivValue ||
    !tagValue ||
    !encryptedValue ||
    extra !== undefined
  ) {
    throw new Error(input.invalidMessage);
  }

  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      getFacebookConnectSecretKey(input.domain),
      Buffer.from(ivValue, "base64url")
    );
    decipher.setAAD(input.aad);
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error(input.openMessage);
  }
}

function sealFacebookConnectPageToken(
  token: string,
  context: {
    state: string;
    workspaceId: number;
    userId: number;
    pageId: string;
  }
): string {
  return sealFacebookConnectSecret({
    value: token,
    domain: FACEBOOK_CONNECT_PAGE_TOKEN_DOMAIN,
    version: "fc1",
    aad: getFacebookConnectPageTokenAad(context),
    requiredMessage: "Facebook connect page token is required",
  });
}

function unsealFacebookConnectPageToken(
  envelope: string,
  context: {
    state: string;
    workspaceId: number;
    userId: number;
    pageId: string;
  }
): string {
  return unsealFacebookConnectSecret({
    envelope,
    domain: FACEBOOK_CONNECT_PAGE_TOKEN_DOMAIN,
    version: "fc1",
    aad: getFacebookConnectPageTokenAad(context),
    invalidMessage: "Facebook connect page token envelope is invalid",
    openMessage: "Facebook connect page token envelope could not be opened",
  });
}

function sealFacebookAuthorizationCode(
  code: string,
  context: {
    state: string;
    workspaceId: number;
    userId: number;
  }
): string {
  return sealFacebookConnectSecret({
    value: code,
    domain: FACEBOOK_CONNECT_AUTHORIZATION_CODE_DOMAIN,
    version: "fca1",
    aad: getFacebookConnectAuthorizationCodeAad(context),
    requiredMessage: "Facebook authorization code is required",
  });
}

function unsealFacebookAuthorizationCode(
  envelope: string,
  context: {
    state: string;
    workspaceId: number;
    userId: number;
  }
): string {
  return unsealFacebookConnectSecret({
    envelope,
    domain: FACEBOOK_CONNECT_AUTHORIZATION_CODE_DOMAIN,
    version: "fca1",
    aad: getFacebookConnectAuthorizationCodeAad(context),
    invalidMessage: "Facebook authorization code envelope is invalid",
    openMessage: "Facebook authorization code envelope could not be opened",
  });
}

function getFacebookConnectKey(state: string) {
  return `portal:facebook_connect:${state}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[]
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every(key => allowedKeys.has(key));
}

function canReadLegacyFacebookConnectSecrets(
  mode: FacebookConnectStorageMode
): boolean {
  return mode !== "sealed_only";
}

function writesSealedFacebookConnectSecrets(
  mode: FacebookConnectStorageMode
): boolean {
  return mode !== "legacy_compat";
}

function parseStoredFacebookConnectState(
  value: unknown,
  expectedState: string,
  mode: FacebookConnectStorageMode
): StoredFacebookConnectState {
  if (!isRecord(value)) {
    throw new Error("invalid facebook connect state storage");
  }

  const hasLegacyAuthorizationCode = Object.prototype.hasOwnProperty.call(
    value,
    "authorizationCode"
  );
  if (
    hasLegacyAuthorizationCode &&
    !canReadLegacyFacebookConnectSecrets(mode)
  ) {
    throw new Error("legacy plaintext facebook authorization code rejected");
  }
  if (
    !hasOnlyKeys(value, [
      "state",
      "workspaceId",
      "userId",
      "createdAt",
      "authorizationCode",
      "authorizationCodeEnvelope",
      "pages",
    ]) ||
    value.state !== expectedState ||
    !Number.isSafeInteger(value.workspaceId) ||
    Number(value.workspaceId) <= 0 ||
    !Number.isSafeInteger(value.userId) ||
    Number(value.userId) <= 0 ||
    !Number.isSafeInteger(value.createdAt) ||
    Number(value.createdAt) < 0 ||
    (hasLegacyAuthorizationCode &&
      (typeof value.authorizationCode !== "string" ||
        value.authorizationCode.length === 0)) ||
    (value.authorizationCodeEnvelope !== undefined &&
      (typeof value.authorizationCodeEnvelope !== "string" ||
        !value.authorizationCodeEnvelope.startsWith("fca1:"))) ||
    (hasLegacyAuthorizationCode &&
      value.authorizationCodeEnvelope !== undefined)
  ) {
    throw new Error("invalid facebook connect state storage");
  }

  let pages: FacebookConnectPage[] | undefined;
  if (value.pages !== undefined) {
    if (!Array.isArray(value.pages)) {
      throw new Error("invalid facebook connect page storage");
    }
    pages = value.pages.map(page => {
      const grantedScopes = isRecord(page) ? page.grantedScopes : undefined;
      if (
        !isRecord(page) ||
        !hasOnlyKeys(page, ["id", "name", "grantedScopes", "accessToken"]) ||
        typeof page.id !== "string" ||
        page.id.trim().length === 0 ||
        typeof page.name !== "string" ||
        !Array.isArray(grantedScopes) ||
        new Set(grantedScopes).size !== grantedScopes.length ||
        !grantedScopes.every(
          scope =>
            typeof scope === "string" &&
            (REQUIRED_FACEBOOK_SCOPES as readonly string[]).includes(scope)
        ) ||
        typeof page.accessToken !== "string"
      ) {
        throw new Error("invalid facebook connect page storage");
      }
      if (
        !page.accessToken.startsWith("fc1:") &&
        !canReadLegacyFacebookConnectSecrets(mode)
      ) {
        throw new Error("legacy plaintext facebook page token rejected");
      }
      return {
        id: page.id,
        name: page.name,
        grantedScopes: grantedScopes.map(
          scope => scope as RequiredFacebookScope
        ),
        accessToken: page.accessToken,
      };
    });
  }

  if (pages && value.authorizationCodeEnvelope !== undefined) {
    throw new Error("invalid facebook connect state storage");
  }

  return {
    state: value.state,
    workspaceId: Number(value.workspaceId),
    userId: Number(value.userId),
    createdAt: Number(value.createdAt),
    ...(hasLegacyAuthorizationCode &&
    typeof value.authorizationCode === "string"
      ? { authorizationCode: value.authorizationCode }
      : {}),
    ...(typeof value.authorizationCodeEnvelope === "string"
      ? { authorizationCodeEnvelope: value.authorizationCodeEnvelope }
      : {}),
    ...(pages ? { pages } : {}),
  };
}

async function readFacebookConnectState(
  state: string
): Promise<StoredFacebookConnectState | null> {
  const mode = getFacebookConnectStorageMode();
  if (!isRedisEnabled()) {
    const value = facebookConnectStates.get(state);
    if (!value) return null;
    try {
      return parseStoredFacebookConnectState(value, state, mode);
    } catch (error) {
      facebookConnectStates.delete(state);
      throw error;
    }
  }

  const redis = await getRedisClient();
  const value = await redis.get(getFacebookConnectKey(state));
  if (!value) return null;
  try {
    return parseStoredFacebookConnectState(JSON.parse(value), state, mode);
  } catch (error) {
    await redis.del(getFacebookConnectKey(state));
    throw error;
  }
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
  void getFacebookConnectStorageMode();
  const state = createFacebookConnectState(input);
  await writeFacebookConnectState(state);
  return state;
}

export async function storeFacebookAuthorizationCode(input: {
  state: string;
  code: string;
}) {
  const mode = getFacebookConnectStorageMode();
  const stored = await readFacebookConnectState(input.state);
  if (!stored) {
    return false;
  }

  const { authorizationCode, authorizationCodeEnvelope, ...stateWithoutCode } =
    stored;
  void authorizationCode;
  void authorizationCodeEnvelope;

  await writeFacebookConnectState(
    writesSealedFacebookConnectSecrets(mode)
      ? {
          ...stateWithoutCode,
          authorizationCodeEnvelope: sealFacebookAuthorizationCode(input.code, {
            state: stored.state,
            workspaceId: stored.workspaceId,
            userId: stored.userId,
          }),
        }
      : {
          ...stateWithoutCode,
          authorizationCode: input.code,
        }
  );
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
  const { authorizationCode, authorizationCodeEnvelope, ...validatedState } =
    stored;
  return {
    ...validatedState,
    ...(authorizationCodeEnvelope
      ? {
          authorizationCode: unsealFacebookAuthorizationCode(
            authorizationCodeEnvelope,
            {
              state: stored.state,
              workspaceId: stored.workspaceId,
              userId: stored.userId,
            }
          ),
        }
      : authorizationCode
        ? { authorizationCode }
        : {}),
  } satisfies ValidatedFacebookConnectState;
}

export async function getStoredFacebookState(state: string) {
  return readFacebookConnectState(state);
}

export async function storeFacebookPages(input: {
  state: string;
  pages: FacebookConnectPage[];
}) {
  const mode = getFacebookConnectStorageMode();
  const stored = await readFacebookConnectState(input.state);
  if (!stored) {
    throw new Error("invalid facebook connect state");
  }

  const { authorizationCode, authorizationCodeEnvelope, ...stateWithoutCode } =
    stored;
  void authorizationCode;
  void authorizationCodeEnvelope;

  await writeFacebookConnectState({
    ...stateWithoutCode,
    pages: input.pages.map(page => ({
      ...page,
      accessToken: writesSealedFacebookConnectSecrets(mode)
        ? sealFacebookConnectPageToken(page.accessToken, {
            state: stored.state,
            workspaceId: stored.workspaceId,
            userId: stored.userId,
            pageId: page.id,
          })
        : page.accessToken,
    })),
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

  const accessToken = page.accessToken.startsWith("fc1:")
    ? unsealFacebookConnectPageToken(page.accessToken, {
        state: stored.state,
        workspaceId: stored.workspaceId,
        userId: stored.userId,
        pageId: page.id,
      })
    : page.accessToken;
  await deleteFacebookConnectState(input.state);
  return { ...page, accessToken };
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
