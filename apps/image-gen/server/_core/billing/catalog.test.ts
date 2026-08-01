import { describe, expect, it } from "vitest";

import {
  getBillingPlan,
  listPublicBillingPlans,
  requireActiveBillingPlan,
} from "./catalog";

describe("billing catalog", () => {
  it("resolves price, currency, interval and entitlements from the server allowlist", () => {
    const plan = requireActiveBillingPlan("premium_monthly_v1");

    expect(plan).toEqual({
      code: "premium_monthly_v1",
      publicName: "Leaderbot Premium",
      amountMinor: 2_900,
      currency: "EUR",
      interval: "1 month",
      entitlements: {
        imagesPerDay: 100,
        messagesPerMinute: 120,
      },
      mollieDescription: "Leaderbot Premium - maandelijks abonnement",
      active: true,
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.entitlements)).toBe(true);
    expect(Reflect.set(plan, "amountMinor", 1)).toBe(false);
    expect(plan.amountMinor).toBe(2_900);
  });

  it("publishes only active plans using formatted server-side amounts", () => {
    expect(listPublicBillingPlans()).toEqual([
      expect.objectContaining({
        code: "premium_monthly_v1",
        amount: "29.00",
        currency: "EUR",
        interval: "1 month",
        active: true,
        disclosure: expect.objectContaining({
          firstPaymentAmount: "29.00",
          recurringAmount: "29.00",
          automaticRenewal: true,
          recurringMethod: "SEPA Direct Debit",
        }),
      }),
    ]);
  });

  it.each([
    "",
    "unknown_plan",
    "premium_monthly_v1_inactive",
    "toString",
    "__proto__",
  ])("fails closed for unavailable plan code %j", planCode => {
    expect(getBillingPlan(planCode)).toBeNull();
    expect(() => requireActiveBillingPlan(planCode)).toThrow(
      "billing plan is unavailable"
    );
  });
});
