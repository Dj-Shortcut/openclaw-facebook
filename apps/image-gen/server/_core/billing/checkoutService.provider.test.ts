import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MollieClient } from "./mollieClient";

const storeMocks = vi.hoisted(() => ({
  attachMollieCustomer: vi.fn(),
  attachMolliePayment: vi.fn(),
  claimCustomerProviderCreation: vi.fn(),
  claimIntentPaymentCreation: vi.fn(),
  finalizePaymentProviderOperation: vi.fn(),
  getBillingCustomer: vi.fn(),
  getBillingIntent: vi.fn(),
  isCheckoutUrlExposureAllowed: vi.fn(),
  markBillingCustomerManualReview: vi.fn(),
  markIntentApiUnknown: vi.fn(),
  markIntentPaymentMismatch: vi.fn(),
  markPaymentProviderTransportStarted: vi.fn(),
  reserveBillingCustomer: vi.fn(),
  reserveCheckoutIntent: vi.fn(),
}));

vi.mock("./checkoutStore", () => storeMocks);
vi.mock("./catalog", async importOriginal => {
  const actual = await importOriginal<typeof import("./catalog")>();
  return {
    ...actual,
    requireActiveBillingPlan: (planCode: string) => {
      const plan = actual.requireActiveBillingPlan(planCode);
      return plan.code === actual.STARTPILOT_PLAN_CODE
        ? { ...plan, publiclyAvailable: true }
        : plan;
    },
  };
});
vi.mock("./billingProfileStore", () => ({
  assertWorkspaceBillingProfileEligible: vi.fn(async () => ({
    eligibilityVersion: 1,
  })),
}));
vi.mock("./billingSchedulerStore", () => ({
  assertBillingSchedulerTenantEnabled: vi.fn(async () => ({
    workspaceId: 1,
    mode: "test",
    authorizationEpoch: 2,
    laneEpochs: {},
  })),
  assertBillingExecutionBoundary: vi.fn(async () => undefined),
  wakeBillingSchedulerTenant: vi.fn(async () => true),
}));

import { startMollieCheckout } from "./checkoutService";

const originalEnv = { ...process.env };
const intentId = "550e8400-e29b-41d4-a716-446655440000";

