import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { databaseMock } = vi.hoisted(() => ({ databaseMock: vi.fn() }));
vi.mock("../../db", () => ({
  getDatabaseOrThrow: databaseMock,
  beginBillingHandoffDelivery: vi.fn(),
  advanceBillingHandoffDeliveryFence: vi.fn(),
}));

import {
  finalizeSubscriptionProviderOperation,
  reserveSubscriptionProviderOperation,
} from "./outboxWorker";

describe("subscription provider operation recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MOLLIE_CREDENTIAL_GENERATION_ID = "test-generation";
  });

  it.each(["reserved", "known_failed"] as const)(
    "resumes a provably pre-transport %s operation",
    async state => {
      const existing = operationFixture(state, null);
      const harness = databaseHarness(existing);
      databaseMock.mockResolvedValue(harness.database);

      await expect(
        reserveSubscriptionProviderOperation(providerInput)
      ).resolves.toEqual({
        operationId: existing.operationId,
        leaseToken: expect.any(String),
        authorizationEpoch: 2,
        workspaceId: 42,
        mode: "test",
        intentId: subscription.sourceIntentId,
        customerId: subscription.mollieCustomerId,
      });
      expect(harness.updateWhere).toHaveBeenCalledOnce();
      expect(harness.insertValues).not.toHaveBeenCalled();
    }
  );

  it.each(["transport_started", "ambiguous"] as const)(
    "never re-posts an existing %s operation",
    async state => {
      const harness = databaseHarness(operationFixture(state, new Date()));
      databaseMock.mockResolvedValue(harness.database);

      await expect(
        reserveSubscriptionProviderOperation(providerInput)
      ).resolves.toBeNull();
      expect(harness.updateWhere).not.toHaveBeenCalled();
      expect(harness.insertValues).not.toHaveBeenCalled();
    }
  );

  it("fails closed when the immutable request fingerprint changed", async () => {
    const existing = operationFixture("known_failed", null);
    existing.requestFingerprint = "0".repeat(64);
    const harness = databaseHarness(existing);
    databaseMock.mockResolvedValue(harness.database);

    await expect(
      reserveSubscriptionProviderOperation(providerInput)
    ).resolves.toBeNull();
    expect(harness.updateWhere).not.toHaveBeenCalled();
  });

  it("atomically records and contains a known subscription after disable", async () => {
    const harness = finalizationHarness(false, 1);
    databaseMock.mockResolvedValue(harness.database);

    await expect(
      finalizeSubscriptionProviderOperation(
        operationCapability,
        "succeeded",
        "sub_subscription123",
        {
          job: providerInput.job as never,
          subscription: subscription as never,
        }
      )
    ).resolves.toEqual({
      recorded: true,
      authorized: false,
      revokedAuthorizationEpoch: 2,
    });
    expect(harness.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "cancel_subscription",
        payload: expect.objectContaining({
          reason: "billing_execution_disabled",
          expectedSourceIntentId: subscription.sourceIntentId,
          targetSubscriptionId: "sub_subscription123",
          revokedAuthorizationEpoch: 2,
        }),
      })
    );
  });

  it("never enqueues cancellation when a stale worker loses the outcome fence", async () => {
    const harness = finalizationHarness(false, 0);
    databaseMock.mockResolvedValue(harness.database);

    await expect(
      finalizeSubscriptionProviderOperation(
        operationCapability,
        "succeeded",
        "sub_subscription123",
        {
          job: providerInput.job as never,
          subscription: subscription as never,
        }
      )
    ).resolves.toEqual({
      recorded: false,
      authorized: false,
      revokedAuthorizationEpoch: null,
    });
    expect(harness.insertValues).not.toHaveBeenCalled();
  });

  it("atomically schedules bounded safety reconciliation for an ambiguous disabled call", async () => {
    const harness = finalizationHarness(false, 1);
    databaseMock.mockResolvedValue(harness.database);

    await expect(
      finalizeSubscriptionProviderOperation(
        operationCapability,
        "ambiguous",
        undefined,
        {
          job: providerInput.job as never,
          subscription: subscription as never,
        }
      )
    ).resolves.toMatchObject({ recorded: true, authorized: false });
    expect(harness.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "cancel_subscription",
        payload: expect.objectContaining({
          providerOperationId: operationCapability.operationId,
          targetCustomerId: subscription.mollieCustomerId,
          targetSubscriptionId: null,
        }),
      })
    );
    expect(harness.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "manual_review",
        payload: {
          reason: "subscription_provider_ambiguous_after_disable",
          intentId: subscription.sourceIntentId,
        },
      })
    );
  });
});

