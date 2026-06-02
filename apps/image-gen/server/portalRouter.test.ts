import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";
import { portalRouter } from "./_core/portalRouter";

const mocks = vi.hoisted(() => ({
  getOrCreateUserWorkspace: vi.fn(),
  getWorkspaceMembership: vi.fn(),
  getOrCreateAiIdentity: vi.fn(),
  updateAiIdentity: vi.fn(),
  listChannelConnections: vi.fn(),
  getWorkspaceUsageSummary: vi.fn(),
  insertAuditLog: vi.fn(),
}));

vi.mock("./db", () => ({
  getOrCreateUserWorkspace: mocks.getOrCreateUserWorkspace,
  getWorkspaceMembership: mocks.getWorkspaceMembership,
  getOrCreateAiIdentity: mocks.getOrCreateAiIdentity,
  updateAiIdentity: mocks.updateAiIdentity,
  listChannelConnections: mocks.listChannelConnections,
  getWorkspaceUsageSummary: mocks.getWorkspaceUsageSummary,
  insertAuditLog: mocks.insertAuditLog,
}));

const user: NonNullable<TrpcContext["user"]> = {
  id: 7,
  openId: "portal-user-7",
  email: "portal-user@example.com",
  name: "Portal User",
  loginMethod: "manus",
  role: "user",
  createdAt: new Date(0),
  updatedAt: new Date(0),
  lastSignedIn: new Date(0),
};

const workspaceId = 42;
const aiIdentityUpdateInput = {
  workspaceId,
  name: "Leaderbot Support",
  instructions: "Answer as the customer support assistant.",
  tone: "Helpful",
  language: "nl",
  modelDefault: "default",
};

function createCaller() {
  return portalRouter.createCaller({
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  });
}

async function expectForbidden(call: () => Promise<unknown>) {
  await expect(call()).rejects.toMatchObject({
    code: "FORBIDDEN",
    message: "workspace access denied",
  });
}

describe("portal router tenant isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getWorkspaceMembership.mockResolvedValue(null);
  });

  it("rejects cross-workspace AI identity updates before mutating data", async () => {
    const caller = createCaller();

    await expectForbidden(() =>
      caller.aiIdentity.update({
        ...aiIdentityUpdateInput,
        name: "Other Workspace Bot",
        instructions: "Do not cross tenant boundaries.",
      })
    );

    expect(mocks.getWorkspaceMembership).toHaveBeenCalledWith(workspaceId, user.id);
    expect(mocks.updateAiIdentity).not.toHaveBeenCalled();
    expect(mocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it("rejects cross-workspace channel and usage reads before returning tenant data", async () => {
    const caller = createCaller();

    await expectForbidden(() => caller.channels.list({ workspaceId }));
    await expectForbidden(() => caller.channels.status({ workspaceId }));
    await expectForbidden(() => caller.usage.summary({ workspaceId }));

    expect(mocks.getWorkspaceMembership).toHaveBeenCalledTimes(3);
    expect(mocks.listChannelConnections).not.toHaveBeenCalled();
    expect(mocks.getWorkspaceUsageSummary).not.toHaveBeenCalled();
  });

  it("rejects cross-workspace Facebook connect starts before creating state or audit logs", async () => {
    const caller = createCaller();

    await expectForbidden(() => caller.facebook.startConnect({ workspaceId }));

    expect(mocks.getWorkspaceMembership).toHaveBeenCalledWith(workspaceId, user.id);
    expect(mocks.insertAuditLog).not.toHaveBeenCalled();
  });
});

describe("portal router audit logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getWorkspaceMembership.mockResolvedValue({
      workspaceId,
      userId: user.id,
      role: "owner",
    });
  });

  it("records an audit log when a workspace AI identity is updated", async () => {
    const caller = createCaller();
    const updatedIdentity = {
      id: workspaceId,
      ...aiIdentityUpdateInput,
      createdAt: new Date(0),
      updatedAt: new Date(1),
    };
    mocks.updateAiIdentity.mockResolvedValue(updatedIdentity);

    await expect(caller.aiIdentity.update(aiIdentityUpdateInput)).resolves.toEqual(updatedIdentity);

    expect(mocks.insertAuditLog).toHaveBeenCalledWith({
      workspaceId,
      userId: user.id,
      event: "ai_identity.updated",
      metadata: {
        fields: ["name", "instructions", "tone", "language", "modelDefault"],
      },
    });
  });

  it("records an audit log when Facebook connect is started", async () => {
    const caller = createCaller();
    const originalFbAppId = process.env.FB_APP_ID;

    try {
      delete process.env.FB_APP_ID;

      await expect(caller.facebook.startConnect({ workspaceId })).resolves.toMatchObject({
        authorizationUrl: null,
        callbackMode: "hosted",
      });
    } finally {
      if (originalFbAppId === undefined) {
        delete process.env.FB_APP_ID;
      } else {
        process.env.FB_APP_ID = originalFbAppId;
      }
    }

    expect(mocks.insertAuditLog).toHaveBeenCalledWith({
      workspaceId,
      userId: user.id,
      event: "facebook_connect.started",
      metadata: {
        scopes: ["pages_show_list", "pages_manage_metadata", "pages_messaging"],
      },
    });
  });
});