describe("dormant Mollie checkout provider failure boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
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
    };
    storeMocks.reserveCheckoutIntent.mockResolvedValue({
      intentId,
      workspaceId: 1,
      mode: "test",
      status: "created",
      molliePaymentId: null,
      idempotencyKey: "payment-idempotency-key",
    });
    storeMocks.reserveBillingCustomer.mockResolvedValue({
      customer: {
        mollieCustomerId: "cst_customer123",
      },
      creationClaimed: false,
    });
    storeMocks.claimIntentPaymentCreation.mockResolvedValue({
      claimed: true,
      operationId: "operation-1",
      leaseToken: "lease-1",
    });
    storeMocks.claimCustomerProviderCreation.mockResolvedValue({
      claimed: true,
      operationId: "customer-operation-1",
      leaseToken: "customer-lease-1",
    });
    storeMocks.markPaymentProviderTransportStarted.mockResolvedValue(true);
    storeMocks.finalizePaymentProviderOperation.mockResolvedValue({
      recorded: true,
      authorized: true,
      revokedAuthorizationEpoch: null,
    });
    storeMocks.attachMolliePayment.mockResolvedValue(true);
    storeMocks.isCheckoutUrlExposureAllowed.mockResolvedValue(true);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("durably reviews a locally rejected provider response without marking api_unknown", async () => {
    const client = checkoutClient({
      mode: "live",
      customerId: "cst_customer123",
      metadata: { billingIntentId: intentId },
    });

    await expect(startMollieCheckout(checkoutInput(), client)).rejects.toThrow(
      "did not match the billing intent"
    );
    expect(storeMocks.markIntentApiUnknown).not.toHaveBeenCalled();
    expect(storeMocks.markIntentPaymentMismatch).toHaveBeenCalledWith({
      intentId,
      workspaceId: 1,
      mode: "test",
      molliePaymentId: "tr_payment123",
      operationId: "operation-1",
      authorizationEpoch: 2,
      targetCustomerId: "cst_customer123",
    });
    expect(storeMocks.attachMolliePayment).not.toHaveBeenCalled();
  });

  it("marks an unexpected one-off payment failure as api_unknown", async () => {
    const client = checkoutClient();
    vi.mocked(client.createOneTimePayment).mockRejectedValueOnce(
      new Error("provider unavailable")
    );

    await expect(startMollieCheckout(checkoutInput(), client)).rejects.toThrow(
      "provider unavailable"
    );
    expect(storeMocks.markIntentApiUnknown).toHaveBeenCalledWith(intentId);
    expect(storeMocks.markIntentPaymentMismatch).not.toHaveBeenCalled();
    expect(
      storeMocks.markPaymentProviderTransportStarted
    ).toHaveBeenCalledOnce();
    expect(storeMocks.finalizePaymentProviderOperation).toHaveBeenCalledWith({
      operationId: "operation-1",
      leaseToken: "lease-1",
      outcome: "ambiguous",
      workspaceId: 1,
      mode: "test",
      authorizationEpoch: 2,
      intentId,
      targetCustomerId: "cst_customer123",
    });
  });

  it("does not call Mollie when the durable transport fence is lost", async () => {
    storeMocks.markPaymentProviderTransportStarted.mockResolvedValue(false);
    const client = checkoutClient();

    await expect(startMollieCheckout(checkoutInput(), client)).rejects.toThrow(
      "provider operation fence was lost"
    );

    expect(client.createOneTimePayment).not.toHaveBeenCalled();
    expect(storeMocks.finalizePaymentProviderOperation).not.toHaveBeenCalled();
    expect(storeMocks.markIntentApiUnknown).not.toHaveBeenCalled();
  });

  it("contains the exact remote payment when the result fence is lost", async () => {
    storeMocks.finalizePaymentProviderOperation.mockResolvedValue({
      recorded: false,
      authorized: false,
      revokedAuthorizationEpoch: null,
    });
    const client = checkoutClient();

    await expect(startMollieCheckout(checkoutInput(), client)).rejects.toThrow(
      "provider result fence was lost"
    );

    expect(client.createOneTimePayment).toHaveBeenCalledOnce();
    expect(storeMocks.attachMolliePayment).not.toHaveBeenCalled();
    expect(storeMocks.markIntentApiUnknown).not.toHaveBeenCalled();
  });

  it("keeps the legacy one-off transport separate from the subscription path", async () => {
    const createOneTimePayment = vi.fn().mockResolvedValue({
      resource: "payment",
      id: "tr_payment123",
      mode: "test",
      status: "open",
      amount: { currency: "EUR", value: "19.00" },
      description: "Leaderbot Startpilot - eenmalig 30 dagen",
      customerId: "cst_customer123",
      metadata: { billingIntentId: intentId },
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    const createFirstPayment = vi.fn();
    const listMethods = vi
      .fn<MollieClient["listMethods"]>()
      .mockResolvedValue([
        { resource: "method", id: "bancontact", status: "active" },
      ]);
    const client = {
      listMethods,
      createOneTimePayment,
      createFirstPayment,
      getHostedCheckoutUrl: vi
        .fn()
        .mockReturnValue("https://checkout.mollie.com/pay/tr_payment123"),
    } as unknown as MollieClient;

    await expect(
      startMollieCheckout(
        {
          workspaceId: 1,
          planCode: "startpilot_once_v1",
          countryCode: "BE",
          kind: "startpilot_purchase",
          businessCheckout: false,
        },
        client
      )
    ).resolves.toMatchObject({ status: "open" });
    expect(createOneTimePayment).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: { currency: "EUR", value: "19.00" },
      })
    );
    expect(createFirstPayment).not.toHaveBeenCalled();
    expect(listMethods).toHaveBeenCalledWith("oneoff");
  });
});

function checkoutInput() {
  return {
    workspaceId: 1,
    planCode: "startpilot_once_v1",
    countryCode: "BE" as const,
    kind: "startpilot_purchase" as const,
    businessCheckout: false,
  };
}

function checkoutClient(
  overrides: Partial<{
    mode: "test" | "live";
    customerId: string;
    metadata: unknown;
  }> = {}
): MollieClient {
  return {
    listMethods: vi
      .fn()
      .mockResolvedValue([{ resource: "method", id: "bancontact" }]),
    createOneTimePayment: vi.fn().mockResolvedValue({
      resource: "payment",
      id: "tr_payment123",
      mode: overrides.mode ?? "test",
      status: "open",
      amount: { currency: "EUR", value: "19.00" },
      description: "Leaderbot Startpilot - eenmalig 30 dagen",
      customerId: overrides.customerId ?? "cst_customer123",
      metadata: overrides.metadata ?? { billingIntentId: intentId },
      createdAt: "2026-08-01T00:00:00.000Z",
    }),
    getHostedCheckoutUrl: vi.fn(),
  } as unknown as MollieClient;
}
