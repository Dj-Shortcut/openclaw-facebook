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

import { reserveMessengerProviderAttemptFence } from "./_core/messengerProviderAttemptFence";

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
});

function databaseFlow(inserted: Array<Record<string, unknown>>) {
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
                return [
                  {
                    status: "reserved",
                    leaseToken: inserted.at(-1)?.leaseToken,
                    leaseUntil: new Date(Date.now() + 60_000),
                    attemptNumber: 1,
                  },
                ];
              }
              return [];
            }),
          })),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((value: Record<string, unknown>) => {
        inserted.push(value);
        return { onDuplicateKeyUpdate: vi.fn(async () => undefined) };
      }),
    })),
    update: vi.fn(),
  };
  return { transaction: vi.fn(async callback => callback(tx)) };
}
