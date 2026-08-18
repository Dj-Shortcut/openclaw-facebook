import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDatabaseOrThrowMock } = vi.hoisted(() => ({
  getDatabaseOrThrowMock: vi.fn(),
}));

vi.mock("../../db", () => ({
  getDatabaseOrThrow: getDatabaseOrThrowMock,
}));

import {
  enableBillingSchedulerTenant,
  registerBillingSchedulerTenant,
  releaseBillingTenantLease,
  wakeBillingSchedulerTenant,
} from "./billingSchedulerStore";

describe("billing scheduler lifecycle boundaries", () => {
  beforeEach(() => {
    getDatabaseOrThrowMock.mockReset();
    process.env.MOLLIE_BILLING_SCHEDULER_MODE = "multi_tenant";
    delete process.env.MOLLIE_BILLING_WORKER_WORKSPACE_ID;
  });

  it("fails closed before DB access when rollout mode is not explicit", async () => {
    delete process.env.MOLLIE_BILLING_SCHEDULER_MODE;
    const { claimNextBillingTenant } = await import("./billingSchedulerStore");
    await expect(claimNextBillingTenant("test")).rejects.toThrow(
      "MOLLIE_BILLING_SCHEDULER_MODE"
    );
    expect(getDatabaseOrThrowMock).not.toHaveBeenCalled();
  });

  it("registration never re-enables an operator-disabled existing row", async () => {
    const duplicateSet = vi.fn(async () => undefined);
    const values = vi.fn(() => ({ onDuplicateKeyUpdate: duplicateSet }));
    const tx = { insert: vi.fn(() => ({ values })) };
    getDatabaseOrThrowMock.mockResolvedValue({
      transaction: vi.fn(async callback => callback(tx)),
    });

    await registerBillingSchedulerTenant(10, "test", new Date("2030-01-01"));

    expect(duplicateSet).toHaveBeenCalledTimes(5);
    const insertedRows = values.mock.calls.slice(1).map(call => call[0]);
    expect(insertedRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "outbox", enabled: true }),
        expect.objectContaining({ kind: "reconciliation", enabled: false }),
        expect.objectContaining({ kind: "profile_expiry", enabled: false }),
        expect.objectContaining({ kind: "ai_finalization", enabled: false }),
      ])
    );
    const update = duplicateSet.mock.calls[1]![0] as {
      set: Record<string, unknown>;
    };
    expect(update.set).not.toHaveProperty("enabled");
    expect(update.set).not.toHaveProperty("mode");
  });

  it("checkout wake-up fails closed for missing or disabled registry rows", async () => {
    getDatabaseOrThrowMock.mockResolvedValue(updateDatabaseResult(0));
    await expect(wakeBillingSchedulerTenant(10, "test")).resolves.toBe(false);

    getDatabaseOrThrowMock.mockResolvedValue(updateDatabaseResult(1));
    await expect(wakeBillingSchedulerTenant(10, "test")).resolves.toBe(true);
  });

  it("enables all four lanes only through the fenced audited operator flow", async () => {
    const rows = [
      "ai_finalization",
      "outbox",
      "profile_expiry",
      "reconciliation",
    ].map(kind => ({
      id: kind,
      workspaceId: 10,
      mode: "test",
      kind,
      enabled: false,
      executionEpoch: 1,
      operatorRequestId: null,
      operatorRequestFingerprint: null,
    }));
    const auditValues = vi.fn(async () => undefined);
    const controlWhere = vi.fn(async () => [{ affectedRows: 1 }]);
    const laneWhere = vi.fn(async () => [{ affectedRows: 4 }]);
    const tx = {
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(() => ({
                for: vi.fn(async () => [
                  { commercialEnabled: false, authorizationEpoch: 1 },
                ]),
              })),
            })),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({ for: vi.fn(async () => rows) })),
            })),
          })),
        }),
      update: vi
        .fn()
        .mockReturnValueOnce({ set: vi.fn(() => ({ where: controlWhere })) })
        .mockReturnValueOnce({ set: vi.fn(() => ({ where: laneWhere })) }),
      insert: vi.fn(() => ({ values: auditValues })),
    };
    getDatabaseOrThrowMock.mockResolvedValue({
      transaction: vi.fn(async callback => callback(tx)),
    });

    await expect(
      enableBillingSchedulerTenant({
        workspaceId: 10,
        mode: "test",
        actorUserId: 7,
        requestId: "77777777-7777-4777-8777-777777777777",
        expectedExecutionEpoch: 1,
        reason: "approved pilot rollout",
      })
    ).resolves.toEqual({ executionEpoch: 2 });
    expect(controlWhere).toHaveBeenCalledOnce();
    expect(laneWhere).toHaveBeenCalledOnce();
    expect(auditValues).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 10,
        userId: 7,
        event: "billing_scheduler_enabled",
      })
    );
  });

  it("detects stale-owner lease release instead of reporting scheduler success", async () => {
    getDatabaseOrThrowMock.mockResolvedValue(updateDatabaseResult(0));
    await expect(
      releaseBillingTenantLease({
        workspaceId: 10,
        mode: "test",
        kind: "outbox",
        leaseToken: "stale-token",
        nextAt: new Date("2030-01-02"),
        failed: false,
      })
    ).resolves.toBe(false);
  });
});

function updateDatabaseResult(affectedRows: number) {
  return {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => [{ affectedRows }]),
      })),
    })),
  };
}
