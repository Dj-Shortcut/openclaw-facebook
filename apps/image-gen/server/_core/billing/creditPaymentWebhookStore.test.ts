import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDatabaseOrThrowMock } = vi.hoisted(() => ({
  getDatabaseOrThrowMock: vi.fn(),
}));

vi.mock("../../db", () => ({
  getDatabaseOrThrow: getDatabaseOrThrowMock,
}));

import type { MolliePayment } from "./mollieClient";
import {
  getCreditOffer,
  LEGACY_PREMIUM_IMAGE_CREDIT_OFFER_ID,
  LEGACY_PREMIUM_IMAGE_CREDIT_OFFER_VERSION,
  PREMIUM_IMAGE_CREDIT_OFFER_ID,
  PREMIUM_IMAGE_CREDIT_OFFER_VERSION,
} from "./creditCatalog";
import {
  classifyCreditPaymentFinancialAdjustmentState,
  classifyCreditPaymentAdjustment,
  hasCreditPaymentFinancialAdjustment,
  isCreditPaymentGrantComplete,
  persistCreditPaymentWebhookSnapshot,
  resolveCreditPaymentOccurredAt,
  shouldApplyPersistedCreditPaymentSnapshot,
  shouldPreservePendingCreditGrantSnapshot,
  shouldRecoverPersistedCreditPaymentGrant,
} from "./creditPaymentWebhookStore";

const ADJUSTMENT_HASH = "e".repeat(64);
const legacyOffer = getCreditOffer(
  LEGACY_PREMIUM_IMAGE_CREDIT_OFFER_ID,
  LEGACY_PREMIUM_IMAGE_CREDIT_OFFER_VERSION
)!;
const currentOffer = getCreditOffer(
  PREMIUM_IMAGE_CREDIT_OFFER_ID,
  PREMIUM_IMAGE_CREDIT_OFFER_VERSION
)!;

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

  it.each(["failed", "canceled"])(
    "does not freeze credits for a %s refund attempt",
    status => {
      const payment = {
        ...basePayment,
        amountRefunded: { currency: "EUR", value: "0.00" },
        _embedded: {
          refunds: [
            {
              id: `re_${status}`,
              status,
              amount: { currency: "EUR", value: "4.99" },
            },
          ],
        },
      };
      expect(classifyCreditPaymentFinancialAdjustmentState(payment)).toBe(
        "none"
      );
      expect(hasCreditPaymentFinancialAdjustment(payment)).toBe(false);
    }
  );

  it.each(["queued", "pending", "processing"])(
    "keeps a %s refund pending without calling it completed",
    status => {
      const payment = {
        ...basePayment,
        _embedded: {
          refunds: [
            {
              id: `re_${status}`,
              status,
              amount: { currency: "EUR", value: "4.99" },
            },
          ],
        },
      };
      expect(classifyCreditPaymentFinancialAdjustmentState(payment)).toBe(
        "pending"
      );
      expect(hasCreditPaymentFinancialAdjustment(payment)).toBe(true);
    }
  );

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

describe("credit payment snapshot monotonicity", () => {
  it("does not apply an older delivery after persistence keeps terminal evidence", () => {
    expect(
      shouldApplyPersistedCreditPaymentSnapshot("a".repeat(64), "b".repeat(64))
    ).toBe(false);
  });

  it("continues processing the exact snapshot accepted by the ledger", () => {
    const snapshotHash = "a".repeat(64);
    expect(
      shouldApplyPersistedCreditPaymentSnapshot(snapshotHash, snapshotHash)
    ).toBe(true);
  });

  it("recovers an unfinished grant from a later non-adjustment observation", () => {
    expect(
      shouldRecoverPersistedCreditPaymentGrant(
        { status: "paid", paidEffectApplied: 0 },
        {
          ...basePayment,
          amountRefunded: { currency: "EUR", value: "0.00" },
        }
      )
    ).toBe(true);
  });

  it("can recover from stale open but never from adjusted payment input", () => {
    expect(
      shouldRecoverPersistedCreditPaymentGrant(
        { status: "paid", paidEffectApplied: 0 },
        { ...basePayment, status: "open", paidAt: undefined }
      )
    ).toBe(true);
    expect(
      shouldRecoverPersistedCreditPaymentGrant(
        { status: "paid", paidEffectApplied: 0 },
        {
          ...basePayment,
          amountRefunded: { currency: "EUR", value: "4.99" },
        }
      )
    ).toBe(false);
  });
});

