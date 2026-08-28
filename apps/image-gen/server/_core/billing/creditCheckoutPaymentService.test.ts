import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MollieConfig } from "./config";
import type { CreditCheckoutPilotConfig } from "./creditCheckoutConfig";
import type { CreditCheckoutProviderScope } from "./creditCheckoutProviderStore";
import {
  confirmCreditCheckoutPayment,
  CreditCheckoutPaymentError,
  type CreditCheckoutPaymentSession,
} from "./creditCheckoutPaymentService";
import { MollieApiError, type MolliePayment } from "./mollieClient";

const INTENT_ID = "11111111-1111-8111-8111-111111111111";
const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const LEASE_TOKEN = "33333333-3333-4333-8333-333333333333";
const PAYMENT_ID = "tr_credit1";

const pilot: CreditCheckoutPilotConfig = Object.freeze({
  checkoutEnabled: true,
  paidCreditsEnabled: true,
  workspaceId: 42,
  mode: "test",
});

const config: MollieConfig = Object.freeze({
  apiKey: "test_redacted",
  mode: "test",
  paymentWebhookUrl: "https://app.leaderbot.live/api/webhooks/mollie/payments",
  appBaseUrl: "https://app.leaderbot.live",
  billingSupportEmail: "support@example.com",
  liveBillingEnabled: false,
});

function session(
  patch: Partial<CreditCheckoutPaymentSession["record"]> = {}
): CreditCheckoutPaymentSession {
  return {
    intentId: INTENT_ID,
    offer: {
      mode: "test",
      amount: "4.99",
      currency: "EUR",
      creditCount: 8,
      imageQuality: "medium",
      expires: false,
      automaticRenewal: false,
    },
    record: {
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
      messengerSenderUserKey: `u2.k1.${"a".repeat(64)}`,
      messengerChannelConnectionId: 7,
      messengerBindingEpoch: 3,
      messengerPrivacyEpoch: 4,
      creditWalletId: "44444444-4444-8444-8444-444444444444",
      creditFinancialSubjectRef: "b".repeat(64),
      creditCount: 8,
      creditMetadataHash: "c".repeat(64),
      checkoutCapabilityHash: "d".repeat(64),
      checkoutCapabilityExpiresAt: new Date("2026-08-28T10:00:00.000Z"),
      checkoutCapabilityConsumedAt: new Date("2026-08-28T09:00:00.000Z"),
      checkoutCapabilitySessionNonceHash: "e".repeat(64),
      creditIdentityErasedAt: null,
      billingProfileVersion: 0,
      authorizationEpoch: 2,
      urlExposedAt: null,
      paidAt: null,
      ...patch,
    },
  };
}

function payment(patch: Partial<MolliePayment> = {}): MolliePayment {
  return {
    resource: "payment",
    id: PAYMENT_ID,
    mode: "test",
    status: "open",
    amount: { currency: "EUR", value: "4.99" },
    description: "Leaderbot - 8 premium beeldcredits",
    method: null,
    sequenceType: "oneoff",
    customerId: null,
    subscriptionId: null,
    mandateId: null,
    metadata: {
      billingIntentId: INTENT_ID,
      purpose: "premium_image_credits",
      version: 1,
      metadataHash: "c".repeat(64),
    },
    createdAt: "2026-08-28T09:01:00.000Z",
    _links: {
      checkout: { href: "https://www.mollie.com/checkout/select-method/x" },
    },
    ...patch,
  };
}

function harness(
  options: {
    providerResult?: MolliePayment;
    providerError?: unknown;
    claim?: boolean;
    transport?: boolean;
    finalized?: Readonly<{ recorded: boolean; authorized: boolean }>;
    exposed?: boolean;
    checkoutUrlError?: boolean;
  } = {}
) {
  const calls: string[] = [];
  const createCreditPayment = vi.fn(async () => {
    calls.push("provider");
    if (options.providerError) throw options.providerError;
    return options.providerResult ?? payment();
  });
  const getHostedCheckoutUrl = vi.fn(() => {
    calls.push("url");
    if (options.checkoutUrlError) throw new Error("bad provider URL");
    return "https://www.mollie.com/checkout/select-method/x";
  });
  const claim = vi.fn(async (_scope: CreditCheckoutProviderScope) => {
    calls.push("claim");
    return options.claim === false
      ? ({ claimed: false } as const)
      : ({
          claimed: true,
          operationId: OPERATION_ID,
          leaseToken: LEASE_TOKEN,
        } as const);
  });
  const markTransportStarted = vi.fn(async () => {
    calls.push("transport");
    return options.transport ?? true;
  });
  const finalize = vi.fn(async (input: { outcome: unknown }) => {
    calls.push("finalize");
    return {
      recorded: options.finalized?.recorded ?? true,
      authorized: options.finalized?.authorized ?? true,
      revokedAuthorizationEpoch: null,
      outcome: input.outcome,
    };
  });
  const expose = vi.fn(async () => {
    calls.push("expose");
    return options.exposed ?? true;
  });
  const dependencies = {
    mollieConfig: () => config,
    pilotConfig: () => pilot,
    createClient: () => ({ createCreditPayment, getHostedCheckoutUrl }),
    claim,
    markTransportStarted,
    finalize,
    expose,
  };
  return {
    calls,
    createCreditPayment,
    getHostedCheckoutUrl,
    claim,
    markTransportStarted,
    finalize,
    expose,
    dependencies,
  };
}

