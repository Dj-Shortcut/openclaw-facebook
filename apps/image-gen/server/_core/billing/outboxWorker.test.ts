import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BillingOutboxItem,
  BillingSubscription,
} from "../../../drizzle/schema";
import {
  MollieApiError,
  type MollieClient,
  type MollieSubscription,
} from "./mollieClient";

const databaseMock = vi.hoisted(() => vi.fn());
const retryCreditAdjustmentMock = vi.hoisted(() => vi.fn());
const safeLogMock = vi.hoisted(() => vi.fn());

vi.mock("../../db", () => ({
  getDatabaseOrThrow: databaseMock,
}));
vi.mock("../logger", () => ({ safeLog: safeLogMock }));
vi.mock("./creditPaymentWebhook", () => {
  class CreditPaymentAdjustmentPendingError extends Error {}
  return {
    CreditPaymentAdjustmentPendingError,
    retryPersistedCreditPaymentAdjustment: retryCreditAdjustmentMock,
  };
});

import { CreditPaymentAdjustmentPendingError } from "./creditPaymentWebhook";

import {
  cancelContainedMolliePayment,
  cancelContainedMollieSubscription,
  claimBillingOutboxItem,
  collectingSubscriptionsForIntent,
  failBillingOutboxItem,
  isCriticalContainmentJob,
  mandateMatchesCurrentSubscription,
  processBillingOutboxItem,
  readCreditAdjustmentRetryPayload,
  reconcileExecutionDisabledPayment,
  runHistoricalBillingSafetyOutboxOnce,
  sendPaymentHandoff,
} from "./outboxWorker";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MOLLIE_API_KEY = `test_${"a".repeat(32)}`;
  process.env.MOLLIE_MODE = "test";
  process.env.APP_BASE_URL = "http://leaderbot.test";
  process.env.MOLLIE_PAYMENT_WEBHOOK_URL =
    "http://billing.test/api/webhooks/mollie/payments";
  process.env.BILLING_SUPPORT_EMAIL = "billing@leaderbot.test";
  retryCreditAdjustmentMock.mockResolvedValue("duplicate");
});

