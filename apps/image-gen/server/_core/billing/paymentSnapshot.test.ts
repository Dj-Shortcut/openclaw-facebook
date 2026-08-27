import { describe, expect, it } from "vitest";
import type { MolliePayment } from "./mollieClient";
import {
  createPaymentSnapshot,
  mergePaymentFinancialSnapshot,
} from "./paymentSnapshot";

describe("payment snapshot ordering", () => {
  it("orders refund and chargeback IDs by locale-independent code units", () => {
    const payment: MolliePayment = {
      resource: "payment",
      id: "tr_payment123",
      mode: "test",
      status: "paid",
      amount: { currency: "EUR", value: "29.00" },
      description: "Leaderbot Premium",
      createdAt: "2026-08-01T10:00:00.000Z",
      _embedded: {
        refunds: [
          {
            id: "re_a",
            status: "refunded",
            amount: { currency: "EUR", value: "1.00" },
          },
          {
            id: "re_B",
            status: "refunded",
            amount: { currency: "EUR", value: "2.00" },
          },
        ],
        chargebacks: [
          { id: "ch_a", amount: { currency: "EUR", value: "3.00" } },
          { id: "ch_B", amount: { currency: "EUR", value: "4.00" } },
        ],
      },
    };

    const snapshot = createPaymentSnapshot(payment);

    expect(snapshot.refunds.map(refund => refund.id)).toEqual(["re_B", "re_a"]);
    expect(snapshot.chargebacks.map(chargeback => chargeback.id)).toEqual([
      "ch_B",
      "ch_a",
    ]);
  });

  it("keeps refunds, chargebacks and reversal truth when a later snapshot omits them", () => {
    const merged = mergePaymentFinancialSnapshot({
      existingRefunds: [
        {
          id: "re_existing",
          status: "refunded",
          amount: { currency: "EUR", value: "10.00" },
          createdAt: "2026-08-01T10:00:00.000Z",
        },
      ],
      existingChargebacks: [
        {
          id: "ch_existing",
          amount: { currency: "EUR", value: "10.00" },
          createdAt: "2026-08-02T10:00:00.000Z",
          reversedAt: "2026-08-03T10:00:00.000Z",
        },
      ],
      observedRefunds: [],
      observedChargebacks: [],
    });

    expect(merged.refunds).toEqual([
      expect.objectContaining({ id: "re_existing", status: "refunded" }),
    ]);
    expect(merged.chargebacks).toEqual([
      expect.objectContaining({
        id: "ch_existing",
        reversedAt: "2026-08-03T10:00:00.000Z",
      }),
    ]);
    expect(merged.changedFromExisting).toBe(false);
  });

  it("accepts forward financial additions without regressing terminal facts", () => {
    const merged = mergePaymentFinancialSnapshot({
      existingRefunds: [
        {
          id: "re_existing",
          status: "refunded",
          amount: { currency: "EUR", value: "10.00" },
          createdAt: null,
        },
      ],
      existingChargebacks: [
        {
          id: "ch_existing",
          amount: { currency: "EUR", value: "10.00" },
          createdAt: null,
          reversedAt: "2026-08-03T10:00:00.000Z",
        },
      ],
      observedRefunds: [
        {
          id: "re_existing",
          status: "pending",
          amount: { currency: "EUR", value: "10.00" },
          createdAt: null,
        },
        {
          id: "re_new",
          status: "processing",
          amount: { currency: "EUR", value: "9.00" },
          createdAt: null,
        },
      ],
      observedChargebacks: [
        {
          id: "ch_existing",
          amount: { currency: "EUR", value: "10.00" },
          createdAt: null,
          reversedAt: null,
        },
        {
          id: "ch_new",
          amount: { currency: "EUR", value: "9.00" },
          createdAt: null,
          reversedAt: null,
        },
      ],
    });

    expect(merged.refunds).toEqual([
      expect.objectContaining({ id: "re_existing", status: "refunded" }),
      expect.objectContaining({ id: "re_new", status: "processing" }),
    ]);
    expect(merged.chargebacks).toEqual([
      expect.objectContaining({
        id: "ch_existing",
        reversedAt: "2026-08-03T10:00:00.000Z",
      }),
      expect.objectContaining({ id: "ch_new", reversedAt: null }),
    ]);
    expect(merged.changedFromExisting).toBe(true);
  });

  it("advances a pending refund and records a chargeback reversal", () => {
    const merged = mergePaymentFinancialSnapshot({
      existingRefunds: [
        {
          id: "re_existing",
          status: "pending",
          amount: { currency: "EUR", value: "19.00" },
          createdAt: null,
        },
      ],
      existingChargebacks: [
        {
          id: "ch_existing",
          amount: { currency: "EUR", value: "19.00" },
          createdAt: null,
          reversedAt: null,
        },
      ],
      observedRefunds: [
        {
          id: "re_existing",
          status: "refunded",
          amount: { currency: "EUR", value: "19.00" },
          createdAt: null,
        },
      ],
      observedChargebacks: [
        {
          id: "ch_existing",
          amount: { currency: "EUR", value: "19.00" },
          createdAt: null,
          reversedAt: "2026-08-04T10:00:00.000Z",
        },
      ],
    });

    expect(merged.refunds[0]?.status).toBe("refunded");
    expect(merged.chargebacks[0]?.reversedAt).toBe("2026-08-04T10:00:00.000Z");
  });

  it("fails closed on malformed existing financial JSON", () => {
    expect(() =>
      mergePaymentFinancialSnapshot({
        existingRefunds: null,
        existingChargebacks: [],
        observedRefunds: [],
        observedChargebacks: [],
      })
    ).toThrow("billing_payment_financial_snapshot_invalid");

    expect(() =>
      mergePaymentFinancialSnapshot({
        existingRefunds: [],
        existingChargebacks: [{ id: "ch_missing_amount" }],
        observedRefunds: [],
        observedChargebacks: [],
      })
    ).toThrow("billing_payment_financial_snapshot_invalid");
  });

  it("fails closed when terminal refund truth conflicts", () => {
    expect(() =>
      mergePaymentFinancialSnapshot({
        existingRefunds: [
          {
            id: "re_existing",
            status: "refunded",
            amount: { currency: "EUR", value: "19.00" },
            createdAt: null,
          },
        ],
        existingChargebacks: [],
        observedRefunds: [
          {
            id: "re_existing",
            status: "failed",
            amount: { currency: "EUR", value: "19.00" },
            createdAt: null,
          },
        ],
        observedChargebacks: [],
      })
    ).toThrow("billing_payment_financial_snapshot_conflict");
  });
});
