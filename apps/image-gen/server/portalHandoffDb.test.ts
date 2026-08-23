import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock, drizzleMock } = vi.hoisted(() => {
  const db = {
    delete: vi.fn(),
    insert: vi.fn(),
    select: vi.fn(),
    transaction: vi.fn(async (callback: (tx: unknown) => unknown) =>
      callback(db)
    ),
    update: vi.fn(),
  };
  return {
    dbMock: db,
    drizzleMock: vi.fn(() => db),
  };
});

vi.mock("drizzle-orm/mysql2", () => ({
  drizzle: drizzleMock,
}));

import {
  addWorkspaceMember,
  claimPortalHandoffTokenForUser,
  createPortalHandoffToken,
  createOrGetPortalHandoffToken,
  deletePortalHandoffTokensForMessengerUserKey,
  eraseBillingHandoffIdentity,
  findPortalHandoffReentryBinding,
  getWorkspaceById,
  markPortalHandoffTokenConsumed,
  revokePortalHandoffToken,
} from "./db";

const originalDatabaseUrl = process.env.DATABASE_URL;

function selectRows(rows: unknown[]) {
  const forUpdate = vi.fn(async () => rows);
  const limit = vi.fn(() =>
    Object.assign(Promise.resolve(rows), { for: forUpdate })
  );
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  return { from, where, limit, forUpdate };
}

function selectWhereRows(rows: unknown[]) {
  const where = vi.fn(async () => rows);
  const from = vi.fn(() => ({ where }));
  return { from, where };
}

function orderedSelectRows(rows: unknown[]) {
  const forUpdate = vi.fn(async () => rows);
  const orderBy = vi.fn(() => ({ for: forUpdate }));
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  return { from, where, orderBy, forUpdate };
}

function duplicateInsert() {
  const onDuplicateKeyUpdate = vi.fn(async () => undefined);
  const values = vi.fn(() => ({ onDuplicateKeyUpdate }));
  return { values, onDuplicateKeyUpdate };
}

