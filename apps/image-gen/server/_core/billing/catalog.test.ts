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
      offerType: "subscription",
      interval: "1 month",
      accessDurationDays: null,
      entitlements: {
        imagesPerDay: 100,
        messagesPerMinute: 120,
        videoGenerationsPerDay: 10,
      },
      mollieDescription: "Leaderbot Premium - maandelijks abonnement",
      active: true,
      publiclyAvailable: false,
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.entitlements)).toBe(true);
    expect(Reflect.set(plan, "amountMinor", 1)).toBe(false);
    expect(plan.amountMinor).toBe(2_900);
  });

  it("publishes only the one-time premium credit bundle", () => {
    expect(listPublicBillingPlans()).toEqual([
      expect.objectContaining({
        code: "premium_image_credits_5_v1",
        amount: "3.00",
        currency: "EUR",
        offerType: "one_time",
        interval: "one-time",
        accessDurationDays: null,
        active: true,
        entitlements: {
          premiumImageCredits: 5,
          imageModel: "gpt-image-2",
          imageQuality: "high",
        },
        disclosure: expect.objectContaining({
          paymentAmount: "3.00",
          recurringAmount: null,
          automaticRenewal: false,
          recurringMethod: null,
          noTopUps: true,
        }),
      }),
    ]);
  });

  it("keeps legacy workspace products unavailable for new checkout", () => {
    expect(
      requireActiveBillingPlan("startpilot_once_v1").publiclyAvailable
    ).toBe(false);
    expect(
      requireActiveBillingPlan("premium_monthly_v1").publiclyAvailable
    ).toBe(false);
  });

  it("keeps the Startpilot catalog snapshot immutable", () => {
    const plan = requireActiveBillingPlan("startpilot_once_v1");
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.entitlements)).toBe(true);
    expect(Reflect.set(plan.entitlements, "imagesTotal", 2_000)).toBe(false);
    expect(plan.entitlements.imagesTotal).toBe(20);
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
