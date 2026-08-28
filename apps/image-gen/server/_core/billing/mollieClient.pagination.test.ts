import { describe, expect, it, vi } from "vitest";
import type { MollieConfig } from "./config";
import {
  MollieClient,
  type MollieMandate,
  type MolliePayment,
  type MollieSubscription,
} from "./mollieClient";

const config: MollieConfig = Object.freeze({
  apiKey: "test_example123",
  mode: "test",
  paymentWebhookUrl: "https://billing.test/api/webhooks/mollie/payments",
  appBaseUrl: "https://leaderbot.test",
  billingSupportEmail: "billing@leaderbot.test",
  liveBillingEnabled: false,
});

function payment(id: string): MolliePayment {
  return {
    resource: "payment",
    id,
    mode: "test",
    status: "paid",
    amount: { currency: "EUR", value: "29.00" },
    description: "Leaderbot Premium",
    createdAt: "2026-08-01T10:00:00.000Z",
  };
}

function mandate(id: string): MollieMandate {
  return {
    resource: "mandate",
    id,
    mode: "test",
    status: "valid",
    method: "directdebit",
    createdAt: "2026-08-01T10:00:00.000Z",
  };
}

function subscription(id: string): MollieSubscription {
  return {
    resource: "subscription",
    id,
    mode: "test",
    status: "active",
    amount: { currency: "EUR", value: "29.00" },
    interval: "1 month",
    startDate: "2026-08-01",
  };
}

