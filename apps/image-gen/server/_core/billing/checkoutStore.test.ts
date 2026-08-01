import { describe, expect, it } from "vitest";
import { blocksSubscriptionStart } from "./checkoutStore";

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
