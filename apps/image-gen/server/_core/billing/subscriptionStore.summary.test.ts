import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDatabaseOrThrow: vi.fn(),
}));

vi.mock("../../db", () => ({
  getDatabaseOrThrow: mocks.getDatabaseOrThrow,
}));

import { getWorkspaceBillingSummary } from "./subscriptionStore";

function selectChain(rows: unknown[], includeOrderBy = false) {
  const chain = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(includeOrderBy ? chain : undefined);
  return chain;
}

describe("workspace billing summary visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("defaults payment history closed and does not query the ledger", async () => {
    const subscription = selectChain([]);
    const entitlement = selectChain([]);
    const database = {
      select: vi
        .fn()
        .mockReturnValueOnce(subscription)
        .mockReturnValueOnce(entitlement),
    };
    mocks.getDatabaseOrThrow.mockResolvedValue(database);

    await expect(getWorkspaceBillingSummary(42, "test")).resolves.toEqual({
      subscription: null,
      entitlement: null,
      payments: [],
    });
    expect(database.select).toHaveBeenCalledTimes(2);
  });

  it("loads workspace-scoped payment history for billing managers", async () => {
    const subscription = selectChain([]);
    const entitlement = selectChain([]);
    const payments = selectChain(
      [
        {
          molliePaymentId: "tr_payment123",
          grossAmount: "29.00",
          currency: "EUR",
          status: "paid",
          invoiceNumber: "LB-2026-000001",
          occurredAt: new Date("2026-08-01T00:00:00.000Z"),
        },
      ],
      true
    );
    const database = {
      select: vi
        .fn()
        .mockReturnValueOnce(subscription)
        .mockReturnValueOnce(entitlement)
        .mockReturnValueOnce(payments),
    };
    mocks.getDatabaseOrThrow.mockResolvedValue(database);

    const summary = await getWorkspaceBillingSummary(42, "test", {
      includePayments: true,
    });

    expect(database.select).toHaveBeenCalledTimes(3);
    expect(summary.payments).toEqual([
      expect.objectContaining({
        molliePaymentId: "tr_payment123",
        receiptPath:
          "/api/portal/billing/receipts/tr_payment123?workspaceId=42",
      }),
    ]);
  });
});
