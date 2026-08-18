import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { databaseMock } = vi.hoisted(() => ({ databaseMock: vi.fn() }));
vi.mock("../../db", () => ({
  getDatabaseOrThrow: databaseMock,
  beginBillingHandoffDelivery: vi.fn(),
  advanceBillingHandoffDeliveryFence: vi.fn(),
}));

import { reserveSubscriptionProviderOperation } from "./outboxWorker";

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
});

const subscription = {
  sourceIntentId: "11111111-1111-4111-8111-111111111111",
  recurringAmount: "19.00",
  currency: "EUR",
  interval: "1 month",
  paidThrough: new Date("2026-09-18T00:00:00.000Z"),
  idempotencyKey: "subscription-idempotency-key",
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
    credentialGenerationId: "test-generation",
    idempotencyKeyHash: createHash("sha256")
      .update(subscription.idempotencyKey)
      .digest("hex"),
  };
}

function databaseHarness(existing: ReturnType<typeof operationFixture>) {
  const updateWhere = vi.fn(async () => [{ affectedRows: 1 }]);
  const insertValues = vi.fn(async () => undefined);
  const tx = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => ({ for: vi.fn(async () => [existing]) })),
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