describe("Mollie payment pagination", () => {
  it("lists bounded profile payments without a customer filter", async () => {
    const secondUrl =
      "https://api.mollie.test/v2/payments?from=tr_first&limit=250";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            _embedded: { payments: [payment("tr_first")] },
            _links: { next: { href: secondUrl } },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            _embedded: { payments: [payment("tr_second")] },
            _links: { next: null },
          }),
          { status: 200 }
        )
      );
    const client = new MollieClient(
      config,
      fetchMock as unknown as typeof fetch,
      "https://api.mollie.test/v2"
    );

    await expect(client.listPayments()).resolves.toEqual([
      payment("tr_first"),
      payment("tr_second"),
    ]);
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      "https://api.mollie.test/v2/payments?limit=250",
      secondUrl,
    ]);
    expect(
      fetchMock.mock.calls.every(call => !String(call[0]).includes("customers"))
    ).toBe(true);
  });

  it.each([
    ["missing from", "limit=250"],
    ["empty from", "from=&limit=250"],
    ["missing limit", "from=tr_first"],
    ["wrong limit", "from=tr_first&limit=100"],
    ["duplicate from", "from=tr_first&from=tr_second&limit=250"],
    ["duplicate limit", "from=tr_first&limit=250&limit=250"],
    ["customer filter", "from=tr_first&limit=250&customerId=cst_other"],
    ["status filter", "from=tr_first&limit=250&status=paid"],
    ["unknown filter", "from=tr_first&limit=250&unknown=value"],
    ["empty payment suffix", "from=tr_&limit=250"],
    ["wrong cursor type", "from=cst_customer123&limit=250"],
    ["malformed cursor", "from=tr_bad%2Fcursor&limit=250"],
    ["oversized cursor", `from=tr_${"a".repeat(62)}&limit=250`],
  ])(
    "rejects a profile-payment next query with %s before fetching it",
    async (_name, query) => {
      const fetchMock = vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            _embedded: { payments: [payment("tr_first")] },
            _links: {
              next: {
                href: `https://api.mollie.test/v2/payments?${query}`,
              },
            },
          }),
          { status: 200 }
        )
      );
      const client = new MollieClient(
        config,
        fetchMock as unknown as typeof fetch,
        "https://api.mollie.test/v2"
      );

      await expect(client.listPayments()).rejects.toThrow(
        "Mollie returned an unexpected payment pagination query"
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it("fails closed before a fifth profile-payment page is fetched", async () => {
    const fetchMock = vi.fn();
    for (let page = 1; page <= 4; page += 1) {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            _embedded: { payments: [payment(`tr_page${page}`)] },
            _links: {
              next: {
                href: `https://api.mollie.test/v2/payments?from=tr_page${page}&limit=250`,
              },
            },
          }),
          { status: 200 }
        )
      );
    }
    const client = new MollieClient(
      config,
      fetchMock as unknown as typeof fetch,
      "https://api.mollie.test/v2"
    );

    await expect(client.listPayments()).rejects.toThrow(
      "Mollie pagination page limit exceeded"
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("fails closed when a profile-payment page exceeds the result bound", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          _embedded: {
            payments: Array.from({ length: 1_001 }, (_, index) =>
              payment(`tr_result${index}`)
            ),
          },
          _links: { next: null },
        }),
        { status: 200 }
      )
    );
    const client = new MollieClient(
      config,
      fetchMock as unknown as typeof fetch,
      "https://api.mollie.test/v2"
    );

    await expect(client.listPayments()).rejects.toThrow(
      "Mollie pagination result limit exceeded"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    "https://attacker.test/v2/payments?from=tr_first&limit=250",
    "http://api.mollie.test/v2/payments?from=tr_first&limit=250",
    "https://api.mollie.test/v2/customers/cst_other/payments?from=tr_first&limit=250",
    "https://user:password@api.mollie.test/v2/payments?from=tr_first&limit=250",
    "https://api.mollie.test/v2/payments?from=tr_first&limit=250#fragment",
  ])("rejects a hostile profile-payment next link: %s", async nextHref => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          _embedded: { payments: [payment("tr_first")] },
          _links: { next: { href: nextHref } },
        }),
        { status: 200 }
      )
    );
    const client = new MollieClient(
      config,
      fetchMock as unknown as typeof fetch,
      "https://api.mollie.test/v2"
    );

    await expect(client.listPayments()).rejects.toThrow(
      "Mollie returned an unexpected pagination URL"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { href: "" },
    { href: 123 },
    "https://api.mollie.test/v2/payments?from=tr_first&limit=250",
  ])("rejects a malformed profile-payment next link: %j", async next => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          _embedded: { payments: [payment("tr_first")] },
          _links: { next },
        }),
        { status: 200 }
      )
    );
    const client = new MollieClient(
      config,
      fetchMock as unknown as typeof fetch,
      "https://api.mollie.test/v2"
    );

    await expect(client.listPayments()).rejects.toThrow(
      "Mollie returned an invalid pagination URL"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows every same-origin HAL next link", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            _embedded: { payments: [payment("tr_first")] },
            _links: {
              next: {
                href: "https://api.mollie.test/v2/customers/cst_customer123/payments?from=tr_first&limit=250",
              },
            },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            _embedded: { payments: [payment("tr_second")] },
            _links: { next: null },
          }),
          { status: 200 }
        )
      );
    const client = new MollieClient(
      config,
      fetchMock as unknown as typeof fetch,
      "https://api.mollie.test/v2"
    );

    await expect(
      client.listCustomerPayments("cst_customer123")
    ).resolves.toEqual([payment("tr_first"), payment("tr_second")]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      "https://api.mollie.test/v2/customers/cst_customer123/payments?limit=250",
      "https://api.mollie.test/v2/customers/cst_customer123/payments?from=tr_first&limit=250",
    ]);
  });

  it("keeps the legacy customer-payment query contract unchanged", async () => {
    const secondUrl =
      "https://api.mollie.test/v2/customers/cst_customer123/payments?from=tr_first&limit=100";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            _embedded: { payments: [payment("tr_first")] },
            _links: { next: { href: secondUrl } },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            _embedded: { payments: [payment("tr_second")] },
            _links: { next: null },
          }),
          { status: 200 }
        )
      );
    const client = new MollieClient(
      config,
      fetchMock as unknown as typeof fetch,
      "https://api.mollie.test/v2"
    );

    await expect(
      client.listCustomerPayments("cst_customer123")
    ).resolves.toEqual([payment("tr_first"), payment("tr_second")]);
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      "https://api.mollie.test/v2/customers/cst_customer123/payments?limit=250",
      secondUrl,
    ]);
  });

  it("rejects pagination links outside the configured API origin", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          _embedded: { payments: [payment("tr_first")] },
          _links: {
            next: { href: "https://attacker.test/v2/payments?from=tr_first" },
          },
        }),
        { status: 200 }
      )
    );
    const client = new MollieClient(
      config,
      fetchMock as unknown as typeof fetch,
      "https://api.mollie.test/v2"
    );

    await expect(
      client.listCustomerPayments("cst_customer123")
    ).rejects.toThrow("Mollie returned an unexpected pagination URL");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("detects a pagination cycle before fetching the repeated page", async () => {
    const initialUrl =
      "https://api.mollie.test/v2/customers/cst_customer123/payments?limit=250";
    const secondUrl =
      "https://api.mollie.test/v2/customers/cst_customer123/payments?from=tr_first&limit=250";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            _embedded: { payments: [payment("tr_first")] },
            _links: { next: { href: secondUrl } },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            _embedded: { payments: [payment("tr_second")] },
            _links: { next: { href: initialUrl } },
          }),
          { status: 200 }
        )
      );
    const client = new MollieClient(
      config,
      fetchMock as unknown as typeof fetch,
      "https://api.mollie.test/v2"
    );

    await expect(
      client.listCustomerPayments("cst_customer123")
    ).rejects.toThrow("Mollie pagination cycle detected");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      initialUrl,
      secondUrl,
    ]);
  });
});

