import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  billingSchedulerTenants,
  channelConnections,
  workspaceEntitlements,
  workspaceEntitlementUsage,
  workspaceEntitlementUsageReservations,
} from "../../../drizzle/schema";

const databaseMock = vi.hoisted(() => vi.fn());
vi.mock("../../db", () => ({ getDatabaseOrThrow: databaseMock }));

import {
  commitStartpilotAiAnswerUsage,
  parseStartpilotQuota,
  releaseStartpilotAiAnswerUsage,
  reserveStartpilotAiAnswerUsage,
  reserveStartpilotImageUsage,
  utcDateKey,
} from "./entitlementUsageStore";

const OWNER_TOKEN = "11111111-1111-4111-8111-111111111111";

const quota = {
  aiAnswersTotal: 300,
  imagesTotal: 20,
  imagesPerDay: 5,
  workspaces: 1,
  facebookPages: 1,
  imageQuality: "images_2",
} as const;

beforeEach(() => vi.clearAllMocks());

describe("Startpilot finite entitlement usage", () => {
  it("accepts only the exact cost-bounded quota snapshot", () => {
    expect(parseStartpilotQuota(quota)).toEqual(quota);
    expect(parseStartpilotQuota({ ...quota, imagesTotal: 200 })).toBeNull();
    expect(
      parseStartpilotQuota({ ...quota, imageQuality: "legacy" })
    ).toBeNull();
  });

  it("reserves an image atomically and resets only the UTC daily counter", async () => {
    const flow = usageFlow({
      imagesUsed: 7,
      imageUsageDate: "2026-07-31",
      imagesUsedToday: 5,
    });
    databaseMock.mockResolvedValue(flow.database);

    await expect(
      reserveStartpilotImageUsage({
        workspaceId: 1,
        entitlementId: 9,
        channelConnectionId: 7,
        bindingEpoch: 3,
        mode: "test",
        idempotencyKey: "image-request-key-00000001",
        now: new Date("2026-08-01T00:00:00.000Z"),
      })
    ).resolves.toEqual({
      allowed: true,
      imagesUsed: 8,
      imagesUsedToday: 1,
      alreadyReserved: false,
    });
    expect(flow.updateSet).toHaveBeenCalledWith({
      imagesUsed: 8,
      imageUsageDate: "2026-08-01",
      imagesUsedToday: 1,
    });
  });

  it("blocks before writing at the total and daily limits", async () => {
    const total = usageFlow({ imagesUsed: 20 });
    databaseMock.mockResolvedValue(total.database);
    await expect(
      reserveStartpilotImageUsage({
        workspaceId: 1,
        entitlementId: 9,
        channelConnectionId: 7,
        bindingEpoch: 3,
        mode: "test",
        idempotencyKey: "image-request-key-total-limit",
      })
    ).resolves.toEqual({ allowed: false, reason: "total_exhausted" });
    expect(total.updateSet).not.toHaveBeenCalled();

    const now = new Date("2026-08-01T12:00:00.000Z");
    const daily = usageFlow({
      imageUsageDate: utcDateKey(now),
      imagesUsedToday: 5,
    });
    databaseMock.mockResolvedValue(daily.database);
    await expect(
      reserveStartpilotImageUsage({
        workspaceId: 1,
        entitlementId: 9,
        channelConnectionId: 7,
        bindingEpoch: 3,
        mode: "test",
        idempotencyKey: "image-request-key-daily-limit",
        now,
      })
    ).resolves.toEqual({ allowed: false, reason: "daily_exhausted" });
    expect(daily.updateSet).not.toHaveBeenCalled();
  });

  it("reuses the exact committed image receipt without counting twice", async () => {
    const existing = imageReservation();
    const flow = usageFlow(
      { imagesUsed: 8, imageUsageDate: "2026-08-01", imagesUsedToday: 2 },
      { reservations: [existing] }
    );
    databaseMock.mockResolvedValue(flow.database);

    await expect(
      reserveStartpilotImageUsage({
        workspaceId: 1,
        entitlementId: 9,
        channelConnectionId: 7,
        bindingEpoch: 3,
        mode: "test",
        idempotencyKey: existing.idempotencyKey,
        now: new Date("2026-08-01T12:00:00.000Z"),
      })
    ).resolves.toEqual({
      allowed: true,
      imagesUsed: 8,
      imagesUsedToday: 2,
      alreadyReserved: true,
    });
    expect(flow.updateSet).not.toHaveBeenCalled();
    expect(flow.insertValues).not.toHaveBeenCalled();
  });

  it("fails closed when the Page binding changed", async () => {
    const flow = usageFlow({}, { bindingMatches: false });
    databaseMock.mockResolvedValue(flow.database);

    await expect(
      reserveStartpilotImageUsage({
        workspaceId: 1,
        entitlementId: 9,
        channelConnectionId: 7,
        bindingEpoch: 3,
        mode: "test",
        idempotencyKey: "image-request-key-stale-binding",
      })
    ).rejects.toThrow("Startpilot image usage binding changed");
    expect(flow.updateSet).not.toHaveBeenCalled();
    expect(flow.insertValues).not.toHaveBeenCalled();
  });

  it("reserves the first AI answer and increments the reserved counter", async () => {
    const now = new Date("2026-08-01T12:00:00.000Z");
    const flow = aiUsageFlow();
    databaseMock.mockResolvedValue(flow.database);

    await expect(
      reserveStartpilotAiAnswerUsage({
        workspaceId: 1,
        entitlementId: 9,
        mode: "test",
        idempotencyKey: "request-key-00000001",
        ownerToken: OWNER_TOKEN,
        now,
      })
    ).resolves.toEqual({
      allowed: true,
      reservationId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      alreadyReserved: false,
    });
    expect(flow.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 1,
        entitlementId: 9,
        mode: "test",
        kind: "ai_answer",
        status: "reserved",
        idempotencyKey: "request-key-00000001",
        ownerTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        ownerLeaseUntil: new Date("2026-08-01T12:04:30.000Z"),
        resolutionDueAt: new Date("2026-08-01T12:05:00.000Z"),
        expiresAt: new Date("2026-08-01T12:05:00.000Z"),
      })
    );
    expect(flow.usage.aiAnswersReserved).toBe(1);
  });

  it("refuses a stale binding snapshot before reserving usage", async () => {
    const flow = aiUsageFlow({ bindingMatches: false });
    databaseMock.mockResolvedValue(flow.database);

    await expect(
      reserveStartpilotAiAnswerUsage({
        workspaceId: 1,
        entitlementId: 9,
        channelConnectionId: 7,
        bindingEpoch: 3,
        mode: "test",
        idempotencyKey: "request-key-stale-binding",
        ownerToken: OWNER_TOKEN,
        now: new Date("2026-08-01T12:00:00.000Z"),
      })
    ).rejects.toThrow("AI answer reservation binding changed");
    expect(flow.insertValues).not.toHaveBeenCalled();
    expect(flow.usage.aiAnswersReserved).toBe(0);
  });

  it("refuses a partial connection snapshot before opening a transaction", async () => {
    await expect(
      reserveStartpilotAiAnswerUsage({
        workspaceId: 1,
        entitlementId: 9,
        channelConnectionId: 7,
        mode: "test",
        idempotencyKey: "request-key-partial-binding",
        ownerToken: OWNER_TOKEN,
      })
    ).rejects.toThrow("incomplete AI answer reservation binding");
    expect(databaseMock).not.toHaveBeenCalled();
  });

  it("stores a binding only after locking the exact current epoch", async () => {
    const flow = aiUsageFlow({ bindingMatches: true });
    databaseMock.mockResolvedValue(flow.database);

    await expect(
      reserveStartpilotAiAnswerUsage({
        workspaceId: 1,
        entitlementId: 9,
        channelConnectionId: 7,
        bindingEpoch: 3,
        mode: "test",
        idempotencyKey: "request-key-current-binding",
        ownerToken: OWNER_TOKEN,
        now: new Date("2026-08-01T12:00:00.000Z"),
      })
    ).resolves.toEqual({
      allowed: true,
      reservationId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      alreadyReserved: false,
    });
    expect(flow.selectedTables.indexOf(channelConnections)).toBeLessThan(
      flow.selectedTables.indexOf(billingSchedulerTenants)
    );
    expect(flow.selectedTables.indexOf(billingSchedulerTenants)).toBeLessThan(
      flow.selectedTables.indexOf(workspaceEntitlementUsageReservations)
    );
    expect(flow.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ channelConnectionId: 7, bindingEpoch: 3 })
    );
  });

  it("reuses only a reserved idempotency key from the same entitlement", async () => {
    const reserved = aiReservation();
    const flow = aiUsageFlow({
      usage: { aiAnswersReserved: 1 },
      lookupReservations: [reserved],
    });
    databaseMock.mockResolvedValue(flow.database);

    await expect(
      reserveStartpilotAiAnswerUsage({
        workspaceId: 1,
        entitlementId: 9,
        mode: "test",
        idempotencyKey: reserved.idempotencyKey,
        ownerToken: OWNER_TOKEN,
        now: new Date("2026-08-01T12:00:00.000Z"),
      })
    ).resolves.toEqual({
      allowed: true,
      reservationId: reserved.reservationId,
      alreadyReserved: true,
    });
    expect(flow.insertValues).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "ai_answer" })
    );

    const otherEntitlement = aiReservation({ entitlementId: 8 });
    const conflict = aiUsageFlow({ lookupReservations: [otherEntitlement] });
    databaseMock.mockResolvedValue(conflict.database);
    await expect(
      reserveStartpilotAiAnswerUsage({
        workspaceId: 1,
        entitlementId: 9,
        mode: "test",
        idempotencyKey: otherEntitlement.idempotencyKey,
        ownerToken: OWNER_TOKEN,
        now: new Date("2026-08-01T12:00:00.000Z"),
      })
    ).resolves.toEqual({ allowed: false, reason: "idempotency_reused" });
    expect(conflict.insertValues).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "ai_answer" })
    );
  });

  it.each(["committed", "released", "expired"] as const)(
    "does not reuse an idempotency key in %s state",
    async status => {
      const finished = aiReservation({ status });
      const flow = aiUsageFlow({ lookupReservations: [finished] });
      databaseMock.mockResolvedValue(flow.database);

      await expect(
        reserveStartpilotAiAnswerUsage({
          workspaceId: 1,
          entitlementId: 9,
          mode: "test",
          idempotencyKey: finished.idempotencyKey,
          ownerToken: OWNER_TOKEN,
          now: new Date("2026-08-01T12:00:00.000Z"),
        })
      ).resolves.toEqual({ allowed: false, reason: "idempotency_reused" });
      expect(flow.insertValues).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: "ai_answer" })
      );
    }
  );

  it("blocks AI-answer reservations at the total allowance", async () => {
    const flow = aiUsageFlow({
      usage: { aiAnswersCommitted: 299, aiAnswersReserved: 1 },
    });
    databaseMock.mockResolvedValue(flow.database);

    await expect(
      reserveStartpilotAiAnswerUsage({
        workspaceId: 1,
        entitlementId: 9,
        mode: "test",
        idempotencyKey: "request-key-00000002",
        ownerToken: OWNER_TOKEN,
        now: new Date("2026-08-01T12:00:00.000Z"),
      })
    ).resolves.toEqual({ allowed: false, reason: "total_exhausted" });
    expect(flow.insertValues).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "ai_answer" })
    );
  });

  it("commits a live AI-answer reservation exactly once", async () => {
    const reserved = aiReservation();
    const flow = aiUsageFlow({
      usage: { aiAnswersReserved: 1 },
      lookupReservations: [reserved],
    });
    databaseMock.mockResolvedValue(flow.database);

    await expect(
      commitStartpilotAiAnswerUsage({
        workspaceId: 1,
        entitlementId: 9,
        mode: "test",
        reservationId: reserved.reservationId,
        ownerTokenHash: reserved.ownerTokenHash,
        now: new Date("2026-08-01T12:00:00.000Z"),
      })
    ).resolves.toEqual({ committed: true });
    expect(reserved.status).toBe("committed");
    expect(flow.usage).toEqual(
      expect.objectContaining({ aiAnswersReserved: 0, aiAnswersCommitted: 1 })
    );
  });

  it("releases a live AI-answer reservation without consuming quota", async () => {
    const reserved = aiReservation();
    const flow = aiUsageFlow({
      usage: { aiAnswersReserved: 1 },
      lookupReservations: [reserved],
    });
    databaseMock.mockResolvedValue(flow.database);

    await expect(
      releaseStartpilotAiAnswerUsage({
        workspaceId: 1,
        entitlementId: 9,
        mode: "test",
        reservationId: reserved.reservationId,
        ownerTokenHash: reserved.ownerTokenHash,
        now: new Date("2026-08-01T12:00:00.000Z"),
      })
    ).resolves.toEqual({ released: true });
    expect(reserved.status).toBe("released");
    expect(flow.usage).toEqual(
      expect.objectContaining({ aiAnswersReserved: 0, aiAnswersCommitted: 0 })
    );
  });

  it("conservatively commits a stale delivered reservation during finish", async () => {
    const now = new Date("2026-08-01T12:00:00.000Z");
    const reserved = aiReservation({
      expiresAt: new Date("2026-08-01T11:59:59.000Z"),
    });
    const flow = aiUsageFlow({
      usage: { aiAnswersReserved: 1 },
      lookupReservations: [reserved],
    });
    databaseMock.mockResolvedValue(flow.database);

    await expect(
      commitStartpilotAiAnswerUsage({
        workspaceId: 1,
        entitlementId: 9,
        mode: "test",
        reservationId: reserved.reservationId,
        ownerTokenHash: reserved.ownerTokenHash,
        now,
      })
    ).resolves.toEqual({ committed: true });
    expect(reserved).toEqual(
      expect.objectContaining({ status: "committed", committedAt: now })
    );
    expect(flow.usage.aiAnswersReserved).toBe(0);
    expect(flow.usage.aiAnswersCommitted).toBe(1);
  });

  it("conservatively commits ambiguous stale reservations before the next answer", async () => {
    const stale = aiReservation({
      idempotencyKey: "request-key-stale-0001",
      expiresAt: new Date("2026-08-01T11:59:59.000Z"),
      deliveryStartedAt: new Date("2026-08-01T11:58:00.000Z"),
    });
    const flow = aiUsageFlow({
      usage: { aiAnswersReserved: 1 },
      staleReservations: [stale],
    });
    databaseMock.mockResolvedValue(flow.database);

    await expect(
      reserveStartpilotAiAnswerUsage({
        workspaceId: 1,
        entitlementId: 9,
        mode: "test",
        idempotencyKey: "request-key-fresh-0001",
        ownerToken: OWNER_TOKEN,
        now: new Date("2026-08-01T12:00:00.000Z"),
      })
    ).resolves.toEqual({
      allowed: true,
      reservationId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      alreadyReserved: false,
    });
    expect(stale.status).toBe("committed");
    expect(flow.usage.aiAnswersReserved).toBe(1);
    expect(flow.usage.aiAnswersCommitted).toBe(1);
    expect(
      flow.updates.filter(update => update.table === workspaceEntitlementUsage)
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          values: { aiAnswersReserved: 0, aiAnswersCommitted: 1 },
        }),
        expect.objectContaining({ values: { aiAnswersReserved: 1 } }),
      ])
    );
  });
});

