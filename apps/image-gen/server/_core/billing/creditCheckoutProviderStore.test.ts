import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  billingExecutionControls,
  billingIntents,
  billingOutbox,
  billingProviderOperations,
  billingSchedulerTenants,
  billingWebhookRoutes,
  channelConnections,
  creditWallets,
  messengerPrivacySubjects,
} from "../../../drizzle/schema";

const { getDatabaseOrThrowMock } = vi.hoisted(() => ({
  getDatabaseOrThrowMock: vi.fn(),
}));

vi.mock("../../db", () => ({
  getDatabaseOrThrow: getDatabaseOrThrowMock,
}));

import {
  claimCreditPaymentCreation,
  exposeCreditPaymentCheckout,
  finalizeCreditPaymentProviderOperation,
  markCreditPaymentTransportStarted,
} from "./creditCheckoutProviderStore";

const NOW = new Date("2026-08-28T08:00:00.000Z");
const WORKSPACE_ID = 42;
const CONNECTION_ID = 7;
const BINDING_EPOCH = 3;
const PRIVACY_EPOCH = 4;
const AUTHORIZATION_EPOCH = 2;
const USER_KEY = `u2.k1.${"a".repeat(64)}`;
const WALLET_ID = "11111111-1111-8111-8111-111111111111";
const INTENT_ID = "22222222-2222-8222-8222-222222222222";
const OPERATION_ID = "33333333-3333-4333-8333-333333333333";
const LEASE_TOKEN = "44444444-4444-4444-8444-444444444444";
const PAYMENT_ID = "tr_creditpayment1";
const FINANCIAL_REF = "b".repeat(64);
const SESSION_NONCE_HASH = "c".repeat(64);
const METADATA_HASH = "d".repeat(64);
const IDEMPOTENCY_KEY = `credit-payment:${INTENT_ID}`;
const IDEMPOTENCY_KEY_HASH = createHash("sha256")
  .update(IDEMPOTENCY_KEY)
  .digest("hex");

const scope = Object.freeze({
  workspaceId: WORKSPACE_ID,
  mode: "test" as const,
  channelConnectionId: CONNECTION_ID,
  bindingEpoch: BINDING_EPOCH,
  privacyEpoch: PRIVACY_EPOCH,
  userKey: USER_KEY,
  walletId: WALLET_ID,
  financialSubjectRef: FINANCIAL_REF,
  intentId: INTENT_ID,
  authorizationEpoch: AUTHORIZATION_EPOCH,
  sessionNonceHash: SESSION_NONCE_HASH,
  metadataHash: METADATA_HASH,
  offerId: "premium_images_8_medium_v1",
  offerVersion: 1,
});

function intent(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intentId: INTENT_ID,
    workspaceId: WORKSPACE_ID,
    mode: "test",
    planCode: "premium_images_8_medium_v1",
    kind: "credit_purchase",
    expectedAmount: "4.99",
    currency: "EUR",
    interval: "oneoff",
    entitlements: {},
    mollieDescription: "Leaderbot - 8 premium beeldcredits",
    status: "created",
    molliePaymentId: null,
    idempotencyKey: IDEMPOTENCY_KEY,
    checkoutScopeKey: `credit-checkout:v1:${"e".repeat(64)}`,
    messengerSenderUserKey: USER_KEY,
    messengerPageId: null,
    messengerChannelConnectionId: CONNECTION_ID,
    messengerBindingEpoch: BINDING_EPOCH,
    messengerPrivacyEpoch: PRIVACY_EPOCH,
    creditWalletId: WALLET_ID,
    creditFinancialSubjectRef: FINANCIAL_REF,
    creditCount: 8,
    creditMetadataHash: METADATA_HASH,
    checkoutCapabilityHash: "f".repeat(64),
    checkoutCapabilityExpiresAt: new Date("2026-08-28T08:10:00.000Z"),
    checkoutCapabilityConsumedAt: new Date("2026-08-28T07:59:00.000Z"),
    checkoutCapabilitySessionNonceHash: SESSION_NONCE_HASH,
    creditIdentityErasedAt: null,
    billingProfileVersion: 0,
    authorizationEpoch: AUTHORIZATION_EPOCH,
    urlExposedAt: null,
    paidAt: null,
    createdAt: new Date("2026-08-28T07:58:00.000Z"),
    updatedAt: new Date("2026-08-28T07:59:00.000Z"),
    ...patch,
  };
}

