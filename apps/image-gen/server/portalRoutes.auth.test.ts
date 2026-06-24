import http from "node:http";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerPortalRoutes } from "./_core/portalRoutes";
import { bindTestHttpServer } from "./testHttpServer";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  getOrCreateUserWorkspace: vi.fn(),
  getWorkspaceMembership: vi.fn(),
  getOrCreateAiIdentity: vi.fn(),
  listChannelConnections: vi.fn(),
  getWorkspaceUsageSummary: vi.fn(),
  listWorkspaceUpgradeRequests: vi.fn(),
  getWorkspaceKnowledgeSummary: vi.fn(),
  getWorkspacePrivacySettings: vi.fn(),
  updateAiIdentity: vi.fn(),
  insertAuditLog: vi.fn(),
}));

vi.mock("./_core/sdk", () => ({
  sdk: {
    authenticateRequest: mocks.authenticateRequest,
  },
}));

vi.mock("./db", () => ({
  getOrCreateUserWorkspace: mocks.getOrCreateUserWorkspace,
  getWorkspaceMembership: mocks.getWorkspaceMembership,
  getOrCreateAiIdentity: mocks.getOrCreateAiIdentity,
  listChannelConnections: mocks.listChannelConnections,
  getWorkspaceUsageSummary: mocks.getWorkspaceUsageSummary,
  listWorkspaceUpgradeRequests: mocks.listWorkspaceUpgradeRequests,
  getWorkspaceKnowledgeSummary: mocks.getWorkspaceKnowledgeSummary,
  getWorkspacePrivacySettings: mocks.getWorkspacePrivacySettings,
  updateAiIdentity: mocks.updateAiIdentity,
  insertAuditLog: mocks.insertAuditLog,
}));

const user = {
  id: 7,
  openId: "portal-user-7",
  email: "portal@example.com",
  name: "Portal User",
  loginMethod: "facebook",
  role: "user",
  createdAt: new Date(0),
  updatedAt: new Date(0),
  lastSignedIn: new Date(0),
};

async function sendPortalRequest(input: {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
}) {
  const app = express();
  app.use(express.json());
  registerPortalRoutes(app);

  const server = http.createServer(app);
  const boundServer = await bindTestHttpServer(server);
  const payload = input.body === undefined ? undefined : JSON.stringify(input.body);

  try {
    return await new Promise<{
      status: number;
      body: string;
      json: unknown;
    }>((resolve, reject) => {
      const request = http.request(
        {
          hostname: "127.0.0.1",
          port: boundServer.port,
          path: input.path,
          method: input.method,
          headers: payload
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              }
            : undefined,
        },
        res => {
          let body = "";
          res.on("data", chunk => {
            body += chunk;
          });
          res.on("end", () => {
            resolve({
              status: res.statusCode ?? 0,
              body,
              json: body ? JSON.parse(body) : null,
            });
          });
        }
      );

      request.on("error", reject);
      if (payload) {
        request.write(payload);
      }
      request.end();
    });
  } finally {
    await boundServer.close();
  }
}

