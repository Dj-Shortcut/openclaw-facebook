import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BillingOutboxItem,
  BillingSubscription,
} from "../../../drizzle/schema";
import type { MollieClient, MollieSubscription } from "./mollieClient";

const databaseMock = vi.hoisted(() => vi.fn());

vi.mock("../../db", () => ({ getDatabaseOrThrow: databaseMock }));

import {
  cancelContainedMollieSubscription,
  claimBillingOutboxItem,
  collectingSubscriptionsForIntent,
  mandateMatchesCurrentSubscription,
} from "./outboxWorker";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("billing outbox containment safeguards", () => {
  it("preserves a unique provisioning remote when the valid mandate was not stored yet", () => {
    expect(mandateMatchesCurrentSubscription("mdt_valid123", null, true)).toBe(
      true
    );
    expect(mandateMatchesCurrentSubscription(undefined, null, true)).toBe(
      false
    );
  });

  it("requires the exact stored mandate after provisioning", () => {
    expect(
      mandateMatchesCurrentSubscription("mdt_valid123", "mdt_valid123", false)
    ).toBe(true);
    expect(
      mandateMatchesCurrentSubscription("mdt_other123", "mdt_valid123", false)
    ).toBe(false);
    expect(mandateMatchesCurrentSubscription("mdt_valid123", null, false)).toBe(
      false
    );
  });

  it("counts only active and pending subscriptions for an intent", () => {
    const remotes = [
      remoteSubscription(),
      remoteSubscription({ id: "sub_pending123", status: "pending" }),
      remoteSubscription({ id: "sub_canceled123", status: "canceled" }),
      remoteSubscription({ id: "sub_completed123", status: "completed" }),
      remoteSubscription({ id: "sub_suspended123", status: "suspended" }),
    ];

    expect(
      collectingSubscriptionsForIntent(
        remotes,
        "550e8400-e29b-41d4-a716-446655440000"
      ).map(remote => remote.id)
    ).toEqual(["sub_subscription123", "sub_pending123"]);
  });

  it("keeps containment provider calls outside every transaction", async () => {
    const { database, isInTransaction } = transactionalDatabase([[], [], []]);
    databaseMock.mockResolvedValue(database);
    const remote = remoteSubscription();
    const getSubscription = vi.fn(async () => {
      expect(isInTransaction()).toBe(false);
      return remote;
    });
    const cancelSubscription = vi.fn(async () => {
      expect(isInTransaction()).toBe(false);
    });

    await expect(
      cancelContainedMollieSubscription(
        containmentJob(),
        { customerId: "cst_customer123", subscriptionId: remote.id },
        { getSubscription, cancelSubscription } as unknown as MollieClient
      )
    ).resolves.toBe("canceled");

    expect(getSubscription).toHaveBeenCalledOnce();
    expect(cancelSubscription).toHaveBeenCalledOnce();
    expect(database.transaction).toHaveBeenCalledTimes(3);
  });

  it("lists provisioning remotes outside the transaction and preserves the unique current one", async () => {
    const current = provisioningSubscription();
    const { database, isInTransaction } = transactionalDatabase([
      [current],
      [current],
    ]);
    databaseMock.mockResolvedValue(database);
    const remote = remoteSubscription();
    const getSubscription = vi.fn(async () => {
      expect(isInTransaction()).toBe(false);
      return remote;
    });
    const listCustomerSubscriptions = vi.fn(async () => {
      expect(isInTransaction()).toBe(false);
      return [
        remote,
        remoteSubscription({ id: "sub_canceled123", status: "canceled" }),
        remoteSubscription({ id: "sub_completed123", status: "completed" }),
        remoteSubscription({ id: "sub_suspended123", status: "suspended" }),
      ];
    });
    const cancelSubscription = vi.fn();

    await expect(
      cancelContainedMollieSubscription(
        containmentJob(),
        { customerId: "cst_customer123", subscriptionId: remote.id },
        {
          getSubscription,
          listCustomerSubscriptions,
          cancelSubscription,
        } as unknown as MollieClient
      )
    ).resolves.toBe("skipped_current");

    expect(listCustomerSubscriptions).toHaveBeenCalledOnce();
    expect(cancelSubscription).not.toHaveBeenCalled();
    expect(database.transaction).toHaveBeenCalledTimes(2);
  });

  it.each(["active", "pending"] as const)(
    "preserves an exact %s remote when retrying after a failed DELETE",
    async status => {
      const current = manualReviewSubscription();
      const { database, isInTransaction } = transactionalDatabase([
        [current],
        [current],
      ]);
      databaseMock.mockResolvedValue(database);
      const remote = remoteSubscription({ status });
      const getSubscription = vi.fn(async () => {
        expect(isInTransaction()).toBe(false);
        return remote;
      });
      const cancelSubscription = vi.fn();

      await expect(
        cancelContainedMollieSubscription(
          containmentJob(),
          { customerId: "cst_customer123", subscriptionId: remote.id },
          { getSubscription, cancelSubscription } as unknown as MollieClient
        )
      ).resolves.toBe("skipped_current");

      expect(cancelSubscription).not.toHaveBeenCalled();
      expect(database.transaction).toHaveBeenCalledTimes(2);
    }
  );

  it("still cancels a genuinely mismatched manual-review remote", async () => {
    const current = manualReviewSubscription();
    const { database } = transactionalDatabase([
      [current],
      [current],
      [current],
    ]);
    databaseMock.mockResolvedValue(database);
    const remote = remoteSubscription({
      amount: { currency: "EUR", value: "30.00" },
    });
    const cancelSubscription = vi.fn().mockResolvedValue(undefined);

    await expect(
      cancelContainedMollieSubscription(
        containmentJob(),
        { customerId: "cst_customer123", subscriptionId: remote.id },
        {
          getSubscription: vi.fn().mockResolvedValue(remote),
          cancelSubscription,
        } as unknown as MollieClient
      )
    ).resolves.toBe("canceled");

    expect(cancelSubscription).toHaveBeenCalledOnce();
  });

  it("does not claim a second workspace job while another lease is processing", async () => {
    const pendingSelect = vi.fn();
    const tx = {
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(() => ({
                for: vi.fn().mockResolvedValue([{ id: 1 }]),
              })),
            })),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([{ id: 99 }]),
            })),
          })),
        })
        .mockImplementation(pendingSelect),
      update: vi.fn(),
    };
    databaseMock.mockResolvedValue({
      transaction: vi.fn(async callback => callback(tx)),
    });

    await expect(claimBillingOutboxItem("test", 1)).resolves.toBeNull();
    expect(tx.select).toHaveBeenCalledTimes(2);
    expect(tx.update).not.toHaveBeenCalled();
    expect(pendingSelect).not.toHaveBeenCalled();
  });
});