describe("billing outbox containment safeguards", () => {
  const adjustment = {
    workspaceId: 42,
    mode: "test",
    channelConnectionId: 8,
    bindingEpoch: 3,
    privacyEpoch: 5,
    walletId: "11111111-1111-4111-8111-111111111111",
    financialSubjectRef: "a".repeat(64),
    intentId: "22222222-2222-4222-8222-222222222222",
    authorizationEpoch: 7,
    paymentLedgerId: 9,
    providerPaymentId: "tr_credit1",
    rootGrantEntryId: "33333333-3333-4333-8333-333333333333",
    evidenceHash: "b".repeat(64),
    webhookPaymentId: "tr_credit1",
    deliverySnapshotHash: "b".repeat(64),
    kind: "refund_debit",
    providerEffectIds: ["re_credit_1"],
  } as const;

  it("retries an exact persisted credit adjustment without a Mollie key", async () => {
    delete process.env.MOLLIE_API_KEY;
    const job = {
      workspaceId: 42,
      mode: "test",
      eventType: "credit_adjustment_retry",
      payload: { reason: "credit_adjustment_pending", adjustment },
    } as BillingOutboxItem & { leaseToken: string };

    await expect(processBillingOutboxItem(job)).resolves.toBeUndefined();

    expect(retryCreditAdjustmentMock).toHaveBeenCalledExactlyOnceWith(
      adjustment
    );
    expect(isCriticalContainmentJob(job)).toBe(true);
  });

  it("keeps a pending credit adjustment retryable and rejects altered scope", async () => {
    retryCreditAdjustmentMock.mockRejectedValueOnce(
      new CreditPaymentAdjustmentPendingError()
    );
    const payload = { reason: "credit_adjustment_pending", adjustment };
    const job = {
      workspaceId: 42,
      mode: "test",
      eventType: "credit_adjustment_retry",
      payload,
    } as BillingOutboxItem & { leaseToken: string };

    await expect(processBillingOutboxItem(job)).rejects.toThrow(
      "credit_adjustment_pending_holds"
    );
    expect(readCreditAdjustmentRetryPayload(payload, 42, "test")).toEqual(
      adjustment
    );
    expect(
      readCreditAdjustmentRetryPayload(
        {
          ...payload,
          adjustment: { ...adjustment, workspaceId: 43 },
        },
        42,
        "test"
      )
    ).toBeNull();
  });

  it("reconciles a null-id checkout mismatch only to an exact one-off payment", async () => {
    const sourceIntentId = "550e8400-e29b-41d4-a716-446655440000";
    const selectResult = (rows: unknown[]) => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue(rows) })),
      })),
    });
    const updateWhere = vi.fn().mockResolvedValue([{ affectedRows: 1 }]);
    const insertValues = vi.fn(() => ({
      onDuplicateKeyUpdate: vi.fn().mockResolvedValue(undefined),
    }));
    const tx = {
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: updateWhere })),
      })),
      insert: vi.fn(() => ({ values: insertValues })),
    };
    const database = {
      select: vi
        .fn()
        .mockReturnValueOnce(
          selectResult([
            {
              operationId: "operation-1",
              billingProfileVersion: 3,
              credentialGenerationId: "credential-1",
              firstStartedAt: new Date("2026-08-18T10:00:00.000Z"),
            },
          ])
        )
        .mockReturnValueOnce(
          selectResult([
            {
              expectedAmount: "19.00",
              currency: "EUR",
              mollieDescription: "Leaderbot Startpilot",
            },
          ])
        ),
      transaction: vi.fn(async callback => callback(tx)),
    };
    databaseMock.mockResolvedValue(database);
    const oneOffPayment = {
      resource: "payment" as const,
      id: "tr_payment123",
      mode: "test" as const,
      status: "open",
      amount: { currency: "EUR", value: "19.00" },
      description: "Leaderbot Startpilot",
      customerId: "cst_customer123",
      subscriptionId: null,
      metadata: { billingIntentId: sourceIntentId },
      createdAt: "2026-08-18T10:00:01.000Z",
    };

    await reconcileExecutionDisabledPayment(
      {
        workspaceId: 1,
        mode: "test",
        payload: {
          reason: "checkout_provider_response_mismatch",
          intentId: sourceIntentId,
          targetCustomerId: "cst_customer123",
          targetPaymentId: null,
          providerOperationId: "operation-1",
          revokedAuthorizationEpoch: 2,
        },
      } as BillingOutboxItem & { leaseToken: string },
      {
        listCustomerPayments: vi.fn().mockResolvedValue([oneOffPayment]),
      } as unknown as MollieClient
    );

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "cancel_payment",
        payload: expect.objectContaining({
          targetPaymentId: "tr_payment123",
          targetCustomerId: "cst_customer123",
          intentId: sourceIntentId,
        }),
      })
    );
  });

  it("does not reconcile a recurring payment that reuses intent metadata", async () => {
    const sourceIntentId = "550e8400-e29b-41d4-a716-446655440000";
    const selectResult = (rows: unknown[]) => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue(rows) })),
      })),
    });
    const database = {
      select: vi
        .fn()
        .mockReturnValueOnce(
          selectResult([
            {
              operationId: "operation-1",
              billingProfileVersion: 3,
              credentialGenerationId: "credential-1",
              firstStartedAt: new Date("2026-08-18T10:00:00.000Z"),
            },
          ])
        )
        .mockReturnValueOnce(
          selectResult([
            {
              expectedAmount: "19.00",
              currency: "EUR",
              mollieDescription: "Leaderbot Startpilot",
            },
          ])
        ),
      transaction: vi.fn(),
    };
    databaseMock.mockResolvedValue(database);

    await expect(
      reconcileExecutionDisabledPayment(
        {
          workspaceId: 1,
          mode: "test",
          payload: {
            reason: "checkout_provider_response_mismatch",
            intentId: sourceIntentId,
            targetCustomerId: "cst_customer123",
            targetPaymentId: null,
            providerOperationId: "operation-1",
            revokedAuthorizationEpoch: 2,
          },
        } as BillingOutboxItem & { leaseToken: string },
        {
          listCustomerPayments: vi.fn().mockResolvedValue([
            {
              resource: "payment",
              id: "tr_recurring123",
              mode: "test",
              status: "open",
              amount: { currency: "EUR", value: "19.00" },
              description: "Leaderbot Startpilot",
              customerId: "cst_customer123",
              subscriptionId: "sub_subscription123",
              metadata: { billingIntentId: sourceIntentId },
              createdAt: "2026-08-18T10:00:01.000Z",
            },
          ]),
        } as unknown as MollieClient
      )
    ).rejects.toThrow("payment_reconciliation_not_visible");
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it.each([
    ["cancel_subscription", "billing_profile_revoked", true],
    ["cancel_subscription", "billing_profile_expired", true],
    ["cancel_payment", "billing_profile_revoked", true],
    ["cancel_subscription", "replacement_subscription", false],
    ["manual_review", "billing_profile_revoked", false],
  ] as const)(
    "classifies %s/%s as continuously contained=%s",
    (eventType, reason, expected) => {
      expect(
        isCriticalContainmentJob({
          eventType,
          payload: { reason },
        } as BillingOutboxItem)
      ).toBe(expected);
    }
  );

  it("durably escalates a permanent credit-payment cancellation without a Mollie key", async () => {
    delete process.env.MOLLIE_API_KEY;
    const insertValues = vi.fn(() => ({
      onDuplicateKeyUpdate: vi.fn(async () => undefined),
    }));
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({
              for: vi.fn(async () => [{ id: 91 }]),
            })),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
      })),
      insert: vi.fn(() => ({ values: insertValues })),
    };
    databaseMock.mockResolvedValue({
      transaction: vi.fn(async callback => callback(tx)),
    });

    await failBillingOutboxItem(
      {
        id: 91,
        deliveryId: "11111111-1111-4111-8111-111111111111",
        workspaceId: 1,
        mode: "test",
        eventType: "cancel_payment",
        status: "processing",
        leaseToken: "lease-1",
        attemptCount: 12,
        payload: { creditPurpose: "premium_image_credits" },
      } as BillingOutboxItem & { leaseToken: string },
      "payment_cancellation_target_mismatch"
    );

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "manual_review",
        payload: {
          reason: "payment_cancellation_failed",
          failedDeliveryId: "11111111-1111-4111-8111-111111111111",
        },
      })
    );
  });
  it("contains a queued portal handoff without sending a retired link", async () => {
    const job = {
      id: 9,
      deliveryId: "11111111-1111-4111-8111-111111111111",
      workspaceId: 42,
      mode: "test",
      eventType: "send_portal_handoff",
      payload: {
        intentId: "550e8400-e29b-41d4-a716-446655440000",
        messengerSenderUserKey: "a".repeat(64),
        messengerPageId: "page-42",
        messengerChannelConnectionId: 12,
        messengerPrivacyEpoch: 4,
      },
    } as BillingOutboxItem & { leaseToken: string };

    await expect(sendPaymentHandoff(job)).rejects.toMatchObject({
      name: "PermanentOutboxError",
      errorCode: "portal_handoff_route_retired",
    });
    expect(safeLogMock).toHaveBeenCalledWith(
      "legacy_portal_handoff_delivery_contained",
      {
        level: "error",
        workspaceId: 42,
        mode: "test",
        outboxId: 9,
        deliveryId: "11111111-1111-4111-8111-111111111111",
        errorCode: "portal_handoff_route_retired",
      }
    );
    expect(databaseMock).not.toHaveBeenCalled();
  });
  it("preserves a unique provisioning remote when the valid mandate was not stored yet", () => {
    expect(mandateMatchesCurrentSubscription("mdt_valid123", null, true)).toBe(
      true
    );
    expect(mandateMatchesCurrentSubscription(undefined, null, true)).toBe(
      false
    );
  });

  it("requires the exact stored mandate after provisioning", () => {
    expect(
      mandateMatchesCurrentSubscription("mdt_valid123", "mdt_valid123", false)
    ).toBe(true);
    expect(
      mandateMatchesCurrentSubscription("mdt_other123", "mdt_valid123", false)
    ).toBe(false);
    expect(mandateMatchesCurrentSubscription("mdt_valid123", null, false)).toBe(
      false
    );
  });

  it("counts only active and pending subscriptions for an intent", () => {
    const remotes = [
      remoteSubscription(),
      remoteSubscription({ id: "sub_pending123", status: "pending" }),
      remoteSubscription({ id: "sub_canceled123", status: "canceled" }),
      remoteSubscription({ id: "sub_completed123", status: "completed" }),
      remoteSubscription({ id: "sub_suspended123", status: "suspended" }),
    ];

    expect(
      collectingSubscriptionsForIntent(
        remotes,
        "550e8400-e29b-41d4-a716-446655440000"
      ).map(remote => remote.id)
    ).toEqual(["sub_subscription123", "sub_pending123"]);
  });

  it("keeps containment provider calls outside every transaction", async () => {
    const { database, isInTransaction } = transactionalDatabase(
      [[], [], []],
      [{ operationId: "provider-operation-1" }]
    );
    databaseMock.mockResolvedValue(database);
    const remote = remoteSubscription();
    const getSubscription = vi.fn(async () => {
      expect(isInTransaction()).toBe(false);
      return remote;
    });
    const cancelSubscription = vi.fn(async () => {
      expect(isInTransaction()).toBe(false);
    });

    await expect(
      cancelContainedMollieSubscription(
        containmentJob(),
        { customerId: "cst_customer123", subscriptionId: remote.id },
        { getSubscription, cancelSubscription } as unknown as MollieClient
      )
    ).resolves.toBe("canceled");

    expect(getSubscription).toHaveBeenCalledOnce();
    expect(cancelSubscription).toHaveBeenCalledOnce();
    expect(database.transaction).toHaveBeenCalledTimes(3);
  });

  it("lists provisioning remotes outside the transaction and preserves the unique current one", async () => {
    const current = provisioningSubscription();
    const { database, isInTransaction } = transactionalDatabase(
      [[current], [current]],
      [{ operationId: "provider-operation-1" }]
    );
    databaseMock.mockResolvedValue(database);
    const remote = remoteSubscription();
    const getSubscription = vi.fn(async () => {
      expect(isInTransaction()).toBe(false);
      return remote;
    });
    const listCustomerSubscriptions = vi.fn(async () => {
      expect(isInTransaction()).toBe(false);
      return [
        remote,
        remoteSubscription({ id: "sub_canceled123", status: "canceled" }),
        remoteSubscription({ id: "sub_completed123", status: "completed" }),
        remoteSubscription({ id: "sub_suspended123", status: "suspended" }),
      ];
    });
    const cancelSubscription = vi.fn();

    await expect(
      cancelContainedMollieSubscription(
        containmentJob(),
        { customerId: "cst_customer123", subscriptionId: remote.id },
        {
          getSubscription,
          listCustomerSubscriptions,
          cancelSubscription,
        } as unknown as MollieClient
      )
    ).resolves.toBe("skipped_current");

    expect(listCustomerSubscriptions).toHaveBeenCalledOnce();
    expect(cancelSubscription).not.toHaveBeenCalled();
    expect(database.transaction).toHaveBeenCalledTimes(2);
  });

  it.each(["active", "pending"] as const)(
    "preserves an exact %s remote when retrying after a failed DELETE",
    async status => {
      const current = manualReviewSubscription();
      const { database, isInTransaction } = transactionalDatabase([
        [current],
        [current],
      ]);
      databaseMock.mockResolvedValue(database);
      const remote = remoteSubscription({ status });
      const getSubscription = vi.fn(async () => {
        expect(isInTransaction()).toBe(false);
        return remote;
      });
      const cancelSubscription = vi.fn();

      await expect(
        cancelContainedMollieSubscription(
          containmentJob(),
          { customerId: "cst_customer123", subscriptionId: remote.id },
          { getSubscription, cancelSubscription } as unknown as MollieClient
        )
      ).resolves.toBe("skipped_current");

      expect(cancelSubscription).not.toHaveBeenCalled();
      expect(database.transaction).toHaveBeenCalledTimes(2);
    }
  );

  it("still cancels a genuinely mismatched manual-review remote", async () => {
    const current = manualReviewSubscription();
    const { database } = transactionalDatabase([
      [current],
      [current],
      [current],
    ]);
    databaseMock.mockResolvedValue(database);
    const remote = remoteSubscription({
      amount: { currency: "EUR", value: "30.00" },
    });
    const cancelSubscription = vi.fn().mockResolvedValue(undefined);

    await expect(
      cancelContainedMollieSubscription(
        containmentJob(),
        { customerId: "cst_customer123", subscriptionId: remote.id },
        {
          getSubscription: vi.fn().mockResolvedValue(remote),
          cancelSubscription,
        } as unknown as MollieClient
      )
    ).resolves.toBe("canceled");

    expect(cancelSubscription).toHaveBeenCalledOnce();
  });

  it("cancels the exact current remote once when the billing profile was revoked", async () => {
    const current = manualReviewSubscription();
    const { database } = transactionalDatabase([
      [current],
      [current],
      [current],
    ]);
    databaseMock.mockResolvedValue(database);
    const remote = remoteSubscription();
    const cancelSubscription = vi.fn().mockResolvedValue(undefined);
    const job = containmentJob();
    job.payload = { ...job.payload, reason: "billing_profile_revoked" };

    await expect(
      cancelContainedMollieSubscription(
        job,
        { customerId: "cst_customer123", subscriptionId: remote.id },
        {
          getSubscription: vi.fn().mockResolvedValue(remote),
          cancelSubscription,
        } as unknown as MollieClient
      )
    ).resolves.toBe("canceled");

    expect(cancelSubscription).toHaveBeenCalledOnce();
  });

  it("cancels only the exact provisioning remote from the disabled authorization epoch", async () => {
    const current = {
      ...provisioningSubscription(),
      mollieSubscriptionId: "sub_subscription123",
      mollieMandateId: "mdt_mandate123",
    };
    const { database } = transactionalDatabase(
      [[current], [current], [current]],
      [{ intentId: current.sourceIntentId }]
    );
    databaseMock.mockResolvedValue(database);
    const remote = remoteSubscription();
    const cancelSubscription = vi.fn().mockResolvedValue(undefined);
    const job = containmentJob();
    job.payload = {
      ...job.payload,
      reason: "billing_execution_disabled",
      revokedAuthorizationEpoch: 7,
    };

    await expect(
      cancelContainedMollieSubscription(
        job,
        { customerId: "cst_customer123", subscriptionId: remote.id },
        {
          getSubscription: vi.fn().mockResolvedValue(remote),
          cancelSubscription,
        } as unknown as MollieClient
      )
    ).resolves.toBe("canceled");

    expect(cancelSubscription).toHaveBeenCalledOnce();
  });

  it.each(["epoch", "tenant", "remote"] as const)(
    "never deletes an execution-disabled %s mismatch",
    async mismatch => {
      const current = {
        ...provisioningSubscription(),
        mollieSubscriptionId: "sub_subscription123",
        mollieMandateId: "mdt_mandate123",
      };
      const localIntent =
        mismatch === "remote" ? [{ intentId: current.sourceIntentId }] : [];
      const { database, insertValues } = transactionalDatabase(
        [[current], [current]],
        localIntent
      );
      databaseMock.mockResolvedValue(database);
      const remote = remoteSubscription(
        mismatch === "remote"
          ? { metadata: { billingIntentId: "wrong-intent" } }
          : {}
      );
      const cancelSubscription = vi.fn();
      const job = containmentJob();
      job.payload = {
        ...job.payload,
        reason: "billing_execution_disabled",
        revokedAuthorizationEpoch: 7,
      };

      const expectedError =
        mismatch === "remote"
          ? "subscription_cancellation_provider_scope_mismatch"
          : "subscription_cancellation_local_scope_mismatch";
      await expect(
        cancelContainedMollieSubscription(
          job,
          { customerId: "cst_customer123", subscriptionId: remote.id },
          {
            getSubscription: vi.fn().mockResolvedValue(remote),
            cancelSubscription,
          } as unknown as MollieClient
        )
      ).rejects.toThrow(expectedError);
      expect(cancelSubscription).not.toHaveBeenCalled();
      expect(insertValues).toHaveBeenCalledWith({
        workspaceId: job.workspaceId,
        mode: job.mode,
        eventType: "manual_review",
        deduplicationKey: `subscription_cancel_scope_review:${job.deliveryId}`,
        payload: { reason: expectedError },
        status: "pending",
      });
    }
  );

  it("treats an exact execution-disabled 404 as idempotently absent", async () => {
    const current = {
      ...provisioningSubscription(),
      mollieSubscriptionId: "sub_subscription123",
    };
    const { database, insertValues } = transactionalDatabase(
      [[current]],
      [{ intentId: current.sourceIntentId }]
    );
    databaseMock.mockResolvedValue(database);
    const job = containmentJob();
    job.payload = {
      ...job.payload,
      reason: "billing_execution_disabled",
      revokedAuthorizationEpoch: 7,
    };

    await expect(
      cancelContainedMollieSubscription(
        job,
        {
          customerId: "cst_customer123",
          subscriptionId: "sub_subscription123",
        },
        {
          getSubscription: vi
            .fn()
            .mockRejectedValue(new MollieApiError(404, "not_found")),
          cancelSubscription: vi.fn(),
        } as unknown as MollieClient
      )
    ).resolves.toBe("skipped_current");
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("rejects a cross-intent cancellation binding without provider DELETE", async () => {
    const current = {
      ...manualReviewSubscription(),
      sourceIntentId: "550e8400-e29b-41d4-a716-446655440000",
    };
    const { database } = transactionalDatabase([[current]], []);
    databaseMock.mockResolvedValue(database);
    const cancelSubscription = vi.fn();
    const job = containmentJob();
    job.payload = {
      ...job.payload,
      expectedSourceIntentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    };

    await expect(
      cancelContainedMollieSubscription(
        job,
        {
          customerId: "cst_customer123",
          subscriptionId: "sub_subscription123",
        },
        {
          getSubscription: vi.fn(),
          cancelSubscription,
        } as unknown as MollieClient
      )
    ).rejects.toThrow("subscription_cancellation_local_scope_mismatch");
    expect(cancelSubscription).not.toHaveBeenCalled();
    expect(database.insert).toHaveBeenCalledOnce();
  });

  it.each([
    ["local", "payment_cancellation_local_scope_mismatch"],
    ["metadata", "payment_cancellation_target_mismatch"],
    ["paid", "payment_cancellation_requires_manual_review"],
  ] as const)(
    "never deletes a %s payment cancellation mismatch",
    async (mismatch, expectedError) => {
      const sourceIntentId = "550e8400-e29b-41d4-a716-446655440000";
      const rows = [
        [{ mollieCustomerId: "cst_customer123" }],
        mismatch === "local" ? [] : [{ molliePaymentId: "tr_payment123" }],
        [],
      ];
      let selected = 0;
      const database = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () => rows[selected++] ?? []),
            })),
          })),
        })),
      };
      databaseMock.mockResolvedValue(database);
      const cancelPayment = vi.fn();
      const getPayment = vi.fn().mockResolvedValue({
        resource: "payment",
        id: "tr_payment123",
        mode: "test",
        status: mismatch === "paid" ? "paid" : "open",
        customerId: "cst_customer123",
        metadata: {
          billingIntentId:
            mismatch === "metadata" ? "wrong-intent" : sourceIntentId,
        },
      });

      await expect(
        cancelContainedMolliePayment(
          {
            workspaceId: 1,
            mode: "test",
            payload: {
              reason: "billing_execution_disabled",
              intentId: sourceIntentId,
              targetPaymentId: "tr_payment123",
            },
          } as BillingOutboxItem & { leaseToken: string },
          { getPayment, cancelPayment } as unknown as MollieClient
        )
      ).rejects.toThrow(expectedError);
      expect(cancelPayment).not.toHaveBeenCalled();
    }
  );

  it("does not claim a second workspace job while another lease is processing", async () => {
    const pendingSelect = vi.fn();
    const tx = {
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(() => ({
                for: vi.fn().mockResolvedValue([{ commercialEnabled: true }]),
              })),
            })),
          })),
        })
        .mockReturnValueOnce({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([{ id: 99 }]),
            })),
          })),
        })
        .mockImplementation(pendingSelect),
      update: vi.fn(),
    };
    databaseMock.mockResolvedValue({
      transaction: vi.fn(async callback => callback(tx)),
    });

    await expect(claimBillingOutboxItem("test", 1)).resolves.toBeNull();
    expect(tx.select).toHaveBeenCalledTimes(2);
    expect(tx.update).not.toHaveBeenCalled();
    expect(pendingSelect).not.toHaveBeenCalled();
  });

  it.each([
    ["manual_review", false],
    ["credit_adjustment_retry", true],
  ] as const)(
    "drains historical Test Mode %s without reopening Mollie after live cutover",
    async (eventType, expectsAdjustment) => {
      process.env.MOLLIE_MODE = "live";
      process.env.BILLING_OPERATOR_NOTIFICATION_WEBHOOK_URL =
        "https://notify.example/operator";
      process.env.BILLING_OPERATOR_NOTIFICATION_SIGNING_SECRET = "s".repeat(32);
      process.env.BILLING_OPERATOR_NOTIFICATION_KEY_ID = "operator-v1";
      process.env.BILLING_NOTIFICATION_SOURCE_ID = "leaderbot-test";
      const now = new Date("2026-08-28T12:00:00.000Z");
      const job = {
        id: 51,
        deliveryId: "11111111-1111-4111-8111-111111111111",
        workspaceId: 42,
        mode: "test",
        eventType,
        deduplicationKey: `historical-key-free:${eventType}`,
        payload: expectsAdjustment
          ? { reason: "credit_adjustment_pending", adjustment }
          : { reason: "credit_reservation_transport_ambiguous" },
        status: "pending",
        attemptCount: 0,
        maxAttempts: 12,
        availableAt: now,
        lockedAt: null,
        leaseToken: null,
        lastErrorCode: null,
        deliveryEpoch: 0,
        deliveryState: "idle",
        privacyErasedAt: null,
        createdAt: now,
        updatedAt: now,
      } satisfies BillingOutboxItem;
      const outsideUpdateWhere = vi
        .fn()
        .mockResolvedValueOnce([{ affectedRows: 0 }])
        .mockResolvedValueOnce([{ affectedRows: 1 }]);
      let transactionSelect = 0;
      const tx = {
        select: vi.fn(() => {
          transactionSelect += 1;
          if (transactionSelect === 1) {
            return {
              from: vi.fn(() => ({
                where: vi.fn(() => ({
                  limit: vi.fn(() => ({
                    for: vi.fn(async () => [{ commercialEnabled: true }]),
                  })),
                })),
              })),
            };
          }
          if (transactionSelect === 2) {
            return {
              from: vi.fn(() => ({
                where: vi.fn(() => ({ limit: vi.fn(async () => []) })),
              })),
            };
          }
          return {
            from: vi.fn(() => ({
              where: vi.fn(() => ({
                orderBy: vi.fn(() => ({
                  limit: vi.fn(() => ({
                    for: vi.fn(async () => [job]),
                  })),
                })),
              })),
            })),
          };
        }),
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn(async () => [{ affectedRows: 1 }]),
          })),
        })),
      };
      const database = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              where: vi.fn(() => ({
                orderBy: vi.fn(() => ({
                  limit: vi.fn(async () => [{ workspaceId: 42 }]),
                })),
              })),
            })),
          })),
        })),
        update: vi.fn(() => ({
          set: vi.fn(() => ({ where: outsideUpdateWhere })),
        })),
        transaction: vi.fn(async callback => callback(tx)),
      };
      databaseMock.mockResolvedValue(database);
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(null, { status: 204 }));

      try {
        await expect(runHistoricalBillingSafetyOutboxOnce(now)).resolves.toBe(
          true
        );
        if (expectsAdjustment) {
          expect(fetchMock).not.toHaveBeenCalled();
        } else {
          expect(fetchMock).toHaveBeenCalledOnce();
          expect(fetchMock.mock.calls[0]?.[0].toString()).toBe(
            "https://notify.example/operator"
          );
          expect(fetchMock.mock.calls[0]?.[1]?.body).toContain('"mode":"test"');
        }
      } finally {
        fetchMock.mockRestore();
      }

      if (expectsAdjustment) {
        expect(retryCreditAdjustmentMock).toHaveBeenCalledExactlyOnceWith(
          adjustment
        );
      } else {
        expect(retryCreditAdjustmentMock).not.toHaveBeenCalled();
      }
      expect(outsideUpdateWhere).toHaveBeenCalledTimes(2);
    }
  );
});

