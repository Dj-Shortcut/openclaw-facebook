import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDatabaseOrThrowMock } = vi.hoisted(() => ({
  getDatabaseOrThrowMock: vi.fn(),
}));

vi.mock("../../db", () => ({
  getDatabaseOrThrow: getDatabaseOrThrowMock,
}));

import { assertBillingNotificationRuntimeReadiness } from "./billingReadiness";

describe("billing notification runtime readiness", () => {
  beforeEach(() => {
    getDatabaseOrThrowMock.mockReset();
    process.env.BILLING_SCHEDULER_PROCESS_ID = "notification-test-process";
    delete process.env.FLY_MACHINE_ID;
  });

  it("accepts a fresh idle notification plane before its first tenant receipt", async () => {
    getDatabaseOrThrowMock.mockResolvedValue(
      readinessDatabase({ tenantCount: 0, receiverBacklog: 0 })
    );

    await expect(
      assertBillingNotificationRuntimeReadiness("test")
    ).resolves.toBeUndefined();
  });

  it("rejects pending receiver work without its tenant scheduler row", async () => {
    getDatabaseOrThrowMock.mockResolvedValue(
      readinessDatabase({ tenantCount: 0, receiverBacklog: 1 })
    );

    await expect(
      assertBillingNotificationRuntimeReadiness("test")
    ).rejects.toThrow("scheduler is unhealthy");
  });

  it("rejects a receiver dead letter even when the cached counter drifted", async () => {
    getDatabaseOrThrowMock.mockResolvedValue(
      readinessDatabase({
        tenantCount: 1,
        receiverBacklog: 0,
        receiverDeadLetters: 1,
      })
    );

    await expect(
      assertBillingNotificationRuntimeReadiness("test")
    ).rejects.toThrow("scheduler is unhealthy");
  });
});

function readinessDatabase(input: {
  tenantCount: number;
  receiverBacklog: number;
  receiverDeadLetters?: number;
}) {
  const results = [
    [{ processId: "notification-test-process" }],
    [
      {
        tenantCount: input.tenantCount,
        deadLetters: 0,
        invalidCounters: 0,
        overdueBacklogs: 0,
      },
    ],
    [{ count: input.receiverBacklog }],
    [{ count: input.receiverDeadLetters ?? 0 }],
  ];
  let query = 0;
  return {
    select: vi.fn(() => {
      const result = results[query++]!;
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => result),
            then: (
              resolve: (value: typeof result) => unknown,
              reject?: (reason: unknown) => unknown
            ) => Promise.resolve(result).then(resolve, reject),
          })),
        })),
      };
    }),
  };
}