const subscription = {
  workspaceId: 42,
  mode: "test" as const,
  sourceIntentId: "11111111-1111-4111-8111-111111111111",
  recurringAmount: "19.00",
  currency: "EUR",
  interval: "1 month",
  paidThrough: new Date("2026-09-18T00:00:00.000Z"),
  idempotencyKey: "subscription-idempotency-key",
  mollieCustomerId: "cst_customer123",
};
const operationCapability = {
  operationId: "22222222-2222-4222-8222-222222222222",
  leaseToken: "lease-token",
  authorizationEpoch: 2,
  workspaceId: 42,
  mode: "test" as const,
  intentId: subscription.sourceIntentId,
  customerId: subscription.mollieCustomerId,
};
const providerInput = {
  job: { workspaceId: 42, mode: "test" as const },
  subscription,
  billingProfileVersion: 7,
} as Parameters<typeof reserveSubscriptionProviderOperation>[0];

function operationFixture(
  state: "reserved" | "known_failed" | "transport_started" | "ambiguous",
  firstStartedAt: Date | null
) {
  return {
    operationId: "22222222-2222-4222-8222-222222222222",
    state,
    firstStartedAt,
    leaseUntil: new Date("2000-01-01T00:00:00.000Z"),
    requestFingerprint: createHash("sha256")
      .update(
        JSON.stringify({
          workspaceId: 42,
          mode: "test",
          sourceIntentId: subscription.sourceIntentId,
          amount: subscription.recurringAmount,
          currency: subscription.currency,
          interval: subscription.interval,
          paidThrough: subscription.paidThrough.toISOString(),
        })
      )
      .digest("hex"),
    billingProfileVersion: 7,
    authorizationEpoch: 2,
    credentialGenerationId: "test-generation",
    idempotencyKeyHash: createHash("sha256")
      .update(subscription.idempotencyKey)
      .digest("hex"),
  };
}

function databaseHarness(existing: ReturnType<typeof operationFixture>) {
  const updateWhere = vi.fn(async () => [{ affectedRows: 1 }]);
  const insertValues = vi.fn(async () => undefined);
  const selected = [
    [{ commercialEnabled: true, authorizationEpoch: 2 }],
    [existing],
  ];
  let selectIndex = 0;
  const tx = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => ({
            for: vi.fn(async () => selected[selectIndex++] ?? []),
          })),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: updateWhere })),
    })),
    insert: vi.fn(() => ({ values: insertValues })),
  };
  return {
    database: { transaction: vi.fn(async callback => callback(tx)) },
    updateWhere,
    insertValues,
  };
}

function finalizationHarness(commercialEnabled: boolean, affectedRows: number) {
  const insertValues = vi.fn(() => ({
    onDuplicateKeyUpdate: vi.fn(async () => undefined),
  }));
  const tx = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => ({
            for: vi.fn(async () => [
              {
                commercialEnabled,
                authorizationEpoch: commercialEnabled ? 2 : 3,
              },
            ]),
          })),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => [{ affectedRows }]),
      })),
    })),
    insert: vi.fn(() => ({ values: insertValues })),
  };
  return {
    database: { transaction: vi.fn(async callback => callback(tx)) },
    insertValues,
  };
}