describe("credit payment adjustment classification", () => {
  it("accepts a distinct completed refund set totaling the full €4.99", () => {
    expect(
      classifyCreditPaymentAdjustment({
        offer: legacyOffer,
        snapshotHash: ADJUSTMENT_HASH,
        refunds: [
          {
            id: "re_credit_a",
            status: "refunded",
            amount: { currency: "EUR", value: "2.00" },
          },
          {
            id: "re_credit_b",
            status: "refunded",
            amount: { currency: "EUR", value: "2.99" },
          },
          {
            id: "re_credit_failed",
            status: "failed",
            amount: { currency: "EUR", value: "1.00" },
          },
        ],
        chargebacks: [],
      })
    ).toEqual({
      actionable: true,
      kind: "refund_debit",
      providerEffectIds: ["re_credit_a", "re_credit_b"],
    });
  });

  it("uses the stored v2 €5.00 offer amount for a full refund", () => {
    expect(
      classifyCreditPaymentAdjustment({
        offer: currentOffer,
        snapshotHash: ADJUSTMENT_HASH,
        refunds: [
          {
            id: "re_credit_v2_a",
            status: "refunded",
            amount: { currency: "EUR", value: "2.00" },
          },
          {
            id: "re_credit_v2_b",
            status: "refunded",
            amount: { currency: "EUR", value: "3.00" },
          },
        ],
        chargebacks: [],
      })
    ).toEqual({
      actionable: true,
      kind: "refund_debit",
      providerEffectIds: ["re_credit_v2_a", "re_credit_v2_b"],
    });
  });

  it.each([
    {
      label: "partial",
      refunds: [
        {
          id: "re_partial",
          status: "refunded",
          amount: { currency: "EUR", value: "1.00" },
        },
      ],
      chargebacks: [],
    },
    {
      label: "pending",
      refunds: [
        {
          id: "re_pending",
          status: "pending",
          amount: { currency: "EUR", value: "4.99" },
        },
      ],
      chargebacks: [],
    },
    {
      label: "mixed",
      refunds: [
        {
          id: "re_full",
          status: "refunded",
          amount: { currency: "EUR", value: "4.99" },
        },
      ],
      chargebacks: [
        {
          id: "chb_full",
          amount: { currency: "EUR", value: "4.99" },
          reversedAt: null,
        },
      ],
    },
  ])("contains $label refund evidence", ({ refunds, chargebacks }) => {
    expect(
      classifyCreditPaymentAdjustment({
        offer: legacyOffer,
        snapshotHash: ADJUSTMENT_HASH,
        refunds,
        chargebacks,
      })
    ).toMatchObject({ actionable: false });
  });

  it("accepts exactly one active full chargeback", () => {
    expect(
      classifyCreditPaymentAdjustment({
        offer: legacyOffer,
        snapshotHash: ADJUSTMENT_HASH,
        refunds: [],
        chargebacks: [
          {
            id: "chb_credit_1",
            amount: { currency: "EUR", value: "4.99" },
            reversedAt: null,
          },
        ],
      })
    ).toEqual({
      actionable: true,
      kind: "chargeback_debit",
      providerEffectId: "chb_credit_1",
    });
  });

  it("accepts a reversed chargeback only after its exact debit", () => {
    const providerEffectId = "chb_credit_1";
    const reversed = {
      offer: legacyOffer,
      snapshotHash: ADJUSTMENT_HASH,
      refunds: [],
      chargebacks: [
        {
          id: providerEffectId,
          amount: { currency: "EUR", value: "4.99" },
          reversedAt: "2026-08-28T12:00:00.000Z",
        },
      ],
    } as const;
    expect(classifyCreditPaymentAdjustment(reversed)).toMatchObject({
      actionable: false,
      reason: "restore_without_debit",
    });
    expect(
      classifyCreditPaymentAdjustment({
        ...reversed,
        adjustments: [
          {
            entryId: "44444444-4444-4444-4444-444444444444",
            entryKind: "chargeback_debit",
            providerEffectId,
            providerEffectType: "chargeback",
            providerEffectStatus: "active",
            providerEffectAmount: "4.99",
            providerEffectCurrency: "EUR",
            providerEffectEvidence: null,
            rootAdjustmentSlot: 1,
            evidenceHash: "d".repeat(64),
          },
        ],
      })
    ).toEqual({
      actionable: true,
      kind: "chargeback_restore",
      providerEffectId,
    });
  });

  it("replays the exact immutable refund effect after a later payment snapshot", () => {
    const entryId = "44444444-4444-4444-4444-444444444444";
    const evidenceHash = "d".repeat(64);
    const completedRefund = {
      id: "re_credit_1",
      status: "refunded",
      amount: { currency: "EUR", value: "4.99" },
    };
    expect(
      classifyCreditPaymentAdjustment({
        offer: legacyOffer,
        snapshotHash: ADJUSTMENT_HASH,
        refunds: [completedRefund],
        chargebacks: [],
        adjustments: [
          {
            entryId,
            entryKind: "refund_debit",
            providerEffectId: "f".repeat(64),
            providerEffectType: "refund",
            providerEffectStatus: "refunded",
            providerEffectAmount: "4.99",
            providerEffectCurrency: "EUR",
            providerEffectEvidence: [completedRefund],
            rootAdjustmentSlot: 1,
            evidenceHash,
          },
        ],
      })
    ).toEqual({
      actionable: true,
      kind: "refund_debit",
      providerEffectIds: [completedRefund.id],
      replay: { entryId, evidenceHash },
    });
  });

  it("keeps a changed completed refund effect in review", () => {
    expect(
      classifyCreditPaymentAdjustment({
        offer: legacyOffer,
        snapshotHash: ADJUSTMENT_HASH,
        refunds: [
          {
            id: "re_credit_changed",
            status: "refunded",
            amount: { currency: "EUR", value: "4.99" },
          },
        ],
        chargebacks: [],
        adjustments: [
          {
            entryId: "44444444-4444-4444-4444-444444444444",
            entryKind: "refund_debit",
            providerEffectId: "f".repeat(64),
            providerEffectType: "refund",
            providerEffectStatus: "refunded",
            providerEffectAmount: "4.99",
            providerEffectCurrency: "EUR",
            providerEffectEvidence: [
              {
                id: "re_credit_original",
                status: "refunded",
                amount: { currency: "EUR", value: "4.99" },
              },
            ],
            rootAdjustmentSlot: 1,
            evidenceHash: "d".repeat(64),
          },
        ],
      })
    ).toMatchObject({ actionable: false, reason: "refund_slot_conflict" });
  });

  it("replays exact chargeback debit and restore effects across later snapshots", () => {
    const providerEffectId = "chb_credit_1";
    const debit = {
      entryId: "44444444-4444-4444-4444-444444444444",
      entryKind: "chargeback_debit",
      providerEffectId,
      providerEffectType: "chargeback",
      providerEffectStatus: "active",
      providerEffectAmount: "4.99",
      providerEffectCurrency: "EUR",
      providerEffectEvidence: null,
      rootAdjustmentSlot: 1,
      evidenceHash: "d".repeat(64),
    } as const;
    expect(
      classifyCreditPaymentAdjustment({
        offer: legacyOffer,
        snapshotHash: ADJUSTMENT_HASH,
        refunds: [],
        chargebacks: [
          {
            id: providerEffectId,
            amount: { currency: "EUR", value: "4.99" },
            reversedAt: null,
          },
        ],
        adjustments: [debit],
      })
    ).toEqual({
      actionable: true,
      kind: "chargeback_debit",
      providerEffectId,
      replay: { entryId: debit.entryId, evidenceHash: debit.evidenceHash },
    });

    const restore = {
      ...debit,
      entryId: "55555555-5555-4555-8555-555555555555",
      entryKind: "chargeback_restore",
      providerEffectStatus: "reversed",
      rootAdjustmentSlot: 2,
      evidenceHash: "c".repeat(64),
    } as const;
    expect(
      classifyCreditPaymentAdjustment({
        offer: legacyOffer,
        snapshotHash: ADJUSTMENT_HASH,
        refunds: [],
        chargebacks: [
          {
            id: providerEffectId,
            amount: { currency: "EUR", value: "4.99" },
            reversedAt: "2026-08-28T12:00:00.000Z",
          },
        ],
        adjustments: [debit, restore],
      })
    ).toEqual({
      actionable: true,
      kind: "chargeback_restore",
      providerEffectId,
      replay: {
        entryId: restore.entryId,
        evidenceHash: restore.evidenceHash,
      },
    });
  });
});

