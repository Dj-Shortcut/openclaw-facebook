import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  billingCustomers,
  billingIntents,
  billingOutbox,
  billingSubscriptions,
  paymentLedger,
  webhookDeliveries,
  workspaceEntitlements,
  workspaceEntitlementUsage,
  workspaceEntitlementUsageReservations,
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
  it("activates a 30-day Startpilot without creating or canceling a subscription", async () => {
    const flow = paymentFlow({ intent: startpilotIntent() });
    databaseMock.mockResolvedValue(flow.database);

    await expect(
      applyMolliePaymentSnapshot(
        molliePayment({
          amount: { currency: "EUR", value: "19.00" },
          description: "Leaderbot Startpilot - eenmalig 30 dagen",
        }),
        1
      )
    ).resolves.toEqual({ result: "processed", workspaceId: 1 });

    expect(flow.inserts).toContainEqual({
      table: workspaceEntitlements,
      values: expect.objectContaining({
        planCode: "startpilot_once_v1",
        status: "active",
        validUntil: new Date("2026-08-31T10:00:00.000Z"),
        sourceSubscriptionId: null,
        sourceIntentId: INTENT_ID,
      }),
    });
    expect(flow.inserts).toContainEqual({
      table: workspaceEntitlementUsage,
      values: expect.objectContaining({
        planCode: "startpilot_once_v1",
        aiAnswersCommitted: 0,
        imagesUsed: 0,
      }),
    });
    expect(
      flow.inserts.some(entry => entry.table === billingSubscriptions)
    ).toBe(false);
    expect(
      flow.inserts.some(
        entry =>
          entry.table === billingOutbox &&
          ["ensure_subscription", "cancel_subscription"].includes(
            String(entry.values.eventType)
          )
      )
    ).toBe(false);
  });

  it("expires old AI reservations before resetting usage for a new Startpilot purchase", async () => {
    const flow = paymentFlow({
      intent: startpilotIntent(),
      usageSourceIntentId: "c4695347-4768-4de7-b327-1aaf00da45c1",
    });
    databaseMock.mockResolvedValue(flow.database);

    await expect(
      applyMolliePaymentSnapshot(
        molliePayment({ amount: { currency: "EUR", value: "19.00" } }),
        1
      )
    ).resolves.toEqual({ result: "processed", workspaceId: 1 });

    expect(flow.updates).toContainEqual({
      table: workspaceEntitlementUsageReservations,
      values: {
        status: "expired",
        releasedAt: new Date("2026-08-01T10:00:00.000Z"),
      },
    });
    expect(flow.updates).toContainEqual({
      table: workspaceEntitlementUsage,
      values: expect.objectContaining({
        sourceIntentId: INTENT_ID,
        aiAnswersCommitted: 0,
        aiAnswersReserved: 0,
        imagesUsed: 0,
        imagesUsedToday: 0,
      }),
    });
    expect(
      flow.operations.indexOf("update:workspaceEntitlementUsageReservations")
    ).toBeLessThan(flow.operations.indexOf("update:workspaceEntitlementUsage"));
  });

  it("preserves Startpilot usage and reservations for a provider retry", async () => {
    const flow = paymentFlow({
      intent: startpilotIntent(),
      usageSourceIntentId: INTENT_ID,
    });
    databaseMock.mockResolvedValue(flow.database);

    await applyMolliePaymentSnapshot(
      molliePayment({ amount: { currency: "EUR", value: "19.00" } }),
      1
    );

    expect(
      flow.updates.some(
        entry => entry.table === workspaceEntitlementUsageReservations
      )
    ).toBe(false);
    expect(
      flow.updates.some(
        entry =>
          entry.table === workspaceEntitlementUsage &&
          Object.prototype.hasOwnProperty.call(
            entry.values,
            "aiAnswersCommitted"
          )
      )
    ).toBe(false);
  });

  it("activates Startpilot after a historical canceled subscription has expired", async () => {
    const flow = paymentFlow({
      intent: startpilotIntent(),
      subscription: {
        ...recurringSubscription(),
        status: "canceled",
        paidThrough: new Date("2026-07-31T23:59:59.000Z"),
      },
    });
    databaseMock.mockResolvedValue(flow.database);

    await expect(
      applyMolliePaymentSnapshot(
        molliePayment({ amount: { currency: "EUR", value: "19.00" } }),
        1
      )
    ).resolves.toEqual({ result: "processed", workspaceId: 1 });

    expect(flow.inserts).toContainEqual({
      table: workspaceEntitlements,
      values: expect.objectContaining({
        planCode: "startpilot_once_v1",
        status: "active",
        sourceIntentId: INTENT_ID,
      }),
    });
    expect(flow.inserts).toContainEqual({
      table: workspaceEntitlementUsage,
      values: expect.objectContaining({
        planCode: "startpilot_once_v1",
        sourceIntentId: INTENT_ID,
      }),
    });
    expect(
      flow.inserts.some(
        entry =>
          entry.table === billingOutbox &&
          entry.values.payload &&
          (entry.values.payload as { reason?: unknown }).reason ===
            "startpilot_subscription_conflict"
      )
    ).toBe(false);
  });

  it.each([
    {
      label: "an active subscription",
      subscription: recurringSubscription(),
    },
    {
      label: "a canceled subscription with paid access remaining",
      subscription: {
        ...recurringSubscription(),
        status: "canceled" as const,
        paidThrough: new Date("2026-08-20T00:00:00.000Z"),
      },
    },
  ])("keeps Startpilot in manual review for $label", async ({ subscription }) => {
    const flow = paymentFlow({ intent: startpilotIntent(), subscription });
    databaseMock.mockResolvedValue(flow.database);

    await expect(
      applyMolliePaymentSnapshot(
        molliePayment({ amount: { currency: "EUR", value: "19.00" } }),
        1
      )
    ).resolves.toEqual({ result: "processed", workspaceId: 1 });

    expect(flow.inserts).toContainEqual({
      table: billingOutbox,
      values: expect.objectContaining({
        eventType: "manual_review",
        payload: {
          reason: "startpilot_subscription_conflict",
          paymentId: "tr_payment123",
        },
      }),
    });
    expect(
      flow.inserts.some(entry => entry.table === workspaceEntitlementUsage)
    ).toBe(false);
    expect(flow.updates).toContainEqual({
      table: workspaceEntitlements,
      values: expect.objectContaining({ status: "manual_review" }),
    });
  });

  it("does not create subscription work when a paid Startpilot snapshot is observed again", async () => {
    const flow = paymentFlow({
      intent: startpilotIntent(),
      ledgerPaidEffectApplied: 1,
    });
    databaseMock.mockResolvedValue(flow.database);

    await applyMolliePaymentSnapshot(
      molliePayment({ amount: { currency: "EUR", value: "19.00" } }),
      1
    );

    expect(
      flow.inserts.some(
        entry =>
          entry.table === billingOutbox &&
          ["ensure_subscription", "cancel_subscription"].includes(
            String(entry.values.eventType)
          )
      )
    ).toBe(false);
  });

  it("blocks a charged-back Startpilot without queuing subscription cancellation", async () => {
    const flow = paymentFlow({ intent: startpilotIntent() });
    databaseMock.mockResolvedValue(flow.database);

    await applyMolliePaymentSnapshot(
      molliePayment({
        amount: { currency: "EUR", value: "19.00" },
        _embedded: {
          chargebacks: [
            {
              id: "chb_chargeback123",
              amount: { currency: "EUR", value: "19.00" },
            },
          ],
        },
      }),
      1
    );

    expect(flow.inserts).toContainEqual({
      table: billingOutbox,
      values: expect.objectContaining({ eventType: "manual_review" }),
    });
    expect(flow.updates).toContainEqual({
      table: workspaceEntitlements,
      values: expect.objectContaining({ status: "blocked" }),
    });
    expect(
      flow.inserts.some(
        entry =>
          entry.table === billingOutbox &&
          entry.values.eventType === "cancel_subscription"
      )
    ).toBe(false);
  });

  it("deactivates a fully refunded Startpilot without subscription work", async () => {
    const flow = paymentFlow({ intent: startpilotIntent() });
    databaseMock.mockResolvedValue(flow.database);

    await applyMolliePaymentSnapshot(
      molliePayment({
        amount: { currency: "EUR", value: "19.00" },
        _embedded: {
          refunds: [
            {
              id: "re_refund123",
              status: "refunded",
              amount: { currency: "EUR", value: "19.00" },
            },
          ],
        },
      }),
      1
    );

    expect(flow.updates).toContainEqual({
      table: workspaceEntitlements,
      values: expect.objectContaining({ status: "inactive" }),
    });
    expect(
      flow.inserts.some(
        entry =>
          entry.table === billingOutbox &&
          entry.values.eventType === "cancel_subscription"
      )
    ).toBe(false);
  });

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
          entry.table === paymentLedger && entry.values.paidEffectApplied === 1
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
          entry.table === paymentLedger && entry.values.paidEffectApplied === 1
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
  options: {
    subscription?: BillingSubscription | null;
    intent?: BillingIntent;
    ledgerPaidEffectApplied?: number;
    usageSourceIntentId?: string;
  } = {}
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
  const intent = options.intent ?? billingIntent();
  const customer = billingCustomer();
  const subscription = options.subscription ?? null;
  let paymentLedgerSelectCount = 0;

  function rowsFor(table: unknown): unknown[] {
    if (table === billingIntents) return [intent];
    if (table === billingCustomers) return [customer];
    if (table === billingSubscriptions) {
      return subscription ? [subscription] : [];
    }
    if (table === workspaceEntitlements) {
      return [{ id: 9, status: "active" }];
    }
    if (table === workspaceEntitlementUsage) {
      return [
        {
          id: 11,
          workspaceId: 1,
          mode: intent.mode,
          entitlementId: 9,
          planCode: "startpilot_once_v1",
          sourceIntentId: options.usageSourceIntentId ?? intent.intentId,
          aiAnswersCommitted: 4,
          aiAnswersReserved: 1,
          imagesUsed: 2,
          imagesUsedToday: 1,
        },
      ];
    }
    if (table === paymentLedger) {
      paymentLedgerSelectCount += 1;
      if (paymentLedgerSelectCount > 1) return [];
      return [
        {
          id: 7,
          invoiceNumber: "LB-TEST-2026-00000001",
          occurredAt: new Date("2026-08-01T10:00:00.000Z"),
          paidEffectApplied: options.ledgerPaidEffectApplied ?? 0,
        },
      ];
    }
    throw new Error("unexpected payment flow select");
  }

  function tableName(table: unknown): string {
    if (table === paymentLedger) return "paymentLedger";
    if (table === workspaceEntitlements) return "workspaceEntitlements";
    if (table === workspaceEntitlementUsage) return "workspaceEntitlementUsage";
    if (table === workspaceEntitlementUsageReservations) {
      return "workspaceEntitlementUsageReservations";
    }
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
            if (
              table === billingIntents ||
              table === billingSubscriptions ||
              table === workspaceEntitlements ||
              table === workspaceEntitlementUsage
            ) {
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
          onDuplicateKeyUpdate: vi.fn(
            async (input?: { set?: Record<string, unknown> }) => {
              operations.push(`upsert:${tableName(table)}`);
              if (input?.set) {
                updates.push({ table, values: input.set });
              }
            }
          ),
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

function startpilotIntent(): BillingIntent {
  return {
    ...billingIntent(),
    kind: "startpilot_purchase",
    planCode: "startpilot_once_v1",
    expectedAmount: "19.00",
    interval: "30 days",
    entitlements: {
      aiAnswersTotal: 300,
      imagesTotal: 20,
      imagesPerDay: 5,
      workspaces: 1,
      facebookPages: 1,
      imageQuality: "images_2",
    },
    mollieDescription: "Leaderbot Startpilot - eenmalig 30 dagen",
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

function molliePayment(overrides: Partial<MolliePayment> = {}): MolliePayment {
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
