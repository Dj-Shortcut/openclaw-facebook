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
        workspaceId: 42,
        name: "Other Workspace Bot",
        instructions: "Do not cross tenant boundaries.",
        tone: "Helpful",
        language: "nl",
        modelDefault: "default",
      })
    );

    expect(mocks.getWorkspaceMembership).toHaveBeenCalledWith(42, user.id);
    expect(mocks.updateAiIdentity).not.toHaveBeenCalled();
    expect(mocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it("rejects cross-workspace channel and usage reads before returning tenant data", async () => {
    const caller = createCaller();

    await expectForbidden(() => caller.channels.list({ workspaceId: 42 }));
    await expectForbidden(() => caller.channels.status({ workspaceId: 42 }));
    await expectForbidden(() => caller.usage.summary({ workspaceId: 42 }));

    expect(mocks.getWorkspaceMembership).toHaveBeenCalledTimes(3);
    expect(mocks.listChannelConnections).not.toHaveBeenCalled();
    expect(mocks.getWorkspaceUsageSummary).not.toHaveBeenCalled();
  });

  it("rejects cross-workspace Facebook connect starts before creating state or audit logs", async () => {
    const caller = createCaller();

    await expectForbidden(() => caller.facebook.startConnect({ workspaceId: 42 }));

    expect(mocks.getWorkspaceMembership).toHaveBeenCalledWith(42, user.id);
    expect(mocks.insertAuditLog).not.toHaveBeenCalled();
  });
});
