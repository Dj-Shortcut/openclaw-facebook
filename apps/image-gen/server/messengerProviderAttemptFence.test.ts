import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  channelConnections,
  messengerPrivacySubjects,
  messengerProviderAttemptFences,
} from "../drizzle/schema";

const { getDatabaseOrThrowMock } = vi.hoisted(() => ({
  getDatabaseOrThrowMock: vi.fn(),
}));
vi.mock("./db", () => ({ getDatabaseOrThrow: getDatabaseOrThrowMock }));

import {
  containMessengerProviderAttemptsForPrivacy,
  reserveMessengerProviderAttemptFence,
} from "./_core/messengerProviderAttemptFence";

describe("messenger provider attempt privacy identity", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  beforeEach(() => {
    getDatabaseOrThrowMock.mockReset();
    process.env.DATABASE_URL = "mysql://test.invalid/privacy";
  });
  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("scopes logical operations by user and privacy epoch", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    getDatabaseOrThrowMock.mockResolvedValue(databaseFlow(inserted));
    const base = {
      pageId: "page-1",
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      userId: "privacy-user-key-123",
      reqId: "same-request",
      psid: "psid",
      lang: "nl" as const,
    };
    await reserveMessengerProviderAttemptFence(
      { ...base, privacyEpoch: 5 },
      "image_generation",
      1
    );
    await reserveMessengerProviderAttemptFence(
      { ...base, privacyEpoch: 6 },
      "image_generation",
      1
    );
    expect(inserted).toHaveLength(2);
    expect(inserted[0]?.attemptKeyHash).not.toBe(inserted[1]?.attemptKeyHash);
    expect(inserted[0]).toMatchObject({
      userKey: base.userId,
      privacyEpoch: 5,
    });
  });

  it("blocks automatic retries after transport start without colliding across tenants", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    getDatabaseOrThrowMock.mockResolvedValue(databaseFlow(inserted));
    const base = {
      pageId: "page-1",
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      userId: "privacy-user-key-123",
      privacyEpoch: 5,
      reqId: "same-request",
      psid: "synthetic-psid",
      lang: "nl" as const,
    };

    const first = await reserveMessengerProviderAttemptFence(
      base,
      "image_generation",
      1
    );
    await expect(
      reserveMessengerProviderAttemptFence(base, "image_generation", 2)
    ).rejects.toThrow("Messenger provider attempt already fenced");

    const otherTenant = await reserveMessengerProviderAttemptFence(
      {
        ...base,
        pageId: "page-2",
        workspaceId: 43,
        channelConnectionId: 8,
      },
      "image_generation",
      1
    );
    expect(otherTenant.attemptKeyHash).not.toBe(first.attemptKeyHash);
    expect(inserted).toHaveLength(2);
  });

  it("keeps privacy erasure pending while a transport attempt is active", async () => {
    getDatabaseOrThrowMock.mockResolvedValue(
      privacyContainmentFlow([{ id: 91 }])
    );

    await expect(
      containMessengerProviderAttemptsForPrivacy({
        workspaceId: 42,
        channelConnectionId: 7,
        userKey: "privacy-user-key-123",
      })
    ).resolves.toBe(false);
  });

  it("allows erasure to finish after active transports have drained", async () => {
    getDatabaseOrThrowMock.mockResolvedValue(privacyContainmentFlow([]));

    await expect(
      containMessengerProviderAttemptsForPrivacy({
        workspaceId: 42,
        channelConnectionId: 7,
        userKey: "privacy-user-key-123",
      })
    ).resolves.toBe(true);
  });
});

function privacyContainmentFlow(active: Array<{ id: number }>) {
  const tx = {
    delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => ({ for: vi.fn(async () => active) })),
        })),
      })),
    })),
  };
  return { transaction: vi.fn(async callback => callback(tx)) };
}

function databaseFlow(inserted: Array<Record<string, unknown>>) {
  let selectedAttemptKeyHash: string | undefined;
  const tx = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => ({
            for: vi.fn(async () => {
              if (
                table === channelConnections ||
                table === messengerPrivacySubjects
              ) {
                return [{ id: 1 }];
              }
              if (table === messengerProviderAttemptFences) {
                const row = inserted.find(
                  value => value.attemptKeyHash === selectedAttemptKeyHash
                );
                return row ? [row] : [];
              }
              return [];
            }),
          })),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((value: Record<string, unknown>) => {
        selectedAttemptKeyHash = String(value.attemptKeyHash);
        if (
          !inserted.some(row => row.attemptKeyHash === value.attemptKeyHash)
        ) {
          inserted.push(value);
        }
        return { onDuplicateKeyUpdate: vi.fn(async () => undefined) };
      }),
    })),
    update: vi.fn(),
  };
  return { transaction: vi.fn(async callback => callback(tx)) };
}
