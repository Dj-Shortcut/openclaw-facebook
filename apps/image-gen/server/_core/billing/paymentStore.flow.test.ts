import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  billingCustomers,
  billingIntents,
  billingOutbox,
  billingSubscriptions,
  paymentLedger,
  webhookDeliveries,
  workspaceEntitlements,
  type BillingCustomer,
  type BillingIntent,
  type BillingSubscription,
} from "../../../drizzle/schema";
import type { MolliePayment } from "./mollieClient";

const databaseMock = vi.hoisted(() => vi.fn());

vi.mock("../../db", () => ({ getDatabaseOrThrow: databaseMock }));

import { applyMolliePaymentSnapshot } from "./paymentStore";

const INTENT_ID = "550e8400-e29b-41d4-a716-446655440000";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("payment snapshot persistence flow", () => {
  it("upserts a mismatched paid snapshot before returning without applying paid access", async () => {
    const flow = paymentFlow();
    databaseMock.mockResolvedValue(flow.database);

    await expect(
      applyMolliePaymentSnapshot(
        molliePayment({ amount: { currency: "EUR", value: "30.00" } }),
        1
      )
    ).resolves.toEqual({ result: "mismatch", workspaceId: 1 });

    expect(flow.operations).toContain("upsert:paymentLedger");
    expect(flow.operations.indexOf("upsert:paymentLedger")).toBeLessThan(
      flow.operations.indexOf("insert:workspaceEntitlements")
    );
    expect(flow.inserts).toContainEqual({
      table: paymentLedger,
      values: expect.objectContaining({
        molliePaymentId: "tr_payment123",
        grossAmount: "30.00",
        status: "paid",
      }),
    });
    expect(
      flow.inserts.filter(
        entry =>
          entry.table === workspaceEntitlements &&
          entry.values.status === "active"
      )
    ).toEqual([]);
    expect(
      flow.updates.filter(
        entry =>
          entry.table === paymentLedger &&
          entry.values.paidEffectApplied === 1
      )
    ).toEqual([]);
  });

  it("durably finishes malformed timestamps as a nonretryable mismatch", async () => {
    const flow = paymentFlow();
    databaseMock.mockResolvedValue(flow.database);

    await expect(
      applyMolliePaymentSnapshot(
        molliePayment({ paidAt: "not-a-provider-timestamp" }),
        1
      )
    ).resolves.toEqual({ result: "mismatch", workspaceId: 1 });

    expect(flow.inserts.some(entry => entry.table === paymentLedger)).toBe(
      false
    );
    expect(flow.inserts).toContainEqual({
      table: billingOutbox,
      values: expect.objectContaining({
        eventType: "manual_review",
        deduplicationKey: expect.stringMatching(
          /^invalid_provider_timestamp:tr_payment123:/
        ),
        payload: {
          reason: "invalid_provider_timestamp",
          paymentId: "tr_payment123",
        },
      }),
    });
    expect(flow.updates).toContainEqual({
      table: webhookDeliveries,
      values: {
        processingResult: "invalid_provider_timestamp",
        processedAt: expect.any(Date),
      },
    });
  });

  it("does not mark the ledger paid effect for a duplicate recurring cycle", async () => {
    const flow = paymentFlow({ subscription: recurringSubscription() });
    databaseMock.mockResolvedValue(flow.database);

    await expect(
      applyMolliePaymentSnapshot(
        molliePayment({ subscriptionId: "sub_subscription123" }),
        1
      )
    ).resolves.toEqual({ result: "processed", workspaceId: 1 });

    expect(flow.operations).toContain("upsert:paymentLedger");
    expect(
      flow.updates.filter(
        entry =>
          entry.table === paymentLedger &&
          entry.values.paidEffectApplied === 1
      )
    ).toEqual([]);
    expect(flow.inserts).toContainEqual({
      table: billingOutbox,
      values: expect.objectContaining({
        eventType: "manual_review",
        deduplicationKey: "duplicate_recurring_cycle:tr_payment123",
        payload: {
          reason: "duplicate_recurring_cycle",
          paymentId: "tr_payment123",
        },
      }),
    });
  });
});

