import { describe, expect, it, vi } from "vitest";

import type { MollieConfig } from "./config";
import { MollieClient, type MolliePayment } from "./mollieClient";

const config: MollieConfig = Object.freeze({
  apiKey: "test_example123",
  mode: "test",
  paymentWebhookUrl: "https://billing.test/api/webhooks/mollie/payments",
  appBaseUrl: "https://leaderbot.test",
  billingSupportEmail: "billing@leaderbot.test",
  liveBillingEnabled: false,
});

const CREDIT_INTENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const CREDIT_METADATA_HASH = "a".repeat(64);
const CREDIT_PAYMENT_INPUT = Object.freeze({
  amount: Object.freeze({ currency: "EUR", value: "9.00" }),
  description: "Leaderbot premium beeldcredits",
  billingIntentId: CREDIT_INTENT_ID,
  metadataHash: CREDIT_METADATA_HASH,
  redirectUrl: "https://leaderbot.test/credits/checkout/return",
  webhookUrl: "https://billing.test/api/webhooks/mollie/payments",
  idempotencyKey: `credit-payment:${CREDIT_INTENT_ID}`,
});

function payment(overrides: Partial<MolliePayment> = {}): MolliePayment {
  return {
    resource: "payment",
    id: "tr_payment123",
    mode: "test",
    status: "open",
    amount: { currency: "EUR", value: "29.00" },
    description: "Leaderbot Premium - maandelijks abonnement",
    createdAt: "2026-08-01T10:00:00+00:00",
    ...overrides,
  };
}

