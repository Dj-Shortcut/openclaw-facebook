import { describe, expect, it } from "vitest";
import {
  hasRemoteCollectionStateMismatch,
  needsReconciliation,
  selectPaymentsForReconciliation,
  shouldPreserveRemoteSubscription,
  sortPaymentsOldestFirst,
} from "./reconciliation";

describe("billing reconciliation collection-risk detection", () => {
  it.each(["canceled", "completed", "suspended"] as const)(
    "flags local %s while Mollie remains active",
    localStatus => {
      expect(hasRemoteCollectionStateMismatch(localStatus, "active")).toBe(
        true
      );
    }
  );

  it("flags a stopped local subscription while Mollie remains pending", () => {
    expect(hasRemoteCollectionStateMismatch("canceled", "pending")).toBe(true);
  });

  it("does not flag expected active or non-collecting remote states", () => {
    expect(hasRemoteCollectionStateMismatch("active", "active")).toBe(false);
    expect(hasRemoteCollectionStateMismatch("canceled", "canceled")).toBe(
      false
    );
    expect(hasRemoteCollectionStateMismatch("manual_review", "active")).toBe(
      false
    );
    expect(hasRemoteCollectionStateMismatch("manual_review", "suspended")).toBe(
      false
    );
  });

  it("replays missed payments from oldest to newest", () => {
    const newest = { id: "tr_new", createdAt: "2026-09-01T00:00:00.000Z" };
    const oldest = { id: "tr_old", createdAt: "2026-08-01T00:00:00.000Z" };

    expect(sortPaymentsOldestFirst([newest, oldest])).toEqual([oldest, newest]);
  });

  it("preserves a remote that became the current valid subscription", () => {
    expect(
      shouldPreserveRemoteSubscription(
        {
          status: "active",
          sourceIntentId: "00000000-0000-4000-8000-000000000001",
        },
        {
          status: "active",
          metadata: {
            billingIntentId: "00000000-0000-4000-8000-000000000001",
          },
        },
        true
      )
    ).toBe(true);
    expect(
      shouldPreserveRemoteSubscription(
        {
          status: "provisioning",
          sourceIntentId: "00000000-0000-4000-8000-000000000001",
        },
        {
          status: "pending",
          metadata: {
            billingIntentId: "00000000-0000-4000-8000-000000000001",
          },
        },
        false
      )
    ).toBe(true);
    expect(
      shouldPreserveRemoteSubscription(
        { status: "canceled", sourceIntentId: "intent-old" },
        { status: "active", metadata: { billingIntentId: "intent-old" } },
        true
      )
    ).toBe(false);
  });

  it("preserves a matching collecting subscription during review-only state", () => {
    expect(
      shouldPreserveRemoteSubscription(
        { status: "manual_review", sourceIntentId: "intent-review" },
        {
          status: "active",
          metadata: {
            billingIntentId: "00000000-0000-4000-8000-000000000001",
          },
        },
        true
      )
    ).toBe(true);
  });

  it("always reconciles mutable, refunded, recent, or malformed listings", () => {
    const now = new Date("2026-08-01T12:00:00.000Z");

    expect(
      needsReconciliation(
        { status: "pending", createdAt: "2020-01-01T00:00:00.000Z" },
        now
      )
    ).toBe(true);
    expect(
      needsReconciliation(
        {
          status: "paid",
          amountRefunded: { currency: "EUR", value: "1.00" },
          createdAt: "2020-01-01T00:00:00.000Z",
        },
        now
      )
    ).toBe(true);
    expect(
      needsReconciliation(
        { status: "paid", createdAt: "2026-07-01T00:00:00.000Z" },
        now
      )
    ).toBe(true);
    expect(
      needsReconciliation({ status: "paid", createdAt: "not-a-date" }, now)
    ).toBe(true);
    expect(
      needsReconciliation(
        { status: "paid", createdAt: "2020-01-01T00:00:00.000Z" },
        now
      )
    ).toBe(false);
  });

  it("bounds old settled fetches while rotating recovery coverage", () => {
    const payments = Array.from({ length: 4 }, (_, index) => ({
      id: `tr_old_${index}`,
      status: "paid",
      createdAt: "2020-01-01T00:00:00.000Z",
    }));
    const firstDay = selectPaymentsForReconciliation(
      payments,
      new Date("2026-08-01T12:00:00.000Z"),
      1
    );
    const secondDay = selectPaymentsForReconciliation(
      payments,
      new Date("2026-08-02T12:00:00.000Z"),
      1
    );

    expect(firstDay).toHaveLength(1);
    expect(secondDay).toHaveLength(1);
    expect(secondDay[0]!.id).not.toBe(firstDay[0]!.id);
  });
});