function paymentFlow(
  options: { subscription?: BillingSubscription | null } = {}
) {
  const inserts: Array<{
    table: unknown;
    values: Record<string, unknown>;
  }> = [];
  const updates: Array<{
    table: unknown;
    values: Record<string, unknown>;
  }> = [];
  const operations: string[] = [];
  const intent = billingIntent();
  const customer = billingCustomer();
  const subscription = options.subscription ?? null;

  function rowsFor(table: unknown): unknown[] {
    if (table === billingIntents) return [intent];
    if (table === billingCustomers) return [customer];
    if (table === billingSubscriptions) {
      return subscription ? [subscription] : [];
    }
    if (table === paymentLedger) {
      return [
        {
          id: 7,
          invoiceNumber: "LB-TEST-2026-00000001",
          occurredAt: new Date("2026-08-01T10:00:00.000Z"),
          paidEffectApplied: 0,
        },
      ];
    }
    throw new Error("unexpected payment flow select");
  }

  function tableName(table: unknown): string {
    if (table === paymentLedger) return "paymentLedger";
    if (table === workspaceEntitlements) return "workspaceEntitlements";
    if (table === billingOutbox) return "billingOutbox";
    if (table === webhookDeliveries) return "webhookDeliveries";
    if (table === billingIntents) return "billingIntents";
    if (table === billingSubscriptions) return "billingSubscriptions";
    return "unknown";
  }

  const tx = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => {
            const rows = rowsFor(table);
            if (table === billingIntents || table === billingSubscriptions) {
              return { for: vi.fn().mockResolvedValue(rows) };
            }
            return Promise.resolve(rows);
          }),
        })),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((rawValues: unknown) => {
        const values = rawValues as Record<string, unknown>;
        inserts.push({ table, values });
        operations.push(`insert:${tableName(table)}`);
        if (table === webhookDeliveries) {
          return Promise.resolve(undefined);
        }
        return {
          onDuplicateKeyUpdate: vi.fn(async () => {
            operations.push(`upsert:${tableName(table)}`);
          }),
        };
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((rawValues: unknown) => {
        const values = rawValues as Record<string, unknown>;
        updates.push({ table, values });
        operations.push(`update:${tableName(table)}`);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    })),
  };
  const database = {
    transaction: vi.fn(
      async (callback: (transaction: typeof tx) => Promise<unknown>) =>
        callback(tx)
    ),
  };

  return { database, inserts, operations, updates };
}

function billingIntent(): BillingIntent {
  return {
    intentId: INTENT_ID,
    workspaceId: 1,
    mode: "test",
    kind: "subscription_start",
    status: "open",
    planCode: "premium",
    expectedAmount: "29.00",
    currency: "EUR",
    interval: "1 month",
    entitlements: { imagesPerDay: 10, messagesPerMinute: 5 },
    mollieDescription: "Leaderbot Premium",
    molliePaymentId: "tr_payment123",
  } as BillingIntent;
}

function billingCustomer(): BillingCustomer {
  return {
    workspaceId: 1,
    mode: "test",
    mollieCustomerId: "cst_customer123",
  } as BillingCustomer;
}

function recurringSubscription(): BillingSubscription {
  return {
    workspaceId: 1,
    mode: "test",
    status: "active",
    mollieCustomerId: "cst_customer123",
    mollieSubscriptionId: "sub_subscription123",
    sourceIntentId: INTENT_ID,
    currentPeriodStart: new Date("2026-08-01T10:00:00.000Z"),
    paidThrough: new Date("2026-09-01T10:00:00.000Z"),
    cancelAtPeriodEnd: 0,
  } as BillingSubscription;
}

function molliePayment(
  overrides: Partial<MolliePayment> = {}
): MolliePayment {
  return {
    resource: "payment",
    id: "tr_payment123",
    mode: "test",
    status: "paid",
    amount: { currency: "EUR", value: "29.00" },
    description: "Leaderbot Premium",
    customerId: "cst_customer123",
    metadata: { billingIntentId: INTENT_ID },
    createdAt: "2026-08-01T10:00:00.000Z",
    paidAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}
