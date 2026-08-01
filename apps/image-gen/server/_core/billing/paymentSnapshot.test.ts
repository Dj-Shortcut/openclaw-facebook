import { describe, expect, it } from "vitest";
import type { MolliePayment } from "./mollieClient";
import { createPaymentSnapshot } from "./paymentSnapshot";

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
});
