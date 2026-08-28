import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDatabaseOrThrowMock } = vi.hoisted(() => ({
  getDatabaseOrThrowMock: vi.fn(),
}));

vi.mock("../../db", () => ({
  getDatabaseOrThrow: getDatabaseOrThrowMock,
}));

import type { MolliePayment } from "./mollieClient";
import { PREMIUM_IMAGE_CREDIT_OFFER_ID } from "./creditCatalog";
import {
  hasCreditPaymentFinancialAdjustment,
  isCreditPaymentGrantComplete,
  resolveCreditPaymentOccurredAt,
  shouldPreservePendingCreditGrantSnapshot,
} from "./creditPaymentWebhookStore";

const basePayment = {
  resource: "payment",
  id: "tr_credit1",
  mode: "test",
  status: "paid",
  amount: { currency: "EUR", value: "4.99" },
  description: "Leaderbot - 8 premium beeldcredits",
  method: "bancontact",
  sequenceType: "oneoff",
  customerId: null,
  mandateId: null,
  subscriptionId: null,
  metadata: {},
  createdAt: "2026-08-28T10:00:00.000Z",
  paidAt: "2026-08-28T10:01:00.000Z",
} satisfies MolliePayment;

beforeEach(() => {
  getDatabaseOrThrowMock.mockReset();
});

describe("credit payment webhook timestamp policy", () => {
  it("requires the provider paid timestamp before a paid grant is possible", () => {
    expect(
      resolveCreditPaymentOccurredAt({
        status: "paid",
        createdAt: "2026-08-28T10:00:00.000Z",
      })
    ).toBeNull();
    expect(
      resolveCreditPaymentOccurredAt({
        status: "paid",
        createdAt: "2026-08-28T10:00:00.000Z",
        paidAt: "2026-08-28T10:01:00.000Z",
      })
    ).toEqual(new Date("2026-08-28T10:01:00.000Z"));
  });

  it("rejects any malformed provider timestamp", () => {
    expect(
      resolveCreditPaymentOccurredAt({
        status: "failed",
        createdAt: "2026-08-28T10:00:00.000Z",
        failedAt: "not-a-date",
      })
    ).toBeNull();
  });

  it.each([
    ["failed", "failedAt"],
    ["canceled", "canceledAt"],
    ["expired", "expiredAt"],
  ] as const)("uses the exact %s terminal timestamp", (status, field) => {
    const value = "2026-08-28T10:02:00.000Z";
    expect(
      resolveCreditPaymentOccurredAt({
        status,
        createdAt: "2026-08-28T10:00:00.000Z",
        [field]: value,
      })
    ).toEqual(new Date(value));
  });
});

describe("credit payment pre-grant financial adjustment fence", () => {
  it("allows a paid snapshot without refunds or chargebacks", () => {
    expect(hasCreditPaymentFinancialAdjustment(basePayment)).toBe(false);
  });

  it("accepts Mollie's explicit zero refunded amount on a normal payment", () => {
    expect(
      hasCreditPaymentFinancialAdjustment({
        ...basePayment,
        amountRefunded: { currency: "EUR", value: "0.00" },
      })
    ).toBe(false);
  });

  it.each([
    { currency: "USD", value: "0.00" },
    { currency: "EUR", value: "invalid" },
  ])("fails closed for malformed refunded amount evidence", amountRefunded => {
    expect(
      hasCreditPaymentFinancialAdjustment({
        ...basePayment,
        amountRefunded,
      })
    ).toBe(true);
  });

  it.each([
    {
      _embedded: {
        refunds: [
          {
            id: "re_credit_1",
            status: "refunded",
            amount: { currency: "EUR", value: "4.99" },
          },
        ],
      },
    },
    {
      _embedded: {
        chargebacks: [
          {
            id: "chb_credit_1",
            amount: { currency: "EUR", value: "4.99" },
          },
        ],
      },
    },
    { amountRefunded: { currency: "EUR", value: "4.99" } },
  ])(
    "blocks a paid snapshot that already contains a provider adjustment",
    extra => {
      expect(
        hasCreditPaymentFinancialAdjustment({ ...basePayment, ...extra })
      ).toBe(true);
    }
  );

  it("preserves an ordinary duplicate while a paid grant is pending", () => {
    expect(
      shouldPreservePendingCreditGrantSnapshot(
        { status: "paid", paidEffectApplied: 0 },
        basePayment
      )
    ).toBe(true);
  });

  it.each([
    {
      _embedded: {
        refunds: [
          {
            id: "re_credit_1",
            status: "refunded",
            amount: { currency: "EUR", value: "4.99" },
          },
        ],
      },
    },
    {
      _embedded: {
        chargebacks: [
          {
            id: "chb_credit_1",
            amount: { currency: "EUR", value: "4.99" },
          },
        ],
      },
    },
    { amountRefunded: { currency: "EUR", value: "4.99" } },
  ])(
    "replaces pending grant evidence when an adjustment arrives",
    adjustment => {
      expect(
        shouldPreservePendingCreditGrantSnapshot(
          { status: "paid", paidEffectApplied: 0 },
          { ...basePayment, ...adjustment }
        )
      ).toBe(false);
    }
  );
});