describe("credit payment browser completion evidence", () => {
  const legacyIntentSnapshot = {
    planCode: LEGACY_PREMIUM_IMAGE_CREDIT_OFFER_ID,
    expectedAmount: "4.99",
    currency: "EUR",
    creditCount: 8,
    mollieDescription: "Leaderbot - 8 premium beeldcredits",
  };
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
    const intentLimit = vi.fn(async () => [legacyIntentSnapshot]);
    const intentWhere = vi.fn(() => ({ limit: intentLimit }));
    const grantLimit = vi.fn(async () => [{ entryId: "grant-entry" }]);
    const grantWhere = vi.fn(() => ({ limit: grantLimit }));
    const innerJoin = vi.fn(() => ({ where: grantWhere }));
    const select = vi
      .fn()
      .mockReturnValueOnce({
        from: vi.fn(() => ({ where: intentWhere })),
      })
      .mockReturnValueOnce({ from: vi.fn(() => ({ innerJoin })) });
    getDatabaseOrThrowMock.mockResolvedValue({ select });

    await expect(isCreditPaymentGrantComplete(completion)).resolves.toBe(true);
    expect(intentLimit).toHaveBeenCalledWith(2);
    expect(grantLimit).toHaveBeenCalledWith(2);
    const predicate = grantWhere.mock.calls[0]?.[0];
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
        LEGACY_PREMIUM_IMAGE_CREDIT_OFFER_ID,
        "4.99",
        "EUR",
        8,
      ])
    );
  });

  it("fails closed when the joined evidence is absent or duplicated", async () => {
    for (const rows of [[], [{ entryId: "one" }, { entryId: "two" }]]) {
      const select = vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () => [legacyIntentSnapshot]),
            })),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              where: vi.fn(() => ({ limit: vi.fn(async () => rows) })),
            })),
          })),
        });
      getDatabaseOrThrowMock.mockResolvedValueOnce({
        select,
      });
      await expect(isCreditPaymentGrantComplete(completion)).resolves.toBe(
        false
      );
    }
  });

  it("fails closed when the stored offer tuple mixes v1 and v2", async () => {
    const select = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [
            { ...legacyIntentSnapshot, expectedAmount: "5.00" },
          ]),
        })),
      })),
    }));
    getDatabaseOrThrowMock.mockResolvedValue({ select });

    await expect(isCreditPaymentGrantComplete(completion)).resolves.toBe(false);
    expect(select).toHaveBeenCalledOnce();
  });
});

describe("credit payment webhook legacy-route bridge", () => {
  it("returns unknown for a routed non-credit intent without selecting 0017 fields", async () => {
    const selections: unknown[] = [];
    const rowSets = [
      [
        {
          workspaceId: 11,
          intentId: "22222222-2222-2222-2222-222222222222",
        },
      ],
      [
        {
          intentId: "22222222-2222-2222-2222-222222222222",
          workspaceId: 11,
          mode: "test",
          kind: "checkout",
        },
      ],
    ];
    const select = vi.fn((selection?: unknown) => {
      selections.push(selection);
      const rows = rowSets.shift() ?? [];
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => rows),
          })),
        })),
      };
    });
    getDatabaseOrThrowMock.mockResolvedValue({ select });

    await expect(
      persistCreditPaymentWebhookSnapshot({
        webhookPaymentId: basePayment.id,
        expectedMode: "test",
        payment: basePayment,
      })
    ).resolves.toEqual({ result: "unknown" });

    expect(select).toHaveBeenCalledTimes(2);
    expect(
      Object.keys(selections[1] as Record<string, unknown>).sort()
    ).toEqual(["intentId", "kind", "mode", "workspaceId"]);
  });
});
