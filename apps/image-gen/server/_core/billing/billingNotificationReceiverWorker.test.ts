import { beforeEach, describe, expect, it, vi } from "vitest";

const { databaseMock } = vi.hoisted(() => ({ databaseMock: vi.fn() }));
vi.mock("../../db", () => ({ getDatabaseOrThrow: databaseMock }));
vi.mock("./config", () => ({ getConfiguredBillingMode: () => "test" }));
vi.mock("./billingSchedulerStore", () => ({
  recordBillingSchedulerPoll: vi.fn(async () => undefined),
}));

import { runBillingNotificationReceiverOnce } from "./billingNotificationReceiverWorker";

describe("billing notification receiver worker", () => {
  beforeEach(() => vi.clearAllMocks());

  it("claims and materializes one tenant-scoped notification exactly once", async () => {
    const harness = createHarness([job(1, 42)]);
    databaseMock.mockResolvedValue(harness.database);

    await expect(runBillingNotificationReceiverOnce(fixedNow)).resolves.toBe(
      true
    );
    expect(harness.inbox).toEqual([
      expect.objectContaining({
        receiptId: 101,
        workspaceId: 42,
        audience: "customer",
      }),
    ]);
    expect(harness.completed).toEqual([1]);
  });

  it("does not let a poison tenant block the next workspace", async () => {
    const harness = createHarness([job(1, 42), job(2, 84)], 1);
    databaseMock.mockResolvedValue(harness.database);

    await expect(runBillingNotificationReceiverOnce(fixedNow)).resolves.toBe(
      true
    );
    await expect(runBillingNotificationReceiverOnce(fixedNow)).resolves.toBe(
      true
    );
    expect(harness.rescheduled).toEqual([1]);
    expect(harness.completed).toEqual([2]);
    expect(harness.inbox).toEqual([
      expect.objectContaining({ receiptId: 102, workspaceId: 84 }),
    ]);
  });

  it("returns false without scanning customer payloads when no work is due", async () => {
    const harness = createHarness([]);
    databaseMock.mockResolvedValue(harness.database);
    await expect(runBillingNotificationReceiverOnce(fixedNow)).resolves.toBe(
      false
    );
    expect(harness.inbox).toEqual([]);
  });

  it("preserves a terminal dead letter while later tenant work succeeds", async () => {
    const terminal = { ...job(1, 42), attemptCount: 7, maxAttempts: 8 };
    const harness = createHarness([terminal, job(2, 42)], 1);
    databaseMock.mockResolvedValue(harness.database);

    await expect(runBillingNotificationReceiverOnce(fixedNow)).resolves.toBe(
      true
    );
    await expect(runBillingNotificationReceiverOnce(fixedNow)).resolves.toBe(
      true
    );
    expect(harness.deadLetters).toEqual([1]);
    expect(harness.completed).toEqual([2]);
    expect(harness.aggregateDeadCounts).toEqual([1, 1]);
  });
});

const fixedNow = new Date("2026-08-18T10:00:00.000Z");

function job(id: number, workspaceId: number) {
  return {
    id,
    receiptId: 100 + id,
    workspaceId,
    mode: "test" as const,
    audience: "customer" as const,
    eventType: "payment_warning",
    reason: "payment_failed",
    status: "pending" as const,
    attemptCount: 0,
    maxAttempts: 8,
    availableAt: fixedNow,
    lockedAt: null,
    leaseToken: null,
    lastErrorCode: null,
    deliveredAt: null,
    createdAt: fixedNow,
  };
}

function createHarness(rows: ReturnType<typeof job>[], poisonId?: number) {
  const queue = [...rows];
  const inbox: unknown[] = [];
  const completed: number[] = [];
  const rescheduled: number[] = [];
  const deadLetters: number[] = [];
  const aggregateDeadCounts: number[] = [];
  let active: ReturnType<typeof job> | null = null;
  let needsFailure = false;

  const aggregateSelect = () => ({
    from: vi.fn(() => ({
      where: vi.fn(async () => {
        aggregateDeadCounts.push(deadLetters.length);
        return [
          {
            nextAt: queue[0]?.availableAt ?? null,
            pendingCount: queue.length,
            deadLetterCount: deadLetters.length,
          },
        ];
      }),
    })),
  });

  const update = (phase: "claim" | "process" | "failure") => ({
    set: (values: Record<string, unknown>) => ({
      where: async () => {
        if (phase === "process" && values.status === "delivered" && active) {
          completed.push(active.id);
          active = null;
        }
        if (phase === "failure" && "lastErrorCode" in values && active) {
          if (values.status === "dead_letter") deadLetters.push(active.id);
          else rescheduled.push(active.id);
          active = null;
          needsFailure = false;
        }
        return [{ affectedRows: 1 }];
      },
    }),
  });

  const claimTransaction = () => {
    let selectNumber = 0;
    return {
      update: vi.fn(() => update("claim")),
      select: vi.fn(() => {
        selectNumber += 1;
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                limit: vi.fn(() => ({
                  for: vi.fn(async () => {
                    if (selectNumber === 1) {
                      const next = queue[0];
                      return next
                        ? [
                            {
                              workspaceId: next.workspaceId,
                              mode: next.mode,
                              leaseToken: null,
                              leaseUntil: null,
                            },
                          ]
                        : [];
                    }
                    active = queue.shift() ?? null;
                    return active ? [active] : [];
                  }),
                })),
              })),
            })),
          })),
        };
      }),
    };
  };

  const processTransaction = () => {
    let selectNumber = 0;
    return {
      select: vi.fn(() => {
        selectNumber += 1;
        if (selectNumber > 1) return aggregateSelect();
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(() => ({
                for: vi.fn(async () => (active ? [{ id: active.id }] : [])),
              })),
            })),
          })),
        };
      }),
      insert: vi.fn(() => ({
        values: vi.fn((value: unknown) => {
          if (active?.id === poisonId) {
            needsFailure = true;
            throw new Error("poison");
          }
          inbox.push(value);
          return { onDuplicateKeyUpdate: vi.fn(async () => undefined) };
        }),
      })),
      update: vi.fn(() => update("process")),
    };
  };

  const failureTransaction = () => ({
    select: vi.fn(aggregateSelect),
    update: vi.fn(() => update("failure")),
  });
  const database = {
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      if (needsFailure) return callback(failureTransaction());
      if (active) return callback(processTransaction());
      return callback(claimTransaction());
    }),
  };
  return {
    database,
    inbox,
    completed,
    rescheduled,
    deadLetters,
    aggregateDeadCounts,
  };
}
