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
  it("creates the first Bancontact payment with server fields and an idempotency key", async () => {
    const providerPayment = payment();
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
      "https://api.mollie.test/v2/"
    );

    await expect(
      client.createFirstPayment({
        customerId: "cst_customer123",
        amount: { currency: "EUR", value: "29.00" },
        description: "Leaderbot Premium - maandelijks abonnement",
        intentId: "intent_opaque123",
        redirectUrl: "https://leaderbot.test/billing/return/intent_opaque123",
        webhookUrl: "https://billing.test/api/webhooks/mollie/payments",
        idempotencyKey: "payment_intent_opaque123",
      })
    ).resolves.toEqual(providerPayment);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = fetchMock.mock.calls[0]!;
    expect(requestUrl).toBe("https://api.mollie.test/v2/payments");
    expect(requestInit?.method).toBe("POST");
    expect(requestInit?.headers).toMatchObject({
      Authorization: "Bearer test_example123",
      Accept: "application/hal+json",
      "Content-Type": "application/json",
      "Idempotency-Key": "payment_intent_opaque123",
    });
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      amount: { currency: "EUR", value: "29.00" },
      customerId: "cst_customer123",
      sequenceType: "first",
      method: "bancontact",
      locale: "nl_BE",
      description: "Leaderbot Premium - maandelijks abonnement",
      redirectUrl: "https://leaderbot.test/billing/return/intent_opaque123",
      webhookUrl: "https://billing.test/api/webhooks/mollie/payments",
      metadata: { billingIntentId: "intent_opaque123" },
    });
  });

  it("creates Startpilot as a one-off payment without recurring fields", async () => {
    const providerPayment = payment({
      amount: { currency: "EUR", value: "19.00" },
      description: "Leaderbot Startpilot - eenmalig 30 dagen",
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

    await client.createOneTimePayment({
      customerId: "cst_customer123",
      amount: { currency: "EUR", value: "19.00" },
      description: "Leaderbot Startpilot - eenmalig 30 dagen",
      intentId: "intent_opaque123",
      redirectUrl: "https://leaderbot.test/?billing=return",
      webhookUrl: "https://billing.test/api/webhooks/mollie/payments",
      idempotencyKey: "startpilot_intent_opaque123",
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      sequenceType: "oneoff",
      method: "bancontact",
      amount: { currency: "EUR", value: "19.00" },
      customerId: "cst_customer123",
    });
    expect(body).not.toHaveProperty("mandateId");
    expect(body).not.toHaveProperty("subscriptionId");
  });

  it("reuses an exact Bancontact credit-payment request without recurring or customer fields", async () => {
    const providerPayment = payment({
      amount: { currency: "EUR", value: "9.00" },
      description: "Leaderbot premium beeldcredits",
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

    const input = {
      amountValue: "9.00",
      description: "Leaderbot premium beeldcredits",
      creditCheckoutIntentId: "550e8400-e29b-41d4-a716-446655440000",
      redirectUrl:
        "https://leaderbot.test/?creditPayment=return&intent=550e8400-e29b-41d4-a716-446655440000",
      webhookUrl: "https://billing.test/api/webhooks/mollie/payments",
      idempotencyKey: "credit_payment_550e8400-e29b-41d4-a716-446655440000",
    } as const;

    await expect(client.createCreditPayment(input)).resolves.toEqual(
      providerPayment
    );
    await expect(client.createCreditPayment(input)).resolves.toEqual(
      providerPayment
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [requestUrl, requestInit] = fetchMock.mock.calls[0]!;
    const [replayUrl, replayInit] = fetchMock.mock.calls[1]!;
    expect(requestUrl).toBe("https://api.mollie.test/v2/payments");
    expect(replayUrl).toBe(requestUrl);
    expect(requestInit?.method).toBe("POST");
    expect(requestInit?.headers).toMatchObject({
      Authorization: "Bearer test_example123",
      Accept: "application/hal+json",
      "Content-Type": "application/json",
      "Idempotency-Key": "credit_payment_550e8400-e29b-41d4-a716-446655440000",
    });
    expect(replayInit?.headers).toEqual(requestInit?.headers);
    expect(replayInit?.body).toBe(requestInit?.body);
    const body = JSON.parse(String(requestInit?.body));
    expect(body).toEqual({
      amount: { currency: "EUR", value: "9.00" },
      sequenceType: "oneoff",
      method: "bancontact",
      locale: "nl_BE",
      description: "Leaderbot premium beeldcredits",
      redirectUrl:
        "https://leaderbot.test/?creditPayment=return&intent=550e8400-e29b-41d4-a716-446655440000",
      webhookUrl: "https://billing.test/api/webhooks/mollie/payments",
      metadata: {
        creditCheckoutIntentId: "550e8400-e29b-41d4-a716-446655440000",
      },
    });
    expect(body).not.toHaveProperty("customerId");
    expect(body).not.toHaveProperty("mandateId");
    expect(body).not.toHaveProperty("subscriptionId");
    expect(body).not.toHaveProperty("storeCredentials");
    expect(body).not.toHaveProperty("cardToken");
    expect(body).not.toHaveProperty("profileId");
    expect(body).not.toHaveProperty("testmode");
  });

  it.each([
    {
      name: "empty idempotency key",
      input: { idempotencyKey: "" },
      message: "invalid credit payment idempotency key",
    },
    {
      name: "whitespace idempotency key",
      input: { idempotencyKey: "                " },
      message: "invalid credit payment idempotency key",
    },
    {
      name: "non-UUID intent metadata",
      input: { creditCheckoutIntentId: "private-user-identifier" },
      message: "invalid credit checkout intent ID",
    },
    {
      name: "zero amount",
      input: { amountValue: "0.00" },
      message: "invalid credit payment amount",
    },
    {
      name: "below Bancontact minimum amount",
      input: { amountValue: "0.01" },
      message: "invalid credit payment amount",
    },
  ])("rejects $name before transport", async ({ input, message }) => {
    const fetchMock = vi.fn();
    const client = new MollieClient(
      config,
      fetchMock as unknown as typeof fetch,
      "https://api.mollie.test/v2"
    );

    await expect(
      client.createCreditPayment({
        amountValue: "9.00",
        description: "Leaderbot premium beeldcredits",
        creditCheckoutIntentId: "550e8400-e29b-41d4-a716-446655440000",
        redirectUrl: "https://leaderbot.test/?creditPayment=return",
        webhookUrl: "https://billing.test/api/webhooks/mollie/payments",
        idempotencyKey: "credit_payment_550e8400-e29b-41d4-a716-446655440000",
        ...input,
      })
    ).rejects.toThrow(message);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves a Mollie 409 so the caller can reconcile the same credit operation", async () => {
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
      client.createCreditPayment({
        amountValue: "9.00",
        description: "Leaderbot premium beeldcredits",
        creditCheckoutIntentId: "550e8400-e29b-41d4-a716-446655440000",
        redirectUrl: "https://leaderbot.test/?creditPayment=return",
        webhookUrl: "https://billing.test/api/webhooks/mollie/payments",
        idempotencyKey: "credit_payment_550e8400-e29b-41d4-a716-446655440000",
      })
    ).rejects.toMatchObject({ status: 409, code: "mollie_409" });
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
