import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";
import { portalRouter } from "./_core/portalRouter";

const mocks = vi.hoisted(() => ({
  getOrCreateUserWorkspace: vi.fn(),
  getWorkspaceMembership: vi.fn(),
  listWorkspaceMembers: vi.fn(),
  updateWorkspace: vi.fn(),
  getOrCreateAiIdentity: vi.fn(),
  updateAiIdentity: vi.fn(),
  listChannelConnections: vi.fn(),
  disconnectChannelConnection: vi.fn(),
  getWorkspaceUsageSummary: vi.fn(),
  listWorkspaceKnowledgeSources: vi.fn(),
  getWorkspaceKnowledgeSummary: vi.fn(),
  registerWorkspaceKnowledgeSource: vi.fn(),
  disableWorkspaceKnowledgeSource: vi.fn(),
  getWorkspacePrivacySettings: vi.fn(),
  updateWorkspacePrivacySettings: vi.fn(),
  listWorkspacePrivacyRequests: vi.fn(),
  createWorkspacePrivacyRequest: vi.fn(),
  insertAuditLog: vi.fn(),
}));

vi.mock("./db", () => ({
  getOrCreateUserWorkspace: mocks.getOrCreateUserWorkspace,
  getWorkspaceMembership: mocks.getWorkspaceMembership,
  listWorkspaceMembers: mocks.listWorkspaceMembers,
  updateWorkspace: mocks.updateWorkspace,
  getOrCreateAiIdentity: mocks.getOrCreateAiIdentity,
  updateAiIdentity: mocks.updateAiIdentity,
  listChannelConnections: mocks.listChannelConnections,
  disconnectChannelConnection: mocks.disconnectChannelConnection,
  getWorkspaceUsageSummary: mocks.getWorkspaceUsageSummary,
  listWorkspaceKnowledgeSources: mocks.listWorkspaceKnowledgeSources,
  getWorkspaceKnowledgeSummary: mocks.getWorkspaceKnowledgeSummary,
  registerWorkspaceKnowledgeSource: mocks.registerWorkspaceKnowledgeSource,
  disableWorkspaceKnowledgeSource: mocks.disableWorkspaceKnowledgeSource,
  getWorkspacePrivacySettings: mocks.getWorkspacePrivacySettings,
  updateWorkspacePrivacySettings: mocks.updateWorkspacePrivacySettings,
  listWorkspacePrivacyRequests: mocks.listWorkspacePrivacyRequests,
  createWorkspacePrivacyRequest: mocks.createWorkspacePrivacyRequest,
  insertAuditLog: mocks.insertAuditLog,
}));

const user: NonNullable<TrpcContext["user"]> = {
  id: 7,
  openId: "portal-user-7",
  email: "portal-user@example.com",
  name: "Portal User",
  loginMethod: "facebook",
  role: "user",
  createdAt: new Date(0),
  updatedAt: new Date(0),
  lastSignedIn: new Date(0),
};

