import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDatabaseOrThrowMock } = vi.hoisted(() => ({
  getDatabaseOrThrowMock: vi.fn(),
}));

vi.mock("../../db", () => ({
  getDatabaseOrThrow: getDatabaseOrThrowMock,
}));

import {
  assertBillingTenantLeaseOwnedInTransaction,
  disableBillingSchedulerTenant,
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

  it("contains known and reconciles ambiguous customerless credit Payments on disable", async () => {
    const knownIntentId = "11111111-1111-4111-8111-111111111111";
    const ambiguousIntentId = "22222222-2222-4222-8222-222222222222";
    const knownOperationId = "33333333-3333-4333-8333-333333333333";
    const ambiguousOperationId = "44444444-4444-4444-8444-444444444444";
    const paymentId = "tr_creditknown1";
    const creditIntent = (intentId: string, marker: string) => ({
      intentId,
      kind: "credit_purchase",
      planCode: "premium_images_8_medium_v1",
      expectedAmount: "4.99",
      currency: "EUR",
      interval: "oneoff",
      mollieDescription: "Leaderbot - 8 premium beeldcredits",
      molliePaymentId: null,
      billingProfileVersion: 0,
      authorizationEpoch: 2,
      messengerChannelConnectionId: 7,
      messengerBindingEpoch: 3,
      messengerPrivacyEpoch: 4,
      creditWalletId: `${marker.repeat(8)}-${marker.repeat(4)}-8${marker.repeat(3)}-8${marker.repeat(3)}-${marker.repeat(12)}`,
      creditFinancialSubjectRef: marker.repeat(64),
      creditCount: 8,
      creditMetadataHash: marker.repeat(64),
    });
    const knownIntent = creditIntent(knownIntentId, "a");
    const ambiguousIntent = creditIntent(ambiguousIntentId, "b");
    const schedulerRows = [
      "ai_finalization",
      "outbox",
      "profile_expiry",
      "reconciliation",
    ].map(kind => ({
      kind,
      enabled: true,
      executionEpoch: 2,
      operatorRequestId: null,
      operatorRequestFingerprint: null,
    }));
    const selectRows = [
      [{ commercialEnabled: true, authorizationEpoch: 2 }],
      [{ intentId: knownIntentId }, { intentId: ambiguousIntentId }],
      schedulerRows,
      [knownIntent, ambiguousIntent],
      [
        {
          operationId: knownOperationId,
          operationType: "create_payment",
          operationKey: knownIntentId,
          intentId: knownIntentId,
          state: "succeeded",
          providerResourceId: paymentId,
          providerCustomerId: null,
          requestFingerprint: knownIntent.creditMetadataHash,
          authorizationEpoch: 2,
          billingProfileVersion: 0,
          credentialGenerationId: "credential-v1",
        },
        {
          operationId: ambiguousOperationId,
          operationType: "create_payment",
          operationKey: ambiguousIntentId,
          intentId: ambiguousIntentId,
          state: "reconciliation_only",
          providerResourceId: null,
          providerCustomerId: null,
          requestFingerprint: ambiguousIntent.creditMetadataHash,
          authorizationEpoch: 2,
          billingProfileVersion: 0,
          credentialGenerationId: "credential-v1",
        },
      ],
      [{ workspaceId: 10, intentId: knownIntentId }],
      [],
    ];
    let selected = 0;
    const select = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          const rows = selectRows[selected++] ?? [];
          const locked = vi.fn(async () => rows);
          return {
            for: locked,
            limit: vi.fn(() => ({ for: locked })),
            orderBy: vi.fn(() => ({ for: locked })),
          };
        }),
      })),
    }));
    const updates: Array<{ table: unknown; value: Record<string, unknown> }> =
      [];
    let updateIndex = 0;
    const updateAffectedRows = [1, 4, 2, 1, 1];
    const inserts: Array<Record<string, unknown>> = [];
    const tx = {
      select,
      update: vi.fn((table: unknown) => ({
        set: vi.fn((value: Record<string, unknown>) => {
          updates.push({ table, value });
          return {
            where: vi.fn(async () => [
              { affectedRows: updateAffectedRows[updateIndex++] ?? 1 },
            ]),
          };
        }),
      })),
      insert: vi.fn(() => ({
        values: vi.fn((value: Record<string, unknown>) => {
          inserts.push(value);
          return {
            onDuplicateKeyUpdate: vi.fn(async () => undefined),
          };
        }),
      })),
    };
    getDatabaseOrThrowMock.mockResolvedValue({
      transaction: vi.fn(async callback => callback(tx)),
    });

    await expect(
      disableBillingSchedulerTenant({
        workspaceId: 10,
        mode: "test",
        actorUserId: 7,
        requestId: "55555555-5555-4555-8555-555555555555",
        expectedExecutionEpoch: 2,
        reason: "disable customerless credit checkout",
      })
    ).resolves.toEqual({ executionEpoch: 3 });

    const creditCancels = inserts.filter(
      value =>
        value.eventType === "cancel_payment" &&
        (value.payload as Record<string, unknown>)?.creditPurpose ===
          "premium_image_credits"
    );
    expect(creditCancels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            providerOperationId: knownOperationId,
            targetCustomerId: null,
            targetPaymentId: paymentId,
            creditWalletId: knownIntent.creditWalletId,
            creditMetadataHash: knownIntent.creditMetadataHash,
          }),
        }),
        expect.objectContaining({
          payload: expect.objectContaining({
            providerOperationId: ambiguousOperationId,
            targetCustomerId: null,
            targetPaymentId: null,
            creditWalletId: ambiguousIntent.creditWalletId,
            creditMetadataHash: ambiguousIntent.creditMetadataHash,
          }),
        }),
      ])
    );
    expect(
      updates.filter(item =>
        Object.prototype.hasOwnProperty.call(item.value, "resolutionDueAt")
      )
    ).toHaveLength(1);
  });

  it.each([
    ["owned", [{ workspaceId: 10 }]],
    ["lost", []],
  ] as const)(
    "atomically treats a transaction lease as %s",
    async (state, rows) => {
      const forUpdate = vi.fn(async () => rows);
      const query = {
        limit: vi.fn(() => ({ for: forUpdate })),
      };
      const tx = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({ where: vi.fn(() => query) })),
        })),
      } as never;
      const assertion = assertBillingTenantLeaseOwnedInTransaction(tx, {
        workspaceId: 10,
        mode: "test",
        kind: "reconciliation",
        leaseToken: "lease-token",
        executionEpoch: 2,
      });
      if (state === "owned") {
        await expect(assertion).resolves.toBeUndefined();
      } else {
        await expect(assertion).rejects.toThrow(
          "billing scheduler lease ownership was lost"
        );
      }
      expect(forUpdate).toHaveBeenCalledOnce();
    }
  );
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