function providerOperation(
  patch: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    operationId: OPERATION_ID,
    operationType: "create_payment",
    operationKey: INTENT_ID,
    intentId: INTENT_ID,
    billingProfileVersion: 0,
    authorizationEpoch: AUTHORIZATION_EPOCH,
    state: "transport_started",
    requestFingerprint: METADATA_HASH,
    idempotencyKeyHash: IDEMPOTENCY_KEY_HASH,
    credentialGenerationId: "credential-v1",
    providerResourceId: null,
    providerCustomerId: null,
    leaseToken: LEASE_TOKEN,
    leaseUntil: new Date("2026-08-28T08:01:00.000Z"),
    firstStartedAt: new Date("2026-08-28T07:59:30.000Z"),
    ...patch,
  };
}

type HarnessOptions = Readonly<{
  commercialEnabled?: boolean;
  controlEpoch?: number;
  schedulerEpoch?: number;
  intent?: Record<string, unknown>;
  operation?: Record<string, unknown> | null;
  route?: Readonly<{ workspaceId: number; intentId: string }> | null;
  updateAffectedRows?: ReadonlyMap<object, readonly number[]>;
}>;

function createHarness(options: HarnessOptions = {}) {
  const selectedTables: object[] = [];
  const inserts: Array<{ table: object; value: Record<string, unknown> }> = [];
  const updates: Array<{ table: object; value: Record<string, unknown> }> = [];
  const affected = new Map<object, number[]>(
    [...(options.updateAffectedRows ?? new Map()).entries()].map(
      ([table, values]) => [table, [...values]]
    )
  );
  const intentRow = options.intent ?? intent();
  const operationRow =
    options.operation === undefined
      ? providerOperation()
      : options.operation === null
        ? undefined
        : options.operation;

  function rowsFor(table: object): unknown[] {
    if (table === billingExecutionControls) {
      return [
        {
          commercialEnabled: options.commercialEnabled ?? true,
          authorizationEpoch: options.controlEpoch ?? AUTHORIZATION_EPOCH,
        },
      ];
    }
    if (table === channelConnections) {
      return [
        {
          channel: "facebook_messenger",
          status: "connected",
          bindingEpoch: BINDING_EPOCH,
        },
      ];
    }
    if (table === messengerPrivacySubjects) {
      return [{ status: "active", privacyEpoch: PRIVACY_EPOCH }];
    }
    if (table === creditWallets) {
      return [
        {
          channelConnectionId: CONNECTION_ID,
          bindingEpoch: BINDING_EPOCH,
          privacyEpoch: PRIVACY_EPOCH,
          currentUserKeyHash: USER_KEY,
          financialSubjectRef: FINANCIAL_REF,
          status: "active",
        },
      ];
    }
    if (table === billingIntents) return [intentRow];
    if (table === billingSchedulerTenants) {
      return [
        {
          enabled: true,
          executionEpoch: options.schedulerEpoch ?? AUTHORIZATION_EPOCH,
        },
      ];
    }
    if (table === billingProviderOperations) {
      return operationRow ? [operationRow] : [];
    }
    if (table === billingWebhookRoutes) {
      return options.route === null
        ? []
        : [
            options.route ?? {
              workspaceId: WORKSPACE_ID,
              intentId: INTENT_ID,
            },
          ];
    }
    return [];
  }

  const tx = {
    select: vi.fn(() => ({
      from: vi.fn((table: object) => {
        selectedTables.push(table);
        return {
          where: vi.fn(() => ({
            limit: vi.fn(() => ({
              for: vi.fn(async () => rowsFor(table)),
            })),
          })),
        };
      }),
    })),
    update: vi.fn((table: object) => ({
      set: vi.fn((value: Record<string, unknown>) => {
        updates.push({ table, value });
        return {
          where: vi.fn(async () => {
            const queue = affected.get(table);
            return [{ affectedRows: queue?.shift() ?? 1 }];
          }),
        };
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
    database: {
      transaction: vi.fn(async callback => callback(tx)),
    },
    selectedTables,
    inserts,
    updates,
  };
}

function lockedTableOrder(harness: ReturnType<typeof createHarness>) {
  return harness.selectedTables.map(table => {
    if (table === billingExecutionControls) return "control";
    if (table === channelConnections) return "connection";
    if (table === messengerPrivacySubjects) return "privacy";
    if (table === creditWallets) return "wallet";
    if (table === billingIntents) return "intent";
    if (table === billingSchedulerTenants) return "scheduler";
    if (table === billingProviderOperations) return "provider_op";
    if (table === billingWebhookRoutes) return "route";
    return "unknown";
  });
}

describe("customerless credit checkout provider store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = "test";
    process.env.MOLLIE_CREDENTIAL_GENERATION_ID = "credential-v1";
  });

  it("claims one exact customerless create-payment operation", async () => {
    const harness = createHarness({ operation: null });
    getDatabaseOrThrowMock.mockResolvedValue(harness.database);

    await expect(claimCreditPaymentCreation(scope, NOW)).resolves.toEqual({
      claimed: true,
      operationId: expect.any(String),
      leaseToken: expect.any(String),
    });

    expect(lockedTableOrder(harness)).toEqual([
      "control",
      "connection",
      "privacy",
      "wallet",
      "intent",
      "scheduler",
      "provider_op",
    ]);
    expect(harness.inserts).toContainEqual({
      table: billingProviderOperations,
      value: expect.objectContaining({
        operationType: "create_payment",
        operationKey: INTENT_ID,
        intentId: INTENT_ID,
        billingProfileVersion: 0,
        providerCustomerId: null,
        requestFingerprint: METADATA_HASH,
        authorizationEpoch: AUTHORIZATION_EPOCH,
      }),
    });
    expect(harness.updates).toContainEqual({
      table: billingIntents,
      value: { status: "creating_payment" },
    });
  });

  it("rejects a duplicate claim without mutating either intent or operation", async () => {
    const harness = createHarness({
      operation: providerOperation({
        state: "reserved",
        firstStartedAt: null,
      }),
    });
    getDatabaseOrThrowMock.mockResolvedValue(harness.database);

    await expect(claimCreditPaymentCreation(scope, NOW)).resolves.toEqual({
      claimed: false,
    });
    expect(harness.inserts).toEqual([]);
    expect(harness.updates).toEqual([]);
  });

  it("rejects an intent whose immutable offer metadata does not match", async () => {
    const harness = createHarness({
      intent: intent({ creditMetadataHash: "9".repeat(64) }),
      operation: null,
    });
    getDatabaseOrThrowMock.mockResolvedValue(harness.database);

    await expect(claimCreditPaymentCreation(scope, NOW)).resolves.toEqual({
      claimed: false,
    });
    expect(harness.inserts).toEqual([]);
    expect(harness.updates).toEqual([]);
  });

  it("marks transport started only under the exact active lease and epoch", async () => {
    const harness = createHarness({
      intent: intent({ status: "creating_payment" }),
      operation: providerOperation({
        state: "reserved",
        firstStartedAt: null,
      }),
    });
    getDatabaseOrThrowMock.mockResolvedValue(harness.database);

    await expect(
      markCreditPaymentTransportStarted(
        { ...scope, operationId: OPERATION_ID, leaseToken: LEASE_TOKEN },
        NOW
      )
    ).resolves.toBe(true);
    expect(harness.updates[0]).toEqual({
      table: billingProviderOperations,
      value: expect.objectContaining({
        state: "transport_started",
        firstStartedAt: NOW,
      }),
    });
  });

  it("records a known result before any domain or outbox mutation", async () => {
    const harness = createHarness({
      intent: intent({ status: "creating_payment" }),
    });
    getDatabaseOrThrowMock.mockResolvedValue(harness.database);

    await expect(
      finalizeCreditPaymentProviderOperation(
        {
          ...scope,
          operationId: OPERATION_ID,
          leaseToken: LEASE_TOKEN,
          outcome: { kind: "known_succeeded", paymentId: PAYMENT_ID },
        },
        NOW
      )
    ).resolves.toEqual({
      recorded: true,
      authorized: true,
      revokedAuthorizationEpoch: null,
    });
    expect(harness.updates).toEqual([
      {
        table: billingProviderOperations,
        value: expect.objectContaining({
          state: "succeeded",
          providerResourceId: PAYMENT_ID,
          completedAt: NOW,
        }),
      },
    ]);
    expect(harness.inserts).toEqual([]);
  });

  it("records an authorized ambiguous outcome as reconciliation evidence", async () => {
    const harness = createHarness({
      intent: intent({ status: "creating_payment" }),
    });
    getDatabaseOrThrowMock.mockResolvedValue(harness.database);

    await expect(
      finalizeCreditPaymentProviderOperation(
        {
          ...scope,
          operationId: OPERATION_ID,
          leaseToken: LEASE_TOKEN,
          outcome: { kind: "ambiguous" },
        },
        NOW
      )
    ).resolves.toEqual({
      recorded: true,
      authorized: true,
      revokedAuthorizationEpoch: null,
    });
    expect(harness.updates[0]).toEqual({
      table: billingProviderOperations,
      value: expect.objectContaining({ state: "ambiguous" }),
    });
    expect(harness.updates[1]).toEqual({
      table: billingIntents,
      value: { status: "api_unknown" },
    });
    expect(harness.inserts).toEqual([]);
  });

  it("atomically contains a known payment returned after execution revoke", async () => {
    const harness = createHarness({
      commercialEnabled: false,
      controlEpoch: AUTHORIZATION_EPOCH + 1,
      schedulerEpoch: AUTHORIZATION_EPOCH + 1,
      intent: intent({ status: "creating_payment" }),
    });
    getDatabaseOrThrowMock.mockResolvedValue(harness.database);

    await expect(
      finalizeCreditPaymentProviderOperation(
        {
          ...scope,
          operationId: OPERATION_ID,
          leaseToken: LEASE_TOKEN,
          outcome: { kind: "known_succeeded", paymentId: PAYMENT_ID },
        },
        NOW
      )
    ).resolves.toEqual({
      recorded: true,
      authorized: false,
      revokedAuthorizationEpoch: AUTHORIZATION_EPOCH,
    });

    expect(harness.updates[0]).toEqual({
      table: billingProviderOperations,
      value: expect.objectContaining({
        state: "contained",
        providerResourceId: PAYMENT_ID,
      }),
    });
    expect(harness.inserts).toContainEqual({
      table: billingWebhookRoutes,
      value: expect.objectContaining({
        molliePaymentId: PAYMENT_ID,
        intentId: INTENT_ID,
      }),
    });
    const cancel = harness.inserts.find(
      item =>
        item.table === billingOutbox &&
        item.value.eventType === "cancel_payment"
    );
    expect(cancel?.value.payload).toEqual(
      expect.objectContaining({
        reason: "billing_execution_disabled",
        targetCustomerId: null,
        targetPaymentId: PAYMENT_ID,
        providerOperationId: OPERATION_ID,
        creditMetadataHash: METADATA_HASH,
      })
    );
    expect(
      harness.inserts.some(
        item =>
          item.table === billingOutbox &&
          item.value.eventType === "manual_review"
      )
    ).toBe(true);
  });

  it("durably routes a revoked ambiguous result to exact reconciliation and review", async () => {
    const harness = createHarness({
      commercialEnabled: false,
      controlEpoch: AUTHORIZATION_EPOCH + 1,
      schedulerEpoch: AUTHORIZATION_EPOCH + 1,
      intent: intent({ status: "creating_payment" }),
    });
    getDatabaseOrThrowMock.mockResolvedValue(harness.database);

    await expect(
      finalizeCreditPaymentProviderOperation(
        {
          ...scope,
          operationId: OPERATION_ID,
          leaseToken: LEASE_TOKEN,
          outcome: { kind: "ambiguous" },
        },
        NOW
      )
    ).resolves.toEqual({
      recorded: true,
      authorized: false,
      revokedAuthorizationEpoch: AUTHORIZATION_EPOCH,
    });
    expect(harness.updates[0]?.value).toEqual(
      expect.objectContaining({
        state: "reconciliation_only",
        providerResourceId: null,
      })
    );
    const cancel = harness.inserts.find(
      item =>
        item.table === billingOutbox &&
        item.value.eventType === "cancel_payment"
    );
    expect(cancel?.value.payload).toEqual(
      expect.objectContaining({
        reason: "billing_execution_disabled",
        targetCustomerId: null,
        targetPaymentId: null,
        providerOperationId: OPERATION_ID,
      })
    );
    const review = harness.inserts.find(
      item =>
        item.table === billingOutbox && item.value.eventType === "manual_review"
    );
    expect(review?.value.payload).toEqual(
      expect.objectContaining({
        reason: "payment_provider_ambiguous_after_disable",
      })
    );
  });

  it("contains a mismatched provider response without customer assumptions", async () => {
    const harness = createHarness({
      intent: intent({ status: "creating_payment" }),
    });
    getDatabaseOrThrowMock.mockResolvedValue(harness.database);

    await expect(
      finalizeCreditPaymentProviderOperation(
        {
          ...scope,
          operationId: OPERATION_ID,
          leaseToken: LEASE_TOKEN,
          outcome: { kind: "known_mismatch", paymentId: PAYMENT_ID },
        },
        NOW
      )
    ).resolves.toEqual({
      recorded: true,
      authorized: true,
      revokedAuthorizationEpoch: null,
    });
    expect(harness.updates[0]?.value).toEqual(
      expect.objectContaining({ state: "contained" })
    );
    const cancel = harness.inserts.find(
      item =>
        item.table === billingOutbox &&
        item.value.eventType === "cancel_payment"
    );
    expect(cancel?.value.payload).toEqual(
      expect.objectContaining({
        reason: "checkout_provider_response_mismatch",
        targetCustomerId: null,
        targetPaymentId: PAYMENT_ID,
      })
    );
  });

  it("makes zero mutations when the finalizer has lost its lease", async () => {
    const harness = createHarness({
      intent: intent({ status: "creating_payment" }),
      operation: providerOperation({ leaseToken: "lost-lease" }),
    });
    getDatabaseOrThrowMock.mockResolvedValue(harness.database);

    await expect(
      finalizeCreditPaymentProviderOperation(
        {
          ...scope,
          operationId: OPERATION_ID,
          leaseToken: LEASE_TOKEN,
          outcome: { kind: "known_succeeded", paymentId: PAYMENT_ID },
        },
        NOW
      )
    ).resolves.toEqual({
      recorded: false,
      authorized: false,
      revokedAuthorizationEpoch: null,
    });
    expect(harness.updates).toEqual([]);
    expect(harness.inserts).toEqual([]);
  });

  it("binds route, intent and URL exposure atomically and replays safely", async () => {
    const harness = createHarness({
      intent: intent({ status: "creating_payment" }),
      operation: providerOperation({
        state: "succeeded",
        providerResourceId: PAYMENT_ID,
      }),
    });
    getDatabaseOrThrowMock.mockResolvedValue(harness.database);
    await expect(
      exposeCreditPaymentCheckout(
        {
          ...scope,
          operationId: OPERATION_ID,
          leaseToken: LEASE_TOKEN,
          paymentId: PAYMENT_ID,
        },
        NOW
      )
    ).resolves.toBe(true);
    expect(lockedTableOrder(harness)).toEqual([
      "control",
      "connection",
      "privacy",
      "wallet",
      "intent",
      "scheduler",
      "provider_op",
      "route",
    ]);
    expect(harness.updates).toContainEqual({
      table: billingIntents,
      value: {
        molliePaymentId: PAYMENT_ID,
        status: "open",
        urlExposedAt: NOW,
      },
    });

    const replay = createHarness({
      intent: intent({
        status: "open",
        molliePaymentId: PAYMENT_ID,
        urlExposedAt: NOW,
      }),
      operation: providerOperation({
        state: "succeeded",
        providerResourceId: PAYMENT_ID,
        leaseUntil: new Date("2026-08-28T07:00:00.000Z"),
      }),
    });
    getDatabaseOrThrowMock.mockResolvedValue(replay.database);
    await expect(
      exposeCreditPaymentCheckout(
        {
          ...scope,
          operationId: OPERATION_ID,
          leaseToken: LEASE_TOKEN,
          paymentId: PAYMENT_ID,
        },
        NOW
      )
    ).resolves.toBe(true);
    expect(replay.updates).toEqual([]);
    expect(replay.inserts).toEqual([]);
  });
});