const workspaceId = 42;
const workspace = {
  id: workspaceId,
  ownerUserId: user.id,
  slug: "portal-user",
  name: "Portal User Workspace",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
const aiIdentityUpdateInput = {
  workspaceId,
  name: "Leaderbot Support",
  instructions: "Answer as the customer support assistant.",
  tone: "Helpful",
  language: "nl",
  modelDefault: "default",
};

const workspaceUpdateInput = {
  workspaceId,
  name: "Leaderbot Support Workspace",
};

const privacyControlsUpdateInput = {
  workspaceId,
  allowKnowledgeIndexing: false,
  allowUsageAnalytics: true,
  imageMemoryRetentionDays: 14,
};

const knowledgeSourceInput = {
  workspaceId,
  sourceType: "website" as const,
  name: "Support docs",
  sourceReference: "https://example.com/help",
};

const privacyRequestInput = {
  workspaceId,
  requestType: "deletion" as const,
  note: "Please delete the customer workspace data.",
};

function createCaller(overrides: Partial<TrpcContext> = {}) {
  return portalRouter.createCaller({
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
    ...overrides,
  });
}

async function expectForbidden(call: () => Promise<unknown>) {
  await expect(call()).rejects.toMatchObject({
    code: "FORBIDDEN",
    message: "workspace access denied",
  });
}

async function expectFacebookLoginRequired(call: () => Promise<unknown>) {
  await expect(call()).rejects.toMatchObject({
    code: "FORBIDDEN",
    message: "facebook login required",
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

  it("rejects portal auth sessions when the user has no workspace membership", async () => {
    const caller = createCaller();
    mocks.getOrCreateUserWorkspace.mockResolvedValue(workspace);

    await expectForbidden(() => caller.auth.session());

    expect(mocks.getOrCreateUserWorkspace).toHaveBeenCalledWith(user);
    expect(mocks.getWorkspaceMembership).toHaveBeenCalledWith(workspaceId, user.id);
  });

  it("rejects non-Facebook customer sessions before creating a workspace", async () => {
    const caller = createCaller({
      user: {
        ...user,
        loginMethod: "email",
      },
    });

    await expectFacebookLoginRequired(() => caller.auth.session());

    expect(mocks.getOrCreateUserWorkspace).not.toHaveBeenCalled();
    expect(mocks.getWorkspaceMembership).not.toHaveBeenCalled();
  });

  it("rejects cross-workspace workspace updates before mutating data", async () => {
    const caller = createCaller();

    await expectForbidden(() => caller.workspace.update(workspaceUpdateInput));

    expect(mocks.getWorkspaceMembership).toHaveBeenCalledWith(workspaceId, user.id);
    expect(mocks.updateWorkspace).not.toHaveBeenCalled();
    expect(mocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it("rejects cross-workspace workspace member reads before returning account data", async () => {
    const caller = createCaller();

    await expectForbidden(() => caller.workspace.members({ workspaceId }));

    expect(mocks.getWorkspaceMembership).toHaveBeenCalledWith(workspaceId, user.id);
    expect(mocks.listWorkspaceMembers).not.toHaveBeenCalled();
    expect(mocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it("rejects cross-workspace channel and usage reads before returning tenant data", async () => {
    const caller = createCaller();

    await expectForbidden(() => caller.channels.list({ workspaceId }));
    await expectForbidden(() => caller.channels.status({ workspaceId }));
    await expectForbidden(() => caller.usage.summary({ workspaceId }));
    await expectForbidden(() => caller.usage.requestUpgrade({ workspaceId }));
    await expectForbidden(() => caller.knowledge.list({ workspaceId }));
    await expectForbidden(() => caller.knowledge.summary({ workspaceId }));
    await expectForbidden(() => caller.privacy.controls({ workspaceId }));
    await expectForbidden(() => caller.privacy.requests({ workspaceId }));

    expect(mocks.getWorkspaceMembership).toHaveBeenCalledTimes(8);
    expect(mocks.listChannelConnections).not.toHaveBeenCalled();
    expect(mocks.getWorkspaceUsageSummary).not.toHaveBeenCalled();
    expect(mocks.listWorkspaceKnowledgeSources).not.toHaveBeenCalled();
    expect(mocks.getWorkspaceKnowledgeSummary).not.toHaveBeenCalled();
    expect(mocks.getWorkspacePrivacySettings).not.toHaveBeenCalled();
    expect(mocks.listWorkspacePrivacyRequests).not.toHaveBeenCalled();
  });

  it("rejects cross-workspace Facebook connect starts before creating state or audit logs", async () => {
    const caller = createCaller();

    await expectForbidden(() => caller.facebook.startConnect({ workspaceId }));

    expect(mocks.getWorkspaceMembership).toHaveBeenCalledWith(workspaceId, user.id);
    expect(mocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it("rejects cross-workspace Facebook disconnects before mutating channel state", async () => {
    const caller = createCaller();

    await expectForbidden(() => caller.facebook.disconnect({ workspaceId }));

    expect(mocks.getWorkspaceMembership).toHaveBeenCalledWith(workspaceId, user.id);
    expect(mocks.listChannelConnections).not.toHaveBeenCalled();
    expect(mocks.disconnectChannelConnection).not.toHaveBeenCalled();
    expect(mocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it("rejects cross-workspace privacy updates before mutating data", async () => {
    const caller = createCaller();

    await expectForbidden(() =>
      caller.privacy.updateControls(privacyControlsUpdateInput)
    );

    expect(mocks.getWorkspaceMembership).toHaveBeenCalledWith(workspaceId, user.id);
    expect(mocks.updateWorkspacePrivacySettings).not.toHaveBeenCalled();
    expect(mocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it("rejects cross-workspace knowledge source registration before mutating data", async () => {
    const caller = createCaller();

    await expectForbidden(() => caller.knowledge.registerSource(knowledgeSourceInput));

    expect(mocks.getWorkspaceMembership).toHaveBeenCalledWith(workspaceId, user.id);
    expect(mocks.registerWorkspaceKnowledgeSource).not.toHaveBeenCalled();
    expect(mocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it("rejects cross-workspace knowledge source disable before mutating data", async () => {
    const caller = createCaller();

    await expectForbidden(() =>
      caller.knowledge.disableSource({ workspaceId, sourceId: 11 })
    );

    expect(mocks.getWorkspaceMembership).toHaveBeenCalledWith(workspaceId, user.id);
    expect(mocks.disableWorkspaceKnowledgeSource).not.toHaveBeenCalled();
    expect(mocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it("rejects cross-workspace privacy requests before mutating data", async () => {
    const caller = createCaller();

    await expectForbidden(() => caller.privacy.createRequest(privacyRequestInput));

    expect(mocks.getWorkspaceMembership).toHaveBeenCalledWith(workspaceId, user.id);
    expect(mocks.createWorkspacePrivacyRequest).not.toHaveBeenCalled();
    expect(mocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it("propagates privacy request load failures instead of returning an empty list", async () => {
    const caller = createCaller();
    mocks.getWorkspaceMembership.mockResolvedValue({
      workspaceId,
      userId: user.id,
      role: "owner",
    });
    mocks.listWorkspacePrivacyRequests.mockRejectedValue(
      new Error("Database unavailable: privacy requests were not loaded")
    );

    await expect(caller.privacy.requests({ workspaceId })).rejects.toThrow(
      "Database unavailable: privacy requests were not loaded"
    );

    expect(mocks.getWorkspaceMembership).toHaveBeenCalledWith(workspaceId, user.id);
    expect(mocks.listWorkspacePrivacyRequests).toHaveBeenCalledWith(workspaceId);
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

  it("records a privacy-safe audit log when workspace details are updated", async () => {
    const caller = createCaller();
    const updatedWorkspace = {
      ...workspace,
      name: workspaceUpdateInput.name,
      updatedAt: new Date(1),
    };
    mocks.updateWorkspace.mockResolvedValue(updatedWorkspace);

    await expect(caller.workspace.update(workspaceUpdateInput)).resolves.toEqual(
      updatedWorkspace
    );

    expect(mocks.getWorkspaceMembership).toHaveBeenCalledWith(workspaceId, user.id);
    expect(mocks.updateWorkspace).toHaveBeenCalledWith(workspaceId, {
      name: workspaceUpdateInput.name,
    });
    expect(mocks.insertAuditLog).toHaveBeenCalledWith({
      workspaceId,
      userId: user.id,
      event: "workspace.updated",
      metadata: {
        fields: ["name"],
      },
    });
  });

  it("returns tenant-checked workspace members without auditing a read", async () => {
    const caller = createCaller();
    const members = [
      {
        userId: user.id,
        role: "owner",
        name: user.name,
        email: user.email,
        createdAt: new Date(0),
      },
    ];
    mocks.listWorkspaceMembers.mockResolvedValue(members);

    await expect(caller.workspace.members({ workspaceId })).resolves.toEqual(members);

    expect(mocks.getWorkspaceMembership).toHaveBeenCalledWith(workspaceId, user.id);
    expect(mocks.listWorkspaceMembers).toHaveBeenCalledWith(workspaceId);
    expect(mocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it("propagates workspace member load failures instead of returning an empty list", async () => {
    const caller = createCaller();
    mocks.listWorkspaceMembers.mockRejectedValue(
      new Error("Database unavailable: workspace members were not loaded")
    );

    await expect(caller.workspace.members({ workspaceId })).rejects.toThrow(
      "Database unavailable: workspace members were not loaded"
    );

    expect(mocks.getWorkspaceMembership).toHaveBeenCalledWith(workspaceId, user.id);
    expect(mocks.listWorkspaceMembers).toHaveBeenCalledWith(workspaceId);
    expect(mocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it("returns the tenant-checked portal auth session without tenant content", async () => {
    const caller = createCaller();
    mocks.getOrCreateUserWorkspace.mockResolvedValue(workspace);

    await expect(caller.auth.session()).resolves.toEqual({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      workspace: {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
      },
      membership: {
        role: "owner",
      },
    });

    expect(mocks.getOrCreateUserWorkspace).toHaveBeenCalledWith(user);
    expect(mocks.getWorkspaceMembership).toHaveBeenCalledWith(workspaceId, user.id);
    expect(mocks.getOrCreateAiIdentity).not.toHaveBeenCalled();
    expect(mocks.listChannelConnections).not.toHaveBeenCalled();
    expect(mocks.listWorkspaceKnowledgeSources).not.toHaveBeenCalled();
    expect(mocks.getWorkspacePrivacySettings).not.toHaveBeenCalled();
    expect(mocks.insertAuditLog).not.toHaveBeenCalled();
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
      if (originalFbAppId !== undefined) {
        process.env.FB_APP_ID = originalFbAppId;
      } else {
        delete process.env.FB_APP_ID;
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

  it("disconnects Facebook Messenger and records privacy-safe channel audit metadata", async () => {
    const caller = createCaller();
    mocks.listChannelConnections.mockResolvedValue([
      {
        id: 5,
        workspaceId,
        channel: "facebook_messenger",
        status: "connected",
        externalId: "page-123",
        displayName: "Tenant Page",
        encryptedAccessToken: "sealed-token",
        grantedScopes: ["pages_messaging"],
        lastCheckedAt: new Date(1),
        createdAt: new Date(0),
        updatedAt: new Date(1),
      },
    ]);
    mocks.disconnectChannelConnection.mockResolvedValue([]);

    await expect(caller.facebook.disconnect({ workspaceId })).resolves.toEqual({
      success: true,
      status: "disconnected",
    });

    expect(mocks.getWorkspaceMembership).toHaveBeenCalledWith(workspaceId, user.id);
    expect(mocks.disconnectChannelConnection).toHaveBeenCalledWith(
      workspaceId,
      "facebook_messenger"
    );
    expect(mocks.insertAuditLog).toHaveBeenCalledWith({
      workspaceId,
      userId: user.id,
      event: "facebook_page.disconnected",
      metadata: {
        previousStatus: "connected",
      },
    });
    expect(mocks.insertAuditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          pageId: expect.any(String),
        }),
      })
    );
  });

  it("returns the tenant-checked workspace usage balance without audit logging", async () => {
    const caller = createCaller();
    const usageSummary = {
      workspaceId,
      period: "today",
      plan: {
        name: "Free",
        billingStatus: "free",
      },
      messageCount: 18,
      imageCount: 20,
      blockedCount: 1,
      limits: {
        imagesPerDay: 20,
        messagesPerWindow: 30,
        messageWindowSeconds: 60,
      },
      remaining: {
        imagesToday: 0,
      },
      upgrade: {
        recommended: true,
        reason: "image_limit_reached",
      },
    };
    mocks.getWorkspaceUsageSummary.mockResolvedValue(usageSummary);

    await expect(caller.usage.summary({ workspaceId })).resolves.toEqual(usageSummary);

    expect(mocks.getWorkspaceMembership).toHaveBeenCalledWith(workspaceId, user.id);
    expect(mocks.getWorkspaceUsageSummary).toHaveBeenCalledWith(workspaceId);
    expect(mocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it("records a privacy-safe audit log when a workspace upgrade is requested", async () => {
    const caller = createCaller();
    const usageSummary = {
      workspaceId,
      period: "today",
      plan: {
        name: "Free",
        billingStatus: "free",
      },
      messageCount: 18,
      imageCount: 20,
      blockedCount: 1,
      limits: {
        imagesPerDay: 20,
        messagesPerWindow: 30,
        messageWindowSeconds: 60,
      },
      remaining: {
        imagesToday: 0,
      },
      upgrade: {
        recommended: true,
        reason: "image_limit_reached",
      },
    };
    mocks.getWorkspaceUsageSummary.mockResolvedValue(usageSummary);

    await expect(caller.usage.requestUpgrade({ workspaceId })).resolves.toEqual({
      success: true,
      status: "requested",
    });

    expect(mocks.getWorkspaceMembership).toHaveBeenCalledWith(workspaceId, user.id);
    expect(mocks.getWorkspaceUsageSummary).toHaveBeenCalledWith(workspaceId);
    expect(mocks.insertAuditLog).toHaveBeenCalledWith({
      workspaceId,
      userId: user.id,
      event: "billing_upgrade.requested",
      metadata: {
        planName: "Free",
        billingStatus: "free",
        upgradeReason: "image_limit_reached",
        imagesRemainingToday: 0,
        blockedToday: 1,
      },
    });
  });

  it("returns tenant-scoped knowledge sources without auditing a read", async () => {
    const caller = createCaller();
    const sources = [
      {
        id: 11,
        workspaceId,
        sourceType: "website",
        name: "Support docs",
        sourceReference: "https://example.com/help",
        status: "active",
        itemCount: 4,
        lastIndexedAt: new Date(1),
        metadata: null,
        createdAt: new Date(0),
        updatedAt: new Date(1),
      },
    ];
    mocks.listWorkspaceKnowledgeSources.mockResolvedValue(sources);

    await expect(caller.knowledge.list({ workspaceId })).resolves.toEqual(sources);

    expect(mocks.getWorkspaceMembership).toHaveBeenCalledWith(workspaceId, user.id);
    expect(mocks.listWorkspaceKnowledgeSources).toHaveBeenCalledWith(workspaceId);
    expect(mocks.registerWorkspaceKnowledgeSource).not.toHaveBeenCalled();
    expect(mocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it("propagates knowledge source load failures instead of returning an empty list", async () => {
    const caller = createCaller();
    mocks.listWorkspaceKnowledgeSources.mockRejectedValue(
      new Error("Database unavailable: knowledge sources were not loaded")
    );

    await expect(caller.knowledge.list({ workspaceId })).rejects.toThrow(
      "Database unavailable: knowledge sources were not loaded"
    );

    expect(mocks.getWorkspaceMembership).toHaveBeenCalledWith(workspaceId, user.id);
    expect(mocks.listWorkspaceKnowledgeSources).toHaveBeenCalledWith(workspaceId);
    expect(mocks.insertAuditLog).not.toHaveBeenCalled();
  });

  it("records an audit log when workspace privacy controls are updated", async () => {
    const caller = createCaller();
    const updatedControls = {
      ...privacyControlsUpdateInput,
      createdAt: new Date(0),
      updatedAt: new Date(1),
    };
    mocks.updateWorkspacePrivacySettings.mockResolvedValue(updatedControls);

    await expect(
      caller.privacy.updateControls(privacyControlsUpdateInput)
    ).resolves.toEqual(updatedControls);

    expect(mocks.updateWorkspacePrivacySettings).toHaveBeenCalledWith(workspaceId, {
      allowKnowledgeIndexing: false,
      allowUsageAnalytics: true,
      imageMemoryRetentionDays: 14,
    });
    expect(mocks.insertAuditLog).toHaveBeenCalledWith({
      workspaceId,
      userId: user.id,
      event: "privacy_controls.updated",
      metadata: {
        fields: [
          "allowKnowledgeIndexing",
          "allowUsageAnalytics",
          "imageMemoryRetentionDays",
        ],
      },
    });
  });

  it("records a privacy-safe audit log when a knowledge source is registered", async () => {
    const caller = createCaller();
    const registeredSource = {
      id: 9,
      ...knowledgeSourceInput,
      status: "queued",
      itemCount: 0,
      lastIndexedAt: null,
      metadata: null,
      createdAt: new Date(0),
      updatedAt: new Date(1),
    };
    mocks.registerWorkspaceKnowledgeSource.mockResolvedValue(registeredSource);

    await expect(caller.knowledge.registerSource(knowledgeSourceInput)).resolves.toEqual(
      registeredSource
    );

    expect(mocks.registerWorkspaceKnowledgeSource).toHaveBeenCalledWith(workspaceId, {
      sourceType: "website",
      name: "Support docs",
      sourceReference: "https://example.com/help",
    });
    expect(mocks.insertAuditLog).toHaveBeenCalledWith({
      workspaceId,
      userId: user.id,
      event: "knowledge_source.registered",
      metadata: {
        sourceType: "website",
        status: "queued",
      },
    });
    expect(mocks.insertAuditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          name: expect.any(String),
          sourceReference: expect.any(String),
        }),
      })
    );
  });

  it("records a privacy-safe audit log when a knowledge source is disabled", async () => {
    const caller = createCaller();
    const disabledSource = {
      id: 9,
      ...knowledgeSourceInput,
      status: "disabled",
      itemCount: 0,
      lastIndexedAt: null,
      metadata: null,
      createdAt: new Date(0),
      updatedAt: new Date(1),
    };
    mocks.disableWorkspaceKnowledgeSource.mockResolvedValue(disabledSource);

    await expect(
      caller.knowledge.disableSource({ workspaceId, sourceId: disabledSource.id })
    ).resolves.toEqual(disabledSource);

    expect(mocks.disableWorkspaceKnowledgeSource).toHaveBeenCalledWith(
      workspaceId,
      disabledSource.id
    );
    expect(mocks.insertAuditLog).toHaveBeenCalledWith({
      workspaceId,
      userId: user.id,
      event: "knowledge_source.disabled",
      metadata: {
        sourceType: "website",
        status: "disabled",
      },
    });
    expect(mocks.insertAuditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          name: expect.any(String),
          sourceReference: expect.any(String),
        }),
      })
    );
  });

  it("records a privacy-safe audit log when a data privacy request is created", async () => {
    const caller = createCaller();
    const createdRequest = {
      id: 12,
      ...privacyRequestInput,
      userId: user.id,
      status: "requested",
      createdAt: new Date(0),
      updatedAt: new Date(1),
      completedAt: null,
    };
    mocks.createWorkspacePrivacyRequest.mockResolvedValue(createdRequest);

    await expect(caller.privacy.createRequest(privacyRequestInput)).resolves.toEqual(
      createdRequest
    );

    expect(mocks.createWorkspacePrivacyRequest).toHaveBeenCalledWith(
      workspaceId,
      user.id,
      {
        requestType: "deletion",
        note: "Please delete the customer workspace data.",
      },
      {
        event: "privacy_request.created",
        metadata: {
          requestType: "deletion",
          status: "requested",
        },
      }
    );
    expect(mocks.createWorkspacePrivacyRequest).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({
          note: expect.any(String),
        }),
      })
    );
  });
});
