import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const mocks = vi.hoisted(() => ({
  cancelSubscription: vi.fn(),
  formatAmountMinor: vi.fn(),
  getBillingPlan: vi.fn(),
  getBillingSummary: vi.fn(),
  getCheckoutReturnStatus: vi.fn(),
  getMollieConfig: vi.fn(),
  getMollieLaunchCheck: vi.fn(),
  getWorkspaceById: vi.fn(),
  getWorkspaceMembership: vi.fn(),
  insertAuditLog: vi.fn(),
  isMollieBillingEnabled: vi.fn(),
  listPublicBillingPlans: vi.fn(),
  safeLog: vi.fn(),
  startCheckout: vi.fn(),
}));

vi.mock("./db", () => ({
  getWorkspaceById: mocks.getWorkspaceById,
  getWorkspaceMembership: mocks.getWorkspaceMembership,
  insertAuditLog: mocks.insertAuditLog,
}));

vi.mock("./_core/logger", () => ({
  safeLog: mocks.safeLog,
}));

vi.mock("./_core/billing/checkoutService", () => ({
  cancelMollieSubscriptionAtPeriodEnd: mocks.cancelSubscription,
  getCheckoutReturnStatus: mocks.getCheckoutReturnStatus,
  getMollieLaunchCheck: mocks.getMollieLaunchCheck,
  startMollieCheckout: mocks.startCheckout,
}));

vi.mock("./_core/billing/catalog", () => ({
  formatAmountMinor: mocks.formatAmountMinor,
  getBillingPlan: mocks.getBillingPlan,
  listPublicBillingPlans: mocks.listPublicBillingPlans,
}));

vi.mock("./_core/billing/config", () => ({
  getMollieConfig: mocks.getMollieConfig,
  isMollieBillingEnabled: mocks.isMollieBillingEnabled,
}));

vi.mock("./_core/billing/subscriptionStore", () => ({
  getWorkspaceBillingSummary: mocks.getBillingSummary,
}));

import { portalRouter } from "./_core/portalRouter";

const workspaceId = 42;
const user: NonNullable<TrpcContext["user"]> = {
  id: 7,
  openId: "portal-user-7",
  email: "portal-user@example.com",
  name: "Portal User",
  loginMethod: "facebook",
  role: "user",
  createdAt: new Date(0),
  updatedAt: new Date(0),
  lastSignedIn: new Date(0),
};

function createCaller(
  headers: Record<string, string | string[] | undefined> = {
    origin: "https://leaderbot.test",
  }
) {
  return portalRouter.createCaller({
    user,
    req: { protocol: "https", headers } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  });
}