function usageFlow(
  overrides: Partial<{
    imagesUsed: number;
    imageUsageDate: string | null;
    imagesUsedToday: number;
  }>,
  options: {
    reservations?: ReturnType<typeof imageReservation>[];
    bindingMatches?: boolean;
  } = {}
) {
  const validUntil = new Date("2026-09-01T00:00:00.000Z");
  const usage = {
    id: 4,
    workspaceId: 1,
    entitlementId: 9,
    mode: "test",
    planCode: "startpilot_once_v1",
    periodEndsAt: validUntil,
    aiAnswersCommitted: 0,
    aiAnswersReserved: 0,
    imagesUsed: 0,
    imageUsageDate: utcDateKey(new Date()),
    imagesUsedToday: 0,
    ...overrides,
  };
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const insertValues = vi.fn(async () => undefined);
  const tx = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => ({
            for: vi.fn().mockResolvedValue(
              table === workspaceEntitlements
                ? [
                    {
                      id: 9,
                      workspaceId: 1,
                      mode: "test",
                      planCode: "startpilot_once_v1",
                      status: "active",
                      quota,
                      validUntil,
                    },
                  ]
                : table === channelConnections
                  ? options.bindingMatches === false
                    ? []
                    : [{ id: 7 }]
                  : table === workspaceEntitlementUsage
                    ? [usage]
                    : table === workspaceEntitlementUsageReservations
                      ? (options.reservations ?? [])
                      : []
            ),
          })),
        })),
      })),
    })),
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn(() => ({ set: updateSet })),
  };
  return {
    database: {
      transaction: vi.fn(
        async (callback: (transaction: typeof tx) => Promise<unknown>) =>
          callback(tx)
      ),
    },
    insertValues,
    updateSet,
  };
}

