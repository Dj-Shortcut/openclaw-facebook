import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";

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
  ChannelConnectionAuthorizationError,
  ChannelConnectionClaimConflictError,
  disconnectChannelConnection,
  getConnectedMetaChannelConnection,
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

function boundedSelect(rows: unknown[]) {
  const limit = vi.fn(async () => rows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  return { from, where, limit };
}

const connection = {
  workspaceId: 42,
  channel: "facebook_messenger" as const,
  status: "connected" as const,
  externalId: "123456789012345",
  displayName: "Tenant Page",
  encryptedAccessToken: "sealed-tenant-token",
  grantedScopes: ["pages_messaging"],
};

const whatsAppConnection = {
  workspaceId: 42,
  channel: "whatsapp" as const,
  status: "connected" as const,
  externalId: "223456789012345",
  providerAccountExternalId: "323456789012345",
  displayName: "Tenant WhatsApp",
  encryptedAccessToken: "sealed-whatsapp-token",
  grantedScopes: ["whatsapp_business_messaging"],
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

  it("loads WhatsApp deletion ownership only through the exact immutable binding", async () => {
    const stored = {
      id: 12,
      workspaceId: 42,
      channel: "whatsapp" as const,
      status: "connected" as const,
      externalId: "223456789012345",
      bindingEpoch: 3,
    };
    const selected = boundedSelect([stored]);
    dbMock.select.mockReturnValue({ from: selected.from });

    await expect(
      getConnectedMetaChannelConnection("whatsapp", stored.externalId, {
        workspaceId: 42,
        channelConnectionId: 12,
        bindingEpoch: 3,
      })
    ).resolves.toEqual(stored);

    const query = new MySqlDialect().sqlToQuery(
      selected.where.mock.calls[0]?.[0]
    );
    expect(query.params).toEqual(
      expect.arrayContaining([
        "whatsapp",
        "connected",
        stored.externalId,
        42,
        12,
        3,
      ])
    );
    expect(selected.limit).toHaveBeenCalledWith(2);
  });

  it("rejects ambiguous WhatsApp deletion ownership", async () => {
    const selected = boundedSelect([
      { id: 12, workspaceId: 42 },
      { id: 13, workspaceId: 99 },
    ]);
    dbMock.select.mockReturnValue({ from: selected.from });

    await expect(
      getConnectedMetaChannelConnection("whatsapp", "223456789012345", {
        workspaceId: 42,
        channelConnectionId: 12,
        bindingEpoch: 3,
      })
    ).resolves.toBeNull();
  });

  it.each([
    {
      label: "Messenger without a Page ID",
      value: { ...connection, externalId: null },
    },
    {
      label: "Messenger with a non-canonical Page ID",
      value: { ...connection, externalId: " 123456789012345 " },
    },
    {
      label: "Messenger with a provider-account ID",
      value: {
        ...connection,
        providerAccountExternalId: "323456789012345",
      },
    },
    {
      label: "WhatsApp without a phone-number ID",
      value: { ...whatsAppConnection, externalId: null },
    },
    {
      label: "WhatsApp without a WABA ID",
      value: { ...whatsAppConnection, providerAccountExternalId: null },
    },
    {
      label: "WhatsApp with a non-canonical WABA ID",
      value: {
        ...whatsAppConnection,
        providerAccountExternalId: " 323456789012345 ",
      },
    },
  ])(
    "rejects $label before starting a database transaction",
    async ({ value }) => {
      const result = upsertChannelConnection(value);

      await expect(result).rejects.toMatchObject({
        name: "ConversationIdentityError",
        code: "invalid_input",
        message: "Conversation identity is unavailable",
      });
      expect(dbMock.transaction).not.toHaveBeenCalled();
      expect(dbMock.update).not.toHaveBeenCalled();
      expect(dbMock.insert).not.toHaveBeenCalled();
    }
  );

  it("rejects a Page already claimed by another workspace without touching credentials", async () => {
    const pageClaim = lockedSelect([{ id: 7, workspaceId: 99 }]);
    dbMock.select.mockReturnValueOnce({ from: pageClaim.from });

    const result = upsertChannelConnection(connection);

    await expect(result).rejects.toBeInstanceOf(
      ChannelConnectionClaimConflictError
    );
    await expect(result).rejects.not.toThrow("123456789012345");
    await expect(result).rejects.not.toThrow("sealed-tenant-token");
    expect(pageClaim.lock).toHaveBeenCalledWith("update");
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("updates credentials only after the Page claim and workspace row are locked", async () => {
    const pageClaim = lockedSelect([{ id: 7, workspaceId: 42 }]);
    const workspaceConnection = lockedSelect([{ id: 7 }]);
    const activeAttempts = lockedSelect([]);
    const listed = [{ id: 7, ...connection }];
    const list = listSelect(listed);
    dbMock.select
      .mockReturnValueOnce({ from: pageClaim.from })
      .mockReturnValueOnce({ from: workspaceConnection.from })
      .mockReturnValueOnce({ from: activeAttempts.from })
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
        externalId: "123456789012345",
        providerAccountExternalId: null,
        encryptedAccessToken: "sealed-tenant-token",
        lastCheckedAt: expect.any(Date),
      })
    );
    expect(set).not.toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: expect.anything() })
    );
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it("reconciles expired provider fences before reconnecting a Page", async () => {
    const pageClaim = lockedSelect([{ id: 7, workspaceId: 42 }]);
    const workspaceConnection = lockedSelect([{ id: 7 }]);
    const activeAttempts = lockedSelect([]);
    const listed = [{ id: 7, ...connection }];
    const list = listSelect(listed);
    dbMock.select
      .mockReturnValueOnce({ from: pageClaim.from })
      .mockReturnValueOnce({ from: workspaceConnection.from })
      .mockReturnValueOnce({ from: activeAttempts.from })
      .mockReturnValueOnce({ from: list.from });
    const updateWhere = vi.fn(async () => undefined);
    const set = vi.fn(() => ({ where: updateWhere }));
    dbMock.update.mockReturnValue({ set });

    await expect(upsertChannelConnection(connection)).resolves.toEqual(listed);

    expect(set).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        status: "contained",
        completedAt: expect.any(Date),
        leaseUntil: expect.any(Date),
      })
    );
    expect(set).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ status: "connected" })
    );
  });

  it("still blocks reconnect while a provider fence lease is active", async () => {
    const pageClaim = lockedSelect([{ id: 7, workspaceId: 42 }]);
    const workspaceConnection = lockedSelect([{ id: 7 }]);
    const activeAttempts = lockedSelect([{ id: 91 }]);
    dbMock.select
      .mockReturnValueOnce({ from: pageClaim.from })
      .mockReturnValueOnce({ from: workspaceConnection.from })
      .mockReturnValueOnce({ from: activeAttempts.from });
    const updateWhere = vi.fn(async () => undefined);
    const set = vi.fn(() => ({ where: updateWhere }));
    dbMock.update.mockReturnValue({ set });

    await expect(upsertChannelConnection(connection)).rejects.toThrow(
      "Channel connection has an active provider attempt; retry later"
    );

    expect(set).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "contained" })
    );
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it.each(["whatsapp_openai_image", "whatsapp_graph_erasure_control_text"])(
    "blocks disconnect while %s owns an active transport fence",
    async providerOperation => {
      const workspaceConnection = lockedSelect([{ id: 8 }]);
      const activeAttempts = lockedSelect([{ id: 91, providerOperation }]);
      dbMock.select
        .mockReturnValueOnce({ from: workspaceConnection.from })
        .mockReturnValueOnce({ from: activeAttempts.from });
      const updateWhere = vi.fn(async () => undefined);
      const set = vi.fn(() => ({ where: updateWhere }));
      dbMock.update.mockReturnValue({ set });

      await expect(disconnectChannelConnection(42, "whatsapp")).rejects.toThrow(
        "Channel connection has an active provider attempt; retry later"
      );

      expect(workspaceConnection.lock).toHaveBeenCalledWith("update");
      expect(activeAttempts.lock).toHaveBeenCalledWith("update");
      expect(set).toHaveBeenCalledOnce();
      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "contained" })
      );
      expect(dbMock.insert).not.toHaveBeenCalled();
    }
  );

  it("contains expired attempts before disconnecting the exact connection", async () => {
    const workspaceConnection = lockedSelect([{ id: 8 }]);
    const activeAttempts = lockedSelect([]);
    const list = listSelect([]);
    dbMock.select
      .mockReturnValueOnce({ from: workspaceConnection.from })
      .mockReturnValueOnce({ from: activeAttempts.from })
      .mockReturnValueOnce({ from: list.from });
    const updateWhere = vi.fn(async () => undefined);
    const set = vi.fn(() => ({ where: updateWhere }));
    dbMock.update.mockReturnValue({ set });

    await expect(disconnectChannelConnection(42, "whatsapp")).resolves.toEqual(
      []
    );

    expect(set).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        status: "contained",
        completedAt: expect.any(Date),
        leaseUntil: expect.any(Date),
      })
    );
    expect(set).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        status: "disconnected",
        externalId: null,
        providerAccountExternalId: null,
        encryptedAccessToken: null,
      })
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
        externalId: "123456789012345",
        providerAccountExternalId: null,
        encryptedAccessToken: "sealed-tenant-token",
        lastCheckedAt: expect.any(Date),
      })
    );
    expect(values.mock.results[0]?.value).not.toHaveProperty(
      "onDuplicateKeyUpdate"
    );
  });

  it("writes a connection and its audit event inside the same transaction", async () => {
    const membership = lockedSelect([{ role: "owner" }]);
    const providerAccountClaim = lockedSelect([]);
    const endpointClaim = lockedSelect([]);
    const workspaceConnection = lockedSelect([]);
    const list = listSelect([]);
    dbMock.select
      .mockReturnValueOnce({ from: membership.from })
      .mockReturnValueOnce({ from: providerAccountClaim.from })
      .mockReturnValueOnce({ from: endpointClaim.from })
      .mockReturnValueOnce({ from: workspaceConnection.from })
      .mockReturnValueOnce({ from: list.from });
    const values = vi.fn(async () => undefined);
    dbMock.insert.mockReturnValue({ values });
    const audit = {
      workspaceId: 42,
      userId: 7,
      event: "whatsapp_binding.provisioned",
      metadata: { source: "operator_cli" },
    };

    await expect(
      upsertChannelConnection(whatsAppConnection, {
        authorization: {
          actorUserId: 7,
          allowedRoles: ["owner", "admin"],
        },
        auditLog: audit,
      })
    ).resolves.toEqual([]);

    expect(membership.lock).toHaveBeenCalledWith("update");
    expect(dbMock.transaction).toHaveBeenCalledOnce();
    expect(dbMock.insert).toHaveBeenCalledTimes(2);
    expect(values).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        workspaceId: 42,
        channel: "whatsapp",
        encryptedAccessToken: "sealed-whatsapp-token",
      })
    );
    expect(values).toHaveBeenNthCalledWith(2, audit);
  });

  it("rejects a non-privileged membership before claiming provider identity", async () => {
    const membership = lockedSelect([{ role: "member" }]);
    dbMock.select.mockReturnValueOnce({ from: membership.from });

    await expect(
      upsertChannelConnection(whatsAppConnection, {
        authorization: {
          actorUserId: 7,
          allowedRoles: ["owner", "admin"],
        },
      })
    ).rejects.toBeInstanceOf(ChannelConnectionAuthorizationError);

    expect(membership.lock).toHaveBeenCalledWith("update");
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("rejects a cross-workspace connection audit before any database write", async () => {
    await expect(
      upsertChannelConnection(whatsAppConnection, {
        auditLog: {
          workspaceId: 99,
          userId: 7,
          event: "whatsapp_binding.provisioned",
          metadata: null,
        },
      })
    ).rejects.toThrow("Channel connection audit workspace does not match");

    expect(dbMock.transaction).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("preserves the WhatsApp provider account when updating a connection", async () => {
    const providerAccountClaim = lockedSelect([{ id: 8, workspaceId: 42 }]);
    const endpointClaim = lockedSelect([{ id: 8, workspaceId: 42 }]);
    const workspaceConnection = lockedSelect([{ id: 8 }]);
    const activeAttempts = lockedSelect([]);
    const listed = [{ id: 8, ...whatsAppConnection }];
    const list = listSelect(listed);
    dbMock.select
      .mockReturnValueOnce({ from: providerAccountClaim.from })
      .mockReturnValueOnce({ from: endpointClaim.from })
      .mockReturnValueOnce({ from: workspaceConnection.from })
      .mockReturnValueOnce({ from: activeAttempts.from })
      .mockReturnValueOnce({ from: list.from });
    const updateWhere = vi.fn(async () => undefined);
    const set = vi.fn(() => ({ where: updateWhere }));
    dbMock.update.mockReturnValue({ set });

    await expect(upsertChannelConnection(whatsAppConnection)).resolves.toEqual(
      listed
    );

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        externalId: "223456789012345",
        providerAccountExternalId: "323456789012345",
      })
    );
    expect(providerAccountClaim.lock).toHaveBeenCalledWith("update");
  });

  it("preserves the WhatsApp provider account when inserting a connection", async () => {
    const providerAccountClaim = lockedSelect([]);
    const endpointClaim = lockedSelect([]);
    const workspaceConnection = lockedSelect([]);
    const list = listSelect([]);
    dbMock.select
      .mockReturnValueOnce({ from: providerAccountClaim.from })
      .mockReturnValueOnce({ from: endpointClaim.from })
      .mockReturnValueOnce({ from: workspaceConnection.from })
      .mockReturnValueOnce({ from: list.from });
    const values = vi.fn(async () => undefined);
    dbMock.insert.mockReturnValue({ values });

    await expect(upsertChannelConnection(whatsAppConnection)).resolves.toEqual(
      []
    );

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        externalId: "223456789012345",
        providerAccountExternalId: "323456789012345",
      })
    );
    expect(providerAccountClaim.lock).toHaveBeenCalledWith("update");
  });

  it("rejects a WABA already claimed by another workspace before touching credentials", async () => {
    const providerAccountClaim = lockedSelect([{ id: 8, workspaceId: 99 }]);
    dbMock.select.mockReturnValueOnce({ from: providerAccountClaim.from });

    const result = upsertChannelConnection(whatsAppConnection);

    await expect(result).rejects.toBeInstanceOf(
      ChannelConnectionClaimConflictError
    );
    await expect(result).rejects.not.toThrow("323456789012345");
    await expect(result).rejects.not.toThrow("sealed-whatsapp-token");
    expect(providerAccountClaim.lock).toHaveBeenCalledWith("update");
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(dbMock.insert).not.toHaveBeenCalled();
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
      const activeAttempts = lockedSelect([]);
      const listed = [{ id: 7, ...connection }];
      const list = listSelect(listed);
      dbMock.select
        .mockReturnValueOnce({ from: initialPageClaim.from })
        .mockReturnValueOnce({ from: initialWorkspaceConnection.from })
        .mockReturnValueOnce({ from: retriedPageClaim.from })
        .mockReturnValueOnce({ from: retriedWorkspaceConnection.from })
        .mockReturnValueOnce({ from: activeAttempts.from })
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
      expect(dbMock.update).toHaveBeenCalledTimes(2);
    }
  );

  it("retries a WABA-constraint race into the same workspace", async () => {
    const initialProviderAccountClaim = lockedSelect([]);
    const initialEndpointClaim = lockedSelect([]);
    const initialWorkspaceConnection = lockedSelect([]);
    const retriedProviderAccountClaim = lockedSelect([
      { id: 8, workspaceId: 42 },
    ]);
    const retriedEndpointClaim = lockedSelect([{ id: 8, workspaceId: 42 }]);
    const retriedWorkspaceConnection = lockedSelect([{ id: 8 }]);
    const activeAttempts = lockedSelect([]);
    const listed = [{ id: 8, ...whatsAppConnection }];
    const list = listSelect(listed);
    dbMock.select
      .mockReturnValueOnce({ from: initialProviderAccountClaim.from })
      .mockReturnValueOnce({ from: initialEndpointClaim.from })
      .mockReturnValueOnce({ from: initialWorkspaceConnection.from })
      .mockReturnValueOnce({ from: retriedProviderAccountClaim.from })
      .mockReturnValueOnce({ from: retriedEndpointClaim.from })
      .mockReturnValueOnce({ from: retriedWorkspaceConnection.from })
      .mockReturnValueOnce({ from: activeAttempts.from })
      .mockReturnValueOnce({ from: list.from });
    const values = vi.fn().mockRejectedValueOnce(
      Object.assign(new Error("duplicate WABA claim"), {
        code: "ER_DUP_ENTRY",
        errno: 1062,
        constraint:
          "channelConnections_channel_providerAccountExternalId_unique",
      })
    );
    dbMock.insert.mockReturnValue({ values });
    const updateWhere = vi.fn(async () => undefined);
    dbMock.update.mockReturnValue({
      set: vi.fn(() => ({ where: updateWhere })),
    });

    await expect(upsertChannelConnection(whatsAppConnection)).resolves.toEqual(
      listed
    );

    expect(dbMock.transaction).toHaveBeenCalledTimes(2);
    expect(retriedProviderAccountClaim.lock).toHaveBeenCalledWith("update");
    expect(retriedEndpointClaim.lock).toHaveBeenCalledWith("update");
    expect(dbMock.update).toHaveBeenCalledTimes(2);
  });

  it("fails closed when a WABA-constraint race resolves to another workspace", async () => {
    const initialProviderAccountClaim = lockedSelect([]);
    const initialEndpointClaim = lockedSelect([]);
    const initialWorkspaceConnection = lockedSelect([]);
    const conflictingProviderAccountClaim = lockedSelect([
      { id: 9, workspaceId: 99 },
    ]);
    dbMock.select
      .mockReturnValueOnce({ from: initialProviderAccountClaim.from })
      .mockReturnValueOnce({ from: initialEndpointClaim.from })
      .mockReturnValueOnce({ from: initialWorkspaceConnection.from })
      .mockReturnValueOnce({ from: conflictingProviderAccountClaim.from });
    const values = vi.fn().mockRejectedValueOnce(
      Object.assign(new Error("duplicate WABA claim"), {
        code: "ER_DUP_ENTRY",
        errno: 1062,
        constraint:
          "channelConnections_channel_providerAccountExternalId_unique",
      })
    );
    dbMock.insert.mockReturnValue({ values });

    await expect(
      upsertChannelConnection(whatsAppConnection)
    ).rejects.toBeInstanceOf(ChannelConnectionClaimConflictError);

    expect(dbMock.transaction).toHaveBeenCalledTimes(2);
    expect(conflictingProviderAccountClaim.lock).toHaveBeenCalledWith("update");
    expect(dbMock.update).not.toHaveBeenCalled();
    expect(values).toHaveBeenCalledOnce();
  });

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
