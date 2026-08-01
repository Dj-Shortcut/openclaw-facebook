import { describe, expect, it } from "vitest";
import {
  hasMatchingMollieCustomerId,
  isDuplicateDeliverySnapshot,
  isDuplicateRecurringCycle,
  resolvePaymentOccurredAt,
} from "./paymentStore";

describe("payment-store review safeguards", () => {
  it("requires one valid stored Mollie customer ID that matches the payment", () => {
    expect(hasMatchingMollieCustomerId(null, null)).toBe(false);
    expect(hasMatchingMollieCustomerId("", "")).toBe(false);
    expect(hasMatchingMollieCustomerId("cst_", "cst_")).toBe(false);
    expect(hasMatchingMollieCustomerId("cst_customer123", null)).toBe(false);
    expect(hasMatchingMollieCustomerId("cst_other123", "cst_customer123")).toBe(
      false
    );
    expect(
      hasMatchingMollieCustomerId("cst_customer123", "cst_customer123")
    ).toBe(true);
  });

  it("classifies any malformed provider payment timestamp as permanent review", () => {
    expect(
      resolvePaymentOccurredAt({
        createdAt: "2026-08-01T10:00:00.000Z",
        paidAt: "not-a-provider-date",
      })
    ).toBeNull();
    expect(
      resolvePaymentOccurredAt({
        createdAt: "not-a-provider-date",
        paidAt: "2026-08-01T10:00:00.000Z",
      })
    ).toBeNull();
    expect(
      resolvePaymentOccurredAt({
        createdAt: "2026-08-01T09:00:00.000Z",
        paidAt: "2026-08-01T10:00:00.000Z",
      })
    ).toEqual(new Date("2026-08-01T10:00:00.000Z"));
  });

  it("recognizes a duplicate recurring period without a paid effect", () => {
    const currentPeriodStart = new Date("2026-08-01T10:00:00.000Z");

    expect(
      isDuplicateRecurringCycle(
        new Date("2026-08-01T10:00:00.000Z"),
        currentPeriodStart
      )
    ).toBe(true);
    expect(
      isDuplicateRecurringCycle(
        new Date("2026-08-02T10:00:00.000Z"),
        currentPeriodStart
      )
    ).toBe(false);
  });

  it("bounds cyclic duplicate-delivery cause traversal", () => {
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;

    expect(isDuplicateDeliverySnapshot(cyclic)).toBe(false);
    expect(
      isDuplicateDeliverySnapshot({
        cause: {
          code: "ER_DUP_ENTRY",
          message:
            "Duplicate entry for webhook_deliveries_resource_snapshot_mode_unique",
        },
      })
    ).toBe(true);
  });
});
