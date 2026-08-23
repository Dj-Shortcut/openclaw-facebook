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
  claimMessengerProviderAttemptFence,
  containMessengerProviderAttemptsForPrivacy,
  finalizeMessengerProviderAttemptFence,
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

  it("gives each provider retry sequence its own attempt fence", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    getDatabaseOrThrowMock.mockResolvedValue(databaseFlow(inserted));

    await reserveMessengerProviderAttemptFence(
      providerJob(),
      "image_generation",
      1
    );
    await reserveMessengerProviderAttemptFence(
      providerJob(),
      "image_generation",
      2
    );

    expect(inserted).toHaveLength(2);
    expect(inserted[0]?.attemptKeyHash).not.toBe(inserted[1]?.attemptKeyHash);
    expect(inserted[0]?.providerOperation).toBe("image_generation");
    expect(inserted[1]?.providerOperation).toBe("image_generation");
  });

  it("still rejects an old worker after the connection epoch changes", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    getDatabaseOrThrowMock.mockResolvedValue(
      databaseFlow(inserted, { bindingCurrent: false })
    );

    await expect(
      reserveMessengerProviderAttemptFence(providerJob(), "image_generation", 1)
    ).rejects.toThrow("Messenger provider ownership changed");
    expect(inserted).toHaveLength(0);
  });

  it("still rejects an old worker after the privacy epoch changes", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    getDatabaseOrThrowMock.mockResolvedValue(
      databaseFlow(inserted, { privacyCurrent: false })
    );

    await expect(
      reserveMessengerProviderAttemptFence(providerJob(), "image_generation", 1)
    ).rejects.toThrow("Messenger provider privacy changed");
    expect(inserted).toHaveLength(0);
  });

  it("keeps a current reservation busy unless the same attempt explicitly recovers it", async () => {
    const now = new Date("2026-08-23T12:00:00.000Z");
    const leaseUntil = new Date("2026-08-23T12:15:00.000Z");
    const flow = existingFenceFlow({
      status: "reserved",
      leaseToken: "old-reservation",
      leaseUntil,
      attemptNumber: 1,
    });
    getDatabaseOrThrowMock.mockResolvedValue(flow.database);

    await expect(
      claimMessengerProviderAttemptFence(
        providerJob(),
        "messenger-graph-send",
        1,
        now
      )
    ).resolves.toEqual({ kind: "busy", retryAt: leaseUntil });
    expect(flow.updates).toHaveLength(0);
  });

  it("CAS-takes over a reserved same-attempt fence for safe recovery", async () => {
    const now = new Date("2026-08-23T12:00:00.000Z");
    const flow = existingFenceFlow({
      status: "reserved",
      leaseToken: "old-reservation",
      leaseUntil: new Date("2026-08-23T12:15:00.000Z"),
      attemptNumber: 4,
    });
    getDatabaseOrThrowMock.mockResolvedValue(flow.database);

    const claim = await claimMessengerProviderAttemptFence(
      providerJob(),
      "messenger-graph-send",
      1,
      now,
      { takeOverReserved: true }
    );

    expect(claim.kind).toBe("owned");
    expect(flow.updates).toHaveLength(1);
    expect(flow.updates[0]).toMatchObject({
      attemptNumber: 5,
      startedAt: null,
      completedAt: null,
    });
  });

  it.each(["started", "ambiguous", "succeeded"] as const)(
    "never reclaims a %s provider attempt",
    async status => {
      const flow = existingFenceFlow({
        status,
        leaseToken: "terminal-attempt",
        leaseUntil: new Date("2026-08-23T12:15:00.000Z"),
        attemptNumber: 1,
      });
      getDatabaseOrThrowMock.mockResolvedValue(flow.database);

      await expect(
        claimMessengerProviderAttemptFence(
          providerJob(),
          "messenger-graph-send",
          1,
          new Date("2026-08-23T12:00:00.000Z"),
          { takeOverReserved: true }
        )
      ).resolves.toEqual({ kind: "unsafe_or_done", status });
      expect(flow.updates).toHaveLength(0);
    }
  );

  it("reclaims a provider attempt that is durably known to have failed", async () => {
    const flow = existingFenceFlow({
      status: "known_failed",
      leaseToken: "known-failed-attempt",
      leaseUntil: new Date("2026-08-23T11:59:00.000Z"),
      attemptNumber: 2,
    });
    getDatabaseOrThrowMock.mockResolvedValue(flow.database);

    const claim = await claimMessengerProviderAttemptFence(
      providerJob(),
      "messenger-graph-send",
      1,
      new Date("2026-08-23T12:00:00.000Z")
    );

    expect(claim.kind).toBe("owned");
    expect(flow.updates[0]).toMatchObject({
      status: "reserved",
      attemptNumber: 3,
    });
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

  it("keeps the lease cooling down when the provider outcome is ambiguous", async () => {
    let written: Record<string, unknown> | undefined;
    getDatabaseOrThrowMock.mockResolvedValue({
      update: vi.fn(() => ({
        set: vi.fn((value: Record<string, unknown>) => {
          written = value;
          return {
            where: vi.fn(async () => ({ affectedRows: 1 })),
          };
        }),
      })),
    });
    const completedAt = new Date("2026-08-23T12:00:00.000Z");

    await expect(
      finalizeMessengerProviderAttemptFence(
        {
          leaseToken: "lease-ambiguous",
          attemptKeyHash: "attempt-ambiguous",
        },
        "ambiguous",
        completedAt
      )
    ).resolves.toBeUndefined();

    expect(written).toEqual({
      status: "ambiguous",
      completedAt,
    });
  });
});

function privacyContainmentFlow(active: Array<{ id: number }>) {
  const tx = {
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

function providerJob() {
  return {
    pageId: "page-1",
    workspaceId: 42,
    channelConnectionId: 7,
    bindingEpoch: 3,
    userId: "privacy-user-key-123",
    privacyEpoch: 5,
    reqId: "same-request",
    psid: "psid",
    lang: "nl" as const,
  };
}

function databaseFlow(
  inserted: Array<Record<string, unknown>>,
  options: { bindingCurrent?: boolean; privacyCurrent?: boolean } = {}
) {
  const tx = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => ({
            for: vi.fn(async () => {
              if (table === channelConnections) {
                return options.bindingCurrent === false ? [] : [{ id: 1 }];
              }
              if (table === messengerPrivacySubjects) {
                return options.privacyCurrent === false ? [] : [{ id: 1 }];
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

function existingFenceFlow(existing: {
  status: "reserved" | "started" | "known_failed" | "succeeded" | "ambiguous";
  leaseToken: string;
  leaseUntil: Date;
  attemptNumber: number;
}) {
  const updates: Array<Record<string, unknown>> = [];
  const tx = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => ({
            for: vi.fn(async () => {
              if (table === channelConnections) return [{ id: 1 }];
              if (table === messengerPrivacySubjects) return [{ id: 1 }];
              if (table === messengerProviderAttemptFences) return [existing];
              return [];
            }),
          })),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onDuplicateKeyUpdate: vi.fn(async () => undefined),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((value: Record<string, unknown>) => {
        updates.push(value);
        return { where: vi.fn(async () => ({ affectedRows: 1 })) };
      }),
    })),
  };
  return {
    database: { transaction: vi.fn(async callback => callback(tx)) },
    updates,
  };
}
