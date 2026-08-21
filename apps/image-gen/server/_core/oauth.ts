import crypto from "node:crypto";
import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { parse as parseCookieHeader } from "cookie";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import * as db from "../db";
import { getSessionCookieOptions } from "./cookies";
import {
  getFacebookPagesForUserAccessToken,
  REQUIRED_FACEBOOK_SCOPES,
  startFacebookConnect,
  storeFacebookPages,
} from "./facebookConnectStore";
import { connectAuthorizedFacebookPage } from "./facebookPageConnection";
import { safeLog } from "./logger";
import { isFacebookLoginMethod } from "./portalAuthPolicy";

const OAUTH_STATE_COOKIE_NAME = "lb_oauth_state_nonce";
const FACEBOOK_OAUTH_TIMEOUT_MS = 10_000;

type OAuthStatePayload = {
  nonce: string;
  redirectUri: string;
  returnTo?: string;
};

const oauthCallbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

const oauthStateSchema = z.object({
  nonce: z.string().min(16),
  redirectUri: z.string().url(),
  returnTo: z.string().max(200).optional(),
});

function getSafeReturnTo(returnTo: string | undefined): string {
  if (!returnTo) return "/";
  if (!returnTo.startsWith("/") || returnTo.startsWith("//")) return "/";
  if (returnTo.includes("\\")) return "/";
  return returnTo;
}

function addFacebookConnectState(returnTo: string | undefined, state: string) {
  const target = new URL(
    getSafeReturnTo(returnTo),
    "https://leaderbot.invalid"
  );
  target.searchParams.set("facebookConnectState", state);
  return `${target.pathname}${target.search}${target.hash}`;
}

function isHandoffReturn(returnTo: string | undefined): boolean {
  const safeReturnTo = getSafeReturnTo(returnTo);
  return safeReturnTo === "/handoff" || safeReturnTo.startsWith("/handoff/");
}

function getQueryParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" ? value : undefined;
}

function getCookieValue(req: Request, key: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) {
    return undefined;
  }

  const cookies = parseCookieHeader(header);
  const value = cookies[key];
  return typeof value === "string" ? value : undefined;
}

function clearOAuthStateCookie(req: Request, res: Response) {
  const cookieOptions = getSessionCookieOptions(req);
  res.clearCookie(OAUTH_STATE_COOKIE_NAME, {
    domain: cookieOptions.domain,
    httpOnly: true,
    path: "/api/oauth/callback",
    sameSite: "lax",
    secure:
      process.env.NODE_ENV === "production"
        ? true
        : Boolean(cookieOptions.secure),
  });
}

function getFacebookLoginConfig(): {
  appId: string;
  appSecret: string;
  graphVersion: string;
  redirectUri: string;
} | null {
  const appId = process.env.FB_APP_ID?.trim();
  const appSecret = process.env.FB_APP_SECRET?.trim();
  const baseUrl = process.env.APP_BASE_URL?.trim();
  const graphVersion = process.env.FB_GRAPH_API_VERSION?.trim() || "v21.0";
  if (!appId || !appSecret || !baseUrl || !/^v\d+\.\d+$/.test(graphVersion)) {
    return null;
  }

  try {
    const url = new URL(baseUrl);
    const localHttp =
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if (url.protocol !== "https:" && !localHttp) return null;
    if (url.username || url.password) return null;
    return {
      appId,
      appSecret,
      graphVersion,
      redirectUri: `${url.origin}/api/oauth/callback`,
    };
  } catch {
    return null;
  }
}

export function isDirectFacebookLoginConfigured(): boolean {
  return Boolean(getFacebookLoginConfig());
}

