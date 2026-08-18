export type BillingPlan = Readonly<{
  code: string;
  publicName: string;
  amountMinor: number;
  currency: "EUR";
  offerType: "subscription" | "one_time";
  interval: "1 month" | "30 days";
  accessDurationDays: number | null;
  entitlements: Readonly<Record<string, number | string>>;
  mollieDescription: string;
  active: boolean;
  publiclyAvailable: boolean;
}>;

export const STARTPILOT_PLAN_CODE = "startpilot_once_v1" as const;

/**
 * Business-owned, server-side product catalog. Browser input may select a code
 * only; it can never override amount, currency, interval or entitlements.
 *
 * The v1 price and quota still require product-owner sign-off before the
 * separate live-billing switch may be enabled.
 */
const BILLING_PLANS = Object.freeze({
  premium_monthly_v1: Object.freeze({
    code: "premium_monthly_v1",
    publicName: "Leaderbot Premium",
    amountMinor: 2_900,
    currency: "EUR" as const,
    offerType: "subscription" as const,
    interval: "1 month" as const,
    accessDurationDays: null,
    entitlements: Object.freeze({
      imagesPerDay: 100,
      messagesPerMinute: 120,
      videoGenerationsPerDay: 10,
    }),
    mollieDescription: "Leaderbot Premium - maandelijks abonnement",
    active: true,
    publiclyAvailable: true,
  }),
  [STARTPILOT_PLAN_CODE]: Object.freeze({
    code: STARTPILOT_PLAN_CODE,
    publicName: "Leaderbot Startpilot",
    amountMinor: 1_900,
    currency: "EUR" as const,
    offerType: "one_time" as const,
    interval: "30 days" as const,
    accessDurationDays: 30,
    entitlements: Object.freeze({
      aiAnswersTotal: 300,
      imagesTotal: 20,
      imagesPerDay: 5,
      workspaces: 1,
      facebookPages: 1,
      imageQuality: "images_2",
    }),
    mollieDescription: "Leaderbot Startpilot - eenmalig 30 dagen",
    active: true,
    publiclyAvailable: true,
  }),
}) satisfies Readonly<Record<string, BillingPlan>>;

export type BillingPlanCode = keyof typeof BILLING_PLANS;

export function getBillingPlan(planCode: string): BillingPlan | null {
  if (!Object.prototype.hasOwnProperty.call(BILLING_PLANS, planCode)) {
    return null;
  }

  return BILLING_PLANS[planCode as BillingPlanCode];
}

export function requireActiveBillingPlan(planCode: string): BillingPlan {
  const plan = getBillingPlan(planCode);
  if (!plan || !plan.active) {
    throw new Error("billing plan is unavailable");
  }

  return plan;
}

export function listPublicBillingPlans() {
  return Object.values(BILLING_PLANS)
    .filter(plan => plan.active && plan.publiclyAvailable)
    .map(plan => ({
      code: plan.code,
      publicName: plan.publicName,
      amount: formatAmountMinor(plan.amountMinor),
      currency: plan.currency,
      offerType: plan.offerType,
      interval: plan.interval,
      accessDurationDays: plan.accessDurationDays,
      entitlements: plan.entitlements,
      active: plan.active,
      disclosure: {
        paymentAmount: formatAmountMinor(plan.amountMinor),
        firstPaymentAmount: formatAmountMinor(plan.amountMinor),
        recurringAmount:
          plan.offerType === "subscription"
            ? formatAmountMinor(plan.amountMinor)
            : null,
        automaticRenewal: plan.offerType === "subscription",
        recurringMethod:
          plan.offerType === "subscription" ? "SEPA Direct Debit" : null,
        cancellationTiming:
          plan.offerType === "subscription"
            ? "Cancel before the next billing date; access remains active through the paid period."
            : null,
        noTopUps: plan.offerType === "one_time",
      },
    }));
}

export function formatAmountMinor(amountMinor: number): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new Error("invalid billing amount");
  }

  return `${Math.floor(amountMinor / 100)}.${String(amountMinor % 100).padStart(2, "0")}`;
}

export function addPlanInterval(
  from: Date,
  interval: Extract<BillingPlan["interval"], "1 month">
): Date {
  if (interval !== "1 month") {
    throw new Error("unsupported billing interval");
  }

  const result = new Date(from);
  const originalDay = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + 1);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)
  ).getUTCDate();
  result.setUTCDate(Math.min(originalDay, lastDay));
  return result;
}
