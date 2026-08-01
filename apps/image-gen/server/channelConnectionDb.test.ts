import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock, drizzleMock } = vi.hoisted(() => {
  const db = {
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
  ChannelConnectionClaimConflictError,
  upsertChannelConnection,
} from "./db";

const originalDatabaseUrl = process.env.DATABASE_URL;

function lockedSelect(rows: unknown[]) {
  const lock = vi.fn(async () => rows);
  const limit = vi.fn(() => ({ for: lock }));
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  return { from, limit, lock, where };
}

function listSelect(rows: unknown[]) {
  const where = vi.fn(async () => rows);
  const from = vi.fn(() => ({ where }));
  return { from, where };
}

const connection = {
  workspaceId: 42,
  channel: "facebook_messenger" as const,
  status: "connected" as const,
  externalId: "page-123",
  displayName: "Tenant Page",
  encryptedAccessToken: "sealed-tenant-token",
  grantedScopes: ["pages_messaging"],
};

describe("channel connection database claims", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = "mysql://channel-claim-test";
  });

  afterEach(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it("rejects a Page already claimed by another workspace without touching credentials", async () => {
    const pageClaim = lockedSelect([{ id: 7, workspaceId: 99 }]);
    dbMock.select.mockReturnValueOnce({ from: pageClaim.from });

    const result = upsertChannelConnection(connection);

    await expect(result).rejects.toBeInstanceOf(
      ChannelConnectionClaimConflictError
    );
    await expect(result).rejects.not.toThrow("page-123");
    await expect(result).rejects.not.toThrow("sealed-tenant-token");
    expect(pageClaim.lock).toHaveBeenCalledWith("update");
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("updates credentials only after the Page claim and workspace row are locked", async () => {
    const pageClaim = lockedSelect([{ id: 7, workspaceId: 42 }]);
    const workspaceConnection = lockedSelect([{ id: 7 }]);
    const listed = [{ id: 7, ...connection }];
    const list = listSelect(listed);
    dbMock.select
      .mockReturnValueOnce({ from: pageClaim.from })
      .mockReturnValueOnce({ from: workspaceConnection.from })
      .mockReturnValueOnce({ from: list.from });
    const updateWhere = vi.fn(async () => undefined);
    const set = vi.fn(() => ({ where: updateWhere }));
    dbMock.update.mockReturnValue({ set });

    await expect(upsertChannelConnection(connection)).resolves.toEqual(listed);

    expect(pageClaim.lock).toHaveBeenCalledWith("update");
    expect(workspaceConnection.lock).toHaveBeenCalledWith("update");
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "connected",
        externalId: "page-123",
        encryptedAccessToken: "sealed-tenant-token",
        lastCheckedAt: expect.any(Date),
      })
    );
    expect(set).not.toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: expect.anything() })
    );
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("inserts an unclaimed Page without a duplicate-key update path", async () => {
    const pageClaim = lockedSelect([]);
    const workspaceConnection = lockedSelect([]);
    const list = listSelect([]);
    dbMock.select
      .mockReturnValueOnce({ from: pageClaim.from })
      .mockReturnValueOnce({ from: workspaceConnection.from })
      .mockReturnValueOnce({ from: list.from });
    const values = vi.fn(async () => undefined);
    dbMock.insert.mockReturnValue({ values });

    await expect(upsertChannelConnection(connection)).resolves.toEqual([]);

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 42,
        channel: "facebook_messenger",
        externalId: "page-123",
        encryptedAccessToken: "sealed-tenant-token",
        lastCheckedAt: expect.any(Date),
      })
    );
    expect(values.mock.results[0]?.value).not.toHaveProperty(
      "onDuplicateKeyUpdate"
    );
  });

  it.each([
    "channelConnections_workspace_channel_unique",
    "channelConnections_channel_externalId_unique",
  ])(
    "retries a same-workspace insert race reported by %s",
    async constraint => {
      const initialPageClaim = lockedSelect([]);
      const initialWorkspaceConnection = lockedSelect([]);
      const retriedPageClaim = lockedSelect([{ id: 7, workspaceId: 42 }]);
      const retriedWorkspaceConnection = lockedSelect([{ id: 7 }]);
      const listed = [{ id: 7, ...connection }];
      const list = listSelect(listed);
      dbMock.select
        .mockReturnValueOnce({ from: initialPageClaim.from })
        .mockReturnValueOnce({ from: initialWorkspaceConnection.from })
        .mockReturnValueOnce({ from: retriedPageClaim.from })
        .mockReturnValueOnce({ from: retriedWorkspaceConnection.from })
        .mockReturnValueOnce({ from: list.from });
      const values = vi.fn().mockRejectedValueOnce(
        Object.assign(new Error(`Duplicate entry for ${constraint}`), {
          code: "ER_DUP_ENTRY",
          errno: 1062,
          constraint,
        })
      );
      dbMock.insert.mockReturnValue({ values });
      const updateWhere = vi.fn(async () => undefined);
      dbMock.update.mockReturnValue({
        set: vi.fn(() => ({ where: updateWhere })),
      });

      await expect(upsertChannelConnection(connection)).resolves.toEqual(
        listed
      );

      expect(dbMock.transaction).toHaveBeenCalledTimes(2);
      expect(retriedPageClaim.lock).toHaveBeenCalledWith("update");
      expect(dbMock.update).toHaveBeenCalledOnce();
    }
  );

  it("fails closed when a duplicate race resolves to another workspace", async () => {
    const initialPageClaim = lockedSelect([]);
    const initialWorkspaceConnection = lockedSelect([]);
    const conflictingPageClaim = lockedSelect([{ id: 8, workspaceId: 99 }]);
    dbMock.select
      .mockReturnValueOnce({ from: initialPageClaim.from })
      .mockReturnValueOnce({ from: initialWorkspaceConnection.from })
      .mockReturnValueOnce({ from: conflictingPageClaim.from });
    const values = vi.fn().mockRejectedValueOnce(
      Object.assign(new Error("duplicate"), {
        code: "ER_DUP_ENTRY",
        errno: 1062,
      })
    );
    dbMock.insert.mockReturnValue({ values });

    await expect(upsertChannelConnection(connection)).rejects.toBeInstanceOf(
      ChannelConnectionClaimConflictError
    );
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(dbMock.transaction).toHaveBeenCalledTimes(2);
    expect(conflictingPageClaim.lock).toHaveBeenCalledWith("update");
  });

  it("bounds an unresolved duplicate-key race to three attempts", async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const pageClaim = lockedSelect([]);
      const workspaceConnection = lockedSelect([]);
      dbMock.select
        .mockReturnValueOnce({ from: pageClaim.from })
        .mockReturnValueOnce({ from: workspaceConnection.from });
    }
    const values = vi.fn(async () => {
      throw Object.assign(new Error("duplicate"), {
        code: "ER_DUP_ENTRY",
        errno: 1062,
      });
    });
    dbMock.insert.mockReturnValue({ values });

    await expect(upsertChannelConnection(connection)).rejects.toThrow(
      "Channel connection update could not be completed after concurrent writes"
    );

    expect(dbMock.transaction).toHaveBeenCalledTimes(3);
    expect(values).toHaveBeenCalledTimes(3);
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it.each([
    { code: "ER_LOCK_DEADLOCK", errno: 1213 },
    { code: "ER_LOCK_WAIT_TIMEOUT", errno: 1205 },
  ])("retries a wrapped $code database error", async driverError => {
    dbMock.transaction.mockRejectedValueOnce(
      new Error("transaction failed", { cause: driverError })
    );
    const pageClaim = lockedSelect([]);
    const workspaceConnection = lockedSelect([]);
    const listed = [{ id: 7, ...connection }];
    const list = listSelect(listed);
    dbMock.select
      .mockReturnValueOnce({ from: pageClaim.from })
      .mockReturnValueOnce({ from: workspaceConnection.from })
      .mockReturnValueOnce({ from: list.from });
    const values = vi.fn(async () => undefined);
    dbMock.insert.mockReturnValue({ values });

    await expect(upsertChannelConnection(connection)).resolves.toEqual(listed);

    expect(dbMock.transaction).toHaveBeenCalledTimes(2);
    expect(values).toHaveBeenCalledOnce();
  });
});
