import { describe, expect, it } from "vitest";

import {
  FakeMollieAccountingReader,
  planDescendingAccountingPage,
  validateAccountingEvent,
} from "./accountingImporter";

describe("credential-free Mollie accounting reader", () => {
  it("replays deterministic GET-only pages without provider credentials", async () => {
    const event = accountingEvent();
    const reader = new FakeMollieAccountingReader([
      { events: [event], nextCursor: "cursor-2" },
      { events: [], nextCursor: null },
    ]);

    await expect(
      reader.listEvents({ mode: "test", cursor: null })
    ).resolves.toEqual({
      events: [event],
      nextCursor: "cursor-2",
    });
    await expect(
      reader.listEvents({ mode: "test", cursor: "cursor-2" })
    ).resolves.toEqual({ events: [], nextCursor: null });
  });

  it("accepts only canonical EUR metadata events", () => {
    expect(validateAccountingEvent(accountingEvent())).toEqual(
      accountingEvent()
    );
    expect(() =>
      validateAccountingEvent(
        accountingEvent({ amount: { currency: "EUR", value: "1" } })
      )
    ).toThrow("billing_accounting_data_quality");
    expect(() =>
      validateAccountingEvent(
        accountingEvent({ amount: { currency: "USD" as "EUR", value: "1.00" } })
      )
    ).toThrow("billing_accounting_data_quality");
  });

  it("accepts signed refund, chargeback, and fee adjustments", () => {
    for (const type of ["refund", "chargeback", "fee"] as const) {
      expect(
        validateAccountingEvent(
          accountingEvent({
            type,
            amount: { currency: "EUR", value: "-10.00" },
            netAmount: { currency: "EUR", value: "-10.25" },
            deductionAmount: { currency: "EUR", value: "0.25" },
          })
        )
      ).toEqual(expect.objectContaining({ type }));
    }
  });

  it("enforces event-type sign contracts", () => {
    expect(() =>
      validateAccountingEvent(
        accountingEvent({ amount: { currency: "EUR", value: "-1.00" } })
      )
    ).toThrow("billing_accounting_data_quality");
    for (const type of ["refund", "chargeback", "fee"] as const) {
      expect(() =>
        validateAccountingEvent(
          accountingEvent({
            type,
            amount: { currency: "EUR", value: "1.00" },
          })
        )
      ).toThrow("billing_accounting_data_quality");
    }
  });

  it("requires net amount to equal signed gross less deductions", () => {
    expect(() =>
      validateAccountingEvent(
        accountingEvent({
          type: "refund",
          amount: { currency: "EUR", value: "-10.00" },
          netAmount: { currency: "EUR", value: "-10.25" },
          deductionAmount: { currency: "EUR", value: "0.25" },
        })
      )
    ).not.toThrow();
    expect(() =>
      validateAccountingEvent(
        accountingEvent({
          amount: { currency: "EUR", value: "10.00" },
          netAmount: { currency: "EUR", value: "10.00" },
          deductionAmount: { currency: "EUR", value: "0.25" },
        })
      )
    ).toThrow("billing_accounting_data_quality");
  });

  it("rejects malformed provider IDs and timestamps before persistence", () => {
    expect(() =>
      validateAccountingEvent(accountingEvent({ id: "bad" }))
    ).toThrow("billing_accounting_data_quality");
    expect(() =>
      validateAccountingEvent(accountingEvent({ occurredAt: "not-a-date" }))
    ).toThrow("billing_accounting_data_quality");
    expect(() =>
      validateAccountingEvent(
        accountingEvent({ occurredAt: "2026-02-30T10:00:00.000Z" })
      )
    ).toThrow("billing_accounting_data_quality");
    expect(() =>
      validateAccountingEvent(
        accountingEvent({ occurredAt: "2026-08-18T10:00:00Z" })
      )
    ).toThrow("billing_accounting_data_quality");
    expect(() =>
      validateAccountingEvent(
        accountingEvent({ paymentId: "customer-private" })
      )
    ).toThrow("billing_accounting_data_quality");
  });
});

describe("newest-first accounting watermark", () => {
  it("starts at the head again and imports events newer than the prior watermark", () => {
    const newer = accountingEvent({ id: "bal_evt_new" });
    const prior = accountingEvent({ id: "bal_evt_prior" });
    const plan = planDescendingAccountingPage({
      events: [newer, prior],
      nextCursor: "older-page",
      previousHighWater: prior.id,
      pendingHighWater: null,
    });

    expect(plan.eventsToApply.map(event => event.id)).toEqual([newer.id]);
    expect(plan.completed).toBe(true);
    expect(plan.resumeCursor).toBeNull();
    expect(plan.nextHighWater).toBe(newer.id);
  });

  it("resumes a crashed page chain and preserves its original head", () => {
    const head = accountingEvent({ id: "bal_evt_head" });
    const middle = accountingEvent({ id: "bal_evt_middle" });
    const prior = accountingEvent({ id: "bal_evt_prior" });
    const first = planDescendingAccountingPage({
      events: [head, middle],
      nextCursor: "page-2",
      previousHighWater: prior.id,
      pendingHighWater: null,
    });
    expect(first.completed).toBe(false);
    expect(first.resumeCursor).toBe("page-2");
    expect(first.pendingHighWater).toBe(head.id);

    const resumed = planDescendingAccountingPage({
      events: [prior],
      nextCursor: "page-3",
      previousHighWater: prior.id,
      pendingHighWater: first.pendingHighWater,
    });
    expect(resumed.eventsToApply).toEqual([]);
    expect(resumed.completed).toBe(true);
    expect(resumed.nextHighWater).toBe(head.id);
    expect(resumed.resumeCursor).toBeNull();
  });

  it("allows duplicate head replay to complete without re-applying it", () => {
    const prior = accountingEvent({ id: "bal_evt_prior" });
    const plan = planDescendingAccountingPage({
      events: [prior],
      nextCursor: "older-page",
      previousHighWater: prior.id,
      pendingHighWater: null,
    });
    expect(plan.eventsToApply).toEqual([]);
    expect(plan.nextHighWater).toBe(prior.id);
  });
});

function accountingEvent(
  overrides: Partial<Parameters<typeof validateAccountingEvent>[0]> = {}
) {
  return {
    id: "bal_evt_123",
    type: "payment" as const,
    amount: { currency: "EUR" as const, value: "19.00" },
    occurredAt: "2026-08-18T10:00:00.000Z",
    paymentId: "tr_payment123",
    ...overrides,
  };
}
