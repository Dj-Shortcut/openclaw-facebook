import http from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getFacebookOAuthUrl,
  getStoredFacebookState,
} from "./_core/facebookConnectStore";
import { registerOAuthRoutes } from "./_core/oauth";
import { bindTestHttpServer } from "./testHttpServer";

const OAUTH_STATE_COOKIE_NAME = "lb_oauth_state_nonce";

const mocks = vi.hoisted(() => ({
  exchangeCodeForToken: vi.fn(),
  getUserInfo: vi.fn(),
  createSessionToken: vi.fn(),
  upsertUser: vi.fn(),
  getUserByOpenId: vi.fn(),
  getOrCreateUserWorkspace: vi.fn(),
  listChannelConnections: vi.fn(),
  upsertChannelConnection: vi.fn(),
  insertAuditLog: vi.fn(),
}));

vi.mock("./_core/sdk", () => ({
  sdk: {
    exchangeCodeForToken: mocks.exchangeCodeForToken,
    getUserInfo: mocks.getUserInfo,
    createSessionToken: mocks.createSessionToken,
  },
}));

vi.mock("./db", () => ({
  upsertUser: mocks.upsertUser,
  getUserByOpenId: mocks.getUserByOpenId,
  getOrCreateUserWorkspace: mocks.getOrCreateUserWorkspace,
  listChannelConnections: mocks.listChannelConnections,
  upsertChannelConnection: mocks.upsertChannelConnection,
  insertAuditLog: mocks.insertAuditLog,
}));

function buildState(
  redirectUri: string,
  nonce: string,
  returnTo?: string
): string {
  return Buffer.from(
    JSON.stringify({
      redirectUri,
      nonce,
      ...(returnTo ? { returnTo } : {}),
    }),
    "utf8"
  ).toString("base64");
}

async function sendCallbackRequest(params: {
  code: string;
  state: string;
  cookie?: string;
}): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  payload: string;
}> {
  const app = express();
  registerOAuthRoutes(app);

  const server = http.createServer(app);
  const boundServer = await bindTestHttpServer(server);

  const path = `/api/oauth/callback?code=${encodeURIComponent(params.code)}&state=${encodeURIComponent(params.state)}`;
  try {
    return await new Promise<{
      status: number;
      headers: http.IncomingHttpHeaders;
      payload: string;
    }>((resolve, reject) => {
      const request = http.request(
        {
          hostname: "127.0.0.1",
          port: boundServer.port,
          path,
          method: "GET",
          headers: params.cookie ? { cookie: params.cookie } : undefined,
        },
        res => {
          let payload = "";
          res.on("data", chunk => {
            payload += chunk;
          });
          res.on("end", () => {
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              payload,
            });
          });
        }
      );

      request.on("error", reject);
      request.end();
    });
  } finally {
    await boundServer.close();
  }
}

async function sendGetRequest(
  path: string,
  cookie?: string
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  payload: string;
}> {
  const app = express();
  registerOAuthRoutes(app);
  const server = http.createServer(app);
  const boundServer = await bindTestHttpServer(server);

  try {
    return await new Promise((resolve, reject) => {
      const request = http.request(
        {
          hostname: "127.0.0.1",
          port: boundServer.port,
          path,
          method: "GET",
          headers: cookie ? { cookie } : undefined,
        },
        response => {
          let payload = "";
          response.on("data", chunk => {
            payload += chunk;
          });
          response.on("end", () => {
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              payload,
            });
          });
        }
      );
      request.on("error", reject);
      request.end();
    });
  } finally {
    await boundServer.close();
  }
}

