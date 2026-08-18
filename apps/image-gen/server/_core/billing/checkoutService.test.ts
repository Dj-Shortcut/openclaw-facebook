import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertCheckoutKindMatchesPlan,
  getMollieLaunchCheck,
  hasExistingSubscriptionCollectionRisk,
  isOutsidePaymentMethodChangeCollectionWindow,
  startMollieCheckout,
} from "./checkoutService";
import type { MollieClient } from "./mollieClient";

const originalEnv = { ...process.env };

describe("Mollie checkout launch gate", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("fails before database or provider work while billing is disabled", async () => {
    delete process.env.MOLLIE_BILLING_ENABLED;

    await expect(
      startMollieCheckout({
        workspaceId: 1,
        planCode: "premium_monthly_v1",
        countryCode: "BE",
        kind: "subscription_start",
        businessCheckout: false,
      })
    ).rejects.toThrow("Mollie billing is disabled");
  });

  it("rejects sales outside Belgium before provider work", async () => {
    process.env = billingTestEnv();
    const listMethods = vi.fn();

    await expect(
      startMollieCheckout(
        {
          workspaceId: 1,
          planCode: "premium_monthly_v1",
          countryCode: "NL" as "BE",
          kind: "subscription_start",
          businessCheckout: false,
        },
        { listMethods } as unknown as MollieClient
      )
    ).rejects.toThrow("available in Belgium only");
    expect(listMethods).not.toHaveBeenCalled();
  });

  it("rejects B2B checkout before provider work", async () => {
    process.env = billingTestEnv();
    const listMethods = vi.fn();

    await expect(
      startMollieCheckout(
        {
          workspaceId: 1,
          planCode: "premium_monthly_v1",
          countryCode: "BE",
          kind: "subscription_start",
          businessCheckout: true,
        },
        { listMethods } as unknown as MollieClient
      )
    ).rejects.toThrow("B2B checkout is unavailable");
    expect(listMethods).not.toHaveBeenCalled();
  });

  it("does not allow a caller to buy the hidden recurring offer", async () => {
    process.env = billingTestEnv();
    const listMethods = vi.fn();

    await expect(
      startMollieCheckout(
        {
          workspaceId: 1,
          planCode: "premium_monthly_v1",
          countryCode: "BE",
          kind: "subscription_start",
          businessCheckout: false,
        },
        { listMethods } as unknown as MollieClient
      )
    ).rejects.toThrow("billing plan is unavailable");
    expect(listMethods).not.toHaveBeenCalled();
  });

  it("fails before database work unless both required methods are available", async () => {
    process.env = billingTestEnv();
    const listMethods = vi
      .fn()
      .mockImplementation((sequenceType: string) =>
        Promise.resolve(
          sequenceType === "first"
            ? [{ resource: "method", id: "bancontact" }]
            : []
        )
      );

    await expect(
      startMollieCheckout(
        {
          workspaceId: 1,
          planCode: "premium_monthly_v1",
          countryCode: "BE",
          kind: "payment_method_change",
          businessCheckout: false,
        },
        { listMethods } as unknown as MollieClient
      )
    ).rejects.toThrow("Bancontact and SEPA Direct Debit must both be enabled");
    expect(listMethods).toHaveBeenCalledTimes(2);
  });

  it("checks only one-off Bancontact for the Startpilot", async () => {
    process.env = billingTestEnv();
    const listMethods = vi.fn().mockResolvedValue([]);

    await expect(
      startMollieCheckout(
        {
          workspaceId: 1,
          planCode: "startpilot_once_v1",
          countryCode: "BE",
          kind: "startpilot_purchase",
          businessCheckout: false,
        },
        { listMethods } as unknown as MollieClient
      )
    ).rejects.toThrow("Bancontact must be enabled");
    expect(listMethods).toHaveBeenCalledTimes(1);
    expect(listMethods).toHaveBeenCalledWith("oneoff");
  });

  it("reports Startpilot sandbox readiness without requiring SEPA", async () => {
    process.env = billingTestEnv();
    const listMethods = vi
      .fn()
      .mockResolvedValue([{ resource: "method", id: "bancontact" }]);

    await expect(
      getMollieLaunchCheck({ listMethods } as unknown as MollieClient)
    ).resolves.toMatchObject({
      ok: false,
      sandboxReady: true,
      liveReady: false,
      offerType: "one_time",
      paymentSequenceType: "oneoff",
      bancontact: true,
      sepaDirectDebitRequired: false,
    });
    expect(listMethods).toHaveBeenCalledWith("oneoff");
  });

  it("fails closed when a checkout kind does not match its product", () => {
    expect(() =>
      assertCheckoutKindMatchesPlan("one_time", "subscription_start")
    ).toThrow("do not match");
    expect(() =>
      assertCheckoutKindMatchesPlan("subscription", "startpilot_purchase")
    ).toThrow("do not match");
    expect(() =>
      assertCheckoutKindMatchesPlan("one_time", "startpilot_purchase")
    ).not.toThrow();
  });
});

function billingTestEnv(): NodeJS.ProcessEnv {
  return {
    ...originalEnv,
    NODE_ENV: "test",
    MOLLIE_BILLING_ENABLED: "true",
    MOLLIE_ENTITLEMENT_ENFORCEMENT_ENABLED: "true",
    MOLLIE_API_KEY: "test_example123",
    MOLLIE_MODE: "test",
    MOLLIE_PAYMENT_WEBHOOK_URL:
      "http://billing.test/api/webhooks/mollie/payments",
    APP_BASE_URL: "http://leaderbot.test",
    BILLING_SUPPORT_EMAIL: "billing@leaderbot.test",
    PORTAL_HANDOFF_TOKEN_SECRET: "test-portal-handoff-secret-at-least-32",
    MOLLIE_BILLING_WORKER_WORKSPACE_ID: "1",
  };
}

describe("Mollie payment-method change collection guard", () => {
  const now = new Date("2026-08-01T00:00:00.000Z");

  it("requires a known next collection date more than seven days away", () => {
    expect(
      isOutsidePaymentMethodChangeCollectionWindow("2026-08-10", now)
    ).toBe(true);
    expect(
      isOutsidePaymentMethodChangeCollectionWindow("2026-08-08", now)
    ).toBe(false);
    expect(isOutsidePaymentMethodChangeCollectionWindow(null, now)).toBe(false);
  });

  it("blocks in-flight and newly initiated payments for the old subscription", () => {
    const paidThrough = new Date("2026-08-20T00:00:00.000Z");
    expect(
      hasExistingSubscriptionCollectionRisk(
        [
          {
            subscriptionId: "sub_old",
            status: "pending",
            createdAt: "2026-08-05T00:00:00.000Z",
          },
        ],
        "sub_old",
        paidThrough
      )
    ).toBe(true);
    expect(
      hasExistingSubscriptionCollectionRisk(
        [
          {
            subscriptionId: "sub_old",
            status: "paid",
            createdAt: "2026-07-20T00:00:00.000Z",
          },
        ],
        "sub_old",
        paidThrough
      )
    ).toBe(false);
  });
});
