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

describe("Mollie payment pagination", () => {
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