function getExternalOAuthLoginConfig(): {
  appId: string;
  portalUrl: string;
  redirectUri: string;
} | null {
  const appId = process.env.VITE_APP_ID?.trim();
  const rawPortalUrl = (
    process.env.OAUTH_PORTAL_URL ??
    process.env.OAUTH_SERVER_URL ??
    ""
  ).trim();
  const rawBaseUrl = process.env.APP_BASE_URL?.trim();
  if (!appId || !rawPortalUrl || !rawBaseUrl) return null;

  try {
    const portalUrl = new URL(rawPortalUrl);
    const baseUrl = new URL(rawBaseUrl);
    const portalLocal =
      portalUrl.protocol === "http:" &&
      (portalUrl.hostname === "localhost" ||
        portalUrl.hostname === "127.0.0.1");
    const baseLocal =
      baseUrl.protocol === "http:" &&
      (baseUrl.hostname === "localhost" || baseUrl.hostname === "127.0.0.1");
    if (
      (portalUrl.protocol !== "https:" && !portalLocal) ||
      (baseUrl.protocol !== "https:" && !baseLocal) ||
      portalUrl.username ||
      portalUrl.password ||
      baseUrl.username ||
      baseUrl.password
    ) {
      return null;
    }
    return {
      appId,
      portalUrl: portalUrl.toString().replace(/\/$/, ""),
      redirectUri: `${baseUrl.origin}/api/oauth/callback`,
    };
  } catch {
    return null;
  }
}

