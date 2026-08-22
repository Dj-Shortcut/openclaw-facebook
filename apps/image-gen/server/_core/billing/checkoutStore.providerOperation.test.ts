import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { hashCanonicalSnapshot } from "./ids";
import {
  billingIntents,
  billingProviderOperations,
} from "../../../drizzle/schema";

const { databaseMock } = vi.hoisted(() => ({ databaseMock: vi.fn() }));
vi.mock("../../db", () => ({ getDatabaseOrThrow: databaseMock }));

import {
  claimIntentPaymentCreation,
  finalizePaymentProviderOperation,
} from "./checkoutStore";

describe("payment provider operation recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MOLLIE_CREDENTIAL_GENERATION_ID = "credential-v1";
  });

  it("resumes exactly once after a crash before transport start", async () => {
    const harness = claimHarness();
    databaseMock.mockResolvedValue(harness.database);

    await expect(claimIntentPaymentCreation(claimInput())).resolves.toEqual({
      claimed: true,
      operationId: operation.operationId,
      leaseToken: expect.any(String),
    });
    expect(harness.operationUpdate).toHaveBeenCalledOnce();
  });

  it.each([
    ["changed idempotency key", { idempotencyKey: "changed-key" }, {}],
    ["changed provider body", { description: "changed description" }, {}],
    ["changed credential generation", {}, { credential: "credential-v2" }],
    ["changed profile version", {}, { profileVersion: 8 }],
  ])("rejects %s", async (_label, requestPatch, options) => {
    const input = claimInput(requestPatch as Partial<typeof providerRequest>);
    const profileVersion = Number(
      (options as { profileVersion?: number }).profileVersion ?? 7
    );
    input.billingProfileVersion = profileVersion;
    const harness = claimHarness({ profileVersion });
    databaseMock.mockResolvedValue(harness.database);
    if ((options as { credential?: string }).credential) {
      process.env.MOLLIE_CREDENTIAL_GENERATION_ID = (
        options as { credential: string }
      ).credential;
    }

    await expect(claimIntentPaymentCreation(input)).resolves.toEqual({
      claimed: false,
    });
    expect(harness.operationUpdate).not.toHaveBeenCalled();
  });

  it("atomically records an unauthorized payment and its exact cancel route", async () => {
    const harness = finalizationHarness(false, 1);
    databaseMock.mockResolvedValue(harness.database);

    await expect(
      finalizePaymentProviderOperation({
        operationId: operation.operationId,
        leaseToken: "lease-1",
        outcome: "succeeded",
        providerResourceId: "tr_payment123",
        workspaceId: 42,
        mode: "test",
        authorizationEpoch: 2,
        intentId: providerRequest.intentId,
        targetCustomerId: providerRequest.customerId,
      })
    ).resolves.toEqual({
      recorded: true,
      authorized: false,
      revokedAuthorizationEpoch: 2,
    });
    expect(harness.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "cancel_payment",
        payload: expect.objectContaining({
          reason: "billing_execution_disabled",
          intentId: providerRequest.intentId,
          targetPaymentId: "tr_payment123",
        }),
      })
    );
  });

  it("does not enqueue cancellation when a stale payment worker loses its fence", async () => {
    const harness = finalizationHarness(false, 0);
    databaseMock.mockResolvedValue(harness.database);

    await expect(
      finalizePaymentProviderOperation({
        operationId: operation.operationId,
        leaseToken: "lease-1",
        outcome: "succeeded",
        providerResourceId: "tr_payment123",
        workspaceId: 42,
        mode: "test",
        authorizationEpoch: 2,
        intentId: providerRequest.intentId,
        targetCustomerId: providerRequest.customerId,
      })
    ).resolves.toEqual({
      recorded: false,
      authorized: false,
      revokedAuthorizationEpoch: null,
    });
    expect(harness.insertValues).not.toHaveBeenCalled();
  });
});

const providerRequest = {
  customerId: "cst_customer123",
  amount: { currency: "EUR", value: "19.00" },
  description: "Leaderbot Startpilot",
  intentId: "11111111-1111-4111-8111-111111111111",
  redirectUrl: "https://leaderbot.test/?billing=return&intent=111",
  webhookUrl: "https://leaderbot.test/api/webhooks/mollie/payments",
  idempotencyKey: "persisted-payment-key",
  offerType: "one_time" as const,
};

const operation = {
  operationId: "22222222-2222-4222-8222-222222222222",
  state: "known_failed" as const,
  firstStartedAt: null,
  requestFingerprint: hashCanonicalSnapshot(providerRequest),
  billingProfileVersion: 7,
  authorizationEpoch: 2,
  credentialGenerationId: "credential-v1",
  idempotencyKeyHash: createHash("sha256")
    .update(providerRequest.idempotencyKey)
    .digest("hex"),
};

function claimInput(patch: Partial<typeof providerRequest> = {}) {
  return {
    intentId: providerRequest.intentId,
    workspaceId: 42,
    mode: "test" as const,
    billingProfileVersion: 7,
    authorizationEpoch: 2,
    providerRequest: { ...providerRequest, ...patch },
  };
}

function claimHarness(options: { profileVersion?: number } = {}) {
  const profileVersion = options.profileVersion ?? 7;
  const rows = [
    [{ commercialEnabled: true, authorizationEpoch: 2 }],
    [
      {
        eligibilityVersion: profileVersion,
        verificationStatus: "verified",
        countryCode: "BE",
        customerType: "consumer",
        peppolReady: false,
        verifiedAt: new Date("2026-01-01T00:00:00.000Z"),
        verificationExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
        revokedAt: null,
      },
    ],
    [
      {
        status: "created",
        workspaceId: 42,
        mode: "test",
        billingProfileVersion: profileVersion,
        expectedAmount: providerRequest.amount.value,
        currency: providerRequest.amount.currency,
        mollieDescription: providerRequest.description,
        idempotencyKey: providerRequest.idempotencyKey,
      },
    ],
    [{ ...operation }],
  ];
  let selectNumber = 0;
  const operationUpdate = vi.fn(async () => [{ affectedRows: 1 }]);
  const intentUpdate = vi.fn(async () => [{ affectedRows: 1 }]);
  const tx = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => ({
            for: vi.fn(async () => rows[selectNumber++] ?? []),
          })),
        })),
      })),
    })),
    update: vi.fn(table => ({
      set: vi.fn(() => ({
        where:
          table === billingProviderOperations
            ? operationUpdate
            : table === billingIntents
              ? intentUpdate
              : vi.fn(async () => [{ affectedRows: 1 }]),
      })),
    })),
  };
  return {
    database: { transaction: vi.fn(async callback => callback(tx)) },
    operationUpdate,
  };
}

function finalizationHarness(commercialEnabled: boolean, affectedRows: number) {
  const rows = [
    [{ commercialEnabled, authorizationEpoch: commercialEnabled ? 2 : 3 }],
    [{ operationType: "create_payment", intentId: providerRequest.intentId }],
  ];
  let selected = 0;
  const insertValues = vi.fn(() => ({
    onDuplicateKeyUpdate: vi.fn(async () => undefined),
  }));
  const tx = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => ({
            for: vi.fn(async () => rows[selected++] ?? []),
          })),
        })),
      })),
    })),
    update: vi.fn(table => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => [
          {
            affectedRows:
              table === billingProviderOperations ? affectedRows : 1,
          },
        ]),
      })),
    })),
    insert: vi.fn(() => ({ values: insertValues })),
  };
  return {
    database: { transaction: vi.fn(async callback => callback(tx)) },
    insertValues,
  };
}