describe("OAuth callback security", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "x".repeat(32);
    mocks.exchangeCodeForToken.mockReset();
    mocks.getUserInfo.mockReset();
    mocks.createSessionToken.mockReset();
    mocks.upsertUser.mockReset();
    mocks.getUserByOpenId.mockReset();
    mocks.getOrCreateUserWorkspace.mockReset();
    mocks.listChannelConnections.mockReset();
    mocks.listChannelConnections.mockResolvedValue([]);
    mocks.upsertChannelConnection.mockReset();
    mocks.insertAuditLog.mockReset();
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("starts and completes a direct Facebook Login without exposing the app secret", async () => {
    vi.stubEnv("FB_APP_ID", "facebook-app-123");
    vi.stubEnv("FB_APP_SECRET", "server-only-secret");
    vi.stubEnv("FB_PAGE_CONNECT_CONFIG_ID", "2097873054148678");
    vi.stubEnv("APP_BASE_URL", "https://leaderbot.live");
    vi.stubEnv("NODE_ENV", "production");
    mocks.getUserByOpenId.mockResolvedValue({
      id: 7,
      openId: "facebook:facebook-user-7",
      name: "Test User",
      email: "test@example.com",
      loginMethod: "facebook",
      role: "user",
      createdAt: new Date(0),
      updatedAt: new Date(0),
      lastSignedIn: new Date(0),
    });
    mocks.createSessionToken.mockResolvedValue("session-token");
    mocks.getOrCreateUserWorkspace.mockResolvedValue({
      id: 42,
      name: "Test workspace",
      slug: "workspace-7",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "facebook-user-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "facebook-user-7",
            name: "Test User",
            email: "test@example.com",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "page-42",
                name: "Test Page",
                access_token: "facebook-page-token",
                perms: ["MANAGE"],
                tasks: ["MESSAGING"],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    const start = await sendGetRequest("/api/oauth/start?returnTo=%2Fportal");
    expect(start.status).toBe(302);
    expect(start.headers.location).not.toContain("server-only-secret");
    const authorizationUrl = new URL(
      start.headers.location ?? "https://invalid"
    );
    expect(authorizationUrl.hostname).toBe("www.facebook.com");
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "facebook-app-123"
    );
    expect(authorizationUrl.searchParams.has("config_id")).toBe(false);
    expect(
      new Set(authorizationUrl.searchParams.get("scope")?.split(","))
    ).toEqual(new Set(["public_profile", "pages_show_list"]));
    const pageConnectUrl = new URL(
      getFacebookOAuthUrl("page-connect-state") ?? "https://invalid"
    );
    expect(pageConnectUrl.searchParams.get("config_id")).toBe(
      "2097873054148678"
    );
    expect(
      pageConnectUrl.searchParams.get("override_default_response_type")
    ).toBe("true");
    expect(pageConnectUrl.searchParams.has("scope")).toBe(false);
    const state = authorizationUrl.searchParams.get("state");
    const stateCookie = start.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    const stateCookieHeader = start.headers["set-cookie"]?.[0] ?? "";
    expect(state).toBeTruthy();
    expect(stateCookie).toContain(`${OAUTH_STATE_COOKIE_NAME}=`);
    expect(stateCookieHeader).toContain("HttpOnly");
    expect(stateCookieHeader).toContain("Secure");
    expect(stateCookieHeader).toContain("SameSite=Lax");

    const callback = await sendGetRequest(
      `/api/oauth/callback?code=facebook-code&state=${encodeURIComponent(state ?? "")}`,
      stateCookie
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe("/portal");
    expect(mocks.exchangeCodeForToken).not.toHaveBeenCalled();
    const profileUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(profileUrl.searchParams.get("fields")).toBe("id,name");
    expect(profileUrl.searchParams.has("access_token")).toBe(false);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: {
        Accept: "application/json",
        Authorization: "Bearer facebook-user-token",
      },
    });
    const pagesUrl = new URL(String(fetchMock.mock.calls[2]?.[0]));
    expect(pagesUrl.pathname).toContain("/me/accounts");
    expect(pagesUrl.searchParams.has("access_token")).toBe(false);
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      headers: {
        Accept: "application/json",
        Authorization: "Bearer facebook-user-token",
      },
    });
    expect(mocks.upsertUser).toHaveBeenCalledWith(
      expect.objectContaining({
        openId: "facebook:facebook-user-7",
        loginMethod: "facebook",
      })
    );
    expect(mocks.createSessionToken).toHaveBeenCalledWith(
      "facebook:facebook-user-7",
      expect.any(Object)
    );
    expect(mocks.upsertChannelConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 42,
        channel: "facebook_messenger",
        status: "connected",
        externalId: "page-42",
        encryptedAccessToken: expect.stringMatching(/^v1:/),
      }),
      { updatePolicy: "preserve_exact_facebook_page_binding" }
    );
    expect(
      mocks.upsertChannelConnection.mock.calls[0]?.[0]?.encryptedAccessToken
    ).not.toContain("facebook-page-token");
  });

  it("uses the login authorization for Page selection without a second OAuth redirect", async () => {
    vi.stubEnv("FACEBOOK_CONNECT_STORAGE_MODE", "sealed_compat");
    vi.stubEnv("FB_APP_ID", "facebook-app-123");
    vi.stubEnv("FB_APP_SECRET", "server-only-secret");
    vi.stubEnv("APP_BASE_URL", "https://leaderbot.live");
    vi.stubEnv("NODE_ENV", "production");
    mocks.getUserByOpenId.mockResolvedValue({
      id: 7,
      openId: "facebook:facebook-user-7",
      name: "Test User",
      email: null,
      loginMethod: "facebook",
      role: "user",
      createdAt: new Date(0),
      updatedAt: new Date(0),
      lastSignedIn: new Date(0),
    });
    mocks.getOrCreateUserWorkspace.mockResolvedValue({
      id: 42,
      name: "Test workspace",
      slug: "workspace-7",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    mocks.createSessionToken.mockResolvedValue("session-token");
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ access_token: "facebook-user-token" }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          )
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ id: "facebook-user-7", name: "Test User" }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              data: [
                {
                  id: "page-a",
                  name: "Page A",
                  access_token: "page-token-a",
                  perms: ["MANAGE"],
                  tasks: ["MESSAGING"],
                },
                {
                  id: "page-b",
                  name: "Page B",
                  access_token: "page-token-b",
                  perms: ["MODERATE"],
                  tasks: ["MESSAGING"],
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        )
    );

    const start = await sendGetRequest("/api/oauth/start?returnTo=%2Fportal");
    const authorizationUrl = new URL(
      start.headers.location ?? "https://invalid"
    );
    expect(
      new Set(authorizationUrl.searchParams.get("scope")?.split(","))
    ).toEqual(new Set(["public_profile", "pages_show_list"]));
    const state = authorizationUrl.searchParams.get("state") ?? "";
    const stateCookie = start.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    const callback = await sendGetRequest(
      `/api/oauth/callback?code=facebook-code&state=${encodeURIComponent(state)}`,
      stateCookie
    );

    expect(callback.status).toBe(302);
    const redirect = new URL(
      callback.headers.location ?? "/",
      "https://leaderbot.live"
    );
    expect(redirect.pathname).toBe("/portal");
    const connectState = redirect.searchParams.get("facebookConnectState");
    expect(connectState).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(callback.headers.location).not.toContain("page-token-a");
    expect(callback.headers.location).not.toContain("page-token-b");
    expect(
      (await getStoredFacebookState(connectState ?? ""))?.pages
    ).toHaveLength(2);
    expect(mocks.upsertChannelConnection).not.toHaveBeenCalled();
    expect(mocks.insertAuditLog).toHaveBeenCalledWith({
      workspaceId: 42,
      userId: 7,
      event: "facebook_login.page_selection_required",
      metadata: { pageCount: 2 },
    });
  });

  it("does not rotate or replace an existing connected Page during login", async () => {
    vi.stubEnv("FB_APP_ID", "facebook-app-123");
    vi.stubEnv("FB_APP_SECRET", "server-only-secret");
    vi.stubEnv("APP_BASE_URL", "https://leaderbot.live");
    mocks.getUserByOpenId.mockResolvedValue({
      id: 7,
      openId: "facebook:facebook-user-7",
      name: "Test User",
      email: null,
      loginMethod: "facebook",
      role: "user",
      createdAt: new Date(0),
      updatedAt: new Date(0),
      lastSignedIn: new Date(0),
    });
    mocks.getOrCreateUserWorkspace.mockResolvedValue({
      id: 42,
      name: "Test workspace",
      slug: "workspace-7",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    mocks.listChannelConnections.mockResolvedValue([
      {
        channel: "facebook_messenger",
        status: "connected",
        externalId: "existing-page",
      },
    ]);
    mocks.createSessionToken.mockResolvedValue("session-token");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "facebook-user-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: "facebook-user-7", name: "Test User" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    const start = await sendGetRequest("/api/oauth/start?returnTo=%2Fportal");
    const authorizationUrl = new URL(
      start.headers.location ?? "https://invalid"
    );
    const state = authorizationUrl.searchParams.get("state") ?? "";
    const stateCookie = start.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    const callback = await sendGetRequest(
      `/api/oauth/callback?code=facebook-code&state=${encodeURIComponent(state)}`,
      stateCookie
    );

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe("/portal");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.upsertChannelConnection).not.toHaveBeenCalled();
  });

  it("does not bind a Page before a Messenger handoff has resolved its workspace", async () => {
    vi.stubEnv("FB_APP_ID", "facebook-app-123");
    vi.stubEnv("FB_APP_SECRET", "server-only-secret");
    vi.stubEnv("APP_BASE_URL", "https://leaderbot.live");
    mocks.getUserByOpenId.mockResolvedValue({
      id: 7,
      openId: "facebook:facebook-user-7",
      name: "Test User",
      email: null,
      loginMethod: "facebook",
      role: "user",
      createdAt: new Date(0),
      updatedAt: new Date(0),
      lastSignedIn: new Date(0),
    });
    mocks.createSessionToken.mockResolvedValue("session-token");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "facebook-user-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: "facebook-user-7", name: "Test User" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    const start = await sendGetRequest(
      "/api/oauth/start?returnTo=%2Fhandoff%2Ftoken-123"
    );
    const authorizationUrl = new URL(
      start.headers.location ?? "https://invalid"
    );
    const state = authorizationUrl.searchParams.get("state") ?? "";
    const stateCookie = start.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    const callback = await sendGetRequest(
      `/api/oauth/callback?code=facebook-code&state=${encodeURIComponent(state)}`,
      stateCookie
    );

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe("/handoff/token-123");
    expect(mocks.getOrCreateUserWorkspace).not.toHaveBeenCalled();
    expect(mocks.listChannelConnections).not.toHaveBeenCalled();
    expect(mocks.upsertChannelConnection).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects callback requests with a missing matching state nonce cookie", async () => {
    const state = buildState(
      "https://leaderbot.example/api/oauth/callback",
      "nonce-1234567890abcdef"
    );

    const response = await sendCallbackRequest({
      code: "code-1",
      state,
    });

    expect(response.status).toBe(400);
    expect(response.payload).toContain("invalid oauth state");
    expect(mocks.exchangeCodeForToken).not.toHaveBeenCalled();
  });

  it("accepts callback requests when the nonce cookie matches", async () => {
    mocks.exchangeCodeForToken.mockResolvedValue({
      accessToken: "access-token",
    });
    mocks.getUserInfo.mockResolvedValue({
      openId: "open-id-1",
      name: "Test User",
      email: "test@example.com",
      loginMethod: "facebook",
      platform: "facebook",
    });
    mocks.getUserByOpenId.mockResolvedValue({
      id: 7,
      openId: "open-id-1",
      name: "Test User",
      email: "test@example.com",
      loginMethod: "facebook",
      role: "user",
      createdAt: new Date(0),
      updatedAt: new Date(0),
      lastSignedIn: new Date(0),
    });
    mocks.getOrCreateUserWorkspace.mockResolvedValue({
      id: 42,
      name: "Test User's workspace",
      slug: "workspace-7",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    mocks.createSessionToken.mockResolvedValue("session-token");

    const nonce = "nonce-1234567890abcdef";
    const redirectUri = "https://leaderbot.example/api/oauth/callback";
    const state = buildState(redirectUri, nonce);
    const response = await sendCallbackRequest({
      code: "code-2",
      state,
      cookie: `${OAUTH_STATE_COOKIE_NAME}=${nonce}`,
    });

    expect(response.status).toBe(302);
    expect(mocks.exchangeCodeForToken).toHaveBeenCalledWith(
      "code-2",
      redirectUri
    );
    expect(mocks.upsertUser).toHaveBeenCalledWith(
      expect.objectContaining({
        openId: "open-id-1",
        loginMethod: "facebook",
      })
    );
    expect(mocks.getUserByOpenId).toHaveBeenCalledWith("open-id-1");
    expect(mocks.getOrCreateUserWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 7,
        openId: "open-id-1",
        loginMethod: "facebook",
      })
    );
    expect(mocks.createSessionToken).toHaveBeenCalled();
  });

  it("redirects to a safe relative return path after login", async () => {
    mocks.exchangeCodeForToken.mockResolvedValue({
      accessToken: "access-token",
    });
    mocks.getUserInfo.mockResolvedValue({
      openId: "open-id-1",
      name: "Test User",
      email: "test@example.com",
      loginMethod: "facebook",
      platform: "facebook",
    });
    mocks.getUserByOpenId.mockResolvedValue({
      id: 7,
      openId: "open-id-1",
      name: "Test User",
      email: "test@example.com",
      loginMethod: "facebook",
      role: "user",
      createdAt: new Date(0),
      updatedAt: new Date(0),
      lastSignedIn: new Date(0),
    });
    mocks.getOrCreateUserWorkspace.mockResolvedValue({
      id: 42,
      name: "Test User's workspace",
      slug: "workspace-7",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    mocks.createSessionToken.mockResolvedValue("session-token");

    const nonce = "nonce-1234567890abcdef";
    const redirectUri = "https://leaderbot.example/api/oauth/callback";
    const state = buildState(redirectUri, nonce, "/handoff");
    const response = await sendCallbackRequest({
      code: "code-return",
      state,
      cookie: `${OAUTH_STATE_COOKIE_NAME}=${nonce}`,
    });

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("/handoff");
    expect(mocks.getOrCreateUserWorkspace).not.toHaveBeenCalled();
  });

  it("falls back to the portal root for unsafe return paths", async () => {
    mocks.exchangeCodeForToken.mockResolvedValue({
      accessToken: "access-token",
    });
    mocks.getUserInfo.mockResolvedValue({
      openId: "open-id-1",
      name: "Test User",
      email: "test@example.com",
      loginMethod: "facebook",
      platform: "facebook",
    });
    mocks.getUserByOpenId.mockResolvedValue({
      id: 7,
      openId: "open-id-1",
      name: "Test User",
      email: "test@example.com",
      loginMethod: "facebook",
      role: "user",
      createdAt: new Date(0),
      updatedAt: new Date(0),
      lastSignedIn: new Date(0),
    });
    mocks.getOrCreateUserWorkspace.mockResolvedValue({
      id: 42,
      name: "Test User's workspace",
      slug: "workspace-7",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    mocks.createSessionToken.mockResolvedValue("session-token");

    const nonce = "nonce-1234567890abcdef";
    const redirectUri = "https://leaderbot.example/api/oauth/callback";
    const state = buildState(redirectUri, nonce, "//evil.example/handoff");
    const response = await sendCallbackRequest({
      code: "code-unsafe-return",
      state,
      cookie: `${OAUTH_STATE_COOKIE_NAME}=${nonce}`,
    });

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("/");
  });

  it("fails the callback before session creation when the workspace is not persisted", async () => {
    mocks.exchangeCodeForToken.mockResolvedValue({
      accessToken: "access-token",
    });
    mocks.getUserInfo.mockResolvedValue({
      openId: "open-id-1",
      name: "Test User",
      email: "test@example.com",
      loginMethod: "facebook",
      platform: "facebook",
    });
    mocks.getUserByOpenId.mockResolvedValue({
      id: 7,
      openId: "open-id-1",
      name: "Test User",
      email: "test@example.com",
      loginMethod: "facebook",
      role: "user",
      createdAt: new Date(0),
      updatedAt: new Date(0),
      lastSignedIn: new Date(0),
    });
    mocks.getOrCreateUserWorkspace.mockRejectedValue(
      new Error("Database unavailable: workspace was not loaded")
    );

    const nonce = "nonce-1234567890abcdef";
    const redirectUri = "https://leaderbot.example/api/oauth/callback";
    const state = buildState(redirectUri, nonce);
    const response = await sendCallbackRequest({
      code: "code-workspace-fail",
      state,
      cookie: `${OAUTH_STATE_COOKIE_NAME}=${nonce}`,
    });

    expect(response.status).toBe(500);
    expect(mocks.createSessionToken).not.toHaveBeenCalled();
  });

  it("fails the callback before session creation when the portal customer is not persisted", async () => {
    mocks.exchangeCodeForToken.mockResolvedValue({
      accessToken: "access-token",
    });
    mocks.getUserInfo.mockResolvedValue({
      openId: "open-id-missing",
      name: "Missing User",
      email: "missing@example.com",
      loginMethod: "facebook",
      platform: "facebook",
    });
    mocks.getUserByOpenId.mockResolvedValue(null);

    const nonce = "nonce-1234567890abcdef";
    const redirectUri = "https://leaderbot.example/api/oauth/callback";
    const state = buildState(redirectUri, nonce);
    const response = await sendCallbackRequest({
      code: "code-missing-user",
      state,
      cookie: `${OAUTH_STATE_COOKIE_NAME}=${nonce}`,
    });

    expect(response.status).toBe(500);
    expect(mocks.getOrCreateUserWorkspace).not.toHaveBeenCalled();
    expect(mocks.createSessionToken).not.toHaveBeenCalled();
  });

  it("rejects non-Facebook OAuth identities before creating a portal session", async () => {
    mocks.exchangeCodeForToken.mockResolvedValue({
      accessToken: "access-token",
    });
    mocks.getUserInfo.mockResolvedValue({
      openId: "open-id-email",
      name: "Email User",
      email: "email@example.com",
      loginMethod: "email",
      platform: "email",
    });

    const nonce = "nonce-1234567890abcdef";
    const redirectUri = "https://leaderbot.example/api/oauth/callback";
    const state = buildState(redirectUri, nonce);
    const response = await sendCallbackRequest({
      code: "code-email",
      state,
      cookie: `${OAUTH_STATE_COOKIE_NAME}=${nonce}`,
    });

    expect(response.status).toBe(403);
    expect(response.payload).toContain("Facebook Login is required");
    expect(mocks.upsertUser).not.toHaveBeenCalled();
    expect(mocks.getUserByOpenId).not.toHaveBeenCalled();
    expect(mocks.getOrCreateUserWorkspace).not.toHaveBeenCalled();
    expect(mocks.createSessionToken).not.toHaveBeenCalled();
  });

  it("rejects malformed state payloads through the callback route", async () => {
    const response = await sendCallbackRequest({
      code: "code-3",
      state: "not-base64",
      cookie: `${OAUTH_STATE_COOKIE_NAME}=nonce-1234567890abcdef`,
    });

    expect(response.status).toBe(400);
    expect(response.payload).toContain("invalid oauth state");
    expect(mocks.exchangeCodeForToken).not.toHaveBeenCalled();
  });
});