function encodeOAuthState(payload: OAuthStatePayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

async function getFacebookLoginIdentity(
  code: string,
  redirectUri: string,
  config: NonNullable<ReturnType<typeof getFacebookLoginConfig>>
): Promise<{
  openId: string;
  name: string | null;
  email: string | null;
  accessToken: string;
}> {
  if (redirectUri !== config.redirectUri) {
    throw new Error("facebook oauth redirect URI mismatch");
  }

  const tokenUrl = new URL(
    `https://graph.facebook.com/${config.graphVersion}/oauth/access_token`
  );
  tokenUrl.searchParams.set("client_id", config.appId);
  tokenUrl.searchParams.set("client_secret", config.appSecret);
  tokenUrl.searchParams.set("redirect_uri", redirectUri);
  tokenUrl.searchParams.set("code", code);
  const tokenResponse = await fetch(tokenUrl, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FACEBOOK_OAUTH_TIMEOUT_MS),
  });
  if (!tokenResponse.ok) {
    throw new Error(
      `facebook login token exchange failed: ${tokenResponse.status}`
    );
  }
  const token = (await tokenResponse.json()) as { access_token?: unknown };
  if (typeof token.access_token !== "string" || !token.access_token) {
    throw new Error("facebook login token exchange returned no access token");
  }

  const profileUrl = new URL(
    `https://graph.facebook.com/${config.graphVersion}/me`
  );
  profileUrl.searchParams.set("fields", "id,name");
  const profileResponse = await fetch(profileUrl, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token.access_token}`,
    },
    signal: AbortSignal.timeout(FACEBOOK_OAUTH_TIMEOUT_MS),
  });
  if (!profileResponse.ok) {
    throw new Error(
      `facebook login profile lookup failed: ${profileResponse.status}`
    );
  }
  const profile = (await profileResponse.json()) as {
    id?: unknown;
    name?: unknown;
    email?: unknown;
  };
  if (typeof profile.id !== "string" || !profile.id) {
    throw new Error("facebook login profile returned no id");
  }

  return {
    openId: `facebook:${profile.id}`,
    name: typeof profile.name === "string" ? profile.name : null,
    email: typeof profile.email === "string" ? profile.email : null,
    accessToken: token.access_token,
  };
}
function parseOAuthState(state: string): OAuthStatePayload | null {
  try {
    const decoded = Buffer.from(state, "base64").toString("utf8");
    const parsed = oauthStateSchema.safeParse(JSON.parse(decoded));
    if (!parsed.success) {
      return null;
    }

    return parsed.data;
  } catch {
    return null;
  }
}

function validateOAuthState(
  req: Request,
  state: string
): OAuthStatePayload | null {
  const parsedState = parseOAuthState(state);
  if (!parsedState) {
    return null;
  }

  const expectedNonce = getCookieValue(req, OAUTH_STATE_COOKIE_NAME);
  if (!expectedNonce || expectedNonce !== parsedState.nonce) {
    return null;
  }

  return parsedState;
}

export function registerOAuthRoutes(app: Express) {
  const startOAuth = (req: Request, res: Response) => {
    const facebookConfig = getFacebookLoginConfig();
    const externalConfig = getExternalOAuthLoginConfig();
    const redirectUri =
      facebookConfig?.redirectUri ?? externalConfig?.redirectUri;
    if (!redirectUri) {
      res.status(503).json({ error: "OAuth is not configured" });
      return;
    }

    const nonce = crypto.randomBytes(24).toString("base64url");
    const returnTo = getSafeReturnTo(getQueryParam(req, "returnTo"));
    const state = encodeOAuthState({
      nonce,
      redirectUri,
      ...(returnTo ? { returnTo } : {}),
    });
    const cookieOptions = getSessionCookieOptions(req);
    res.cookie(OAUTH_STATE_COOKIE_NAME, nonce, {
      domain: cookieOptions.domain,
      httpOnly: true,
      path: "/api/oauth/callback",
      sameSite: "lax",
      secure:
        process.env.NODE_ENV === "production"
          ? true
          : Boolean(cookieOptions.secure),
      maxAge: 10 * 60 * 1000,
    });

    const authorizationUrl = facebookConfig
      ? new URL(
          `https://www.facebook.com/${facebookConfig.graphVersion}/dialog/oauth`
        )
      : new URL(`${externalConfig!.portalUrl}/app-auth`);
    authorizationUrl.searchParams.set(
      facebookConfig ? "client_id" : "appId",
      facebookConfig?.appId ?? externalConfig!.appId
    );
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    if (!facebookConfig) {
      authorizationUrl.searchParams.delete("redirect_uri");
      authorizationUrl.searchParams.set("redirectUri", redirectUri);
      authorizationUrl.searchParams.set("type", "signIn");
    }
    authorizationUrl.searchParams.set("state", state);
    if (facebookConfig) {
      authorizationUrl.searchParams.set("response_type", "code");
      authorizationUrl.searchParams.set(
        "scope",
        ["public_profile", ...REQUIRED_FACEBOOK_SCOPES].join(",")
      );
    }
    res.redirect(302, authorizationUrl.toString());
  };
  app.get("/api/oauth/start", startOAuth);
  app.get("/api/oauth/facebook/start", startOAuth);

  app.get("/api/oauth/callback", (req: Request, res: Response) => {
    void (async () => {
      const parsedQuery = oauthCallbackQuerySchema.safeParse({
        code: getQueryParam(req, "code"),
        state: getQueryParam(req, "state"),
      });

      if (!parsedQuery.success) {
        clearOAuthStateCookie(req, res);
        res.status(400).json({ error: "code and state are required" });
        return;
      }

      const { code, state } = parsedQuery.data;

      const validatedState = validateOAuthState(req, state);
      if (!validatedState) {
        clearOAuthStateCookie(req, res);
        res.status(400).json({ error: "invalid oauth state" });
        return;
      }

      try {
        const { sdk } = await import("./sdk");
        const facebookConfig = getFacebookLoginConfig();
        const facebookLogin = facebookConfig
          ? await getFacebookLoginIdentity(
              code,
              validatedState.redirectUri,
              facebookConfig
            )
          : null;
        const userInfo = facebookLogin
          ? { ...facebookLogin, loginMethod: "facebook" }
          : await (async () => {
              const tokenResponse = await sdk.exchangeCodeForToken(
                code,
                validatedState.redirectUri
              );
              return sdk.getUserInfo(tokenResponse.accessToken);
            })();
        const loginMethod = userInfo.loginMethod ?? null;

        if (!userInfo.openId) {
          clearOAuthStateCookie(req, res);
          res.status(400).json({ error: "openId missing from user info" });
          return;
        }

        if (!isFacebookLoginMethod(loginMethod)) {
          clearOAuthStateCookie(req, res);
          res.status(403).json({ error: "Facebook Login is required" });
          return;
        }

        await db.upsertUser({
          openId: userInfo.openId,
          name: userInfo.name || null,
          email: userInfo.email ?? null,
          loginMethod: "facebook",
          lastSignedIn: new Date(),
        });
        const portalUser = await db.getUserByOpenId(userInfo.openId);
        if (!portalUser) {
          throw new Error("portal customer was not persisted");
        }
        let redirectTarget = getSafeReturnTo(validatedState.returnTo);
        let workspace: Awaited<
          ReturnType<typeof db.getOrCreateUserWorkspace>
        > | null = null;
        if (!isHandoffReturn(validatedState.returnTo)) {
          workspace = await db.getOrCreateUserWorkspace(portalUser);
        }

        if (facebookLogin && workspace) {
          try {
            const existingChannels = await db.listChannelConnections(
              workspace.id
            );
            const alreadyConnected = existingChannels.some(
              connection =>
                connection.channel === "facebook_messenger" &&
                connection.status === "connected" &&
                Boolean(connection.externalId)
            );
            if (!alreadyConnected) {
              const pages = await getFacebookPagesForUserAccessToken(
                facebookLogin.accessToken
              );
              if (pages.length === 1) {
                try {
                  await connectAuthorizedFacebookPage({
                    workspaceId: workspace.id,
                    userId: portalUser.id,
                    page: pages[0],
                    source: "facebook_login",
                  });
                } catch (error) {
                  const connectState = await startFacebookConnect({
                    workspaceId: workspace.id,
                    userId: portalUser.id,
                  });
                  await storeFacebookPages({
                    state: connectState.state,
                    pages,
                  });
                  redirectTarget = addFacebookConnectState(
                    redirectTarget,
                    connectState.state
                  );
                  safeLog("facebook_login_page_auto_connect_failed", {
                    level: "warn",
                    error:
                      error instanceof Error ? error.message : String(error),
                  });
                }
              } else if (pages.length > 1) {
                const connectState = await startFacebookConnect({
                  workspaceId: workspace.id,
                  userId: portalUser.id,
                });
                await storeFacebookPages({
                  state: connectState.state,
                  pages,
                });
                redirectTarget = addFacebookConnectState(
                  redirectTarget,
                  connectState.state
                );
                await db.insertAuditLog({
                  workspaceId: workspace.id,
                  userId: portalUser.id,
                  event: "facebook_login.page_selection_required",
                  metadata: { pageCount: pages.length },
                });
              } else {
                await db.insertAuditLog({
                  workspaceId: workspace.id,
                  userId: portalUser.id,
                  event: "facebook_login.no_managed_pages",
                  metadata: {},
                });
              }
            }
          } catch (error) {
            safeLog("facebook_login_page_discovery_failed", {
              level: "warn",
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        const sessionToken = await sdk.createSessionToken(userInfo.openId, {
          name: userInfo.name || "",
          expiresInMs: ONE_YEAR_MS,
        });

        const cookieOptions = getSessionCookieOptions(req);
        res.cookie(COOKIE_NAME, sessionToken, {
          domain: cookieOptions.domain,
          httpOnly: true,
          path: cookieOptions.path,
          sameSite: cookieOptions.sameSite,
          secure:
            process.env.NODE_ENV === "production"
              ? true
              : Boolean(cookieOptions.secure),
          maxAge: ONE_YEAR_MS,
        });
        clearOAuthStateCookie(req, res);

        res.redirect(302, redirectTarget);
      } catch (error) {
        clearOAuthStateCookie(req, res);
        safeLog("oauth_callback_failed", {
          level: "error",
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(500).json({ error: "OAuth callback failed" });
      }
    })();
  });
}