describe("Mollie mandate and subscription pagination", () => {
  it("follows every mandate page", async () => {
    const secondUrl =
      "https://api.mollie.test/v2/customers/cst_customer123/mandates?from=mdt_first&limit=250&scopes%5B%5D=customer-not-present";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            _embedded: { mandates: [mandate("mdt_first")] },
            _links: { next: { href: secondUrl } },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            _embedded: { mandates: [mandate("mdt_second")] },
            _links: { next: null },
          }),
          { status: 200 }
        )
      );
    const client = new MollieClient(
      config,
      fetchMock as unknown as typeof fetch,
      "https://api.mollie.test/v2"
    );

    await expect(client.listMandates("cst_customer123")).resolves.toEqual([
      mandate("mdt_first"),
      mandate("mdt_second"),
    ]);
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      "https://api.mollie.test/v2/customers/cst_customer123/mandates?limit=250&scopes%5B%5D=customer-not-present",
      secondUrl,
    ]);
  });

  it("follows every customer-subscription page", async () => {
    const secondUrl =
      "https://api.mollie.test/v2/customers/cst_customer123/subscriptions?from=sub_first&limit=250";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            _embedded: { subscriptions: [subscription("sub_first")] },
            _links: { next: { href: secondUrl } },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            _embedded: { subscriptions: [subscription("sub_second")] },
            _links: { next: null },
          }),
          { status: 200 }
        )
      );
    const client = new MollieClient(
      config,
      fetchMock as unknown as typeof fetch,
      "https://api.mollie.test/v2"
    );

    await expect(
      client.listCustomerSubscriptions("cst_customer123")
    ).resolves.toEqual([subscription("sub_first"), subscription("sub_second")]);
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      "https://api.mollie.test/v2/customers/cst_customer123/subscriptions?limit=250",
      secondUrl,
    ]);
  });

  it("preserves empty-array results for empty mandate and subscription pages", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ _embedded: {} }), { status: 200 })
    );
    const client = new MollieClient(
      config,
      fetchMock as unknown as typeof fetch,
      "https://api.mollie.test/v2"
    );

    await expect(client.listMandates("cst_customer123")).resolves.toEqual([]);
    await expect(
      client.listCustomerSubscriptions("cst_customer123")
    ).resolves.toEqual([]);
  });
});
