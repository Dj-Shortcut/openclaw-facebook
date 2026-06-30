import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock, drizzleMock } = vi.hoisted(() => {
  const db = {
    delete: vi.fn(),
    insert: vi.fn(),
    select: vi.fn(),
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
  createPortalHandoffToken,
  deletePortalHandoffTokensForMessengerUserKey,
  markPortalHandoffTokenConsumed,
} from "./db";

const originalDatabaseUrl = process.env.DATABASE_URL;

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

  it("reads mysql2 tuple delete results when erasing handoff tokens", async () => {
    const where = vi.fn(async () => [{ affectedRows: 2 }, []]);
    dbMock.delete.mockReturnValue({ where });

    await expect(
      deletePortalHandoffTokensForMessengerUserKey("sender-user-key")
    ).resolves.toBe(2);
  });
});