describe("confirmCreditCheckoutPayment", () => {
  beforeEach(() => vi.clearAllMocks());

  it("persists the exact known response before exposing its checkout URL", async () => {
    const test = harness();
    await expect(
      confirmCreditCheckoutPayment(session(), test.dependencies)
    ).resolves.toEqual({
      checkoutUrl: "https://www.mollie.com/checkout/select-method/x",
    });

    expect(test.calls).toEqual([
      "claim",
      "transport",
      "provider",
      "url",
      "finalize",
      "expose",
    ]);
    expect(test.createCreditPayment).toHaveBeenCalledWith({
      amount: { currency: "EUR", value: "4.99" },
      description: "Leaderbot - 8 premium beeldcredits",
      billingIntentId: INTENT_ID,
      metadataHash: "c".repeat(64),
      redirectUrl: "https://app.leaderbot.live/credits/checkout/return",
      webhookUrl: "https://app.leaderbot.live/api/webhooks/mollie/payments",
      idempotencyKey: `credit-payment:${INTENT_ID}`,
    });
    expect(test.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: { kind: "known_succeeded", paymentId: PAYMENT_ID },
      })
    );
  });

  it("makes no provider call when the exact claim or transport lease is lost", async () => {
    const noClaim = harness({ claim: false });
    await expect(
      confirmCreditCheckoutPayment(session(), noClaim.dependencies)
    ).rejects.toBeInstanceOf(CreditCheckoutPaymentError);
    expect(noClaim.createCreditPayment).not.toHaveBeenCalled();

    const noLease = harness({ transport: false });
    await expect(
      confirmCreditCheckoutPayment(session(), noLease.dependencies)
    ).rejects.toBeInstanceOf(CreditCheckoutPaymentError);
    expect(noLease.createCreditPayment).not.toHaveBeenCalled();
    expect(noLease.finalize).not.toHaveBeenCalled();
  });

  it("records a provider HTTP rejection as known failed", async () => {
    const test = harness({ providerError: new MollieApiError(422, "invalid") });
    await expect(
      confirmCreditCheckoutPayment(session(), test.dependencies)
    ).rejects.toBeInstanceOf(CreditCheckoutPaymentError);
    expect(test.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: { kind: "known_failed" } })
    );
    expect(test.expose).not.toHaveBeenCalled();
  });

  it("records a network or response-parse failure as ambiguous", async () => {
    for (const providerError of [
      new MollieApiError(0, "AbortError"),
      new MollieApiError(503, "http_503"),
      new SyntaxError("malformed accepted response"),
    ]) {
      const test = harness({ providerError });
      await expect(
        confirmCreditCheckoutPayment(session(), test.dependencies)
      ).rejects.toBeInstanceOf(CreditCheckoutPaymentError);
      expect(test.finalize).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: { kind: "ambiguous" } })
      );
    }
  });

  it("contains a known payment whose immutable response shape mismatches", async () => {
    const test = harness({
      providerResult: payment({ amount: { currency: "EUR", value: "5.00" } }),
    });
    await expect(
      confirmCreditCheckoutPayment(session(), test.dependencies)
    ).rejects.toBeInstanceOf(CreditCheckoutPaymentError);
    expect(test.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: { kind: "known_mismatch", paymentId: PAYMENT_ID },
      })
    );
    expect(test.expose).not.toHaveBeenCalled();
  });

  it("contains a known payment with an invalid hosted checkout URL", async () => {
    const test = harness({ checkoutUrlError: true });
    await expect(
      confirmCreditCheckoutPayment(session(), test.dependencies)
    ).rejects.toBeInstanceOf(CreditCheckoutPaymentError);
    expect(test.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: { kind: "known_mismatch", paymentId: PAYMENT_ID },
      })
    );
    expect(test.expose).not.toHaveBeenCalled();
  });

  it("keeps an unidentifiable accepted response in reconciliation", async () => {
    const test = harness({ providerResult: payment({ id: "not-a-payment" }) });
    await expect(
      confirmCreditCheckoutPayment(session(), test.dependencies)
    ).rejects.toBeInstanceOf(CreditCheckoutPaymentError);
    expect(test.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: { kind: "ambiguous" } })
    );
    expect(test.expose).not.toHaveBeenCalled();
  });

  it("does not expose a result rejected by the atomic finalizer", async () => {
    for (const finalized of [
      { recorded: false, authorized: false },
      { recorded: true, authorized: false },
    ]) {
      const test = harness({ finalized });
      await expect(
        confirmCreditCheckoutPayment(session(), test.dependencies)
      ).rejects.toBeInstanceOf(CreditCheckoutPaymentError);
      expect(test.expose).not.toHaveBeenCalled();
    }
  });

  it("fails before claiming when the pilot or browser scope changes", async () => {
    const test = harness();
    await expect(
      confirmCreditCheckoutPayment(session({ messengerPrivacyEpoch: 5 }), {
        ...test.dependencies,
        pilotConfig: () => ({ ...pilot, workspaceId: 99 }),
      })
    ).rejects.toBeInstanceOf(CreditCheckoutPaymentError);
    expect(test.claim).not.toHaveBeenCalled();
    expect(test.createCreditPayment).not.toHaveBeenCalled();
  });
});
