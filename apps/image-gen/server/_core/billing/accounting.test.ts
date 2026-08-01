import { beforeEach, describe, expect, it, vi } from "vitest";

const { safeLogMock } = vi.hoisted(() => ({ safeLogMock: vi.fn() }));

vi.mock("../logger", () => ({ safeLog: safeLogMock }));

import { sumActiveChargebacks, sumCompletedRefunds } from "./accounting";

const amount = (value: string) => ({ currency: "EUR", value });

describe("accounting export totals", () => {
  beforeEach(() => {
    safeLogMock.mockReset();
  });

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

  it("logs metadata only when malformed refund and chargeback amounts are skipped", () => {
    expect(
      sumCompletedRefunds([
        {
          id: "re_private123",
          status: "refunded",
          amount: { currency: "EUR", value: "private-invalid-value" },
        },
      ])
    ).toBe("0.00");
    expect(
      sumActiveChargebacks([
        {
          id: "chb_private123",
          reversedAt: null,
          amount: { currency: "USD", value: "11.00" },
        },
      ])
    ).toBe("0.00");

    expect(safeLogMock.mock.calls).toEqual([
      [
        "billing_accounting_amount_skipped",
        {
          level: "warn",
          reason: "invalid_amount",
          entryType: "refund",
          entryIndex: 0,
        },
      ],
      [
        "billing_accounting_amount_skipped",
        {
          level: "warn",
          reason: "invalid_amount",
          entryType: "chargeback",
          entryIndex: 0,
        },
      ],
    ]);
    expect(JSON.stringify(safeLogMock.mock.calls)).not.toContain("private");
    expect(JSON.stringify(safeLogMock.mock.calls)).not.toContain("11.00");
  });

  it("logs every included missing or wrong-type amount without identifiers or values", () => {
    expect(
      sumCompletedRefunds([
        { id: "re_missing_private", status: "refunded" },
        {
          id: "re_wrong_type_private",
          status: "refunded",
          amount: { currency: 123, value: { private: "refund-value" } },
        },
        { id: "re_excluded_private", status: "processing" },
      ])
    ).toBe("0.00");
    expect(
      sumActiveChargebacks([
        { id: "chb_missing_private", reversedAt: null, amount: null },
        {
          id: "chb_wrong_type_private",
          reversedAt: null,
          amount: { currency: "EUR", value: 700 },
        },
        {
          id: "chb_excluded_private",
          reversedAt: "2026-08-01T12:00:00.000Z",
        },
      ])
    ).toBe("0.00");

    expect(safeLogMock.mock.calls).toEqual([
      [
        "billing_accounting_amount_skipped",
        {
          level: "warn",
          reason: "invalid_amount",
          entryType: "refund",
          entryIndex: 0,
        },
      ],
      [
        "billing_accounting_amount_skipped",
        {
          level: "warn",
          reason: "invalid_amount",
          entryType: "refund",
          entryIndex: 1,
        },
      ],
      [
        "billing_accounting_amount_skipped",
        {
          level: "warn",
          reason: "invalid_amount",
          entryType: "chargeback",
          entryIndex: 0,
        },
      ],
      [
        "billing_accounting_amount_skipped",
        {
          level: "warn",
          reason: "invalid_amount",
          entryType: "chargeback",
          entryIndex: 1,
        },
      ],
    ]);
    const serializedLogs = JSON.stringify(safeLogMock.mock.calls);
    expect(serializedLogs).not.toContain("private");
    expect(serializedLogs).not.toContain("refund-value");
    expect(serializedLogs).not.toContain("700");
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