describe("portal router billing", () => {
  beforeEach(() => {
    vi.stubEnv("PORTAL_BASE_URL", "https://leaderbot.test");
    vi.clearAllMocks();
    mocks.getWorkspaceMembership.mockResolvedValue({
      workspaceId,
      userId: user.id,
      role: "owner",
    });
    mocks.getWorkspaceById.mockResolvedValue({ id: workspaceId });
    mocks.getMollieConfig.mockReturnValue({ mode: "test" });
    mocks.isMollieBillingEnabled.mockReturnValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the shared minor-amount formatter in billing summaries", async () => {
    mocks.getBillingSummary.mockResolvedValue({
      subscription: { planCode: "premium_monthly_v1" },
      entitlement: null,
      payments: [],
    });
    mocks.getBillingPlan.mockReturnValue({
      code: "premium_monthly_v1",
      publicName: "Leaderbot Premium",
      amountMinor: 2_900,
      currency: "EUR",
      interval: "1 month",
    });
    mocks.formatAmountMinor.mockReturnValue("29.00");

    await expect(
      createCaller().billing.summary({ workspaceId })
    ).resolves.toMatchObject({
      plan: { amount: "29.00" },
    });
    expect(mocks.formatAmountMinor).toHaveBeenCalledWith(2_900);
    expect(mocks.getBillingSummary).toHaveBeenCalledWith(workspaceId, "test", {
      includePayments: true,
    });
  });

  it("keeps plan status available but omits payment history for ordinary members", async () => {
    mocks.getWorkspaceMembership.mockResolvedValue({
      workspaceId,
      userId: user.id,
      role: "member",
    });
    mocks.getBillingSummary.mockImplementation(
      async (_workspaceId, _mode, options) => ({
        subscription: { planCode: "premium_monthly_v1" },
        entitlement: null,
        payments: options.includePayments
          ? [{ receiptPath: "/should-not-be-returned" }]
          : [],
      })
    );
    mocks.getBillingPlan.mockReturnValue({
      code: "premium_monthly_v1",
      publicName: "Leaderbot Premium",
      amountMinor: 2_900,
      currency: "EUR",
      interval: "1 month",
    });
    mocks.formatAmountMinor.mockReturnValue("29.00");

    await expect(
      createCaller().billing.summary({ workspaceId })
    ).resolves.toMatchObject({
      subscription: { planCode: "premium_monthly_v1" },
      payments: [],
    });
    expect(mocks.getBillingSummary).toHaveBeenCalledWith(workspaceId, "test", {
      includePayments: false,
    });
  });

  it("rejects all billing procedures for a nonmember before reading or mutating billing", async () => {
    mocks.getWorkspaceMembership.mockResolvedValue(undefined);

    await expect(
      createCaller().billing.summary({ workspaceId })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      createCaller().billing.checkout({
        workspaceId,
        planCode: "premium_monthly_v1",
        countryCode: "BE",
        kind: "subscription_start",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      createCaller().billing.cancel({ workspaceId })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(mocks.getBillingSummary).not.toHaveBeenCalled();
    expect(mocks.startCheckout).not.toHaveBeenCalled();
    expect(mocks.cancelSubscription).not.toHaveBeenCalled();
  });

  it("allows members to read status but rejects billing management and return details", async () => {
    mocks.getWorkspaceMembership.mockResolvedValue({
      workspaceId,
      userId: user.id,
      role: "member",
    });
    mocks.getBillingSummary.mockResolvedValue({
      subscription: null,
      entitlement: null,
      payments: [],
    });

    await expect(
      createCaller().billing.summary({ workspaceId })
    ).resolves.toMatchObject({ payments: [] });
    await expect(
      createCaller().billing.checkout({
        workspaceId,
        planCode: "premium_monthly_v1",
        countryCode: "BE",
        kind: "subscription_start",
      })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "billing admin required",
    });
    await expect(
      createCaller().billing.cancel({ workspaceId })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "billing admin required",
    });
    await expect(
      createCaller().billing.returnStatus({
        workspaceId,
        intentId: "11111111-1111-4111-8111-111111111111",
      })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "billing admin required",
    });
    expect(mocks.startCheckout).not.toHaveBeenCalled();
    expect(mocks.cancelSubscription).not.toHaveBeenCalled();
    expect(mocks.getCheckoutReturnStatus).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", {}],
    ["mismatched", { origin: "https://attacker.test" }],
  ])(
    "fails checkout closed for a %s trusted origin",
    async (_label, headers) => {
      await expect(
        createCaller(headers).billing.checkout({
          workspaceId,
          planCode: "premium_monthly_v1",
          countryCode: "BE",
          kind: "subscription_start",
        })
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "trusted origin required",
      });
      expect(mocks.startCheckout).not.toHaveBeenCalled();
    }
  );

  it("fails checkout closed when the trusted application origin is not configured", async () => {
    vi.stubEnv("PORTAL_BASE_URL", "");
    vi.stubEnv("APP_BASE_URL", "");

    await expect(
      createCaller().billing.checkout({
        workspaceId,
        planCode: "premium_monthly_v1",
        countryCode: "BE",
        kind: "subscription_start",
      })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "trusted origin required",
    });
    expect(mocks.startCheckout).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND only for a missing billing intent", async () => {
    mocks.getCheckoutReturnStatus.mockRejectedValue(
      new Error("billing intent not found")
    );

    await expect(
      createCaller().billing.returnStatus({
        workspaceId,
        intentId: "11111111-1111-4111-8111-111111111111",
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "billing intent not found",
    });
    expect(mocks.safeLog).not.toHaveBeenCalledWith(
      "billing_return_status_failed",
      expect.anything()
    );
  });

  it("redacts internal billing return failures and reports them as retryable server errors", async () => {
    mocks.getCheckoutReturnStatus.mockRejectedValue(
      new Error("database failure exposed a tenant secret")
    );

    await expect(
      createCaller().billing.returnStatus({
        workspaceId,
        intentId: "11111111-1111-4111-8111-111111111111",
      })
    ).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "billing status unavailable",
    });
    expect(mocks.safeLog).toHaveBeenCalledWith("billing_return_status_failed", {
      level: "error",
      operation: "billing_return_status",
      errorCode: "BillingOperationError",
    });
    expect(JSON.stringify(mocks.safeLog.mock.calls)).not.toContain(
      "database failure exposed a tenant secret"
    );
  });

  it.each([
    ["billing customer is not ready", "BillingCustomerNotReady"],
    [
      "workspace already has a billing subscription",
      "BillingSubscriptionAlreadyExists",
    ],
    [
      "workspace has no subscription to update",
      "BillingSubscriptionUpdateUnavailable",
    ],
    [
      "workspace already has a checkout in progress",
      "BillingCheckoutAlreadyInProgress",
    ],
    ["billing plan is unavailable", "BillingPlanUnavailable"],
  ])(
    "logs stable billing-state code %s",
    async (message, expectedErrorCode) => {
      mocks.startCheckout.mockRejectedValue(new Error(message));

      await expect(
        createCaller().billing.checkout({
          workspaceId,
          planCode: "premium_monthly_v1",
          countryCode: "BE",
          kind: "subscription_start",
        })
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "billing checkout failed",
      });
      expect(mocks.safeLog).toHaveBeenCalledWith(
        "billing_portal_request_rejected",
        expect.objectContaining({
          errorCode: expectedErrorCode,
        })
      );
    }
  );

  it("does not mask completed checkout and cancellation operations when auditing fails", async () => {
    const checkout = {
      intentId: "11111111-1111-4111-8111-111111111111",
      checkoutUrl: "https://checkout.mollie.test/pay",
      status: "open",
    };
    const cancellation = { status: "cancel_requested" };
    mocks.startCheckout.mockResolvedValue(checkout);
    mocks.cancelSubscription.mockResolvedValue(cancellation);
    mocks.insertAuditLog.mockRejectedValue(new Error("database unavailable"));

    await expect(
      createCaller().billing.checkout({
        workspaceId,
        planCode: "premium_monthly_v1",
        countryCode: "BE",
        kind: "subscription_start",
      })
    ).resolves.toEqual(checkout);
    await expect(
      createCaller().billing.cancel({ workspaceId })
    ).resolves.toEqual(cancellation);

    expect(mocks.safeLog).toHaveBeenCalledWith(
      "billing_audit_log_failed",
      expect.objectContaining({
        level: "error",
        operation: "billing_checkout.started",
      })
    );
    expect(mocks.safeLog).toHaveBeenCalledWith(
      "billing_audit_log_failed",
      expect.objectContaining({
        level: "error",
        operation: "billing_subscription.canceled",
      })
    );
    expect(mocks.safeLog).not.toHaveBeenCalledWith(
      "billing_portal_request_rejected",
      expect.anything()
    );
  });
});