function imageReservation() {
  return {
    reservationId: "20000000-0000-4000-8000-000000000001",
    workspaceId: 1,
    mode: "test" as const,
    entitlementId: 9,
    channelConnectionId: 7,
    bindingEpoch: 3,
    kind: "image" as const,
    status: "committed" as const,
    idempotencyKey: "image-request-key-00000001",
  };
}

type AiReservation = {
  reservationId: string;
  workspaceId: number;
  mode: "test";
  entitlementId: number;
  kind: "ai_answer";
  status: "reserved" | "committed" | "released" | "expired";
  idempotencyKey: string;
  expiresAt: Date;
  resolutionDueAt: Date;
  ownerTokenHash: string;
  ownerLeaseUntil: Date;
  deliveryStartedAt: Date | null;
  committedAt: Date | null;
  releasedAt: Date | null;
};

function aiReservation(overrides: Partial<AiReservation> = {}): AiReservation {
  return {
    reservationId: "10000000-0000-4000-8000-000000000001",
    workspaceId: 1,
    mode: "test",
    entitlementId: 9,
    kind: "ai_answer",
    status: "reserved",
    idempotencyKey: "request-key-00000001",
    expiresAt: new Date("2026-08-01T12:05:00.000Z"),
    resolutionDueAt: new Date("2026-08-01T12:05:00.000Z"),
    ownerTokenHash:
      "bd7662a5eeb41614e720d477abfcb2272e19a8a70a93b7e3bc8560d44ad326e9",
    ownerLeaseUntil: new Date("2026-08-01T12:05:00.000Z"),
    deliveryStartedAt: null,
    committedAt: null,
    releasedAt: null,
    ...overrides,
  };
}

