import http from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bindTestHttpServer } from "../../testHttpServer";
import {
  MollieApiError,
  type MollieClient,
  type MolliePayment,
} from "./mollieClient";

const mocks = vi.hoisted(() => ({
  applyMolliePaymentSnapshot: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("./paymentStore", () => ({
  applyMolliePaymentSnapshot: mocks.applyMolliePaymentSnapshot,
}));

vi.mock("../logger", () => ({
  safeLog: mocks.safeLog,
}));

import { registerMollieWebhookRoute } from "./webhookRoutes";

const originalEnv = { ...process.env };

function providerPayment(
  overrides: Partial<MolliePayment> = {}
): MolliePayment {
  return {
    resource: "payment",
    id: "tr_payment123",
    mode: "test",
    status: "paid",
    amount: { currency: "EUR", value: "29.00" },
    description: "Leaderbot Premium - maandelijks abonnement",
    customerId: "cst_customer123",
    metadata: { billingIntentId: "intent_opaque123" },
    createdAt: "2026-08-01T10:00:00+00:00",
    paidAt: "2026-08-01T10:01:00+00:00",
    ...overrides,
  };
}

async function postWebhook(input: {
  body: string;
  contentType: string;
  createClient: () => MollieClient;
}) {
  const app = express();
  registerMollieWebhookRoute(app, { createClient: input.createClient });
  const server = http.createServer(app);
  const boundServer = await bindTestHttpServer(server);

  try {
    const response = await fetch(
      `${boundServer.baseUrl}/api/webhooks/mollie/payments`,
      {
        method: "POST",
        headers: { "content-type": input.contentType },
        body: input.body,
      }
    );
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: await response.text(),
    };
  } finally {
    await boundServer.close();
  }
}

describe("classic Mollie payment webhook", () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      NODE_ENV: "test",
      MOLLIE_API_KEY: "test_example123",
      MOLLIE_MODE: "test",
      MOLLIE_PAYMENT_WEBHOOK_URL:
        "http://billing.test/api/webhooks/mollie/payments",
      APP_BASE_URL: "http://leaderbot.test",
      BILLING_SUPPORT_EMAIL: "billing@leaderbot.test",
      MOLLIE_BILLING_WORKER_WORKSPACE_ID: "42",
    };
    delete process.env.MOLLIE_LIVE_BILLING_ENABLED;
    vi.clearAllMocks();
    mocks.applyMolliePaymentSnapshot.mockResolvedValue({
      result: "processed",
      workspaceId: 42,
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("accepts form-urlencoded input, reads only id and processes the fetched payment", async () => {
    const payment = providerPayment();
    const getPayment = vi.fn().mockResolvedValue(payment);
    const createClient = vi.fn(
      () => ({ getPayment }) as unknown as MollieClient
    );

    const response = await postWebhook({
      body: "id=tr_payment123&status=paid",
      contentType: "application/x-www-form-urlencoded",
      createClient,
    });

    expect(response).toEqual({
      status: 200,
      contentType: "text/plain; charset=utf-8",
      body: "OK",
    });
    expect(getPayment).toHaveBeenCalledTimes(1);
    expect(getPayment).toHaveBeenCalledWith("tr_payment123");
    expect(mocks.applyMolliePaymentSnapshot).toHaveBeenCalledWith(payment, 42);
  });

  it("returns the same generic 200 for an unknown provider payment", async () => {
    const getPayment = vi
      .fn()
      .mockRejectedValue(new MollieApiError(404, "mollie_404"));
    const createClient = vi.fn(
      () => ({ getPayment }) as unknown as MollieClient
    );

    const response = await postWebhook({
      body: "id=tr_unknown123",
      contentType: "application/x-www-form-urlencoded",
      createClient,
    });

    expect(response.status).toBe(200);
    expect(response.body).toBe("OK");
    expect(mocks.applyMolliePaymentSnapshot).not.toHaveBeenCalled();
    expect(mocks.safeLog).toHaveBeenCalledWith(
      "mollie_payment_webhook_processed",
      { result: "unknown" }
    );
  });

  it.each(["id=", "id=payment123", "id=tr_bad%21", "id=tr_"])(
    "returns a generic 200 without a provider call for invalid form body %j",
    async body => {
      const createClient = vi.fn();

      const response = await postWebhook({
        body,
        contentType: "application/x-www-form-urlencoded",
        createClient,
      });

      expect(response.status).toBe(200);
      expect(response.body).toBe("OK");
      expect(createClient).not.toHaveBeenCalled();
      expect(mocks.applyMolliePaymentSnapshot).not.toHaveBeenCalled();
    }
  );

  it("does not interpret JSON as a classic form-urlencoded webhook", async () => {
    const createClient = vi.fn();

    const response = await postWebhook({
      body: JSON.stringify({ id: "tr_payment123" }),
      contentType: "application/json",
      createClient,
    });

    expect(response.status).toBe(200);
    expect(response.body).toBe("OK");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("returns a redacted retryable 503 when provider processing fails", async () => {
    const getPayment = vi
      .fn()
      .mockRejectedValue(new Error("provider response contained a secret"));
    const createClient = vi.fn(
      () => ({ getPayment }) as unknown as MollieClient
    );

    const response = await postWebhook({
      body: "id=tr_payment123",
      contentType: "application/x-www-form-urlencoded",
      createClient,
    });

    expect(response.status).toBe(503);
    expect(response.body).toBe("Retry");
    expect(mocks.safeLog).toHaveBeenCalledWith(
      "mollie_payment_webhook_failed_retryable",
      { level: "warn", errorCode: "Error" }
    );
    expect(JSON.stringify(mocks.safeLog.mock.calls)).not.toContain(
      "provider response contained a secret"
    );
  });
});