describe("MollieClient", () => {
  it("cancels an exact open payment without putting credentials in the URL", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const client = new MollieClient(
      config,
      fetchMock as unknown as typeof fetch,
      "https://api.mollie.test/v2"
    );

    await client.cancelPayment("tr_payment123");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.mollie.test/v2/payments/tr_payment123");
    expect(String(url)).not.toContain(config.apiKey);
    expect(init?.method).toBe("DELETE");
    expect(init?.headers).toMatchObject({
      Authorization: `Bearer ${config.apiKey}`,
    });
  });
  it("replays exact customerless Bancontact credit-payment request bytes", async () => {
    const providerPayment = payment({
      amount: CREDIT_PAYMENT_INPUT.amount,
      description: CREDIT_PAYMENT_INPUT.description,
      sequenceType: "oneoff",
    });
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify(providerPayment), {
          status: 201,
          headers: { "content-type": "application/json" },
        })
    );
    const client = new MollieClient(
      config,
      fetchMock as unknown as typeof fetch,
      "https://api.mollie.test/v2"
    );

    await expect(
      client.createCreditPayment(CREDIT_PAYMENT_INPUT)
    ).resolves.toEqual(providerPayment);
    await expect(
      client.createCreditPayment(CREDIT_PAYMENT_INPUT)
    ).resolves.toEqual(providerPayment);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [requestUrl, requestInit] = fetchMock.mock.calls[0]!;
    const [replayUrl, replayInit] = fetchMock.mock.calls[1]!;
    const expectedBody = JSON.stringify({
      amount: { currency: "EUR", value: "9.00" },
      sequenceType: "oneoff",
      method: "bancontact",
      locale: "nl_BE",
      description: "Leaderbot premium beeldcredits",
      redirectUrl: "https://leaderbot.test/credits/checkout/return",
      webhookUrl: "https://billing.test/api/webhooks/mollie/payments",
      metadata: {
        billingIntentId: CREDIT_INTENT_ID,
        purpose: "premium_image_credits",
        version: 1,
        metadataHash: CREDIT_METADATA_HASH,
      },
    });

    expect(requestUrl).toBe("https://api.mollie.test/v2/payments");
    expect(replayUrl).toBe(requestUrl);
    expect(requestInit?.method).toBe("POST");
    expect(requestInit?.headers).toMatchObject({
      Authorization: "Bearer test_example123",
      Accept: "application/hal+json",
      "Content-Type": "application/json",
      "Idempotency-Key": `credit-payment:${CREDIT_INTENT_ID}`,
    });
    expect(requestInit?.body).toBe(expectedBody);
    expect(replayInit?.headers).toEqual(requestInit?.headers);
    expect(replayInit?.body).toBe(expectedBody);

    const body = JSON.parse(expectedBody) as Record<string, unknown>;
    for (const forbiddenField of [
      "customerId",
      "mandateId",
      "subscriptionId",
      "storeCredentials",
      "cardToken",
      "profileId",
      "testmode",
    ]) {
      expect(body).not.toHaveProperty(forbiddenField);
    }
    expect(Object.keys(body.metadata as Record<string, unknown>)).toEqual([
      "billingIntentId",
      "purpose",
      "version",
      "metadataHash",
    ]);
  });

  it.each([
    {
      name: "non-EUR amount",
      override: { amount: { currency: "USD", value: "9.00" } },
      message: "invalid Mollie amount",
    },
    {
      name: "zero amount",
      override: { amount: { currency: "EUR", value: "0.00" } },
      message: "invalid credit payment amount",
    },
    {
      name: "non-canonical amount",
      override: { amount: { currency: "EUR", value: "9" } },
      message: "invalid Mollie amount",
    },
    {
      name: "description with surrounding whitespace",
      override: { description: " Leaderbot premium beeldcredits" },
      message: "invalid credit payment description",
    },
    {
      name: "non-UUID billing intent",
      override: { billingIntentId: "private-user-identifier" },
      message: "invalid credit payment billing intent ID",
    },
    {
      name: "non-hash metadata",
      override: { metadataHash: "private-user-identifier" },
      message: "invalid credit payment metadata hash",
    },
    {
      name: "return URL with intent query",
      override: {
        redirectUrl: `https://leaderbot.test/credits/checkout/return?intent=${CREDIT_INTENT_ID}`,
      },
      message: "invalid credit payment return URL",
    },
    {
      name: "different same-origin return path",
      override: {
        redirectUrl: "https://leaderbot.test/credits/checkout/other-return",
      },
      message: "invalid credit payment return URL",
    },
    {
      name: "cross-origin return URL",
      override: {
        redirectUrl: "https://attacker.test/credits/checkout/return",
      },
      message: "invalid credit payment return URL",
    },
    {
      name: "non-exact webhook URL",
      override: {
        webhookUrl:
          "https://billing.test/api/webhooks/mollie/payments/alternate",
      },
      message: "invalid credit payment webhook URL",
    },
    {
      name: "empty idempotency key",
      override: { idempotencyKey: "" },
      message: "invalid credit payment idempotency key",
    },
    {
      name: "well-formed key bound to another intent",
      override: {
        idempotencyKey: "credit-payment:00000000-0000-4000-8000-000000000001",
      },
      message: "invalid credit payment idempotency key",
    },
  ])("rejects $name before transport", async ({ override, message }) => {
    const fetchMock = vi.fn();
    const client = new MollieClient(
      config,
      fetchMock as unknown as typeof fetch,
      "https://api.mollie.test/v2"
    );

    await expect(
      client.createCreditPayment({
        ...CREDIT_PAYMENT_INPUT,
        ...override,
      })
    ).rejects.toThrow(message);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves a 409 for exact credit-payment reconciliation", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: 409 }), {
          status: 409,
          headers: { "content-type": "application/json" },
        })
    );
    const client = new MollieClient(
      config,
      fetchMock as unknown as typeof fetch,
      "https://api.mollie.test/v2"
    );

    await expect(
      client.createCreditPayment(CREDIT_PAYMENT_INPUT)
    ).rejects.toMatchObject({ status: 409, code: "mollie_409" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    "https://mollie.com/checkout/select-method/tr_payment123",
    "https://www.mollie.com/checkout/select-method/tr_payment123",
    "https://checkout.mollie.com/pay/tr_payment123",
  ])("accepts a secure Mollie hosted-checkout URL: %s", checkoutUrl => {
    const client = new MollieClient(config);

    expect(
      client.getHostedCheckoutUrl(
        payment({ _links: { checkout: { href: checkoutUrl } } })
      )
    ).toBe(checkoutUrl);
  });

  it.each([
    "http://www.mollie.com/checkout/tr_payment123",
    "https://mollie.com.attacker.test/checkout/tr_payment123",
    "https://attacker.test/checkout/tr_payment123",
  ])("rejects an unexpected hosted-checkout URL: %s", checkoutUrl => {
    const client = new MollieClient(config);

    expect(() =>
      client.getHostedCheckoutUrl(
        payment({ _links: { checkout: { href: checkoutUrl } } })
      )
    ).toThrow("Mollie returned an unexpected checkout host");
  });

  it("rejects a payment response without a hosted-checkout URL", () => {
    const client = new MollieClient(config);

    expect(() => client.getHostedCheckoutUrl(payment())).toThrow(
      "Mollie payment has no hosted checkout URL"
    );
  });
});
