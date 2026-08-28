import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  billingExecutionControls,
  billingIntents,
  billingOutbox,
  billingProviderOperations,
  billingWebhookRoutes,
  creditWallets,
  type BillingOutboxItem,
} from "../../../drizzle/schema";
import {
  cancelCustomerlessCreditPayment,
  CreditPaymentRecoveryError,
  enqueueDueCustomerlessCreditPaymentRecoveries,
  reconcileCustomerlessCreditPayment,
} from "./creditPaymentRecovery";
import { MollieApiError, type MollieClient } from "./mollieClient";

const { getDatabaseOrThrowMock } = vi.hoisted(() => ({
  getDatabaseOrThrowMock: vi.fn(),
}));

vi.mock("../../db", () => ({
  getDatabaseOrThrow: getDatabaseOrThrowMock,
}));

const WORKSPACE_ID = 42;
const INTENT_ID = "22222222-2222-8222-8222-222222222222";
const OPERATION_ID = "33333333-3333-4333-8333-333333333333";
const WALLET_ID = "11111111-1111-8111-8111-111111111111";
const PAYMENT_ID = "tr_creditpayment1";
const METADATA_HASH = "d".repeat(64);
const FINANCIAL_REF = "b".repeat(64);
const STARTED_AT = new Date("2026-08-28T08:00:00.000Z");

function creditPayload(paymentId: string | null = PAYMENT_ID) {
  return {
    reason: "billing_execution_disabled",
    intentId: INTENT_ID,
    targetCustomerId: null,
    targetPaymentId: paymentId,
    providerOperationId: OPERATION_ID,
    revokedAuthorizationEpoch: 2,
    creditPurpose: "premium_image_credits",
    creditWalletId: WALLET_ID,
    creditMetadataHash: METADATA_HASH,
    channelConnectionId: 7,
    bindingEpoch: 3,
    privacyEpoch: 4,
  };
}

function job(paymentId: string | null = PAYMENT_ID) {
  return {
    workspaceId: WORKSPACE_ID,
    mode: "test",
    payload: creditPayload(paymentId),
    leaseToken: "lease",
  } as BillingOutboxItem & { leaseToken: string };
}

function exactIntent(patch: Record<string, unknown> = {}) {
  return {
    intentId: INTENT_ID,
    workspaceId: WORKSPACE_ID,
    mode: "test",
    kind: "credit_purchase",
    planCode: "premium_images_8_medium_v1",
    expectedAmount: "4.99",
    currency: "EUR",
    interval: "oneoff",
    mollieDescription: "Leaderbot - 8 premium beeldcredits",
    status: "contained",
    molliePaymentId: PAYMENT_ID,
    billingProfileVersion: 0,
    authorizationEpoch: 2,
    messengerChannelConnectionId: 7,
    messengerBindingEpoch: 3,
    messengerPrivacyEpoch: 4,
    creditWalletId: WALLET_ID,
    creditFinancialSubjectRef: FINANCIAL_REF,
    creditCount: 8,
    creditMetadataHash: METADATA_HASH,
    ...patch,
  };
}

function exactOperation(patch: Record<string, unknown> = {}) {
  return {
    operationId: OPERATION_ID,
    workspaceId: WORKSPACE_ID,
    mode: "test",
    operationType: "create_payment",
    operationKey: INTENT_ID,
    intentId: INTENT_ID,
    billingProfileVersion: 0,
    authorizationEpoch: 2,
    state: "contained",
    requestFingerprint: METADATA_HASH,
    providerResourceId: PAYMENT_ID,
    providerCustomerId: null,
    credentialGenerationId: "credential-v1",
    firstStartedAt: STARTED_AT,
    ...patch,
  };
}

function exactPayment(patch: Record<string, unknown> = {}) {
  return {
    resource: "payment" as const,
    id: PAYMENT_ID,
    mode: "test" as const,
    status: "open",
    amount: { currency: "EUR", value: "4.99" },
    description: "Leaderbot - 8 premium beeldcredits",
    method: "bancontact",
    sequenceType: "oneoff" as const,
    customerId: null,
    subscriptionId: null,
    mandateId: null,
    metadata: {
      billingIntentId: INTENT_ID,
      purpose: "premium_image_credits",
      version: 1,
      metadataHash: METADATA_HASH,
    },
    createdAt: "2026-08-28T08:00:01.000Z",
    ...patch,
  };
}

