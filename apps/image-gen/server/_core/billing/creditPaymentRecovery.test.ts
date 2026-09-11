import { createHash } from "node:crypto";

import { MySqlDialect } from "drizzle-orm/mysql-core";
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
  resolveDueCustomerlessCreditPaymentOperations,
} from "./creditPaymentRecovery";
import { MollieApiError, type MollieClient } from "./mollieClient";

const { getDatabaseOrThrowMock, schedulerFenceMock } = vi.hoisted(() => ({
  getDatabaseOrThrowMock: vi.fn(),
  schedulerFenceMock: vi.fn(),
}));

vi.mock("../../db", () => ({
  getDatabaseOrThrow: getDatabaseOrThrowMock,
}));

vi.mock("./billingSchedulerStore", async importOriginal => ({
  ...(await importOriginal<typeof import("./billingSchedulerStore")>()),
  assertBillingTenantLeaseOwnedInTransaction: schedulerFenceMock,
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
    idempotencyKey: "credit-intent-key",
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
    idempotencyKeyHash: createHash("sha256")
      .update("credit-intent-key")
      .digest("hex"),
    providerResourceId: PAYMENT_ID,
    providerCustomerId: null,
    leaseToken: "provider-lease",
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
  it("discovers an exact joined pair before limiting and then locks canonically", async () => {
    const intent = exactIntent({
      status: "api_unknown",
      molliePaymentId: null,
    });
    const operation = {
      operationId: OPERATION_ID,
      intentId: INTENT_ID,
      authorizationEpoch: 2,
      requestFingerprint: METADATA_HASH,
      providerCustomerId: null,
    };
    const rows: readonly unknown[][] = [
      [{ commercialEnabled: true, authorizationEpoch: 2 }],
      [{ operationId: OPERATION_ID, intentId: INTENT_ID }],
      [intent],
      [operation],
    ];
    const inserts: Record<string, unknown>[] = [];
    const joins: unknown[] = [];
    const predicates: unknown[] = [];
    const limits: number[] = [];
    const lockOrder: string[] = [];
    let selected = 0;
    const tx = {
      select: vi.fn(() => {
        const queryIndex = selected++;
        const result = rows[queryIndex] ?? [];
        return {
          from: vi.fn(() => {
            if (queryIndex === 0) {
              return {
                where: vi.fn((predicate: unknown) => {
                  predicates.push(predicate);
                  return {
                    limit: vi.fn((limit: number) => {
                      limits.push(limit);
                      return {
                        for: vi.fn(async () => {
                          lockOrder.push("control");
                          return result;
                        }),
                      };
                    }),
                  };
                }),
              };
            }
            if (queryIndex === 1) {
              return {
                innerJoin: vi.fn((_table: unknown, join: unknown) => {
                  joins.push(join);
                  return {
                    where: vi.fn((predicate: unknown) => {
                      predicates.push(predicate);
                      return {
                        orderBy: vi.fn(() => ({
                          limit: vi.fn(async (limit: number) => {
                            limits.push(limit);
                            return result.slice(0, limit);
                          }),
                        })),
                      };
                    }),
                  };
                }),
              };
            }
            return {
              where: vi.fn((predicate: unknown) => {
                predicates.push(predicate);
                return {
                  orderBy: vi.fn(() => ({
                    for: vi.fn(async () => {
                      lockOrder.push(queryIndex === 2 ? "intent" : "operation");
                      return result;
                    }),
                  })),
                };
              }),
            };
          }),
        };
      }),
      insert: vi.fn(() => ({
        values: vi.fn((value: Record<string, unknown>) => {
          inserts.push(value);
          return { onDuplicateKeyUpdate: vi.fn(async () => undefined) };
        }),
      })),
    };
    getDatabaseOrThrowMock.mockResolvedValue({
      transaction: vi.fn(async callback => callback(tx)),
    });
    schedulerFenceMock.mockImplementation(async () => {
      lockOrder.push("scheduler");
    });

    await expect(
      enqueueDueCustomerlessCreditPaymentRecoveries(
        WORKSPACE_ID,
        "test",
        STARTED_AT,
        {
          workspaceId: WORKSPACE_ID,
          mode: "test",
          kind: "reconciliation",
          leaseToken: "scheduler-lease",
          executionEpoch: 2,
        }
      )
    ).resolves.toBe(1);

    expect(tx.select).toHaveBeenCalledTimes(4);
    expect(joins).toHaveLength(1);
    expect(limits).toEqual([1, 50]);
    expect(lockOrder).toEqual(["control", "intent", "scheduler", "operation"]);
    const dialect = new MySqlDialect();
    const join = dialect.sqlToQuery(joins[0] as never);
    expect(join.sql).toContain("`billing_provider_operations`.`intent_id`");
    expect(join.sql).toContain("`billing_intents`.`intent_id`");
    expect(join.sql).toContain(
      "`billing_provider_operations`.`request_fingerprint`"
    );
    expect(join.sql).toContain("`billing_intents`.`credit_metadata_hash`");
    const due = dialect.sqlToQuery(predicates[1] as never);
    expect(due.sql).toContain("`billing_intents`.`status`");
    expect(due.sql).toContain("`billing_provider_operations`.`state`");
    expect(due.sql).toContain(
      "`billing_provider_operations`.`resolution_due_at`"
    );
    expect(inserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "cancel_payment",
          payload: expect.objectContaining({
            reason: "credit_payment_provider_ambiguous",
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

  it("does not let 51 lower-sorting unmatched intents starve the joined recovery batch", async () => {
    const unmatchedIntents = Array.from({ length: 51 }, (_, index) =>
      exactIntent({
        intentId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        status: "api_unknown",
        molliePaymentId: null,
      })
    );
    const candidates = Array.from({ length: 50 }, (_, index) => {
      const suffix = String(index).padStart(12, "0");
      const intentId = `f0000000-0000-4000-8000-${suffix}`;
      const operationId = `10000000-0000-4000-8000-${suffix}`;
      const metadataHash = index.toString(16).padStart(64, "d");
      return {
        key: { operationId, intentId },
        intent: exactIntent({
          intentId,
          status: "api_unknown",
          molliePaymentId: null,
          creditMetadataHash: metadataHash,
        }),
        operation: {
          operationId,
          intentId,
          authorizationEpoch: 2,
          requestFingerprint: metadataHash,
          providerCustomerId: null,
        },
      };
    });
    const allIntents = [
      ...unmatchedIntents,
      ...candidates.map(candidate => candidate.intent),
    ];
    const inserts: Record<string, unknown>[] = [];
    const lockOrder: string[] = [];
    let selected = 0;
    const lockedRows = (rows: readonly unknown[], stage: string) => ({
      orderBy: vi.fn(() => ({
        for: vi.fn(async () => {
          lockOrder.push(stage);
          return rows;
        }),
      })),
    });
    const tx = {
      select: vi.fn(() => {
        const queryIndex = selected++;
        return {
          from: vi.fn(() => {
            if (queryIndex === 0) {
              return {
                where: vi.fn(() => ({
                  limit: vi.fn(() => ({
                    for: vi.fn(async () => {
                      lockOrder.push("control");
                      return [
                        { commercialEnabled: true, authorizationEpoch: 2 },
                      ];
                    }),
                  })),
                })),
              };
            }
            if (queryIndex === 1) {
              return {
                // The former direct-where path would have selected 50 of the
                // 51 lower IDs and missed every operation-backed intent.
                where: vi.fn(() => ({
                  orderBy: vi.fn(() => ({
                    limit: vi.fn((limit: number) => ({
                      for: vi.fn(async () => allIntents.slice(0, limit)),
                    })),
                  })),
                })),
                innerJoin: vi.fn(() => ({
                  where: vi.fn(() => ({
                    orderBy: vi.fn(() => ({
                      limit: vi.fn(async (limit: number) =>
                        candidates
                          .map(candidate => candidate.key)
                          .slice(0, limit)
                      ),
                    })),
                  })),
                })),
              };
            }
            return {
              where: vi.fn(() =>
                lockedRows(
                  queryIndex === 2
                    ? candidates.map(candidate => candidate.intent)
                    : candidates.map(candidate => candidate.operation),
                  queryIndex === 2 ? "intent" : "operation"
                )
              ),
            };
          }),
        };
      }),
      insert: vi.fn(() => ({
        values: vi.fn((value: Record<string, unknown>) => {
          inserts.push(value);
          return { onDuplicateKeyUpdate: vi.fn(async () => undefined) };
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
    ).resolves.toBe(50);

    expect(tx.select).toHaveBeenCalledTimes(4);
    expect(lockOrder).toEqual(["control", "intent", "operation"]);
    expect(
      inserts.filter(row => row.eventType === "cancel_payment")
    ).toHaveLength(50);
    expect(
      inserts.filter(row => row.eventType === "manual_review")
    ).toHaveLength(50);
  });

  it("does not enqueue when a discovered operation stops being due before its lock", async () => {
    const rows: readonly unknown[][] = [
      [{ commercialEnabled: true, authorizationEpoch: 2 }],
      [{ operationId: OPERATION_ID, intentId: INTENT_ID }],
      [exactIntent({ status: "api_unknown", molliePaymentId: null })],
      [],
    ];
    const inserts: Record<string, unknown>[] = [];
    let selected = 0;
    const tx = {
      select: vi.fn(() => {
        const queryIndex = selected++;
        const result = rows[queryIndex] ?? [];
        return {
          from: vi.fn(() => {
            if (queryIndex === 0) {
              return {
                where: vi.fn(() => ({
                  limit: vi.fn(() => ({
                    for: vi.fn(async () => result),
                  })),
                })),
              };
            }
            if (queryIndex === 1) {
              return {
                innerJoin: vi.fn(() => ({
                  where: vi.fn(() => ({
                    orderBy: vi.fn(() => ({
                      limit: vi.fn(async () => result),
                    })),
                  })),
                })),
              };
            }
            return {
              where: vi.fn(() => ({
                orderBy: vi.fn(() => ({
                  for: vi.fn(async () => result),
                })),
              })),
            };
          }),
        };
      }),
      insert: vi.fn(() => ({
        values: vi.fn((value: Record<string, unknown>) => {
          inserts.push(value);
          return { onDuplicateKeyUpdate: vi.fn(async () => undefined) };
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
    ).resolves.toBe(0);
    expect(tx.select).toHaveBeenCalledTimes(4);
    expect(inserts).toEqual([]);
  });
});

describe("customerless credit Payment provider-fence resolution", () => {
  it("recovers expired pre-transport claims and advances started work before enqueue", async () => {
    const states = ["reserved", "transport_started", "ambiguous"] as const;
    const intents = states.map((state, index) => {
      const suffix = String(index + 1).padStart(12, "0");
      return exactIntent({
        intentId: `22000000-0000-4000-8000-${suffix}`,
        status: state === "ambiguous" ? "api_unknown" : "creating_payment",
        molliePaymentId: null,
        idempotencyKey: `credit-resolution-${index}`,
        creditMetadataHash: index.toString(16).padStart(64, "a"),
      });
    });
    const operations = states.map((state, index) => ({
      operationId: `33000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      operationType: "create_payment",
      operationKey: intents[index]!.intentId,
      intentId: intents[index]!.intentId,
      billingProfileVersion: 0,
      authorizationEpoch: 2,
      state,
      requestFingerprint: intents[index]!.creditMetadataHash,
      idempotencyKeyHash: createHash("sha256")
        .update(intents[index]!.idempotencyKey)
        .digest("hex"),
      providerResourceId: null,
      providerCustomerId: null,
      leaseToken: `provider-lease-${index}`,
      firstStartedAt: state === "reserved" ? null : STARTED_AT,
    }));
    const state = providerResolutionHarness(intents, operations);
    getDatabaseOrThrowMock.mockResolvedValue(state.database);
    schedulerFenceMock.mockImplementation(async () => {
      state.lockOrder.push("scheduler");
    });

    await expect(
      resolveDueCustomerlessCreditPaymentOperations(
        WORKSPACE_ID,
        "test",
        STARTED_AT,
        {
          workspaceId: WORKSPACE_ID,
          mode: "test",
          kind: "reconciliation",
          leaseToken: "scheduler-lease",
          executionEpoch: 2,
        }
      )
    ).resolves.toBe(3);

    expect(state.lockOrder).toEqual([
      "control",
      "intent",
      "scheduler",
      "operation",
    ]);
    expect(
      state.updates
        .filter(update => update.table === billingProviderOperations)
        .map(update => update.value.state)
    ).toEqual(["known_failed", "reconciliation_only", "reconciliation_only"]);
    expect(
      state.updates
        .filter(update => update.table === billingIntents)
        .map(update => update.value.status)
    ).toEqual(["created", "api_unknown", "api_unknown"]);

    const dialect = new MySqlDialect();
    const join = dialect.sqlToQuery(state.joins[0] as never);
    expect(join.sql).toContain("operation_key");
    expect(join.sql).toContain("idempotency_key_hash");
    expect(join.sql).toContain("SHA2");
    const due = dialect.sqlToQuery(state.predicates[1] as never);
    expect(due.params).toEqual(
      expect.arrayContaining([
        "credit_purchase",
        "creating_payment",
        "api_unknown",
        "create_payment",
        "reserved",
        "transport_started",
        "ambiguous",
      ])
    );
  });

  it("does not resolve a selected row whose locked idempotency binding differs", async () => {
    const intent = exactIntent({
      status: "api_unknown",
      molliePaymentId: null,
      idempotencyKey: "exact-idempotency-key",
    });
    const state = providerResolutionHarness(
      [intent],
      [
        {
          ...exactOperation({
            state: "ambiguous",
            providerResourceId: null,
            operationKey: INTENT_ID,
          }),
          idempotencyKeyHash: "f".repeat(64),
          leaseToken: "provider-lease",
        },
      ]
    );
    getDatabaseOrThrowMock.mockResolvedValue(state.database);

    await expect(
      resolveDueCustomerlessCreditPaymentOperations(
        WORKSPACE_ID,
        "test",
        STARTED_AT
      )
    ).resolves.toBe(0);
    expect(state.updates).toEqual([]);
  });

  it("does not cross a disabled commercial authorization boundary", async () => {
    const intent = exactIntent({
      status: "api_unknown",
      molliePaymentId: null,
      idempotencyKey: "disabled-boundary-key",
    });
    const state = providerResolutionHarness(
      [intent],
      [
        {
          ...exactOperation({
            state: "ambiguous",
            providerResourceId: null,
            operationKey: INTENT_ID,
          }),
          idempotencyKeyHash: createHash("sha256")
            .update(intent.idempotencyKey)
            .digest("hex"),
          leaseToken: "provider-lease",
        },
      ],
      false
    );
    getDatabaseOrThrowMock.mockResolvedValue(state.database);

    await expect(
      resolveDueCustomerlessCreditPaymentOperations(
        WORKSPACE_ID,
        "test",
        STARTED_AT
      )
    ).resolves.toBe(0);
    expect(state.lockOrder).toEqual(["control"]);
    expect(state.updates).toEqual([]);
  });
});

function providerResolutionHarness(
  intents: readonly { intentId: string; [key: string]: unknown }[],
  operations: readonly {
    operationId: string;
    intentId: string;
    [key: string]: unknown;
  }[],
  commercialEnabled = true
) {
  const candidateKeys = operations.map(operation => ({
    operationId: operation.operationId,
    intentId: operation.intentId,
  }));
  const rows: readonly unknown[][] = [
    [{ commercialEnabled, authorizationEpoch: 2 }],
    candidateKeys,
    intents,
    operations,
  ];
  const joins: unknown[] = [];
  const predicates: unknown[] = [];
  const updates: Array<{ table: object; value: Record<string, unknown> }> = [];
  const lockOrder: string[] = [];
  let selected = 0;
  const tx = {
    select: vi.fn(() => {
      const queryIndex = selected++;
      const result = rows[queryIndex] ?? [];
      return {
        from: vi.fn(() => {
          if (queryIndex === 0) {
            return {
              where: vi.fn((predicate: unknown) => {
                predicates.push(predicate);
                return {
                  limit: vi.fn(() => ({
                    for: vi.fn(async () => {
                      lockOrder.push("control");
                      return result;
                    }),
                  })),
                };
              }),
            };
          }
          if (queryIndex === 1) {
            return {
              innerJoin: vi.fn((_table: unknown, join: unknown) => {
                joins.push(join);
                return {
                  where: vi.fn((predicate: unknown) => {
                    predicates.push(predicate);
                    return {
                      orderBy: vi.fn(() => ({
                        limit: vi.fn(async () => result),
                      })),
                    };
                  }),
                };
              }),
            };
          }
          return {
            where: vi.fn((predicate: unknown) => {
              predicates.push(predicate);
              return {
                orderBy: vi.fn(() => ({
                  for: vi.fn(async () => {
                    lockOrder.push(queryIndex === 2 ? "intent" : "operation");
                    return result;
                  }),
                })),
              };
            }),
          };
        }),
      };
    }),
    update: vi.fn((table: object) => ({
      set: vi.fn((value: Record<string, unknown>) => {
        updates.push({ table, value });
        return { where: vi.fn(async () => [{ affectedRows: 1 }]) };
      }),
    })),
  };
  return {
    database: { transaction: vi.fn(async callback => callback(tx)) },
    joins,
    predicates,
    updates,
    lockOrder,
  };
}