describe("portal REST route authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unauthenticated portal snapshots before reading workspace data", async () => {
    mocks.authenticateRequest.mockRejectedValue(new Error("no session"));

    const response = await sendPortalRequest({
      method: "GET",
      path: "/api/portal/snapshot",
    });

    expect(response.status).toBe(401);
    expect(response.json).toEqual({ error: "unauthenticated" });
    expect(mocks.getOrCreateUserWorkspace).not.toHaveBeenCalled();
    expect(mocks.getWorkspaceMembership).not.toHaveBeenCalled();
    expect(mocks.getOrCreateAiIdentity).not.toHaveBeenCalled();
  });

  it("rejects non-Facebook portal snapshots before reading workspace data", async () => {
    mocks.authenticateRequest.mockResolvedValue({
      ...user,
      loginMethod: "email",
    });

    const response = await sendPortalRequest({
      method: "GET",
      path: "/api/portal/snapshot",
    });

    expect(response.status).toBe(403);
    expect(response.json).toEqual({ error: "facebook_login_required" });
    expect(mocks.getOrCreateUserWorkspace).not.toHaveBeenCalled();
    expect(mocks.getWorkspaceMembership).not.toHaveBeenCalled();
    expect(mocks.getOrCreateAiIdentity).not.toHaveBeenCalled();
  });

  it("rejects cross-workspace AI identity updates before mutating or auditing data", async () => {
    mocks.authenticateRequest.mockResolvedValue(user);
    mocks.getWorkspaceMembership.mockResolvedValue(null);

    const response = await sendPortalRequest({
      method: "POST",
      path: "/api/portal/ai-identity",
      body: {
        workspaceId: 42,
        name: "Other Workspace Bot",
        instructions: "No cross-tenant writes.",
        tone: "Helpful",
        language: "nl",
        modelDefault: "default",
      },
    });

    expect(response.status).toBe(403);
    expect(response.json).toEqual({ error: "workspace access denied" });
    expect(mocks.getWorkspaceMembership).toHaveBeenCalledWith(42, user.id);
    expect(mocks.updateAiIdentity).not.toHaveBeenCalled();
    expect(mocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it("returns a tenant-scoped portal snapshot for an authenticated workspace member", async () => {
    const workspace = {
      id: 42,
      ownerUserId: user.id,
      slug: "portal-user",
      name: "Portal User Workspace",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    mocks.authenticateRequest.mockResolvedValue(user);
    mocks.getOrCreateUserWorkspace.mockResolvedValue(workspace);
    mocks.getWorkspaceMembership.mockResolvedValue({
      workspaceId: workspace.id,
      userId: user.id,
      role: "owner",
    });
    mocks.getOrCreateAiIdentity.mockResolvedValue({
      id: 1,
      workspaceId: workspace.id,
      name: "Leaderbot",
      instructions: null,
      tone: "Helpful",
      language: "nl",
      modelDefault: "default",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    mocks.listChannelConnections.mockResolvedValue([
      {
        id: 1,
        workspaceId: workspace.id,
        channel: "facebook_messenger",
        status: "connected",
        externalId: "page-1",
        displayName: "Customer Page",
        encryptedAccessToken: "sealed-token",
        grantedScopes: ["pages_messaging"],
        lastCheckedAt: new Date(0),
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ]);
    mocks.getWorkspaceUsageSummary.mockResolvedValue({
      workspaceId: workspace.id,
      period: "today",
      plan: {
        name: "Free",
        billingStatus: "free",
      },
      messageCount: 3,
      imageCount: 1,
      blockedCount: 0,
      limits: {
        imagesPerDay: 20,
        messagesPerWindow: 30,
        messageWindowSeconds: 60,
      },
      remaining: {
        imagesToday: 19,
      },
      upgrade: {
        recommended: false,
        reason: null,
      },
    });
    mocks.listWorkspaceUpgradeRequests.mockResolvedValue([
      {
        id: 3,
        workspaceId: workspace.id,
        userId: user.id,
        status: "requested",
        currentPlanName: "Free",
        billingStatus: "free",
        upgradeReason: "blocked_usage",
        imagesRemainingToday: 19,
        blockedToday: 1,
        requestedPlanName: "Premium",
        createdAt: new Date(0),
        updatedAt: new Date(0),
        completedAt: null,
      },
    ]);
    mocks.getWorkspaceKnowledgeSummary.mockResolvedValue({
      workspaceId: workspace.id,
      totalSources: 0,
      activeSources: 0,
      lastUpdate: new Date(0),
      sources: [],
    });
    mocks.getWorkspacePrivacySettings.mockResolvedValue({
      workspaceId: workspace.id,
      allowKnowledgeIndexing: true,
      allowUsageAnalytics: false,
      imageMemoryRetentionDays: 30,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });

    const response = await sendPortalRequest({
      method: "GET",
      path: "/api/portal/snapshot",
    });

    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      workspace: { id: workspace.id },
      user: { id: user.id, email: user.email },
      channels: [
        {
          channel: "facebook_messenger",
          status: "connected",
          externalId: "page-1",
        },
      ],
      usage: {
        plan: {
          name: "Free",
          billingStatus: "free",
        },
        remaining: {
          imagesToday: 19,
        },
        upgrade: {
          recommended: false,
        },
        upgradeRequests: [
          {
            status: "requested",
            requestedPlanName: "Premium",
          },
        ],
      },
    });
    expect(JSON.stringify(response.json)).not.toContain("sealed-token");
    expect(mocks.listWorkspaceUpgradeRequests).toHaveBeenCalledWith(workspace.id);
  });
});