function harness(
  options: {
    control?: Record<string, unknown>;
    intent?: Record<string, unknown>;
    wallet?: Record<string, unknown>;
    operation?: Record<string, unknown>;
    route?: Record<string, unknown>;
  } = {}
) {
  const inserts: Array<{ table: object; value: Record<string, unknown> }> = [];
  const updates: Array<{ table: object; value: Record<string, unknown> }> = [];
  const rowsFor = (table: object): unknown[] => {
    if (table === billingExecutionControls) {
      return [
        options.control ?? {
          commercialEnabled: false,
          authorizationEpoch: 3,
        },
      ];
    }
    if (table === creditWallets) {
      return [
        options.wallet ?? {
          walletId: WALLET_ID,
          workspaceId: WORKSPACE_ID,
          mode: "test",
          channelConnectionId: 7,
          bindingEpoch: 3,
          privacyEpoch: 4,
          financialSubjectRef: FINANCIAL_REF,
        },
      ];
    }
    if (table === billingIntents) {
      return [options.intent ?? exactIntent()];
    }
    if (table === billingProviderOperations) {
      return [options.operation ?? exactOperation()];
    }
    if (table === billingWebhookRoutes) {
      return [
        options.route ?? {
          workspaceId: WORKSPACE_ID,
          intentId: INTENT_ID,
        },
      ];
    }
    return [];
  };
  const tx = {
    select: vi.fn(() => ({
      from: vi.fn((table: object) => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => ({
            for: vi.fn(async () => rowsFor(table)),
          })),
        })),
      })),
    })),
    update: vi.fn((table: object) => ({
      set: vi.fn((value: Record<string, unknown>) => {
        updates.push({ table, value });
        return { where: vi.fn(async () => [{ affectedRows: 1 }]) };
      }),
    })),
    insert: vi.fn((table: object) => ({
      values: vi.fn((value: Record<string, unknown>) => {
        inserts.push({ table, value });
        return {
          onDuplicateKeyUpdate: vi.fn(async () => undefined),
        };
      }),
    })),
  };
  return {
    database: { transaction: vi.fn(async callback => callback(tx)) },
    inserts,
    updates,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MOLLIE_API_KEY = `test_${"a".repeat(32)}`;
  process.env.MOLLIE_MODE = "test";
  process.env.APP_BASE_URL = "http://leaderbot.test";
  process.env.MOLLIE_PAYMENT_WEBHOOK_URL =
    "http://billing.test/api/webhooks/mollie/payments";
  process.env.BILLING_SUPPORT_EMAIL = "billing@leaderbot.test";
});

describe("customerless premium-credit payment recovery", () => {
  it("cancels one exact open Payment after proving every local and provider binding", async () => {
    const state = harness();
    getDatabaseOrThrowMock.mockResolvedValue(state.database);
    const cancelPayment = vi.fn().mockResolvedValue(undefined);

    await expect(
      cancelCustomerlessCreditPayment(job(), {
        getPayment: vi.fn().mockResolvedValue(exactPayment()),
        cancelPayment,
      } as unknown as MollieClient)
    ).resolves.toBeUndefined();

    expect(cancelPayment).toHaveBeenCalledOnce();
    expect(cancelPayment).toHaveBeenCalledWith(PAYMENT_ID);
  });

  it.each([
    ["tenant", { route: { workspaceId: 99, intentId: INTENT_ID } }],
    ["intent", { intent: exactIntent({ intentId: "wrong" }) }],
    ["epoch", { operation: exactOperation({ authorizationEpoch: 9 }) }],
    ["wallet", { intent: exactIntent({ creditWalletId: "wrong" }) }],
    [
      "metadata",
      { operation: exactOperation({ requestFingerprint: "e".repeat(64) }) },
    ],
    ["channel", { intent: exactIntent({ messengerChannelConnectionId: 99 }) }],
    [
      "binding",
      {
        wallet: {
          channelConnectionId: 7,
          bindingEpoch: 99,
          privacyEpoch: 4,
          financialSubjectRef: FINANCIAL_REF,
        },
      },
    ],
    ["privacy", { intent: exactIntent({ messengerPrivacyEpoch: 99 }) }],
    [
      "resource",
      { operation: exactOperation({ providerResourceId: "tr_other" }) },
    ],
  ] as const)(
    "rejects a %s mismatch without provider DELETE",
    async (_name, options) => {
      const state = harness(options);
      getDatabaseOrThrowMock.mockResolvedValue(state.database);
      const cancelPayment = vi.fn();

      await expect(
        cancelCustomerlessCreditPayment(job(), {
          getPayment: vi.fn().mockResolvedValue(exactPayment()),
          cancelPayment,
        } as unknown as MollieClient)
      ).rejects.toMatchObject({
        code: "credit_payment_cancellation_local_scope_mismatch",
        retryable: false,
      });
      expect(cancelPayment).not.toHaveBeenCalled();
    }
  );
});