function aiUsageFlow(
  options: {
    usage?: Partial<{
      aiAnswersCommitted: number;
      aiAnswersReserved: number;
    }>;
    lookupReservations?: AiReservation[];
    staleReservations?: AiReservation[];
    schedulerEnabled?: boolean;
    bindingMatches?: boolean;
  } = {}
) {
  const validUntil = new Date("2026-09-01T00:00:00.000Z");
  const usage = {
    id: 4,
    workspaceId: 1,
    entitlementId: 9,
    mode: "test" as const,
    planCode: "startpilot_once_v1",
    sourceIntentId: "550e8400-e29b-41d4-a716-446655440000",
    periodStartedAt: new Date("2026-08-01T00:00:00.000Z"),
    periodEndsAt: validUntil,
    aiAnswersCommitted: 0,
    aiAnswersReserved: 0,
    imagesUsed: 0,
    imageUsageDate: "2026-08-01",
    imagesUsedToday: 0,
    ...options.usage,
  };
  const lookupReservations = options.lookupReservations ?? [];
  const staleReservations = options.staleReservations ?? [];
  const selectedTables: unknown[] = [];
  const updates: Array<{ table: unknown; values: Record<string, unknown> }> =
    [];
  const insertValues = vi.fn((values: Record<string, unknown>) => ({
    values,
    onDuplicateKeyUpdate: vi.fn(async () => undefined),
  }));

  const tx = {
    select: vi.fn((selection?: unknown) => ({
      from: vi.fn((table: unknown) => {
        selectedTables.push(table);
        return {
          where: vi.fn(() => {
            const rows =
              table === workspaceEntitlements
                ? [
                    {
                      id: 9,
                      workspaceId: 1,
                      mode: "test",
                      planCode: "startpilot_once_v1",
                      status: "active",
                      quota,
                      validUntil,
                    },
                  ]
                : table === channelConnections
                  ? options.bindingMatches === false
                    ? []
                    : [{ id: 7 }]
                  : table === workspaceEntitlementUsage
                    ? [usage]
                    : table === billingSchedulerTenants
                      ? [{ enabled: options.schedulerEnabled ?? true }]
                      : table === workspaceEntitlementUsageReservations
                        ? selection === undefined
                          ? lookupReservations
                          : staleReservations
                        : [];
            const lock = vi.fn(async () => rows);
            return {
              limit: vi.fn(() => ({ for: lock })),
              for: lock,
            };
          }),
        };
      }),
    })),
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updates.push({ table, values });
        return {
          where: vi.fn(async () => {
            if (table === workspaceEntitlementUsage) {
              Object.assign(usage, values);
            }
            if (table === workspaceEntitlementUsageReservations) {
              for (const reservation of new Set([
                ...lookupReservations,
                ...staleReservations,
              ])) {
                Object.assign(reservation, values);
              }
            }
            return [{ affectedRows: 1 }];
          }),
        };
      }),
    })),
  };

  return {
    database: {
      transaction: vi.fn(
        async (callback: (transaction: typeof tx) => Promise<unknown>) =>
          callback(tx)
      ),
    },
    insertValues,
    lookupReservations,
    staleReservations,
    selectedTables,
    updates,
    usage,
  };
}