function transactionalDatabase(rowsByTransaction: BillingSubscription[][]) {
  let inTransaction = false;
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const tx = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => ({
            for: vi.fn(async () => rowsByTransaction.shift() ?? []),
          })),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: updateWhere })),
    })),
  };
  const database = {
    transaction: vi.fn(async callback => {
      expect(inTransaction).toBe(false);
      inTransaction = true;
      try {
        return await callback(tx);
      } finally {
        inTransaction = false;
      }
    }),
  };
  return { database, isInTransaction: () => inTransaction };
}

function containmentJob(): BillingOutboxItem {
  const sourceIntentId = "550e8400-e29b-41d4-a716-446655440000";
  return {
    workspaceId: 1,
    mode: "test",
    payload: {
      reason: "remote_subscription_mismatch",
      expectedSourceIntentId: sourceIntentId,
      targetCustomerId: "cst_customer123",
      targetSubscriptionId: "sub_subscription123",
    },
  } as BillingOutboxItem;
}

function provisioningSubscription(): BillingSubscription {
  return {
    workspaceId: 1,
    mode: "test",
    status: "provisioning",
    mollieCustomerId: "cst_customer123",
    mollieSubscriptionId: null,
    mollieMandateId: null,
    sourceIntentId: "550e8400-e29b-41d4-a716-446655440000",
    paidThrough: new Date("2026-09-01T00:00:00.000Z"),
    recurringAmount: "29.00",
    currency: "EUR",
    interval: "1 month",
  } as BillingSubscription;
}

function manualReviewSubscription(): BillingSubscription {
  return {
    ...provisioningSubscription(),
    status: "manual_review",
    mollieSubscriptionId: "sub_subscription123",
    mollieMandateId: "mdt_mandate123",
  };
}

function remoteSubscription(
  overrides: Partial<MollieSubscription> = {}
): MollieSubscription {
  return {
    resource: "subscription",
    id: "sub_subscription123",
    mode: "test",
    status: "active",
    amount: { currency: "EUR", value: "29.00" },
    interval: "1 month",
    startDate: "2026-09-01",
    mandateId: "mdt_mandate123",
    metadata: {
      billingIntentId: "550e8400-e29b-41d4-a716-446655440000",
    },
    ...overrides,
  };
}
