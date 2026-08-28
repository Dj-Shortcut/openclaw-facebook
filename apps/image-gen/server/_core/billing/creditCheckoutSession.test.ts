import { describe, expect, it, vi } from "vitest";

import {
  CREDIT_CHECKOUT_SESSION_MAX_AGE_MS,
  CreditCheckoutSessionError,
  claimCreditCheckoutBrowserSession,
  mapCreditCheckoutReturnStatus,
  readCreditCheckoutBrowserSession,
} from "./creditCheckoutSession";
import { deriveCreditCheckoutCapability } from "./creditCheckoutCapability";
import type { CreditCheckoutSessionRecord } from "./creditCheckoutSessionStore";

const INTENT_ID = "11111111-1111-8111-8111-111111111111";
const WALLET_ID = "22222222-2222-8222-8222-222222222222";
const NOW = new Date("2026-08-28T12:00:00.000Z");
const CAPABILITY = deriveCreditCheckoutCapability({
  dedicatedSecret: Buffer.alloc(32, 7),
  intentId: INTENT_ID,
  metadataHash: "a".repeat(64),
});

function record(
  override: Partial<CreditCheckoutSessionRecord> = {}
): CreditCheckoutSessionRecord {
  return {
    intentId: INTENT_ID,
    workspaceId: 42,
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
    messengerSenderUserKey: "b".repeat(64),
    messengerChannelConnectionId: 8,
    messengerBindingEpoch: 3,
    messengerPrivacyEpoch: 5,
    creditWalletId: WALLET_ID,
    creditFinancialSubjectRef: "c".repeat(64),
    creditCount: 8,
    creditMetadataHash: "a".repeat(64),
    checkoutCapabilityHash: CAPABILITY.capabilityHash,
    checkoutCapabilityExpiresAt: new Date("2026-08-28T12:10:00.000Z"),
    checkoutCapabilityConsumedAt: null,
    checkoutCapabilitySessionNonceHash: null,
    creditIdentityErasedAt: null,
    billingProfileVersion: 0,
    authorizationEpoch: 6,
    urlExposedAt: null,
    paidAt: null,
    ...override,
  };
}

function dependencies(row: CreditCheckoutSessionRecord | null) {
  return {
    config: () => ({
      checkoutEnabled: true,
      paidCreditsEnabled: true,
      workspaceId: 42,
      mode: "test" as const,
    }),
    readRecord: vi.fn(async () => row),
    consume: vi.fn(async () => ({
      result: "applied" as const,
      intentId: INTENT_ID,
    })),
    now: () => NOW,
  };
}

