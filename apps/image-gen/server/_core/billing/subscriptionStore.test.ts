import { describe, expect, it } from "vitest";
import { canceledEntitlementState } from "./subscriptionStore";

describe("subscription cancellation entitlement state", () => {
  const canceledAt = new Date("2026-08-01T12:00:00.000Z");

  it("ends access immediately when no paid-through period exists", () => {
    expect(canceledEntitlementState(null, canceledAt)).toEqual({
      status: "inactive",
      validUntil: canceledAt,
    });
  });

  it("preserves access through an already-paid future period", () => {
    const paidThrough = new Date("2026-09-01T00:00:00.000Z");
    expect(canceledEntitlementState(paidThrough, canceledAt)).toEqual({
      status: "active",
      validUntil: paidThrough,
    });
  });
});
