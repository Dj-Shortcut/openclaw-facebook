import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  billingCustomers,
  billingIntents,
  billingInvoiceSequences,
  billingOutbox,
  billingWebhookRoutes,
  paymentLedger,
  webhookDeliveries,
} from "../../../drizzle/schema";
import type { MolliePayment } from "./mollieClient";

const mocks = vi.hoisted(() => ({
  database: vi.fn(),
  assertLease: vi.fn(),
  assertTransactionLease: vi.fn(),
  config: vi.fn(),
  log: vi.fn(),
}));
vi.mock("../../db", () => ({ getDatabaseOrThrow: mocks.database }));
vi.mock("../logger", () => ({ safeLog: mocks.log }));
vi.mock("./config", () => ({ getMollieConfig: mocks.config }));
vi.mock("./billingSchedulerStore", () => ({
  assertBillingTenantLeaseOwned: mocks.assertLease,
  assertBillingTenantLeaseOwnedInTransaction: mocks.assertTransactionLease,
}));

import {
  applyLegacyPaymentDrainSnapshot,
  reconcileRetainedLegacyPayments,
} from "./legacyPaymentDrain";

const PAYMENT_ID = "tr_retained123";
const INTENT_ID = "11111111-1111-4111-8111-111111111111";
const PAID_AT = new Date("2026-08-01T10:01:00.000Z");
const NOW = new Date("2026-09-01T12:00:00.000Z");
const LEASE = {
  workspaceId: 42,
  mode: "test",
  kind: "reconciliation",
  leaseToken: "lease-token",
  executionEpoch: 3,
} as const;

function payment(overrides: Partial<MolliePayment> = {}): MolliePayment {
  return {
    resource: "payment",
    id: PAYMENT_ID,
    mode: "test",
    status: "paid",
    amount: { currency: "EUR", value: "19.00" },
    description: "Retained purchase",
    customerId: "cst_owner123",
    metadata: { billingIntentId: INTENT_ID },
    createdAt: "2026-08-01T10:00:00.000Z",
    paidAt: PAID_AT.toISOString(),
    method: "bancontact",
    ...overrides,
  };
}

function input(overrides: Partial<MolliePayment> = {}) {
  return {
    webhookPaymentId: PAYMENT_ID,
    expectedMode: "test" as const,
    payment: payment(overrides),
  };
}