function transactionalDatabase(
  rowsByTransaction: BillingSubscription[][],
  outsideRows: unknown[] = []
) {
  let inTransaction = false;
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const tx = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => ({
            for: vi.fn(async () => rowsByTransaction.shift() ?? []),
          })),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: updateWhere })),
    })),
  };
  const insertValues = vi.fn(() => ({
    onDuplicateKeyUpdate: vi.fn(async () => undefined),
  }));
  const database = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => outsideRows),
        })),
      })),
    })),
    insert: vi.fn(() => ({ values: insertValues })),
    transaction: vi.fn(async callback => {
      expect(inTransaction).toBe(false);
      inTransaction = true;
      try {
        return await callback(tx);
      } finally {
        inTransaction = false;
      }
    }),
  };
  return { database, insertValues, isInTransaction: () => inTransaction };
}

function containmentJob(): BillingOutboxItem {
  const sourceIntentId = "550e8400-e29b-41d4-a716-446655440000";
  return {
    workspaceId: 1,
    mode: "test",
    payload: {
      reason: "remote_subscription_mismatch",
      expectedSourceIntentId: sourceIntentId,
      targetCustomerId: "cst_customer123",
      targetSubscriptionId: "sub_subscription123",
    },
  } as BillingOutboxItem;
}

function provisioningSubscription(): BillingSubscription {
  return {
    workspaceId: 1,
    mode: "test",
    status: "provisioning",
    mollieCustomerId: "cst_customer123",
    mollieSubscriptionId: null,
    mollieMandateId: null,
    sourceIntentId: "550e8400-e29b-41d4-a716-446655440000",
    paidThrough: new Date("2026-09-01T00:00:00.000Z"),
    recurringAmount: "29.00",
    currency: "EUR",
    interval: "1 month",
  } as BillingSubscription;
}

function manualReviewSubscription(): BillingSubscription {
  return {
    ...provisioningSubscription(),
    status: "manual_review",
    mollieSubscriptionId: "sub_subscription123",
    mollieMandateId: "mdt_mandate123",
  };
}

function remoteSubscription(
  overrides: Partial<MollieSubscription> = {}
): MollieSubscription {
  return {
    resource: "subscription",
    id: "sub_subscription123",
    mode: "test",
    status: "active",
    amount: { currency: "EUR", value: "29.00" },
    interval: "1 month",
    startDate: "2026-09-01",
    mandateId: "mdt_mandate123",
    metadata: {
      billingIntentId: "550e8400-e29b-41d4-a716-446655440000",
    },
    ...overrides,
  };
}
