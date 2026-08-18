import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { hashCanonicalSnapshot } from "./ids";
import {
  billingIntents,
  billingProviderOperations,
} from "../../../drizzle/schema";

const { databaseMock } = vi.hoisted(() => ({ databaseMock: vi.fn() }));
vi.mock("../../db", () => ({ getDatabaseOrThrow: databaseMock }));

import { claimIntentPaymentCreation } from "./checkoutStore";

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
    providerRequest: { ...providerRequest, ...patch },
  };
}

function claimHarness(options: { profileVersion?: number } = {}) {
  const profileVersion = options.profileVersion ?? 7;
  const rows = [
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