describe("portal handoff database helpers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.DATABASE_URL = "mysql://portal-handoff-test";
  });

  afterEach(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
      return;
    }
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("reads mysql2 tuple insert results before loading the created token", async () => {
    const created = {
      id: 123,
      workspaceId: 42,
      tokenHash: "sha256:token",
      messengerSenderUserKey: null,
      facebookPageId: null,
      messengerChannelConnectionId: null,
      messengerPrivacyEpoch: null,
      claimedByUserId: null,
      purpose: "workspace_onboarding" as const,
      status: "pending" as const,
      expiresAt: new Date("2026-06-30T10:05:00.000Z"),
      consumedAt: null,
      createdByUserId: null,
      createdAt: new Date("2026-06-30T10:00:00.000Z"),
      updatedAt: new Date("2026-06-30T10:00:00.000Z"),
    };
    const limit = vi.fn(async () => [created]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const values = vi.fn(async () => [{ insertId: 123 }, []]);
    dbMock.insert.mockReturnValue({ values });
    dbMock.select.mockReturnValue({ from });

    await expect(
      createPortalHandoffToken({
        workspaceId: 42,
        tokenHash: "sha256:token",
        messengerSenderUserKey: null,
        facebookPageId: null,
        messengerChannelConnectionId: null,
        messengerPrivacyEpoch: null,
        purpose: "workspace_onboarding",
        status: "pending",
        expiresAt: created.expiresAt,
        createdByUserId: null,
      })
    ).resolves.toEqual(created);
  });

  it("reads mysql2 tuple update results when consuming tokens", async () => {
    const where = vi.fn(async () => [{ affectedRows: 1 }, []]);
    const set = vi.fn(() => ({ where }));
    dbMock.update.mockReturnValue({ set });

    await expect(markPortalHandoffTokenConsumed("sha256:token")).resolves.toBe(
      true
    );
  });

  it("reads mysql2 tuple update results when revoking unsent tokens", async () => {
    const where = vi.fn(async () => [{ affectedRows: 1 }, []]);
    const set = vi.fn(() => ({ where }));
    dbMock.update.mockReturnValue({ set });

    await expect(revokePortalHandoffToken("sha256:token")).resolves.toBe(true);
    expect(set).toHaveBeenCalledWith({
      status: "revoked",
      messengerSenderUserKey: null,
      facebookPageId: null,
      messengerChannelConnectionId: null,
      messengerPrivacyEpoch: null,
    });
  });

  it("reuses the stored pending delivery capability and its expiry", async () => {
    const stored = {
      id: 12,
      workspaceId: 42,
      tokenHash: "sha256:token",
      capabilityGeneration: 1,
      deliveryIdempotencyKeyHash: "sha256:delivery",
      messengerSenderUserKey: null,
      facebookPageId: null,
      messengerChannelConnectionId: null,
      messengerPrivacyEpoch: null,
      purpose: "workspace_onboarding" as const,
      status: "pending" as const,
      expiresAt: new Date("2026-07-01T00:00:00.000Z"),
    };
    const rows = selectRows([stored]);
    dbMock.select.mockReturnValue({ from: rows.from });
    const insert = duplicateInsert();
    dbMock.insert.mockReturnValue({ values: insert.values });
    await expect(
      createOrGetPortalHandoffToken(
        {
          ...stored,
          createdByUserId: null,
        },
        new Date("2026-06-30T00:00:00.000Z")
      )
    ).resolves.toEqual(stored);
    expect(rows.forUpdate).toHaveBeenCalledWith("update");
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  function deliveryToken(overrides: Record<string, unknown> = {}) {
    return {
      id: 12,
      workspaceId: 42,
      tokenHash: "sha256:token",
      capabilityGeneration: 1,
      deliveryIdempotencyKeyHash: "sha256:delivery",
      messengerSenderUserKey: null,
      facebookPageId: null,
      messengerChannelConnectionId: null,
      messengerPrivacyEpoch: null,
      purpose: "workspace_onboarding" as const,
      status: "pending" as const,
      expiresAt: new Date("2026-07-01T00:00:00.000Z"),
      createdByUserId: null,
      ...overrides,
    };
  }

  function mockDeliveryToken(stored: Record<string, unknown>) {
    const rows = selectRows([stored]);
    dbMock.select.mockReturnValue({ from: rows.from });
    const insert = duplicateInsert();
    dbMock.insert.mockReturnValue({ values: insert.values });
    return rows;
  }

  it("reactivates a non-expired revoked delivery with an exact conditional update", async () => {
    const stored = deliveryToken({ status: "revoked" });
    mockDeliveryToken(stored);
    const where = vi.fn(async () => undefined);
    const set = vi.fn(() => ({ where }));
    dbMock.update.mockReturnValue({ set });
    await expect(
      createOrGetPortalHandoffToken(
        stored,
        new Date("2026-06-30"),
        generation =>
          generation === 1 ? "sha256:token" : `sha256:token-${generation}`
      )
    ).resolves.toMatchObject({ status: "pending" });
    expect(set).toHaveBeenCalledWith({
      status: "pending",
      expiresAt: stored.expiresAt,
      capabilityGeneration: 2,
      tokenHash: "sha256:token-2",
      messengerSenderUserKey: null,
      facebookPageId: null,
      messengerChannelConnectionId: null,
      messengerPrivacyEpoch: null,
    });
    expect(where).toHaveBeenCalled();
  });

  it("fails closed for a consumed delivery", async () => {
    const overrides = { status: "consumed", expiresAt: new Date("2026-07-01") };
    const stored = deliveryToken(overrides);
    mockDeliveryToken(stored);
    await expect(
      createOrGetPortalHandoffToken(stored, new Date("2026-06-30"))
    ).rejects.toThrow("no longer active");
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it.each([
    { status: "expired", expiresAt: new Date("2026-07-01") },
    { status: "pending", expiresAt: new Date("2026-06-30") },
  ])("rotates an inactive unconsumed capability %#", async overrides => {
    const stored = deliveryToken(overrides);
    mockDeliveryToken(stored);
    const where = vi.fn(async () => undefined);
    const set = vi.fn(() => ({ where }));
    dbMock.update.mockReturnValue({ set });
    await expect(
      createOrGetPortalHandoffToken(
        stored,
        new Date("2026-07-02"),
        generation =>
          generation === 1 ? "sha256:token" : `sha256:rotated-${generation}`
      )
    ).resolves.toMatchObject({
      status: "pending",
      capabilityGeneration: 2,
      tokenHash: "sha256:rotated-2",
    });
  });

  it.each(["tokenHash", "workspaceId", "purpose"])(
    "fails closed for %s binding mismatch",
    async field => {
      const stored = deliveryToken();
      const input = {
        ...stored,
        [field]: field === "workspaceId" ? 99 : "other",
      };
      mockDeliveryToken(stored);
      await expect(
        createOrGetPortalHandoffToken(input, new Date("2026-06-30"))
      ).rejects.toThrow("binding mismatch");
      expect(dbMock.update).not.toHaveBeenCalled();
    }
  );

  it("rejects a missing delivery hash before transaction writes", async () => {
    await expect(
      createOrGetPortalHandoffToken({
        ...deliveryToken(),
        deliveryIdempotencyKeyHash: null,
      })
    ).rejects.toThrow("delivery key hash is required");
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it("reads mysql2 tuple delete results when erasing handoff tokens", async () => {
    const where = vi.fn(async () => [{ affectedRows: 2 }, []]);
    dbMock.delete.mockReturnValue({ where });

    await expect(
      deletePortalHandoffTokensForMessengerUserKey("sender-user-key")
    ).resolves.toBe(2);
  });

  it("erases billing intent identity even when no handoff outbox exists", async () => {
    const intents = orderedSelectRows([{ intentId: "intent-without-outbox" }]);
    const outbox = orderedSelectRows([]);
    dbMock.select
      .mockReturnValueOnce({ from: intents.from })
      .mockReturnValueOnce({ from: outbox.from });

    const updateWhere = vi.fn(async () => [{ affectedRows: 1 }, []]);
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    dbMock.update.mockReturnValue({ set: updateSet });
    const deleteWhere = vi.fn(async () => [{ affectedRows: 0 }, []]);
    dbMock.delete.mockReturnValue({ where: deleteWhere });

    await expect(
      eraseBillingHandoffIdentity(42, "sender-user-key", "facebook-page-42")
    ).resolves.toBe(0);

    expect(intents.forUpdate).toHaveBeenCalledWith("update");
    expect(outbox.forUpdate).toHaveBeenCalledWith("update");
    expect(updateSet).toHaveBeenCalledTimes(1);
    expect(updateSet).toHaveBeenCalledWith({
      messengerSenderUserKey: null,
      messengerPageId: null,
      messengerChannelConnectionId: null,
      messengerPrivacyEpoch: null,
    });
    expect(deleteWhere).toHaveBeenCalledTimes(1);
  });

  it("loads a workspace by id for claimed handoff sessions", async () => {
    const workspace = {
      id: 42,
      name: "Premium Workspace",
      slug: "premium-workspace",
      createdAt: new Date("2026-06-30T10:00:00.000Z"),
      updatedAt: new Date("2026-06-30T10:00:00.000Z"),
    };
    const limit = vi.fn(async () => [workspace]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    dbMock.select.mockReturnValue({ from });

    await expect(getWorkspaceById(42)).resolves.toEqual(workspace);
  });

  it("adds a customer as a workspace member for a claimed handoff", async () => {
    const membership = {
      id: 9,
      workspaceId: 42,
      userId: 7,
      role: "owner" as const,
      createdAt: new Date("2026-06-30T10:00:00.000Z"),
    };
    const onDuplicateKeyUpdate = vi.fn(async () => undefined);
    const values = vi.fn(() => ({ onDuplicateKeyUpdate }));
    dbMock.insert.mockReturnValue({ values });

    const limit = vi.fn(async () => [membership]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    dbMock.select.mockReturnValue({ from });

    await expect(
      addWorkspaceMember({
        workspaceId: 42,
        userId: 7,
        role: "owner",
      })
    ).resolves.toEqual(membership);

    expect(onDuplicateKeyUpdate).toHaveBeenCalled();
  });

  it("claims a pending token with membership and audit writes in one transaction", async () => {
    const expiresAt = new Date("2026-06-30T10:05:00.000Z");
    const token = {
      id: 3,
      workspaceId: 42,
      tokenHash: "sha256:token",
      messengerSenderUserKey: "sender-user-key",
      facebookPageId: "facebook-page-42",
      claimedByUserId: null,
      purpose: "workspace_onboarding" as const,
      status: "pending" as const,
      expiresAt,
      consumedAt: null,
      createdByUserId: 1,
      createdAt: new Date("2026-06-30T09:55:00.000Z"),
      updatedAt: new Date("2026-06-30T09:55:00.000Z"),
    };
    const workspace = {
      id: 42,
      name: "Premium Workspace",
      slug: "premium-workspace",
      createdAt: new Date("2026-06-30T09:00:00.000Z"),
      updatedAt: new Date("2026-06-30T09:00:00.000Z"),
    };
    const membership = {
      id: 9,
      workspaceId: 42,
      userId: 7,
      role: "owner" as const,
      createdAt: new Date("2026-06-30T10:00:00.000Z"),
    };
    const tokenSelect = selectRows([token]);
    const workspaceSelect = selectRows([workspace]);
    const priorClaimSelect = selectWhereRows([
      { minUserId: null, maxUserId: null },
    ]);
    const membershipSelect = selectRows([membership]);
    const connectionSelect = selectRows([{ id: 11 }]);
    dbMock.select
      .mockReturnValueOnce({ from: tokenSelect.from })
      .mockReturnValueOnce({ from: workspaceSelect.from })
      .mockReturnValueOnce({ from: connectionSelect.from })
      .mockReturnValueOnce({ from: priorClaimSelect.from })
      .mockReturnValueOnce({ from: membershipSelect.from });
    const updateWhere = vi.fn(async () => [{ affectedRows: 1 }, []]);
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    dbMock.update.mockReturnValue({ set: updateSet });
    const memberInsert = duplicateInsert();
    const privacyInsert = duplicateInsert();
    const auditValues = vi.fn(async () => undefined);
    dbMock.insert
      .mockReturnValueOnce({ values: memberInsert.values })
      .mockReturnValueOnce({ values: privacyInsert.values })
      .mockReturnValueOnce({ values: auditValues });

    await expect(
      claimPortalHandoffTokenForUser({
        tokenHash: "sha256:token",
        userId: 7,
        now: new Date("2026-06-30T10:00:00.000Z"),
      })
    ).resolves.toEqual({
      ok: true,
      workspace,
      membership,
      purpose: "workspace_onboarding",
      messengerSenderUserKey: "sender-user-key",
    });

    expect(dbMock.transaction).toHaveBeenCalled();
    expect(updateSet).toHaveBeenCalledWith({
      status: "consumed",
      consumedAt: new Date("2026-06-30T10:00:00.000Z"),
      claimedByUserId: 7,
    });
    expect(memberInsert.values).toHaveBeenCalledWith({
      workspaceId: 42,
      userId: 7,
      role: "owner",
    });
    expect(memberInsert.onDuplicateKeyUpdate).toHaveBeenCalledWith({
      set: { workspaceId: 42 },
    });
    expect(auditValues).toHaveBeenCalledWith({
      workspaceId: 42,
      userId: 7,
      event: "portal_handoff.claimed",
      metadata: {
        purpose: "workspace_onboarding",
        source: "messenger_handoff",
        hasMessengerSenderUserKey: true,
        membershipRole: "owner",
      },
    });
  });

  it.each(["owner", "admin", "member"] as const)(
    "keeps an existing %s membership unchanged when a handoff is claimed",
    async role => {
      const token = {
        id: 3,
        workspaceId: 42,
        tokenHash: "sha256:token",
        messengerSenderUserKey: "sender-user-key",
        facebookPageId: "facebook-page-42",
        claimedByUserId: null,
        purpose: "workspace_onboarding" as const,
        status: "pending" as const,
        expiresAt: new Date("2026-06-30T10:05:00.000Z"),
        consumedAt: null,
        createdByUserId: 1,
        createdAt: new Date("2026-06-30T09:55:00.000Z"),
        updatedAt: new Date("2026-06-30T09:55:00.000Z"),
      };
      const workspace = {
        id: 42,
        name: "Premium Workspace",
        slug: "premium-workspace",
        createdAt: new Date("2026-06-30T09:00:00.000Z"),
        updatedAt: new Date("2026-06-30T09:00:00.000Z"),
      };
      const membership = {
        id: 9,
        workspaceId: 42,
        userId: 7,
        role,
        createdAt: new Date("2026-06-30T10:00:00.000Z"),
      };
      const tokenSelect = selectRows([token]);
      const workspaceSelect = selectRows([workspace]);
      const connectionSelect = selectRows([{ id: 11 }]);
      const priorClaimSelect = selectWhereRows([
        { minUserId: null, maxUserId: null },
      ]);
      const membershipSelect = selectRows([membership]);
      dbMock.select
        .mockReturnValueOnce({ from: tokenSelect.from })
        .mockReturnValueOnce({ from: workspaceSelect.from })
        .mockReturnValueOnce({ from: connectionSelect.from })
        .mockReturnValueOnce({ from: priorClaimSelect.from })
        .mockReturnValueOnce({ from: membershipSelect.from });
      const updateWhere = vi.fn(async () => [{ affectedRows: 1 }, []]);
      dbMock.update.mockReturnValue({
        set: vi.fn(() => ({ where: updateWhere })),
      });
      const memberInsert = duplicateInsert();
      const privacyInsert = duplicateInsert();
      dbMock.insert
        .mockReturnValueOnce({ values: memberInsert.values })
        .mockReturnValueOnce({ values: privacyInsert.values })
        .mockReturnValueOnce({ values: vi.fn(async () => undefined) });

      await expect(
        claimPortalHandoffTokenForUser({
          tokenHash: "sha256:token",
          userId: 7,
          now: new Date("2026-06-30T10:00:00.000Z"),
        })
      ).resolves.toMatchObject({ ok: true, membership: { role } });

      expect(memberInsert.onDuplicateKeyUpdate).toHaveBeenCalledWith({
        set: { workspaceId: 42 },
      });
    }
  );

  it("does not consume pending handoff tokens when the workspace is missing", async () => {
    const tokenSelect = selectRows([
      {
        id: 3,
        workspaceId: 404,
        tokenHash: "sha256:token",
        messengerSenderUserKey: "sender-user-key",
        facebookPageId: "facebook-page-42",
        claimedByUserId: null,
        purpose: "workspace_onboarding" as const,
        status: "pending" as const,
        expiresAt: new Date("2026-06-30T10:05:00.000Z"),
        consumedAt: null,
        createdByUserId: 1,
        createdAt: new Date("2026-06-30T09:55:00.000Z"),
        updatedAt: new Date("2026-06-30T09:55:00.000Z"),
      },
    ]);
    const workspaceSelect = selectRows([]);
    dbMock.select
      .mockReturnValueOnce({ from: tokenSelect.from })
      .mockReturnValueOnce({ from: workspaceSelect.from });

    await expect(
      claimPortalHandoffTokenForUser({
        tokenHash: "sha256:token",
        userId: 7,
        now: new Date("2026-06-30T10:00:00.000Z"),
      })
    ).resolves.toEqual({
      ok: false,
      reason: "workspace_not_found",
    });

    expect(dbMock.update).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it.each([
    { connectedPages: [] },
    { connectedPages: [{ id: 11 }, { id: 12 }] },
  ])(
    "does not consume a handoff when its Page binding is missing or ambiguous",
    async ({ connectedPages }) => {
      const tokenSelect = selectRows([
        {
          id: 3,
          workspaceId: 42,
          tokenHash: "sha256:token",
          messengerSenderUserKey: "sender-user-key",
          facebookPageId: "facebook-page-42",
          claimedByUserId: null,
          purpose: "workspace_onboarding" as const,
          status: "pending" as const,
          expiresAt: new Date("2026-06-30T10:05:00.000Z"),
          consumedAt: null,
          createdByUserId: 1,
          createdAt: new Date("2026-06-30T09:55:00.000Z"),
          updatedAt: new Date("2026-06-30T09:55:00.000Z"),
        },
      ]);
      const workspaceSelect = selectRows([
        {
          id: 42,
          name: "Premium Workspace",
          slug: "premium-workspace",
          createdAt: new Date("2026-06-30T09:00:00.000Z"),
          updatedAt: new Date("2026-06-30T09:00:00.000Z"),
        },
      ]);
      const connectionSelect = selectRows(connectedPages);
      dbMock.select
        .mockReturnValueOnce({ from: tokenSelect.from })
        .mockReturnValueOnce({ from: workspaceSelect.from })
        .mockReturnValueOnce({ from: connectionSelect.from });

      await expect(
        claimPortalHandoffTokenForUser({
          tokenHash: "sha256:token",
          userId: 7,
          now: new Date("2026-06-30T10:00:00.000Z"),
        })
      ).resolves.toEqual({ ok: false, reason: "tenant_boundary" });

      expect(dbMock.update).not.toHaveBeenCalled();
      expect(dbMock.insert).not.toHaveBeenCalled();
    }
  );

  it("resolves re-entry only through one connected Page, a consumed claim, and membership", async () => {
    const connectionLimit = vi.fn(async () => [{ workspaceId: 42 }]);
    const claimLimit = vi.fn(async () => [{ userId: 7 }]);
    const membershipLimit = vi.fn(async () => [{ id: 9 }]);
    dbMock.select
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: connectionLimit })),
        })),
      })
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({ limit: claimLimit })),
          })),
        })),
      })
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: membershipLimit })),
        })),
      });

    await expect(
      findPortalHandoffReentryBinding({
        facebookPageId: "facebook-page-42",
        messengerSenderUserKey: "sender-user-key",
      })
    ).resolves.toEqual({ workspaceId: 42, userId: 7 });
  });

  it("refuses re-entry when the Page binding is ambiguous", async () => {
    const limit = vi.fn(async () => [{ workspaceId: 42 }, { workspaceId: 99 }]);
    dbMock.select.mockReturnValueOnce({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit })) })),
    });

    await expect(
      findPortalHandoffReentryBinding({
        facebookPageId: "facebook-page-42",
        messengerSenderUserKey: "sender-user-key",
      })
    ).resolves.toBeNull();
  });

  it("binds a restricted re-entry token to the existing portal member", async () => {
    const token = {
      id: 3,
      workspaceId: 42,
      tokenHash: "sha256:token",
      deliveryIdempotencyKeyHash: "sha256:reentry-delivery",
      messengerSenderUserKey: "sender-user-key",
      facebookPageId: "facebook-page-42",
      claimedByUserId: null,
      purpose: "workspace_onboarding" as const,
      status: "pending" as const,
      expiresAt: new Date("2026-06-30T10:05:00.000Z"),
      consumedAt: null,
      createdByUserId: 7,
      createdAt: new Date("2026-06-30T09:55:00.000Z"),
      updatedAt: new Date("2026-06-30T09:55:00.000Z"),
    };
    const workspace = {
      id: 42,
      name: "Premium Workspace",
      slug: "premium-workspace",
      createdAt: new Date("2026-06-30T09:00:00.000Z"),
      updatedAt: new Date("2026-06-30T09:00:00.000Z"),
    };
    const membership = {
      id: 9,
      workspaceId: 42,
      userId: 7,
      role: "admin" as const,
      createdAt: new Date("2026-06-30T09:00:00.000Z"),
    };
    dbMock.select
      .mockReturnValueOnce({ from: selectRows([token]).from })
      .mockReturnValueOnce({ from: selectRows([workspace]).from })
      .mockReturnValueOnce({ from: selectRows([{ id: 11 }]).from })
      .mockReturnValueOnce({
        from: selectWhereRows([{ minUserId: 7, maxUserId: 7 }]).from,
      })
      .mockReturnValueOnce({ from: selectRows([membership]).from });
    dbMock.update.mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(async () => [{ affectedRows: 1 }, []]),
      })),
    });
    const privacyInsert = duplicateInsert();
    dbMock.insert
      .mockReturnValueOnce({ values: privacyInsert.values })
      .mockReturnValueOnce({ values: vi.fn(async () => undefined) });

    await expect(
      claimPortalHandoffTokenForUser({
        tokenHash: "sha256:token",
        userId: 7,
        now: new Date("2026-06-30T10:00:00.000Z"),
      })
    ).resolves.toMatchObject({
      ok: true,
      membership: { role: "admin" },
    });
    expect(dbMock.insert).toHaveBeenCalledTimes(2);
  });

  it("rejects a restricted re-entry token for another portal user", async () => {
    const token = {
      id: 3,
      workspaceId: 42,
      tokenHash: "sha256:token",
      deliveryIdempotencyKeyHash: "sha256:reentry-delivery",
      messengerSenderUserKey: "sender-user-key",
      facebookPageId: "facebook-page-42",
      status: "pending" as const,
      expiresAt: new Date("2026-06-30T10:05:00.000Z"),
      createdByUserId: 7,
    };
    const workspace = {
      id: 42,
      name: "Premium Workspace",
      slug: "premium-workspace",
      createdAt: new Date("2026-06-30T09:00:00.000Z"),
      updatedAt: new Date("2026-06-30T09:00:00.000Z"),
    };
    dbMock.select
      .mockReturnValueOnce({ from: selectRows([token]).from })
      .mockReturnValueOnce({ from: selectRows([workspace]).from })
      .mockReturnValueOnce({ from: selectRows([{ id: 11 }]).from })
      .mockReturnValueOnce({
        from: selectWhereRows([{ minUserId: 7, maxUserId: 7 }]).from,
      });

    await expect(
      claimPortalHandoffTokenForUser({
        tokenHash: "sha256:token",
        userId: 8,
        now: new Date("2026-06-30T10:00:00.000Z"),
      })
    ).resolves.toEqual({ ok: false, reason: "invalid" });
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
  });
});