describe("customerless credit Payment provider verification", () => {
  it("rejects remote metadata drift without DELETE", async () => {
    const state = harness();
    getDatabaseOrThrowMock.mockResolvedValue(state.database);
    const cancelPayment = vi.fn();
    await expect(
      cancelCustomerlessCreditPayment(job(), {
        getPayment: vi.fn().mockResolvedValue(
          exactPayment({
            metadata: {
              billingIntentId: INTENT_ID,
              purpose: "premium_image_credits",
              version: 1,
              metadataHash: "e".repeat(64),
            },
          })
        ),
        cancelPayment,
      } as unknown as MollieClient)
    ).rejects.toMatchObject({
      code: "credit_payment_cancellation_provider_scope_mismatch",
    });
    expect(cancelPayment).not.toHaveBeenCalled();
  });

  it("treats provider 404 as idempotent only after exact local proof", async () => {
    const state = harness();
    getDatabaseOrThrowMock.mockResolvedValue(state.database);
    await expect(
      cancelCustomerlessCreditPayment(job(), {
        getPayment: vi
          .fn()
          .mockRejectedValue(new MollieApiError(404, "not_found")),
        cancelPayment: vi.fn(),
      } as unknown as MollieClient)
    ).resolves.toBeUndefined();
  });
});

describe("customerless credit Payment ambiguity", () => {
  it("reconciles multiple exact open customerless Payments into deterministic cancels", async () => {
    const state = harness({
      operation: exactOperation({
        state: "reconciliation_only",
        providerResourceId: null,
      }),
      intent: exactIntent({ status: "contained", molliePaymentId: null }),
    });
    getDatabaseOrThrowMock.mockResolvedValue(state.database);
    const secondId = "tr_creditpayment2";
    const client = {
      listPayments: vi.fn().mockResolvedValue([
        exactPayment(),
        exactPayment({ id: secondId }),
        exactPayment({
          id: "tr_recurring",
          sequenceType: "recurring",
          subscriptionId: "sub_other",
        }),
      ]),
    } as unknown as MollieClient;

    await reconcileCustomerlessCreditPayment(job(null), client, STARTED_AT);
    const firstOperationIds = state.inserts
      .filter(item => item.table === billingProviderOperations)
      .map(item => item.value.operationId);
    expect(firstOperationIds).toHaveLength(2);
    expect(
      state.inserts.filter(
        item =>
          item.table === billingOutbox &&
          item.value.eventType === "cancel_payment"
      )
    ).toHaveLength(2);

    const replay = harness({
      operation: exactOperation({
        state: "contained",
        providerResourceId: null,
      }),
      intent: exactIntent({ status: "contained", molliePaymentId: null }),
    });
    getDatabaseOrThrowMock.mockResolvedValue(replay.database);
    await reconcileCustomerlessCreditPayment(job(null), client, STARTED_AT);
    expect(
      replay.inserts
        .filter(item => item.table === billingProviderOperations)
        .map(item => item.value.operationId)
    ).toEqual(firstOperationIds);
  });

  it("keeps a late pending result retryable and never schedules DELETE", async () => {
    const state = harness({
      operation: exactOperation({
        state: "reconciliation_only",
        providerResourceId: null,
      }),
      intent: exactIntent({ status: "contained", molliePaymentId: null }),
    });
    getDatabaseOrThrowMock.mockResolvedValue(state.database);
    await expect(
      reconcileCustomerlessCreditPayment(
        job(null),
        {
          listPayments: vi
            .fn()
            .mockResolvedValue([exactPayment({ status: "pending" })]),
        } as unknown as MollieClient,
        STARTED_AT
      )
    ).rejects.toMatchObject({
      code: "credit_payment_reconciliation_not_terminal",
      retryable: true,
    });
    expect(state.inserts).toEqual([]);
  });
});

