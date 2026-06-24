import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { parse as parseCookieHeader } from "cookie";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import * as db from "../db";
import { getSessionCookieOptions } from "./cookies";
import { safeLog } from "./logger";
import { isFacebookLoginMethod } from "./portalAuthPolicy";

const OAUTH_STATE_COOKIE_NAME = "lb_oauth_state_nonce";

type OAuthStatePayload = {
  nonce: string;
  redirectUri: string;
};

const oauthCallbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

const oauthStateSchema = z.object({
  nonce: z.string().min(16),
  redirectUri: z.string().url(),
});

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
    ...cookieOptions,
    path: "/api/oauth/callback",
    sameSite: "lax",
  });
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
        const tokenResponse = await sdk.exchangeCodeForToken(
          code,
          validatedState.redirectUri
        );
        const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);
        const loginMethod = userInfo.loginMethod ?? userInfo.platform ?? null;

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
        await db.getOrCreateUserWorkspace(portalUser);

        const sessionToken = await sdk.createSessionToken(userInfo.openId, {
          name: userInfo.name || "",
          expiresInMs: ONE_YEAR_MS,
        });

        const cookieOptions = getSessionCookieOptions(req);
        res.cookie(COOKIE_NAME, sessionToken, {
          ...cookieOptions,
          maxAge: ONE_YEAR_MS,
        });
        clearOAuthStateCookie(req, res);

        res.redirect(302, "/");
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
