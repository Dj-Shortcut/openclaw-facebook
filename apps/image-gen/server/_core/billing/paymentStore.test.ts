import { describe, expect, it } from "vitest";
import {
  canTransitionToRecurringGrace,
  isPendingRefundStatus,
  isSupersededPaymentMethodChangeIntent,
  resolveFirstPaymentPeriodStart,
} from "./paymentStore";

describe("payment store terminal intent policy", () => {
  it("keeps a canceled payment-method replacement terminal", () => {
    expect(
      isSupersededPaymentMethodChangeIntent({
        kind: "payment_method_change",
        status: "canceled",
      })
    ).toBe(true);
  });

  it("does not suppress an ordinary open replacement or subscription start", () => {
    expect(
      isSupersededPaymentMethodChangeIntent({
        kind: "payment_method_change",
        status: "open",
      })
    ).toBe(false);
    expect(
      isSupersededPaymentMethodChangeIntent({
        kind: "subscription_start",
        status: "canceled",
      })
    ).toBe(false);
  });

  it("places every new full first-payment period after existing paid access", () => {
    const paidAt = new Date("2026-08-01T12:00:00.000Z");
    const existingPaidThrough = new Date("2026-08-20T00:00:00.000Z");

    expect(
      resolveFirstPaymentPeriodStart(paidAt, existingPaidThrough)
    ).toEqual(existingPaidThrough);
  });

  it("never reopens canceled or review access as recurring grace", () => {
    expect(canTransitionToRecurringGrace("canceled", 1)).toBe(false);
    expect(canTransitionToRecurringGrace("suspended", 0)).toBe(false);
    expect(canTransitionToRecurringGrace("manual_review", 0)).toBe(false);
    expect(canTransitionToRecurringGrace("active", 0)).toBe(true);
    expect(canTransitionToRecurringGrace("past_due", 0)).toBe(true);
  });

  it("treats every in-flight Mollie refund state as pending review", () => {
    expect(isPendingRefundStatus("queued")).toBe(true);
    expect(isPendingRefundStatus("pending")).toBe(true);
    expect(isPendingRefundStatus("processing")).toBe(true);
    expect(isPendingRefundStatus("refunded")).toBe(false);
    expect(isPendingRefundStatus("failed")).toBe(false);
  });
});
