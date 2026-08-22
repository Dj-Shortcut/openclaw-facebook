import { beforeEach, describe, expect, it, vi } from "vitest";

const { safeLogMock } = vi.hoisted(() => ({ safeLogMock: vi.fn() }));

vi.mock("../logger", () => ({ safeLog: safeLogMock }));

import {
  assertCanonicalSignedEurAmount,
  sumActiveChargebacks,
  sumCompletedRefunds,
} from "./accounting";

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

  it("fails closed on malformed and non-EUR values", () => {
    expect(() =>
      sumCompletedRefunds([
        { status: "refunded", amount: { currency: "USD", value: "4.00" } },
        { status: "refunded", amount: { currency: "EUR", value: "4" } },
        { status: "refunded", amount: { currency: "EUR", value: "007.50" } },
      ])
    ).toThrow("billing_accounting_data_quality");
  });

  it("logs metadata only when malformed refund and chargeback amounts are skipped", () => {
    expect(() =>
      sumCompletedRefunds([
        {
          id: "re_private123",
          status: "refunded",
          amount: { currency: "EUR", value: "private-invalid-value" },
        },
      ])
    ).toThrow("billing_accounting_data_quality");
    expect(() =>
      sumActiveChargebacks([
        {
          id: "chb_private123",
          reversedAt: null,
          amount: { currency: "USD", value: "11.00" },
        },
      ])
    ).toThrow("billing_accounting_data_quality");

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
    expect(() =>
      sumCompletedRefunds([
        { id: "re_missing_private", status: "refunded" },
        {
          id: "re_wrong_type_private",
          status: "refunded",
          amount: { currency: 123, value: { private: "refund-value" } },
        },
        { id: "re_excluded_private", status: "processing" },
      ])
    ).toThrow("billing_accounting_data_quality");
    expect(() =>
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
    ).toThrow("billing_accounting_data_quality");

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

  it("fails closed for missing or non-array provider data", () => {
    for (const value of [null, undefined, { items: [] }]) {
      expect(() => sumCompletedRefunds(value)).toThrow(
        "billing_accounting_data_quality"
      );
      expect(() => sumActiveChargebacks(value)).toThrow(
        "billing_accounting_data_quality"
      );
    }
  });
});

describe("signed accounting money", () => {
  it("accepts canonical signed EUR adjustments", () => {
    for (const value of ["10.00", "0.00", "-10.00", "-0.01"]) {
      expect(() => assertCanonicalSignedEurAmount(value, "EUR")).not.toThrow();
    }
  });

  it("rejects noncanonical, wrong-currency, and out-of-range values", () => {
    for (const value of ["-0.00", "+1.00", "01.00", "1", "10000000000.00"]) {
      expect(() => assertCanonicalSignedEurAmount(value, "EUR")).toThrow(
        "billing_accounting_data_quality"
      );
    }
    expect(() => assertCanonicalSignedEurAmount("-1.00", "USD")).toThrow(
      "billing_accounting_data_quality"
    );
  });
});
