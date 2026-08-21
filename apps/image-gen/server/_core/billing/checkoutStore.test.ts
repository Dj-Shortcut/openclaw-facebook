import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseMock = vi.hoisted(() => vi.fn());

vi.mock("../../db", () => ({ getDatabaseOrThrow: databaseMock }));

import {
  attachMollieCustomer,
  blocksSubscriptionStart,
  markIntentPaymentMismatch,
} from "./checkoutStore";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("checkout subscription-start policy", () => {
  const now = new Date("2026-08-01T00:00:00.000Z");

  it("blocks immediate resubscription while canceled access is still paid", () => {
    expect(
      blocksSubscriptionStart(
        {
          status: "canceled",
          paidThrough: new Date("2026-08-20T00:00:00.000Z"),
        },
        now
      )
    ).toBe(true);
  });

  it("allows a new subscription after canceled paid access expires", () => {
    expect(
      blocksSubscriptionStart(
        {
          status: "canceled",
          paidThrough: new Date("2026-07-31T23:59:59.000Z"),
        },
        now
      )
    ).toBe(false);
  });

  it("does not let a new checkout bypass manual review", () => {
    expect(
      blocksSubscriptionStart(
        { status: "manual_review", paidThrough: null },
        now
      )
    ).toBe(true);
  });
});

describe("Mollie customer attachment", () => {
  it("durably reviews a persisted customer id that differs from the provider result", async () => {
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const onDuplicateKeyUpdate = vi.fn().mockResolvedValue(undefined);
    const insertValues = vi.fn(() => ({ onDuplicateKeyUpdate }));
    const forUpdate = vi
      .fn()
      .mockResolvedValue([{ mollieCustomerId: "cst_already_attached" }]);
    const tx = {
      update: vi.fn(() => ({ set: updateSet })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({ for: forUpdate })),
          })),
        })),
      })),
      insert: vi.fn(() => ({ values: insertValues })),
    };
    databaseMock.mockResolvedValue({
      transaction: vi.fn((callback: (transaction: typeof tx) => unknown) =>
        callback(tx)
      ),
    });

    await expect(
      attachMollieCustomer(1, "test", "cst_newly_created")
    ).rejects.toThrow("Mollie customer conflict");
    expect(updateSet).toHaveBeenNthCalledWith(2, { status: "manual_review" });
    expect(insertValues).toHaveBeenCalledWith({
      workspaceId: 1,
      mode: "test",
      eventType: "manual_review",
      deduplicationKey: "customer_conflict:cst_newly_created",
      payload: {
        reason: "billing_customer_id_conflict",
        providerCustomerId: "cst_newly_created",
      },
      status: "pending",
    });
  });
});

describe("checkout provider mismatch persistence", () => {
  it("moves the tenant intent out of creating_payment and queues manual review", async () => {
    const updateWhere = vi.fn().mockResolvedValue({ affectedRows: 1 });
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const onDuplicateKeyUpdate = vi.fn().mockResolvedValue(undefined);
    const insertValues = vi.fn(() => ({ onDuplicateKeyUpdate }));
    const forUpdate = vi.fn().mockResolvedValue([{}]);
    const tx = {
      update: vi.fn(() => ({ set: updateSet })),
      insert: vi.fn(() => ({ values: insertValues })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({ for: forUpdate })),
          })),
        })),
      })),
    };
    databaseMock.mockResolvedValue({
      transaction: vi.fn((callback: (transaction: typeof tx) => unknown) =>
        callback(tx)
      ),
    });

    await markIntentPaymentMismatch({
      intentId: "550e8400-e29b-41d4-a716-446655440000",
      workspaceId: 1,
      mode: "test",
      molliePaymentId: "tr_payment123",
      operationId: "operation-1",
      authorizationEpoch: 2,
      targetCustomerId: "cst_customer123",
    });

    expect(updateSet).toHaveBeenCalledWith({
      state: "contained",
      providerResourceId: "tr_payment123",
      resolutionDueAt: expect.any(Date),
    });
    expect(updateSet).toHaveBeenCalledWith({
      status: "mismatch",
      molliePaymentId: "tr_payment123",
    });
    expect(insertValues).toHaveBeenCalledWith({
      workspaceId: 1,
      mode: "test",
      eventType: "manual_review",
      deduplicationKey:
        "checkout_response_mismatch:550e8400-e29b-41d4-a716-446655440000",
      payload: {
        reason: "checkout_provider_response_mismatch",
        intentId: "550e8400-e29b-41d4-a716-446655440000",
        paymentId: "tr_payment123",
      },
      status: "pending",
    });
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "cancel_payment",
        payload: expect.objectContaining({
          reason: "checkout_provider_response_mismatch",
          intentId: "550e8400-e29b-41d4-a716-446655440000",
          targetCustomerId: "cst_customer123",
          targetPaymentId: "tr_payment123",
          providerOperationId: "operation-1",
          revokedAuthorizationEpoch: 2,
        }),
      })
    );
  });

  it("leaves cancellation routing to the concurrent containment winner", async () => {
    const updateWhere = vi.fn().mockResolvedValue({ affectedRows: 0 });
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const onDuplicateKeyUpdate = vi.fn().mockResolvedValue(undefined);
    const insertValues = vi.fn(() => ({ onDuplicateKeyUpdate }));
    const forUpdate = vi.fn().mockResolvedValue([{}]);
    const tx = {
      update: vi.fn(() => ({ set: updateSet })),
      insert: vi.fn(() => ({ values: insertValues })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({ for: forUpdate })),
          })),
        })),
      })),
    };
    databaseMock.mockResolvedValue({
      transaction: vi.fn((callback: (transaction: typeof tx) => unknown) =>
        callback(tx)
      ),
    });

    await markIntentPaymentMismatch({
      intentId: "550e8400-e29b-41d4-a716-446655440000",
      workspaceId: 1,
      mode: "test",
      molliePaymentId: "tr_payment123",
      operationId: "operation-1",
      authorizationEpoch: 2,
      targetCustomerId: "cst_customer123",
    });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "manual_review" })
    );
    expect(insertValues.mock.calls.map(([value]) => value)).not.toContainEqual(
      expect.objectContaining({ eventType: "cancel_payment" })
    );
  });
});
