import { describe, expect, it } from "vitest";
import { sumActiveChargebacks, sumCompletedRefunds } from "./accounting";

const amount = (value: string) => ({ currency: "EUR", value });

describe("accounting export totals", () => {
  it("counts only completed refunds", () => {
    expect(
      sumCompletedRefunds([
        { status: "refunded", amount: amount("10.00") },
        { status: "processing", amount: amount("12.00") },
        { status: "failed", amount: amount("13.00") },
      ])
    ).toBe("10.00");
  });

  it("excludes reversed chargebacks", () => {
    expect(
      sumActiveChargebacks([
        { reversedAt: null, amount: amount("9.50") },
        { reversedAt: "2026-08-01T12:00:00Z", amount: amount("8.00") },
      ])
    ).toBe("9.50");
  });

  it("ignores malformed and non-EUR values", () => {
    expect(
      sumCompletedRefunds([
        { status: "refunded", amount: { currency: "USD", value: "4.00" } },
        { status: "refunded", amount: { currency: "EUR", value: "4" } },
        { status: "refunded", amount: { currency: "EUR", value: "007.50" } },
      ])
    ).toBe("0.00");
  });

  it("returns zero for missing or non-array input", () => {
    expect(sumCompletedRefunds(null)).toBe("0.00");
    expect(sumCompletedRefunds(undefined)).toBe("0.00");
    expect(sumCompletedRefunds({ items: [] })).toBe("0.00");
    expect(sumActiveChargebacks(null)).toBe("0.00");
    expect(sumActiveChargebacks(undefined)).toBe("0.00");
    expect(sumActiveChargebacks({ items: [] })).toBe("0.00");
  });
});
