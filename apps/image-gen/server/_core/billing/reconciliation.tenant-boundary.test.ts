import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  billingCustomers,
  billingOutbox,
  billingReconciliationAnomalies,
  billingReconciliationRuns,
  billingSubscriptions,
  workspaceEntitlements,
  type BillingCustomer,
  type BillingSubscription,
} from "../../../drizzle/schema";
import type { MollieClient } from "./mollieClient";

const { databaseMock, safeLogMock } = vi.hoisted(() => ({
  databaseMock: vi.fn(),
  safeLogMock: vi.fn(),
}));

vi.mock("../../db", () => ({ getDatabaseOrThrow: databaseMock }));
vi.mock("../logger", () => ({ safeLog: safeLogMock }));

import { runDailyBillingReconciliation } from "./reconciliation";

const originalLiveBillingEnabled = process.env.MOLLIE_LIVE_BILLING_ENABLED;

describe("billing reconciliation tenant boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("MOLLIE_API_KEY", "test_example123");
    vi.stubEnv("MOLLIE_MODE", "test");
    vi.stubEnv(
      "MOLLIE_PAYMENT_WEBHOOK_URL",
      "http://billing.test/api/webhooks/mollie/payments"
    );
    vi.stubEnv("APP_BASE_URL", "http://leaderbot.test");
    vi.stubEnv("BILLING_SUPPORT_EMAIL", "billing@leaderbot.test");
    delete process.env.MOLLIE_LIVE_BILLING_ENABLED;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalLiveBillingEnabled === undefined) {
      delete process.env.MOLLIE_LIVE_BILLING_ENABLED;
    } else {
      process.env.MOLLIE_LIVE_BILLING_ENABLED = originalLiveBillingEnabled;
    }
  });

  it("records a tenant anomaly and skips provider reads and cancellation when customer bindings differ", async () => {
    const localCustomer = {
      workspaceId: 42,
      mode: "test",
      mollieCustomerId: "cst_workspace42",
    } as BillingCustomer;
    const localSubscription = {
      workspaceId: 42,
      mode: "test",
      status: "active",
      mollieCustomerId: "cst_otherworkspace",
      mollieSubscriptionId: "sub_otherworkspace",
    } as BillingSubscription;
    const flow = reconciliationDatabase(localCustomer, localSubscription);
    databaseMock.mockResolvedValue(flow.database);

    const client = {
      listCustomerPayments: vi.fn().mockResolvedValue([]),
      getPayment: vi.fn(),
      getSubscription: vi.fn(),
      listCustomerSubscriptions: vi.fn().mockResolvedValue([]),
    } as unknown as MollieClient;

    await expect(
      runDailyBillingReconciliation(
        42,
        client,
        new Date("2026-08-01T12:00:00.000Z")
      )
    ).resolves.toEqual({
      ran: true,
      summary: {
        customersChecked: 1,
        subscriptionsChecked: 1,
        paymentsChecked: 0,
        paymentSnapshotsApplied: 0,
        anomalies: 1,
        entitlementsExpired: 0,
      },
    });

    expect(client.listCustomerPayments).toHaveBeenCalledWith("cst_workspace42");
    expect(client.getSubscription).not.toHaveBeenCalled();
    expect(client.listCustomerSubscriptions).toHaveBeenCalledWith(
      "cst_workspace42"
    );
    expect(flow.inserts).toContainEqual({
      table: billingReconciliationAnomalies,
      values: {
        runId: 901,
        workspaceId: 42,
        code: "subscription_customer_id_mismatch",
        metadata: null,
      },
    });
    expect(flow.inserts.some(entry => entry.table === billingOutbox)).toBe(
      false
    );
    // Provider-operation resolution, profile-expiry containment and the
    // reconciliation body use separate tenant-scoped transactions.
    expect(flow.transactionMock).toHaveBeenCalledTimes(3);
  });

  it("fails closed when the workspace billing-customer row is missing", async () => {
    const localSubscription = {
      workspaceId: 42,
      mode: "test",
      status: "active",
      mollieCustomerId: "cst_otherworkspace",
      mollieSubscriptionId: "sub_otherworkspace",
    } as BillingSubscription;
    const flow = reconciliationDatabase(null, localSubscription);
    databaseMock.mockResolvedValue(flow.database);

    const client = {
      listCustomerPayments: vi.fn().mockResolvedValue([]),
      getPayment: vi.fn(),
      getSubscription: vi.fn(),
      listCustomerSubscriptions: vi.fn().mockResolvedValue([]),
    } as unknown as MollieClient;

    await expect(
      runDailyBillingReconciliation(
        42,
        client,
        new Date("2026-08-01T12:00:00.000Z")
      )
    ).resolves.toMatchObject({
      ran: true,
      summary: {
        customersChecked: 0,
        subscriptionsChecked: 1,
        anomalies: 2,
      },
    });

    expect(client.listCustomerPayments).not.toHaveBeenCalled();
    expect(client.getSubscription).not.toHaveBeenCalled();
    expect(client.listCustomerSubscriptions).not.toHaveBeenCalled();
    expect(flow.inserts).toEqual(
      expect.arrayContaining([
        {
          table: billingReconciliationAnomalies,
          values: {
            runId: 901,
            workspaceId: 42,
            code: "billing_customer_missing",
            metadata: null,
          },
        },
        {
          table: billingReconciliationAnomalies,
          values: {
            runId: 901,
            workspaceId: 42,
            code: "subscription_customer_binding_missing",
            metadata: null,
          },
        },
      ])
    );
    expect(flow.inserts.some(entry => entry.table === billingOutbox)).toBe(
      false
    );
    expect(flow.transactionMock).toHaveBeenCalledTimes(3);
  });
});

