import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { profileEligibilityMock, schedulerEnabledMock } = vi.hoisted(() => ({
  profileEligibilityMock: vi.fn(),
  schedulerEnabledMock: vi.fn(),
}));
vi.mock("./billingProfileStore", () => ({
  assertWorkspaceBillingProfileEligible: profileEligibilityMock,
}));
vi.mock("./billingSchedulerStore", () => ({
  assertBillingSchedulerTenantEnabled: schedulerEnabledMock,
  assertBillingExecutionBoundary: vi.fn(async () => undefined),
  wakeBillingSchedulerTenant: vi.fn(async () => true),
}));
import {
  assertCheckoutKindMatchesPlan,
  getMollieLaunchCheck,
  hasExistingSubscriptionCollectionRisk,
  isOutsidePaymentMethodChangeCollectionWindow,
  startMollieCheckout,
} from "./checkoutService";
import * as billingReadiness from "./billingReadiness";
import type { MollieClient } from "./mollieClient";

const originalEnv = { ...process.env };

describe("Mollie checkout launch gate", () => {
  beforeEach(() => {
    profileEligibilityMock.mockReset();
    schedulerEnabledMock.mockReset();
    schedulerEnabledMock.mockResolvedValue({
      workspaceId: 1,
      mode: "test",
      laneEpochs: {},
    });
    profileEligibilityMock.mockResolvedValue({ eligibilityVersion: 1 });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it("fails before database or provider work while billing is disabled", async () => {
    process.env = billingTestEnv();
    process.env.MOLLIE_BILLING_ENABLED = "false";
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
    ).rejects.toThrow("Mollie billing is disabled");
    expect(schedulerEnabledMock).not.toHaveBeenCalled();
    expect(profileEligibilityMock).not.toHaveBeenCalled();
    expect(listMethods).not.toHaveBeenCalled();
  });

  it("ignores a forged body country and blocks on server profile state", async () => {
    process.env = billingTestEnv();
    const listMethods = vi.fn();
    profileEligibilityMock.mockRejectedValueOnce(
      new Error("billing_country_not_eligible")
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
    ).rejects.toThrow("billing_country_not_eligible");
    expect(listMethods).not.toHaveBeenCalled();
    expect(profileEligibilityMock).toHaveBeenCalledWith(1);
  });

  it("blocks an operator-disabled scheduler tenant before profile or provider work", async () => {
    process.env = billingTestEnv();
    schedulerEnabledMock.mockRejectedValueOnce(
      new Error("billing scheduler tenant is not enabled")
    );
    const listMethods = vi.fn();

    await expect(
      startMollieCheckout(
        {
          workspaceId: 1,
          planCode: "premium_monthly_v1",
          kind: "payment_method_change",
        },
        { listMethods } as unknown as MollieClient
      )
    ).rejects.toThrow("billing scheduler tenant is not enabled");
    expect(profileEligibilityMock).not.toHaveBeenCalled();
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

  it("keeps recurring Premium out of the public launch checkout", async () => {
    process.env = billingTestEnv();
    const listMethods = vi.fn().mockResolvedValue([
      { resource: "method", id: "bancontact" },
      { resource: "method", id: "directdebit" },
    ]);

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

  it("rejects legacy Startpilot before database or provider work", async () => {
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
    ).rejects.toThrow("billing plan is unavailable");
    expect(schedulerEnabledMock).not.toHaveBeenCalled();
    expect(profileEligibilityMock).not.toHaveBeenCalled();
    expect(listMethods).not.toHaveBeenCalled();
  });

  it("does not report sandbox ready from provider methods alone", async () => {
    process.env = billingTestEnv();
    const listMethods = vi
      .fn()
      .mockResolvedValue([{ resource: "method", id: "bancontact" }]);

    await expect(
      getMollieLaunchCheck({ listMethods } as unknown as MollieClient)
    ).resolves.toMatchObject({
      ok: false,
      sandboxReady: false,
      liveReady: false,
      credentialFreeGatesReady: false,
      offerType: "one_time",
      paymentSequenceType: "oneoff",
      bancontact: true,
      sepaDirectDebitRequired: false,
    });
    expect(listMethods).toHaveBeenCalledWith("oneoff");
  });

  it("reports sandbox ready only after provider and operational gates pass", async () => {
    process.env = operationalBillingTestEnv();
    const listMethods = vi
      .fn()
      .mockResolvedValue([
        { resource: "method", id: "bancontact", status: "active" },
      ]);
    const databaseCheck = vi
      .spyOn(billingReadiness, "assertBillingDatabaseReadiness")
      .mockResolvedValue();

    await expect(
      getMollieLaunchCheck({ listMethods } as unknown as MollieClient)
    ).resolves.toMatchObject({
      phase: "provider",
      mode: "test",
      providerChecked: true,
      ok: false,
      credentialFreeGatesReady: true,
      sandboxReady: true,
      liveReady: false,
      bancontact: true,
      offerType: "one_time",
      paymentSequenceType: "oneoff",
      salesCountry: "BE",
      currency: "EUR",
      b2bCheckoutEnabled: false,
    });
    expect(listMethods).toHaveBeenCalledWith("oneoff");
    expect(databaseCheck).toHaveBeenCalledWith("test", {
      requireRuntimeHeartbeat: true,
    });
  });

  it("runs the offline phase without a Mollie credential or provider call", async () => {
    process.env = offlineBillingTestEnv();
    const listMethods = vi.fn();
    const databaseCheck = vi
      .spyOn(billingReadiness, "assertBillingDatabaseReadiness")
      .mockResolvedValue();

    await expect(
      getMollieLaunchCheck({ listMethods } as unknown as MollieClient, {
        phase: "offline",
      })
    ).resolves.toMatchObject({
      phase: "offline",
      mode: "test",
      providerChecked: false,
      ok: true,
      credentialFreeGatesReady: true,
      sandboxReady: false,
      liveReady: false,
    });
    expect(listMethods).not.toHaveBeenCalled();
    expect(databaseCheck).toHaveBeenCalledWith("test", {
      requireRuntimeHeartbeat: false,
    });
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
    MOLLIE_BILLING_DRAIN_ENABLED: "true",
    MOLLIE_ENTITLEMENT_ENFORCEMENT_ENABLED: "true",
    MOLLIE_API_KEY: "test_example123",
    MOLLIE_MODE: "test",
    MOLLIE_PAYMENT_WEBHOOK_URL:
      "http://billing.test/api/webhooks/mollie/payments",
    APP_BASE_URL: "http://leaderbot.test",
    BILLING_SUPPORT_EMAIL: "billing@leaderbot.test",
    PORTAL_HANDOFF_TOKEN_SECRET: "test-portal-handoff-secret-at-least-32",
    MOLLIE_BILLING_WORKER_WORKSPACE_ID: "1",
    MOLLIE_BILLING_SCHEDULER_MODE: "pilot_pin",
  };
}

function offlineBillingTestEnv(): NodeJS.ProcessEnv {
  const env = billingTestEnv();
  delete env.MOLLIE_API_KEY;
  return {
    ...env,
    MOLLIE_BILLING_ENABLED: "false",
    MOLLIE_BILLING_DRAIN_ENABLED: "false",
    MOLLIE_BILLING_PREFLIGHT_ENABLED: "true",
    MOLLIE_LIVE_BILLING_ENABLED: "false",
    MOLLIE_ENTITLEMENT_ENFORCEMENT_ENABLED: "false",
    AI_ANSWER_FINALIZATION_DRAIN_ENABLED: "false",
    AI_ANSWER_QUOTA_PREFLIGHT_ENABLED: "false",
    BILLING_NOTIFICATION_PLANE_ENABLED: "false",
    MOLLIE_ACCOUNTING_IMPORT_ENABLED: "false",
    DATABASE_URL: "mysql://test:test@database.test/leaderbot",
    REDIS_URL: "redis://cache.test:6379",
    BILLING_PROFILE_EVIDENCE_HMAC_SECRET: "e".repeat(32),
    MOLLIE_CREDENTIAL_GENERATION_ID: "test-generation-1",
    MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD: "10",
    MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD: "100",
    MESSENGER_USER_DAILY_SPEND_CAP_USD: "2",
  };
}

function operationalBillingTestEnv(): NodeJS.ProcessEnv {
  return {
    ...billingTestEnv(),
    DATABASE_URL: "mysql://test:test@database.test/leaderbot",
    REDIS_URL: "redis://cache.test:6379",
    BILLING_PROFILE_EVIDENCE_HMAC_SECRET: "e".repeat(32),
    MOLLIE_CREDENTIAL_GENERATION_ID: "test-generation-1",
    MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD: "10",
    MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD: "100",
    MESSENGER_USER_DAILY_SPEND_CAP_USD: "2",
    BILLING_NOTIFICATION_PLANE_ENABLED: "true",
    BILLING_NOTIFICATION_SOURCE_ID: "leaderbot-test",
    BILLING_NOTIFICATION_RECEIVER_PUBLIC_ORIGIN: "http://receiver.test",
    BILLING_CUSTOMER_NOTIFICATION_WEBHOOK_URL:
      "http://receiver.test/api/internal/billing/notifications/customer",
    BILLING_OPERATOR_NOTIFICATION_WEBHOOK_URL:
      "http://receiver.test/api/internal/billing/notifications/operator",
    BILLING_CUSTOMER_NOTIFICATION_SIGNING_SECRET: "c".repeat(32),
    BILLING_OPERATOR_NOTIFICATION_SIGNING_SECRET: "o".repeat(32),
    BILLING_CUSTOMER_NOTIFICATION_KEY_ID: "customer-k1",
    BILLING_OPERATOR_NOTIFICATION_KEY_ID: "operator-k1",
    BILLING_NOTIFICATION_RECEIVER_CUSTOMER_SIGNING_SECRET: "c".repeat(32),
    BILLING_NOTIFICATION_RECEIVER_OPERATOR_SIGNING_SECRET: "o".repeat(32),
    BILLING_NOTIFICATION_RECEIVER_CUSTOMER_KEY_ID: "customer-k1",
    BILLING_NOTIFICATION_RECEIVER_OPERATOR_KEY_ID: "operator-k1",
    BILLING_NOTIFICATION_RECEIVER_SOURCE_ID: "leaderbot-test",
    BILLING_NOTIFICATION_RECEIVER_PREFLIGHT_ACK: "true",
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