function fixture(
  options: {
    route?: boolean;
    kind?: string;
    ledger?: Record<string, unknown> | null;
    processed?: boolean;
    due?: boolean;
    unroutedDue?: boolean;
    ledgerVanishedOnLock?: boolean;
    invoiceSequence?: number;
  } = {}
) {
  const rows = new Map<unknown, Record<string, unknown>[]>([
    [
      billingWebhookRoutes,
      options.route === false
        ? []
        : [
            {
              workspaceId: 42,
              mode: "test",
              molliePaymentId: PAYMENT_ID,
              intentId: INTENT_ID,
            },
          ],
    ],
    [
      billingIntents,
      [
        {
          intentId: INTENT_ID,
          workspaceId: 42,
          mode: "test",
          kind: options.kind ?? "startpilot_purchase",
          expectedAmount: "19.00",
          currency: "EUR",
          molliePaymentId: PAYMENT_ID,
          status: "contained",
        },
      ],
    ],
    [billingCustomers, [{ id: "cst_owner123" }]],
    [
      paymentLedger,
      options.ledger === null
        ? []
        : [
            {
              id: 91,
              workspaceId: 42,
              grossAmount: "19.00",
              currency: "EUR",
              status: "paid",
              refunds: [],
              chargebacks: [],
              occurredAt: PAID_AT,
              invoiceNumber: "LB-TEST-2026-00000001",
              settlementAmount: null,
              ...options.ledger,
            },
          ],
    ],
    [webhookDeliveries, options.processed ? [{ processedAt: NOW }] : []],
    [billingInvoiceSequences, [{ nextNumber: options.invoiceSequence ?? 2 }]],
  ]);
  const reads: {
    table: unknown;
    predicate?: SQL;
    limit?: number;
    locked?: string;
    joins: SQL[];
  }[] = [];
  const writes: {
    table: unknown;
    values: Record<string, unknown>;
    predicate?: SQL;
  }[] = [];
  const tx = {
    select: vi.fn(() => ({
      from(table: unknown) {
        const read = { table, joins: [] as SQL[] } as (typeof reads)[number];
        reads.push(read);
        const result = () => {
          if (table === billingWebhookRoutes && read.joins.length) {
            return options.due
              ? [
                  {
                    paymentId: PAYMENT_ID,
                    intentId: INTENT_ID,
                    ledgerId: options.ledger === null ? null : 91,
                  },
                ]
              : [];
          }
          if (table === paymentLedger) {
            if (read.joins.length && !read.locked) {
              return options.unroutedDue
                ? [{ paymentId: PAYMENT_ID, ledgerId: 91 }]
                : [];
            }
            if (
              read.locked &&
              (options.ledgerVanishedOnLock ||
                (read.joins.length && options.kind === "credit_purchase"))
            )
              return [];
          }
          return rows.get(table) ?? [];
        };
        const chain = {
          where(predicate: SQL) {
            read.predicate = predicate;
            return chain;
          },
          innerJoin(_table: unknown, predicate: SQL) {
            read.joins.push(predicate);
            return chain;
          },
          leftJoin(_table: unknown, predicate: SQL) {
            read.joins.push(predicate);
            return chain;
          },
          orderBy() {
            return chain;
          },
          limit(limit: number) {
            read.limit = limit;
            return chain;
          },
          for(lock: string) {
            read.locked = lock;
            return Promise.resolve(result());
          },
          then(resolve: (value: Record<string, unknown>[]) => unknown) {
            return Promise.resolve(result()).then(resolve);
          },
        };
        return chain;
      },
    })),
    update: vi.fn((table: unknown) => ({
      set(values: Record<string, unknown>) {
        return {
          where: vi.fn(async (predicate: SQL) => {
            writes.push({ table, values, predicate });
          }),
        };
      },
    })),
    insert: vi.fn((table: unknown) => ({
      values(values: Record<string, unknown>) {
        writes.push({ table, values });
        return {
          then: (resolve: (value: undefined) => unknown) =>
            Promise.resolve(undefined).then(resolve),
          onDuplicateKeyUpdate: vi.fn(async () => undefined),
        };
      },
    })),
  };
  const database = {
    ...tx,
    transaction: vi.fn(
      async (callback: (transaction: typeof tx) => Promise<unknown>) =>
        callback(tx)
    ),
  };
  mocks.database.mockResolvedValue(database);
  return { tx, reads, writes, rows, database };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.config.mockReturnValue({ mode: "test" });
  mocks.assertLease.mockResolvedValue(undefined);
  mocks.assertTransactionLease.mockResolvedValue(undefined);
});