describe("credit payment browser completion evidence", () => {
  const completion = {
    workspaceId: 11,
    mode: "test" as const,
    intentId: "22222222-2222-2222-2222-222222222222",
    providerPaymentId: "tr_credit1",
    walletId: "11111111-1111-1111-1111-111111111111",
    metadataHash: "d".repeat(64),
  };

  it("fails closed before touching the database for malformed scope", async () => {
    await expect(
      isCreditPaymentGrantComplete({ ...completion, providerPaymentId: "bad" })
    ).resolves.toBe(false);
    expect(getDatabaseOrThrowMock).not.toHaveBeenCalled();
  });

  it("requires one exact joined payment-effect and purchase-grant row", async () => {
    const limit = vi.fn(async () => [{ entryId: "grant-entry" }]);
    const where = vi.fn(() => ({ limit }));
    const innerJoin = vi.fn(() => ({ where }));
    const from = vi.fn(() => ({ innerJoin }));
    const select = vi.fn(() => ({ from }));
    getDatabaseOrThrowMock.mockResolvedValue({ select });

    await expect(isCreditPaymentGrantComplete(completion)).resolves.toBe(true);
    expect(limit).toHaveBeenCalledWith(2);
    const predicate = where.mock.calls[0]?.[0];
    const compiled = new MySqlDialect().sqlToQuery(predicate);
    expect(compiled.sql).toContain("`payment_ledger`.`workspace_id` = ?");
    expect(compiled.sql).toContain(
      "`payment_ledger`.`paid_effect_applied` = ?"
    );
    expect(compiled.sql).toContain(
      "`payment_ledger`.`credit_metadata_hash` = ?"
    );
    expect(compiled.sql).toContain("`credit_ledger`.`entry_kind` = ?");
    expect(compiled.sql).toContain("`credit_ledger`.`grant_payment_id` = ?");
    expect(compiled.params).toEqual(
      expect.arrayContaining([
        11,
        "test",
        "tr_credit1",
        "paid",
        1,
        "credit_grant",
        completion.intentId,
        "premium_image_credits",
        completion.walletId,
        completion.metadataHash,
        "purchase_grant",
        PREMIUM_IMAGE_CREDIT_OFFER_ID,
        "4.99",
        "EUR",
        8,
      ])
    );
  });

  it("fails closed when the joined evidence is absent or duplicated", async () => {
    for (const rows of [[], [{ entryId: "one" }, { entryId: "two" }]]) {
      const limit = vi.fn(async () => rows);
      const where = vi.fn(() => ({ limit }));
      const innerJoin = vi.fn(() => ({ where }));
      const from = vi.fn(() => ({ innerJoin }));
      getDatabaseOrThrowMock.mockResolvedValueOnce({
        select: vi.fn(() => ({ from })),
      });
      await expect(isCreditPaymentGrantComplete(completion)).resolves.toBe(
        false
      );
    }
  });
});
