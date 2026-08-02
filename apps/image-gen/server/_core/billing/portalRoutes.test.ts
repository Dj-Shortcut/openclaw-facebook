import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticatePortalRequest: vi.fn(),
  getMollieConfig: vi.fn(),
  getWorkspaceLedgerPayment: vi.fn(),
  getWorkspaceMembership: vi.fn(),
  listWorkspaceAccountingEntries: vi.fn(),
  requirePortalWorkspace: vi.fn(),
}));

vi.mock("../../db", () => ({
  getWorkspaceMembership: mocks.getWorkspaceMembership,
}));

vi.mock("../portalAuth", () => ({
  authenticatePortalRequest: mocks.authenticatePortalRequest,
  requirePortalWorkspace: mocks.requirePortalWorkspace,
}));

vi.mock("./config", () => ({
  getMollieConfig: mocks.getMollieConfig,
}));

vi.mock("./subscriptionStore", () => ({
  getWorkspaceLedgerPayment: mocks.getWorkspaceLedgerPayment,
  listWorkspaceAccountingEntries: mocks.listWorkspaceAccountingEntries,
}));

import { registerBillingPortalRoutes } from "./portalRoutes";

type RouteHandler = (
  req: {
    params: Record<string, string | string[] | undefined>;
    query: Record<string, string>;
  },
  res: FakeResponse,
  next: (error?: unknown) => void
) => void;

class FakeResponse {
  body: unknown;
  contentType = "";
  headers = new Map<string, string>();
  statusCode = 0;
  private resolveSend?: () => void;

  constructor(resolveSend: () => void) {
    this.resolveSend = resolveSend;
  }

  json(body: unknown): this {
    return this.send(body);
  }

  send(body: unknown): this {
    this.body = body;
    this.resolveSend?.();
    this.resolveSend = undefined;
    return this;
  }

  set(name: string, value: string): this {
    this.setHeader(name, value);
    return this;
  }

  setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }

  status(statusCode: number): this {
    this.statusCode = statusCode;
    return this;
  }

  type(contentType: string): this {
    this.contentType = contentType;
    return this;
  }
}

function registeredRoutes(): Map<string, RouteHandler> {
  const routes = new Map<string, RouteHandler>();
  registerBillingPortalRoutes({
    get(path: string, handler: RouteHandler) {
      routes.set(path, handler);
      return this;
    },
  } as never);
  return routes;
}

async function invokeRoute(
  path: string,
  request: Parameters<RouteHandler>[0]
): Promise<FakeResponse> {
  const handler = registeredRoutes().get(path);
  if (!handler) throw new Error(`Missing route: ${path}`);

  let response!: FakeResponse;
  await new Promise<void>((resolve, reject) => {
    response = new FakeResponse(resolve);
    handler(request, response, error => {
      if (error) reject(error);
      else resolve();
    });
  });
  return response;
}