describe("retained legacy payment financial drain", () => {
  it.each([{ id: "tr_other" }, { mode: "live" as const }])(
    "rejects the wrong provider envelope before reading the database: %j",
    async change => {
      await expect(
        applyLegacyPaymentDrainSnapshot(input(change))
      ).resolves.toBe("unknown");
      expect(mocks.database).not.toHaveBeenCalled();
    }
  );

  it.each([
    { route: false, ledger: null },
    { kind: "credit_purchase" },
    { route: false, kind: "credit_purchase" },
  ])(
    "never takes ownership of an unknown or credit route: %j",
    async options => {
      const f = fixture(options);
      await expect(applyLegacyPaymentDrainSnapshot(input())).resolves.toBe(
        "unknown"
      );
      expect(f.writes).toEqual([]);
    }
  );

  it.each(["refund", "chargeback"])(
    "recovers a retained recurring-payment %s without a webhook route",
    async effect => {
      const f = fixture({ route: false });
      f.rows.get(billingIntents)![0]!.molliePaymentId = "tr_firstPayment";
      const observed = input({
        subscriptionId: "sub_retained",
        _embedded:
          effect === "refund"
            ? {
                refunds: [
                  {
                    id: "re_late",
                    status: "refunded",
                    amount: { currency: "EUR", value: "19.00" },
                  },
                ],
              }
            : {
                chargebacks: [
                  {
                    id: "ch_late",
                    amount: { currency: "EUR", value: "19.00" },
                  },
                ],
              },
      });
      await expect(applyLegacyPaymentDrainSnapshot(observed)).resolves.toBe(
        "processed"
      );
      const ledger = f.writes.find(write => write.table === paymentLedger)!;
      expect(
        ledger.values[effect === "refund" ? "refunds" : "chargebacks"]
      ).toEqual([
        expect.objectContaining({
          id: effect === "refund" ? "re_late" : "ch_late",
        }),
      ]);
      expect(
        f.writes.every(write =>
          [paymentLedger, webhookDeliveries, billingOutbox].includes(
            write.table as typeof paymentLedger
          )
        )
      ).toBe(true);
      const dialect = new MySqlDialect();
      expect(
        dialect.sqlToQuery(
          f.reads.find(read => read.table === paymentLedger)!.predicate!
        ).params
      ).toEqual(["test", PAYMENT_ID]);
      expect(
        dialect.sqlToQuery(
          f.reads.find(read => read.table === billingIntents)!.predicate!
        ).params
      ).toEqual([INTENT_ID, 42, "test"]);
      expect(
        dialect.sqlToQuery(
          f.reads.find(read => read.table === billingCustomers)!.predicate!
        ).params
      ).toEqual([42, "test"]);
      expect(dialect.sqlToQuery(ledger.predicate!).params).toEqual([
        91,
        42,
        "test",
      ]);
    }
  );

  it("keeps a duplicate un-routed legacy snapshot idempotent", async () => {
    const f = fixture({ route: false, processed: true });
    await expect(applyLegacyPaymentDrainSnapshot(input())).resolves.toBe(
      "duplicate"
    );
    expect(f.writes).toEqual([]);
  });

  it("never derives ownership from provider metadata without matching retained intent evidence", async () => {
    const f = fixture({ route: false, ledger: { workspaceId: 99 } });
    f.rows.set(billingIntents, []);
    await expect(applyLegacyPaymentDrainSnapshot(input())).resolves.toBe(
      "unknown"
    );
    expect(f.writes).toEqual([]);
    const dialect = new MySqlDialect();
    expect(
      dialect.sqlToQuery(
        f.reads.find(read => read.table === billingIntents)!.predicate!
      ).params
    ).toEqual([INTENT_ID, 99, "test"]);
  });

  it("refuses missing metadata on an un-routed payment", async () => {
    const f = fixture({ route: false });
    await expect(
      applyLegacyPaymentDrainSnapshot(input({ metadata: {} }))
    ).resolves.toBe("unknown");
    expect(f.writes).toEqual([]);
  });

  it("does not recreate a recovered ledger that disappeared before locking", async () => {
    const f = fixture({ route: false, ledgerVanishedOnLock: true });
    await expect(applyLegacyPaymentDrainSnapshot(input())).resolves.toBe(
      "unknown"
    );
    expect(f.writes).toEqual([]);
  });

  it.each([
    { customerId: "cst_other" },
    { amount: { currency: "EUR", value: "20.00" } },
    { amount: { currency: "USD", value: "19.00" } },
  ])(
    "does not change unrouted accounting for mismatched evidence: %j",
    async change => {
      const f = fixture({ route: false });
      await expect(
        applyLegacyPaymentDrainSnapshot(input(change))
      ).resolves.toBe("mismatch");
      expect(
        f.writes.some(
          write =>
            write.table === paymentLedger ||
            write.table === billingWebhookRoutes
        )
      ).toBe(false);
    }
  );

  it("hydrates a late settlement amount without touching reconciled fees or invoice ownership", async () => {
    const f = fixture();
    await expect(
      applyLegacyPaymentDrainSnapshot(
        input({ settlementAmount: { currency: "EUR", value: "18.50" } })
      )
    ).resolves.toBe("processed");
    const ledger = f.writes.find(write => write.table === paymentLedger)!;
    expect(ledger.values.settlementAmount).toBe("18.50");
    for (const field of [
      "settlementId",
      "mollieFees",
      "invoiceNumber",
      "paidEffectApplied",
      "paymentEffectOwnerKind",
    ])
      expect(ledger.values).not.toHaveProperty(field);
  });

  it.each([undefined, { currency: "EUR", value: "18.50" }])(
    "preserves an existing reconciled settlement amount: %j",
    async settlementAmount => {
      const f = fixture({ ledger: { settlementAmount: "18.00" } });
      await expect(
        applyLegacyPaymentDrainSnapshot(input({ settlementAmount }))
      ).resolves.toBe("processed");
      expect(
        f.writes.find(write => write.table === paymentLedger)!.values
      ).not.toHaveProperty("settlementAmount");
    }
  );

  it.each([
    { currency: "USD", value: "18.50" },
    { currency: "EUR", value: "-1.00" },
    { currency: "EUR", value: "not-money" },
  ])(
    "does not hydrate invalid settlement evidence: %j",
    async settlementAmount => {
      const f = fixture();
      await expect(
        applyLegacyPaymentDrainSnapshot(input({ settlementAmount }))
      ).resolves.toBe("mismatch");
      expect(f.writes.some(write => write.table === paymentLedger)).toBe(false);
    }
  );

  it("records late refunds and chargebacks for a contained purchase without granting access", async () => {
    const f = fixture();
    const observed = input({
      _embedded: {
        refunds: [
          {
            id: "re_refund1",
            status: "refunded",
            amount: { currency: "EUR", value: "5.00" },
          },
        ],
        chargebacks: [
          { id: "ch_chargeback1", amount: { currency: "EUR", value: "14.00" } },
        ],
      },
    });
    await expect(applyLegacyPaymentDrainSnapshot(observed)).resolves.toBe(
      "processed"
    );
    const ledgerWrite = f.writes.find(write => write.table === paymentLedger)!;
    expect(ledgerWrite.values).toMatchObject({
      grossAmount: "19.00",
      currency: "EUR",
      status: "paid",
      refunds: [
        expect.objectContaining({ id: "re_refund1", status: "refunded" }),
      ],
      chargebacks: [expect.objectContaining({ id: "ch_chargeback1" })],
    });
    for (const retainedField of [
      "paidEffectApplied",
      "paymentEffectOwnerKind",
      "invoiceNumber",
      "mollieFees",
      "settlementId",
    ])
      expect(ledgerWrite.values).not.toHaveProperty(retainedField);
    expect(
      f.writes.every(write =>
        [paymentLedger, webhookDeliveries, billingOutbox].includes(
          write.table as typeof paymentLedger
        )
      )
    ).toBe(true);
    expect(
      f.writes.find(write => write.table === billingOutbox)?.values
    ).toMatchObject({
      eventType: "manual_review",
      workspaceId: 42,
      mode: "test",
      payload: {
        reason: "retained_legacy_payment_financial_update",
        paymentId: PAYMENT_ID,
      },
    });
    const dialect = new MySqlDialect();
    expect(dialect.sqlToQuery(ledgerWrite.predicate!).params).toEqual([
      91,
      42,
      "test",
    ]);
    expect(
      dialect.sqlToQuery(
        f.reads.find(read => read.table === billingIntents)!.predicate!
      ).params
    ).toEqual([INTENT_ID, 42, "test"]);
    expect(f.reads.find(read => read.table === billingIntents)!.locked).toBe(
      "update"
    );
    expect(f.reads.find(read => read.table === paymentLedger)!.locked).toBe(
      "update"
    );
  });

  it("keeps prior financial effects when a newer provider snapshot omits them", async () => {
    const refunds = [
      {
        id: "re_prior",
        status: "refunded",
        amount: { currency: "EUR", value: "3.00" },
        createdAt: null,
      },
    ];
    const f = fixture({ ledger: { refunds } });
    await expect(applyLegacyPaymentDrainSnapshot(input())).resolves.toBe(
      "processed"
    );
    expect(
      f.writes.find(write => write.table === paymentLedger)?.values.refunds
    ).toEqual(refunds);
  });

  it("recognizes an already processed observation without another write", async () => {
    const f = fixture({ processed: true });
    await expect(applyLegacyPaymentDrainSnapshot(input())).resolves.toBe(
      "duplicate"
    );
    expect(f.writes).toEqual([]);
  });

  it.each([
    { metadata: { billingIntentId: "other" } },
    { customerId: "cst_other" },
    { amount: { currency: "EUR", value: "20.00" } },
    { amount: { currency: "USD", value: "19.00" } },
    { paidAt: "invalid" },
  ])(
    "contains mismatched evidence without changing the ledger: %j",
    async change => {
      const f = fixture();
      await expect(
        applyLegacyPaymentDrainSnapshot(input(change))
      ).resolves.toBe("mismatch");
      expect(f.writes.some(write => write.table === paymentLedger)).toBe(false);
      expect(
        f.writes.find(write => write.table === billingOutbox)?.values.eventType
      ).toBe("manual_review");
    }
  );

  it("rejects a ledger owned by a different workspace", async () => {
    const f = fixture({ ledger: { workspaceId: 99 } });
    await expect(applyLegacyPaymentDrainSnapshot(input())).rejects.toThrow(
      "ledger scope mismatch"
    );
    expect(f.writes).toEqual([]);
  });

  it("ignores stale status snapshots without rolling back paid accounting", async () => {
    const f = fixture();
    await expect(
      applyLegacyPaymentDrainSnapshot(
        input({ status: "open", paidAt: undefined })
      )
    ).resolves.toBe("processed");
    expect(f.writes.some(write => write.table === paymentLedger)).toBe(false);
    expect(
      f.writes.find(
        write =>
          write.values.processingResult === "legacy_stale_snapshot_ignored"
      )
    ).toBeDefined();
  });

  it("keeps conflicting financial changes retryable instead of losing them", async () => {
    fixture();
    await expect(
      applyLegacyPaymentDrainSnapshot(
        input({
          status: "open",
          paidAt: undefined,
          _embedded: {
            refunds: [
              {
                id: "re_late",
                status: "refunded",
                amount: { currency: "EUR", value: "19.00" },
              },
            ],
          },
        })
      )
    ).rejects.toThrow("financial snapshot conflict");
  });

  it("allocates a retained paid invoice once without starting a subscription", async () => {
    const f = fixture({ ledger: null });
    await expect(applyLegacyPaymentDrainSnapshot(input())).resolves.toBe(
      "processed"
    );
    expect(
      f.writes.find(write => write.values.invoiceNumber)?.values.invoiceNumber
    ).toBe("LB-TEST-2026-00000002");
    expect(
      f.writes.find(
        write =>
          write.table === billingInvoiceSequences &&
          write.values.nextNumber === 3
      )
    ).toBeDefined();
    expect(
      f.writes
        .filter(write => write.table === billingOutbox)
        .every(write => write.values.eventType === "manual_review")
    ).toBe(true);
  });

  it("checks the exact scheduler lease before applying a provider observation", async () => {
    const f = fixture();
    await expect(
      applyLegacyPaymentDrainSnapshot(input(), { ...LEASE, workspaceId: 99 })
    ).rejects.toThrow("lease scope mismatch");
    expect(f.writes).toEqual([]);
    mocks.assertTransactionLease.mockRejectedValueOnce(new Error("lease lost"));
    await expect(
      applyLegacyPaymentDrainSnapshot(input(), LEASE)
    ).rejects.toThrow("lease lost");
    expect(f.writes).toEqual([]);
  });
});

