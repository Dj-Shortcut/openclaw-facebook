export type BillingPlan = Readonly<{
  code: string;
  publicName: string;
  amountMinor: number;
  currency: "EUR";
  interval: "1 month";
  entitlements: Readonly<{
    imagesPerDay: number;
    messagesPerMinute: number;
  }>;
  mollieDescription: string;
  active: boolean;
}>;

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
    interval: "1 month" as const,
    entitlements: Object.freeze({
      imagesPerDay: 100,
      messagesPerMinute: 120,
    }),
    mollieDescription: "Leaderbot Premium - maandelijks abonnement",
    active: true,
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
    .filter(plan => plan.active)
    .map(plan => ({
      code: plan.code,
      publicName: plan.publicName,
      amount: formatAmountMinor(plan.amountMinor),
      currency: plan.currency,
      interval: plan.interval,
      entitlements: plan.entitlements,
      active: plan.active,
      disclosure: {
        firstPaymentAmount: formatAmountMinor(plan.amountMinor),
        recurringAmount: formatAmountMinor(plan.amountMinor),
        automaticRenewal: true,
        recurringMethod: "SEPA Direct Debit",
        cancellationTiming: "Cancel before the next billing date; access remains active through the paid period.",
      },
    }));
}

export function formatAmountMinor(amountMinor: number): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new Error("invalid billing amount");
  }

  return `${Math.floor(amountMinor / 100)}.${String(amountMinor % 100).padStart(2, "0")}`;
}

export function addPlanInterval(from: Date, interval: BillingPlan["interval"]): Date {
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