describe("billing portal response caching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticatePortalRequest.mockResolvedValue({ id: 7 });
    mocks.requirePortalWorkspace.mockResolvedValue({ id: 42 });
    mocks.getWorkspaceMembership.mockResolvedValue({ role: "owner" });
    mocks.getMollieConfig.mockReturnValue({
      mode: "test",
      billingSupportEmail: "billing@leaderbot.test",
    });
  });

  it("marks receipt and accounting CSV responses private and non-cacheable", async () => {
    mocks.getWorkspaceLedgerPayment.mockResolvedValue({
      invoiceNumber: "LB-2026-000001",
      occurredAt: new Date("2026-08-01T00:00:00.000Z"),
      grossAmount: "29.00",
      currency: "EUR",
      status: "paid",
      molliePaymentId: "tr_payment123",
    });
    mocks.listWorkspaceAccountingEntries.mockResolvedValue([]);

    const receipt = await invokeRoute(
      "/api/portal/billing/receipts/:paymentId",
      {
        params: { paymentId: "tr_payment123" },
        query: { workspaceId: "42" },
      }
    );
    const accountingExport = await invokeRoute(
      "/api/portal/billing/export.csv",
      {
        params: {},
        query: { workspaceId: "42" },
      }
    );

    expect(receipt.statusCode).toBe(200);
    expect(receipt.contentType).toBe("html");
    expect(receipt.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0"
    );
    expect(accountingExport.statusCode).toBe(200);
    expect(accountingExport.headers.get("content-type")).toBe(
      "text/csv; charset=utf-8"
    );
    expect(accountingExport.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0"
    );
    expect(mocks.getWorkspaceLedgerPayment).toHaveBeenCalledWith(
      42,
      "test",
      "tr_payment123"
    );
    expect(mocks.listWorkspaceAccountingEntries).toHaveBeenCalledWith(
      42,
      "test"
    );
  });

  it.each([
    { label: "missing", params: {} },
    { label: "empty", params: { paymentId: "" } },
    { label: "malformed", params: { paymentId: "tr_invalid-value" } },
    { label: "an empty array", params: { paymentId: [] } },
    {
      label: "an array whose first value is empty",
      params: { paymentId: ["", "tr_payment123"] },
    },
  ])(
    "returns a neutral 404 without reading billing data for $label receipt parameters",
    async ({ params }) => {
      const response = await invokeRoute(
        "/api/portal/billing/receipts/:paymentId",
        {
          params,
          query: { workspaceId: "42" },
        }
      );

      expect(response.statusCode).toBe(404);
      expect(response.body).toBe("Not found");
      expect(mocks.authenticatePortalRequest).toHaveBeenCalledOnce();
      expect(mocks.getWorkspaceMembership).toHaveBeenCalledWith(42, 7);
      expect(mocks.getMollieConfig).not.toHaveBeenCalled();
      expect(mocks.getWorkspaceLedgerPayment).not.toHaveBeenCalled();
    }
  );

  it("returns 404 for a valid-shaped missing receipt after a tenant-scoped lookup", async () => {
    mocks.getWorkspaceLedgerPayment.mockResolvedValue(null);

    const response = await invokeRoute(
      "/api/portal/billing/receipts/:paymentId",
      {
        params: { paymentId: "tr_missing123" },
        query: { workspaceId: "42" },
      }
    );

    expect(response.statusCode).toBe(404);
    expect(response.body).toBe("Not found");
    expect(mocks.getWorkspaceLedgerPayment).toHaveBeenCalledOnce();
    expect(mocks.getWorkspaceLedgerPayment).toHaveBeenCalledWith(
      42,
      "test",
      "tr_missing123"
    );
  });

  it.each([
    "/api/portal/billing/receipts/:paymentId",
    "/api/portal/billing/export.csv",
  ])(
    "rejects ordinary members before reading billing data from %s",
    async path => {
      mocks.getWorkspaceMembership.mockResolvedValue({ role: "member" });

      const response = await invokeRoute(path, {
        params: { paymentId: "tr_payment123" },
        query: { workspaceId: "42" },
      });

      expect(response.statusCode).toBe(403);
      expect(response.body).toEqual({ error: "billing admin required" });
      expect(mocks.getWorkspaceLedgerPayment).not.toHaveBeenCalled();
      expect(mocks.listWorkspaceAccountingEntries).not.toHaveBeenCalled();
    }
  );

  it("neutralizes formula-like CSV values beginning with tab or carriage return", async () => {
    mocks.listWorkspaceAccountingEntries.mockResolvedValue([
      {
        occurredAt: new Date("2026-08-01T00:00:00.000Z"),
        invoiceNumber: '\t=HYPERLINK("https://example.test")',
        molliePaymentId: "tr_payment123",
        status: "\r=1+1",
        currency: "EUR",
        grossAmount: "29.00",
        mollieFees: null,
        refunds: [],
        chargebacks: [],
        settlementAmount: null,
        settlementId: null,
      },
    ]);

    const response = await invokeRoute("/api/portal/billing/export.csv", {
      params: {},
      query: { workspaceId: "42" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(
      `"'\t=HYPERLINK(""https://example.test"")"`
    );
    expect(response.body).toContain(`"'\r=1+1"`);
  });
});
