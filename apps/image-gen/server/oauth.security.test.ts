import http from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
}));

function buildState(redirectUri: string, nonce: string): string {
  return Buffer.from(JSON.stringify({ redirectUri, nonce }), "utf8").toString("base64");
}

async function sendCallbackRequest(params: {
  code: string;
  state: string;
  cookie?: string;
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; payload: string }> {
  const app = express();
  registerOAuthRoutes(app);

  const server = http.createServer(app);
  const boundServer = await bindTestHttpServer(server);

  const path = `/api/oauth/callback?code=${encodeURIComponent(params.code)}&state=${encodeURIComponent(params.state)}`;
  try {
    return await new Promise<{ status: number; headers: http.IncomingHttpHeaders; payload: string }>(
      (resolve, reject) => {
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
      }
    );
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
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
    vi.restoreAllMocks();
  });

  it("rejects callback requests with a missing matching state nonce cookie", async () => {
    const state = buildState("https://leaderbot.example/api/oauth/callback", "nonce-1234567890abcdef");

    const response = await sendCallbackRequest({
      code: "code-1",
      state,
    });

    expect(response.status).toBe(400);
    expect(response.payload).toContain("invalid oauth state");
    expect(mocks.exchangeCodeForToken).not.toHaveBeenCalled();
  });

  it("accepts callback requests when the nonce cookie matches", async () => {
    mocks.exchangeCodeForToken.mockResolvedValue({ accessToken: "access-token" });
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
    expect(mocks.exchangeCodeForToken).toHaveBeenCalledWith("code-2", redirectUri);
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

  it("fails the callback before session creation when the workspace is not persisted", async () => {
    mocks.exchangeCodeForToken.mockResolvedValue({ accessToken: "access-token" });
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
    mocks.exchangeCodeForToken.mockResolvedValue({ accessToken: "access-token" });
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
    mocks.exchangeCodeForToken.mockResolvedValue({ accessToken: "access-token" });
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