describe("credit checkout browser sessions", () => {
  it("consumes the exact capability and returns only the public offer", async () => {
    const deps = dependencies(record());
    const result = await claimCreditCheckoutBrowserSession(
      { intentId: INTENT_ID, capability: CAPABILITY.toUrlFragment() },
      deps
    );

    expect(result.intentId).toBe(INTENT_ID);
    expect(result.cookieValue).toMatch(
      new RegExp(`^${INTENT_ID}[.][A-Za-z0-9_-]{43}$`)
    );
    expect(result.offer).toEqual({
      mode: "test",
      amount: "4.99",
      currency: "EUR",
      creditCount: 8,
      imageQuality: "medium",
      expires: false,
      automaticRenewal: false,
      refundPolicyId: "premium_image_credit_refund",
      refundPolicyVersion: 1,
    });
    expect(JSON.stringify(result)).not.toContain(CAPABILITY.toUrlFragment());
    expect(deps.consume).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 42,
        mode: "test",
        channelConnectionId: 8,
        bindingEpoch: 3,
        privacyEpoch: 5,
        userKey: "b".repeat(64),
        walletId: WALLET_ID,
        financialSubjectRef: "c".repeat(64),
        intentId: INTENT_ID,
        capabilityHash: CAPABILITY.capabilityHash,
        sessionNonceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      })
    );
  });

  it.each([
    ["wrong workspace", { workspaceId: 99 }],
    ["legacy kind", { kind: "startpilot_purchase" }],
    ["wrong amount", { expectedAmount: "49.90" }],
    ["customer-bound profile", { billingProfileVersion: 3 }],
    ["erased identity", { creditIdentityErasedAt: NOW }],
    ["already started", { status: "creating_payment" }],
    ["already claimed", { checkoutCapabilityConsumedAt: NOW }],
    [
      "expired capability",
      { checkoutCapabilityExpiresAt: new Date("2026-08-28T11:59:59.000Z") },
    ],
  ])("fails closed for %s", async (_label, override) => {
    const deps = dependencies(record(override));
    await expect(
      claimCreditCheckoutBrowserSession(
        { intentId: INTENT_ID, capability: CAPABILITY.toUrlFragment() },
        deps
      )
    ).rejects.toBeInstanceOf(CreditCheckoutSessionError);
    expect(deps.consume).not.toHaveBeenCalled();
  });

  it("authenticates the same browser session without reusing the capability", async () => {
    const claimDeps = dependencies(record());
    const claimed = await claimCreditCheckoutBrowserSession(
      { intentId: INTENT_ID, capability: CAPABILITY.toUrlFragment() },
      claimDeps
    );
    const consumed = claimDeps.consume.mock.calls[0]?.[0];
    const sessionHash = consumed?.sessionNonceHash;
    expect(sessionHash).toMatch(/^[0-9a-f]{64}$/);
    const readDeps = dependencies(
      record({
        checkoutCapabilityConsumedAt: NOW,
        checkoutCapabilitySessionNonceHash: sessionHash,
      })
    );

    const result = await readCreditCheckoutBrowserSession(
      claimed.cookieValue,
      { requireUnexpired: true },
      readDeps
    );

    expect(result.intentId).toBe(INTENT_ID);
    expect(readDeps.consume).not.toHaveBeenCalled();
  });

  it("rejects a copied or malformed browser cookie", async () => {
    const deps = dependencies(
      record({
        checkoutCapabilityConsumedAt: NOW,
        checkoutCapabilitySessionNonceHash: "d".repeat(64),
      })
    );
    await expect(
      readCreditCheckoutBrowserSession(
        `${INTENT_ID}.${"A".repeat(43)}`,
        { requireUnexpired: true },
        deps
      )
    ).rejects.toBeInstanceOf(CreditCheckoutSessionError);
    await expect(
      readCreditCheckoutBrowserSession(
        `${INTENT_ID}.bad`,
        { requireUnexpired: true },
        deps
      )
    ).rejects.toBeInstanceOf(CreditCheckoutSessionError);
  });

  it("keeps return-status access longer than the confirm window", async () => {
    const claimedDeps = dependencies(record());
    const claimed = await claimCreditCheckoutBrowserSession(
      { intentId: INTENT_ID, capability: CAPABILITY.toUrlFragment() },
      claimedDeps
    );
    const sessionHash = claimedDeps.consume.mock.calls[0]?.[0].sessionNonceHash;
    const expired = record({
      status: "paid",
      paidAt: new Date("2026-08-28T12:11:00.000Z"),
      molliePaymentId: "tr_testpayment",
      checkoutCapabilityConsumedAt: NOW,
      checkoutCapabilitySessionNonceHash: sessionHash,
      checkoutCapabilityExpiresAt: new Date("2026-08-28T12:10:00.000Z"),
    });
    const deps = {
      ...dependencies(expired),
      now: () => new Date("2026-08-28T12:20:00.000Z"),
    };

    await expect(
      readCreditCheckoutBrowserSession(
        claimed.cookieValue,
        { requireUnexpired: false },
        deps
      )
    ).resolves.toMatchObject({ intentId: INTENT_ID });
    await expect(
      readCreditCheckoutBrowserSession(
        claimed.cookieValue,
        { requireUnexpired: true },
        deps
      )
    ).rejects.toBeInstanceOf(CreditCheckoutSessionError);
  });

  it("maps only known intent states to the public return contract", () => {
    expect(mapCreditCheckoutReturnStatus("created")).toBe("processing");
    expect(mapCreditCheckoutReturnStatus("api_unknown")).toBe("processing");
    expect(mapCreditCheckoutReturnStatus("paid")).toBe("paid");
    expect(mapCreditCheckoutReturnStatus("mismatch")).toBe("failed");
    expect(mapCreditCheckoutReturnStatus("canceled")).toBe("canceled");
    expect(mapCreditCheckoutReturnStatus("expired")).toBe("expired");
    expect(() => mapCreditCheckoutReturnStatus("subscription_active")).toThrow(
      CreditCheckoutSessionError
    );
    expect(CREDIT_CHECKOUT_SESSION_MAX_AGE_MS).toBe(60 * 60_000);
  });
});