describe("customerless credit Payment replay safety", () => {
  it("completes a stale null-target job after an atomic known containment", async () => {
    const state = harness({
      operation: exactOperation({
        state: "contained",
        providerResourceId: PAYMENT_ID,
      }),
      intent: exactIntent({ status: "contained", molliePaymentId: PAYMENT_ID }),
    });
    getDatabaseOrThrowMock.mockResolvedValue(state.database);
    const listPayments = vi.fn();

    await expect(
      reconcileCustomerlessCreditPayment(
        job(null),
        { listPayments } as unknown as MollieClient,
        STARTED_AT
      )
    ).resolves.toBeUndefined();

    expect(listPayments).not.toHaveBeenCalled();
    expect(state.inserts).toEqual([]);
  });

  it("does not match a recurring payment that reuses the metadata", async () => {
    const state = harness({
      operation: exactOperation({
        state: "reconciliation_only",
        providerResourceId: null,
      }),
      intent: exactIntent({ status: "contained", molliePaymentId: null }),
    });
    getDatabaseOrThrowMock.mockResolvedValue(state.database);
    await expect(
      reconcileCustomerlessCreditPayment(
        job(null),
        {
          listPayments: vi.fn().mockResolvedValue([
            exactPayment({
              sequenceType: "recurring",
              subscriptionId: "sub_other",
            }),
          ]),
        } as unknown as MollieClient,
        STARTED_AT
      )
    ).rejects.toBeInstanceOf(CreditPaymentRecoveryError);
    expect(state.inserts).toEqual([]);
  });
});

describe("customerless credit Payment due recovery", () => {
  it("enqueues exact authorized reconciliation after the generic due resolver", async () => {
    const intent = exactIntent({
      status: "api_unknown",
      molliePaymentId: null,
    });
    const rows = [
      [{ commercialEnabled: true, authorizationEpoch: 2 }],
      [intent],
      [
        {
          operationId: OPERATION_ID,
          intentId: INTENT_ID,
          authorizationEpoch: 2,
          requestFingerprint: METADATA_HASH,
          providerCustomerId: null,
        },
      ],
    ];
    let selected = 0;
    const inserts: Record<string, unknown>[] = [];
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            const result = rows[selected++] ?? [];
            const locked = vi.fn(async () => result);
            return {
              limit: vi.fn(() => ({
                for: locked,
              })),
              orderBy: vi.fn(() => ({
                limit: vi.fn(() => ({ for: locked })),
              })),
            };
          }),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn((value: Record<string, unknown>) => {
          inserts.push(value);
          return {
            onDuplicateKeyUpdate: vi.fn(async () => undefined),
          };
        }),
      })),
    };
    getDatabaseOrThrowMock.mockResolvedValue({
      transaction: vi.fn(async callback => callback(tx)),
    });

    await expect(
      enqueueDueCustomerlessCreditPaymentRecoveries(
        WORKSPACE_ID,
        "test",
        STARTED_AT
      )
    ).resolves.toBe(1);
    expect(inserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "cancel_payment",
          payload: expect.objectContaining({
            reason: "credit_payment_provider_ambiguous",
            targetCustomerId: null,
            targetPaymentId: null,
            providerOperationId: OPERATION_ID,
            authorizationEpoch: 2,
            creditPurpose: "premium_image_credits",
          }),
        }),
        expect.objectContaining({
          eventType: "manual_review",
          payload: expect.objectContaining({
            reason: "payment_provider_ambiguous_after_disable",
          }),
        }),
      ])
    );
  });
});