function reconciliationDatabase(
  customer: BillingCustomer | null,
  subscription: BillingSubscription
) {
  const inserts: Array<{
    table: unknown;
    values: Record<string, unknown>;
  }> = [];

  const insert = vi.fn((table: unknown) => ({
    values: vi.fn((rawValues: unknown) => {
      inserts.push({ table, values: rawValues as Record<string, unknown> });
      return {
        onDuplicateKeyUpdate: vi.fn().mockResolvedValue(undefined),
      };
    }),
  }));
  const update = vi.fn((table: unknown) => ({
    set: vi.fn(() => ({
      where: vi
        .fn()
        .mockResolvedValue(
          table === workspaceEntitlements ? { affectedRows: 0 } : undefined
        ),
    })),
  }));
  const select = vi.fn(() => ({
    from: vi.fn((table: unknown) => ({
      where: vi.fn(() => ({
        limit: vi.fn(() => {
          if (table === billingReconciliationRuns) {
            return Promise.resolve([{ id: 901 }]);
          }
          if (table === billingCustomers) {
            return Promise.resolve(customer ? [customer] : []);
          }
          if (table === billingSubscriptions) {
            return Promise.resolve([subscription]);
          }
          throw new Error("unexpected reconciliation select");
        }),
      })),
    })),
  }));

  const transactionInsert = vi.fn((table: unknown) => ({
    values: vi.fn((rawValues: unknown) => {
      inserts.push({ table, values: rawValues as Record<string, unknown> });
      return {
        onDuplicateKeyUpdate: vi.fn().mockResolvedValue(undefined),
      };
    }),
  }));
  const transactionUpdate = vi.fn(() => ({
    set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
  }));
  const transactionSelect = vi.fn(() => ({
    from: vi.fn((table: unknown) => ({
      where: vi.fn(() => ({
        limit: vi.fn(() => ({
          for: vi
            .fn()
            .mockResolvedValue(
              table === billingReconciliationRuns
                ? [{ id: 901 }]
                : [subscription]
            ),
        })),
      })),
    })),
  }));
  const transaction = {
    insert: transactionInsert,
    update: transactionUpdate,
    select: transactionSelect,
  };
  const transactionMock = vi.fn(
    async (callback: (tx: typeof transaction) => Promise<unknown>) =>
      callback(transaction)
  );

  return {
    inserts,
    transactionMock,
    database: {
      insert,
      update,
      select,
      transaction: transactionMock,
    } as never,
  };
}
