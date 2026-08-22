import { describe, expect, it, vi } from "vitest";

import {
  MollieBalanceAccountingReader,
  parseBalanceTransactionsPage,
} from "./mollieAccountingReader";

describe("MollieBalanceAccountingReader", () => {
  it("maps account-wide balance metadata without tenant input", () => {
    expect(parseBalanceTransactionsPage(page())).toEqual({
      events: [
        expect.objectContaining({
          id: "baltr_123456",
          providerType: "refund",
          type: "refund",
          paymentId: "tr_payment123",
          amount: { currency: "EUR", value: "-10.00" },
          netAmount: { currency: "EUR", value: "-10.25" },
          deductionAmount: { currency: "EUR", value: "0.25" },
        }),
      ],
      nextCursor: "baltr_next123",
    });
  });

  it("uses GET, Bearer auth, no URL token, and refuses redirects", async () => {
    const fetchMock = vi.fn(
      async (_url: URL, init?: RequestInit) =>
        new Response(JSON.stringify(page({ next: null })), {
          status: 200,
          headers: { "content-type": "application/hal+json" },
        })
    );
    const token = "access_test_token_that_is_never_in_the_url";
    const reader = new MollieBalanceAccountingReader(
      token,
      fetchMock as typeof fetch
    );
    await reader.listEvents({ mode: "test", cursor: "baltr_cursor1" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).not.toContain(token);
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("error");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${token}`
    );
  });

  it("fails closed on malformed amounts and off-origin pagination", () => {
    const malformed = page();
    (
      malformed._embedded.balance_transactions[0]!.initialAmount as {
        currency: string;
      }
    ).currency = "USD";
    expect(() => parseBalanceTransactionsPage(malformed)).toThrow(
      "billing_accounting_data_quality"
    );
    expect(() =>
      parseBalanceTransactionsPage(
        page({ next: { href: "https://evil.example/x?from=stolen" } })
      )
    ).toThrow("billing_accounting_data_quality");
    expect(() =>
      parseBalanceTransactionsPage(
        page({
          next: {
            href: "https://api.mollie.com/v2/balances/primary/transactions?from=stolen",
          },
        }),
        "bal_accounting123"
      )
    ).toThrow("billing_accounting_data_quality");
  });

  it("binds every request and pagination cursor to the configured balance", async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            page({
              next: {
                href: "https://api.mollie.com/v2/balances/bal_accounting123/transactions?from=baltr_next123",
              },
            })
          ),
          { status: 200 }
        )
      )
    );
    const reader = new MollieBalanceAccountingReader(
      "access_test_token_that_is_never_in_the_url",
      fetchMock as typeof fetch,
      "https://api.mollie.com",
      async () => undefined,
      "bal_accounting123"
    );
    await reader.listEvents({ mode: "test", cursor: null });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/v2/balances/bal_accounting123/transactions"
    );
  });

  it("marks unknown provider transaction types for quarantine instead of treating them as fees", () => {
    const unknown = page();
    unknown._embedded.balance_transactions[0]!.type = "future-private-type";
    expect(parseBalanceTransactionsPage(unknown).events[0]).toMatchObject({
      providerType: "future-private-type",
      type: "unknown",
    });
  });

  it("bounds response bytes while reading the body", async () => {
    const reader = new MollieBalanceAccountingReader(
      "access_test_token_that_is_never_in_the_url",
      vi.fn(async () =>
        Promise.resolve(
          new Response("x".repeat(1_000_001), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        )
      ) as typeof fetch,
      "https://api.mollie.com",
      async () => undefined
    );
    await expect(
      reader.listEvents({ mode: "test", cursor: null })
    ).rejects.toThrow("billing_accounting_data_quality");
  });

  it("retries transient responses using Retry-After without changing the cursor", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("", { status: 429, headers: { "retry-after": "0" } })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(page({ next: null })), { status: 200 })
      );
    const sleep = vi.fn(async () => undefined);
    const reader = new MollieBalanceAccountingReader(
      "access_test_token_that_is_never_in_the_url",
      fetchMock as typeof fetch,
      "https://api.mollie.com",
      sleep
    );
    await expect(
      reader.listEvents({ mode: "test", cursor: "baltr_samecursor" })
    ).resolves.toMatchObject({ events: [expect.any(Object)] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(0);
    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual([
      expect.stringContaining("from=baltr_samecursor"),
      expect.stringContaining("from=baltr_samecursor"),
    ]);
  });
});

function page(overrides: { next?: unknown } = {}) {
  return {
    count: 1,
    _embedded: {
      balance_transactions: [
        {
          resource: "balance-transaction",
          id: "baltr_123456",
          type: "refund",
          initialAmount: { currency: "EUR", value: "-10.00" },
          resultAmount: { currency: "EUR", value: "-10.25" },
          deductions: { currency: "EUR", value: "0.25" },
          context: { paymentId: "tr_payment123" },
          createdAt: "2026-08-18T10:00:00+00:00",
        },
      ],
    },
    _links: {
      next:
        overrides.next === undefined
          ? {
              href: "https://api.mollie.com/v2/balances/primary/transactions?from=baltr_next123",
            }
          : overrides.next,
    },
  };
}
