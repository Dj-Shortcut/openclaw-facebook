import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock, drizzleMock } = vi.hoisted(() => {
  const db = {
    delete: vi.fn(),
    insert: vi.fn(),
    select: vi.fn(),
    transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(db)),
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
  deletePortalHandoffTokensForMessengerUserKey,
  getWorkspaceById,
  markPortalHandoffTokenConsumed,
  revokePortalHandoffToken,
} from "./db";

const originalDatabaseUrl = process.env.DATABASE_URL;

function selectRows(rows: unknown[]) {
  const limit = vi.fn(async () => rows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  return { from, where, limit };
}

function duplicateInsert() {
  const onDuplicateKeyUpdate = vi.fn(async () => undefined);
  const values = vi.fn(() => ({ onDuplicateKeyUpdate }));
  return { values, onDuplicateKeyUpdate };
}

describe("portal handoff database helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      messengerSenderUserKey: "sender-user-key",
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
        messengerSenderUserKey: "sender-user-key",
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
  });

  it("reads mysql2 tuple delete results when erasing handoff tokens", async () => {
    const where = vi.fn(async () => [{ affectedRows: 2 }, []]);
    dbMock.delete.mockReturnValue({ where });

    await expect(
      deletePortalHandoffTokensForMessengerUserKey("sender-user-key")
    ).resolves.toBe(2);
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
    const membershipSelect = selectRows([membership]);
    dbMock.select
      .mockReturnValueOnce({ from: tokenSelect.from })
      .mockReturnValueOnce({ from: workspaceSelect.from })
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
    });
    expect(memberInsert.values).toHaveBeenCalledWith({
      workspaceId: 42,
      userId: 7,
      role: "owner",
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

  it("does not consume pending handoff tokens when the workspace is missing", async () => {
    const tokenSelect = selectRows([
      {
        id: 3,
        workspaceId: 404,
        tokenHash: "sha256:token",
        messengerSenderUserKey: null,
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
});