describe("bounded retained-payment reconciliation", () => {
  it("scans only the leased workspace/mode and makes no provider call for an empty batch", async () => {
    const f = fixture();
    const getPayment = vi.fn();
    await expect(
      reconcileRetainedLegacyPayments(LEASE, NOW, { getPayment })
    ).resolves.toBe(0);
    expect(getPayment).not.toHaveBeenCalled();
    expect(mocks.config).not.toHaveBeenCalled();
    const read = f.reads[0]!;
    const dialect = new MySqlDialect();
    expect(dialect.sqlToQuery(read.predicate!).params).toEqual([
      42,
      "test",
      "credit_purchase",
      "2026-09-01 11:00:00.000",
      "2026-09-01 11:00:00.000",
    ]);
    expect(read.limit).toBe(25);
    for (const predicate of read.joins) {
      const { sql } = dialect.sqlToQuery(predicate);
      expect(sql).toContain("workspace_id");
      expect(sql).toContain("mode");
    }
    const unroutedRead = f.reads[1]!;
    expect(unroutedRead.table).toBe(paymentLedger);
    expect(unroutedRead.limit).toBe(25);
    const unroutedPredicate = dialect.sqlToQuery(unroutedRead.predicate!);
    expect(unroutedPredicate.params).toEqual([
      42,
      "test",
      "2026-09-01 11:00:00.000",
    ]);
    expect(unroutedPredicate.sql).toContain(
      "`billing_webhook_routes`.`mollie_payment_id` is null"
    );
    expect(unroutedPredicate.sql).toContain(
      "`billing_intents`.`intent_id` is null"
    );
    const creditExclusion = dialect.sqlToQuery(unroutedRead.joins[1]!);
    expect(creditExclusion.params).toEqual(["credit_purchase"]);
    for (const column of ["workspace_id", "mode", "mollie_payment_id"])
      expect(creditExclusion.sql).toContain(column);
  });

  it("discovers known recurring-payment ledger IDs without listing or creating provider resources", async () => {
    const f = fixture({ route: false, unroutedDue: true });
    f.rows.get(billingIntents)![0]!.molliePaymentId = "tr_firstPayment";
    const getPayment = vi.fn().mockResolvedValue(
      payment({
        subscriptionId: "sub_retained",
        _embedded: {
          refunds: [
            {
              id: "re_late",
              status: "refunded",
              amount: { currency: "EUR", value: "19.00" },
            },
          ],
        },
      })
    );
    await expect(
      reconcileRetainedLegacyPayments(LEASE, NOW, { getPayment })
    ).resolves.toBe(1);
    expect(getPayment).toHaveBeenCalledExactlyOnceWith(PAYMENT_ID);
    expect(mocks.assertLease).toHaveBeenCalledBefore(getPayment);
    expect(mocks.assertTransactionLease).toHaveBeenCalledTimes(2);
    expect(f.writes[0]!.values).toEqual({ updatedAt: NOW });
    const preparation = f.reads.find(
      read =>
        read.table === paymentLedger &&
        read.locked === "update" &&
        read.joins.length
    )!;
    const dialect = new MySqlDialect();
    expect(dialect.sqlToQuery(preparation.predicate!).params).toEqual([
      91,
      42,
      "test",
      PAYMENT_ID,
    ]);
    expect(dialect.sqlToQuery(preparation.predicate!).sql).toContain(
      "`billing_intents`.`intent_id` is null"
    );
    expect(
      f.writes.some(
        write => write.values.processingResult === "legacy_financial_recorded"
      )
    ).toBe(true);
  });

  it("skips a discovered ledger that becomes a credit payment before transport", async () => {
    const f = fixture({
      route: false,
      unroutedDue: true,
      kind: "credit_purchase",
    });
    const getPayment = vi.fn();
    await expect(
      reconcileRetainedLegacyPayments(LEASE, NOW, { getPayment })
    ).resolves.toBe(0);
    expect(getPayment).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
  });

  it("does not contact Mollie for an unrouted ledger after lease loss", async () => {
    const f = fixture({ route: false, unroutedDue: true });
    mocks.assertTransactionLease.mockRejectedValueOnce(new Error("lease lost"));
    const getPayment = vi.fn();
    await expect(
      reconcileRetainedLegacyPayments(LEASE, NOW, { getPayment })
    ).rejects.toThrow("lease lost");
    expect(getPayment).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
  });

  it("postpones a failed unrouted provider read without losing its retained ledger", async () => {
    const f = fixture({ route: false, unroutedDue: true });
    const getPayment = vi
      .fn()
      .mockRejectedValue(new Error("provider unavailable"));
    await expect(
      reconcileRetainedLegacyPayments(LEASE, NOW, { getPayment })
    ).resolves.toBe(0);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]!.values).toEqual({ updatedAt: NOW });
  });

  it("rechecks the lease before transport and records exact known payment results", async () => {
    const f = fixture({ due: true });
    const getPayment = vi.fn().mockResolvedValue(payment());
    await expect(
      reconcileRetainedLegacyPayments(LEASE, NOW, { getPayment })
    ).resolves.toBe(1);
    expect(getPayment).toHaveBeenCalledExactlyOnceWith(PAYMENT_ID);
    expect(mocks.assertLease).toHaveBeenCalledBefore(getPayment);
    expect(mocks.assertTransactionLease).toHaveBeenCalledTimes(2);
    expect(f.writes[0]!.values).toEqual({ updatedAt: NOW });
    expect(
      f.writes.some(
        write => write.values.processingResult === "legacy_financial_recorded"
      )
    ).toBe(true);
  });

  it("does not contact Mollie after its lease has been revoked", async () => {
    fixture({ due: true });
    mocks.assertLease.mockRejectedValueOnce(new Error("lease lost"));
    const getPayment = vi.fn();
    await expect(
      reconcileRetainedLegacyPayments(LEASE, NOW, { getPayment })
    ).rejects.toThrow("lease lost");
    expect(getPayment).not.toHaveBeenCalled();
  });

  it("bounds failed provider reads without exposing private details", async () => {
    const f = fixture({ due: true });
    const getPayment = vi
      .fn()
      .mockRejectedValue(new Error("secret provider token"));
    await expect(
      reconcileRetainedLegacyPayments(LEASE, NOW, { getPayment })
    ).resolves.toBe(0);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]!.values).toEqual({ updatedAt: NOW });
    expect(mocks.log).toHaveBeenCalledWith(
      "legacy_payment_financial_drain_retryable",
      { level: "warn", errorCode: "Error" }
    );
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain(
      "secret provider token"
    );
  });
});
