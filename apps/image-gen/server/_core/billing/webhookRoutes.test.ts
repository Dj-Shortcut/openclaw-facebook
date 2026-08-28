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
  applyCreditPaymentWebhookSnapshot: vi.fn(),
  applyMolliePaymentSnapshot: vi.fn(),
  getRedisClient: vi.fn(),
  isRedisEnabled: vi.fn(),
  safeLog: vi.fn(),
  resolveMollieWebhookWorkspace: vi.fn(),
}));

vi.mock("./creditPaymentWebhook", () => ({
  applyCreditPaymentWebhookSnapshot: mocks.applyCreditPaymentWebhookSnapshot,
}));

vi.mock("./paymentStore", () => ({
  applyMolliePaymentSnapshot: mocks.applyMolliePaymentSnapshot,
}));

vi.mock("./checkoutStore", () => ({
  resolveMollieWebhookWorkspace: mocks.resolveMollieWebhookWorkspace,
}));

vi.mock("../logger", () => ({
  safeLog: mocks.safeLog,
}));

vi.mock("../redis", () => ({
  getRedisClient: mocks.getRedisClient,
  isRedisEnabled: mocks.isRedisEnabled,
}));

import {
  getMollieWebhookRateLimitKey,
  registerMollieWebhookRoute,
} from "./webhookRoutes";

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
      rateLimitRemaining: response.headers.get("ratelimit-remaining"),
      retryAfter: response.headers.get("retry-after"),
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
    mocks.isRedisEnabled.mockReturnValue(true);
    mocks.getRedisClient.mockResolvedValue({
      eval: vi.fn().mockResolvedValue(1),
    });
    mocks.applyMolliePaymentSnapshot.mockResolvedValue({
      result: "processed",
      workspaceId: 42,
    });
    mocks.applyCreditPaymentWebhookSnapshot.mockResolvedValue("unknown");
    mocks.resolveMollieWebhookWorkspace.mockResolvedValue(42);
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
      rateLimitRemaining: "5999",
      retryAfter: null,
      body: "OK",
    });
    expect(getPayment).toHaveBeenCalledTimes(1);
    expect(getPayment).toHaveBeenCalledWith("tr_payment123");
    expect(mocks.resolveMollieWebhookWorkspace).toHaveBeenCalledWith(
      "test",
      "tr_payment123",
      "intent_opaque123"
    );
    expect(mocks.applyMolliePaymentSnapshot).toHaveBeenCalledWith(payment, 42);
  });

  it("routes an exact customerless credit payment without legacy tenant lookup", async () => {
    const payment = providerPayment({
      id: "tr_credit123",
      amount: { currency: "EUR", value: "4.99" },
      description: "Leaderbot - 8 premium beeldcredits",
      customerId: undefined,
      method: "bancontact",
      sequenceType: "oneoff",
      metadata: {
        billingIntentId: "11111111-1111-8111-8111-111111111111",
        purpose: "premium_image_credits",
        version: 1,
        metadataHash: "a".repeat(64),
      },
    });
    mocks.applyCreditPaymentWebhookSnapshot.mockResolvedValueOnce("processed");
    const getPayment = vi.fn().mockResolvedValue(payment);

    const response = await postWebhook({
      body: "id=tr_credit123",
      contentType: "application/x-www-form-urlencoded",
      createClient: () => ({ getPayment }) as unknown as MollieClient,
    });

    expect(response.status).toBe(200);
    expect(mocks.applyCreditPaymentWebhookSnapshot).toHaveBeenCalledWith({
      webhookPaymentId: "tr_credit123",
      expectedMode: "test",
      payment,
    });
    expect(mocks.resolveMollieWebhookWorkspace).not.toHaveBeenCalled();
    expect(mocks.applyMolliePaymentSnapshot).not.toHaveBeenCalled();
  });

  it("does not acknowledge a retryable credit grant failure", async () => {
    const payment = providerPayment({
      id: "tr_creditretry",
      customerId: undefined,
      metadata: {
        billingIntentId: "11111111-1111-8111-8111-111111111111",
        purpose: "premium_image_credits",
        version: 1,
        metadataHash: "a".repeat(64),
      },
    });
    mocks.applyCreditPaymentWebhookSnapshot.mockRejectedValueOnce(
      new Error("credit database unavailable")
    );

    const response = await postWebhook({
      body: "id=tr_creditretry",
      contentType: "application/x-www-form-urlencoded",
      createClient: () =>
        ({
          getPayment: vi.fn().mockResolvedValue(payment),
        }) as unknown as MollieClient,
    });

    expect(response.status).toBe(503);
    expect(response.body).toBe("Retry");
    expect(mocks.resolveMollieWebhookWorkspace).not.toHaveBeenCalled();
  });

  it("routes multiple tenants from immutable provider metadata without a singleton pin", async () => {
    delete process.env.MOLLIE_BILLING_WORKER_WORKSPACE_ID;
    mocks.resolveMollieWebhookWorkspace.mockResolvedValue(77);
    const payment = providerPayment({
      id: "tr_tenant77",
      metadata: { billingIntentId: "intent_tenant77" },
    });
    const getPayment = vi.fn().mockResolvedValue(payment);

    const response = await postWebhook({
      body: "id=tr_tenant77",
      contentType: "application/x-www-form-urlencoded",
      createClient: () => ({ getPayment }) as unknown as MollieClient,
    });

    expect(response.status).toBe(200);
    expect(mocks.applyMolliePaymentSnapshot).toHaveBeenCalledWith(payment, 77);
  });

  it("fails closed when the provider metadata cannot establish a tenant", async () => {
    const getPayment = vi
      .fn()
      .mockResolvedValue(
        providerPayment({ metadata: { billingIntentId: "bad" } })
      );

    const response = await postWebhook({
      body: "id=tr_payment123",
      contentType: "application/x-www-form-urlencoded",
      createClient: () => ({ getPayment }) as unknown as MollieClient,
    });

    expect(response.status).toBe(200);
    expect(mocks.resolveMollieWebhookWorkspace).not.toHaveBeenCalled();
    expect(mocks.applyMolliePaymentSnapshot).not.toHaveBeenCalled();
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

  it("ignores a provider payment from the other billing mode", async () => {
    const getPayment = vi
      .fn()
      .mockResolvedValue(providerPayment({ mode: "live" }));
    const createClient = vi.fn(
      () => ({ getPayment }) as unknown as MollieClient
    );

    const response = await postWebhook({
      body: "id=tr_payment123",
      contentType: "application/x-www-form-urlencoded",
      createClient,
    });

    expect(response).toEqual({
      status: 200,
      contentType: "text/plain; charset=utf-8",
      rateLimitRemaining: "5999",
      retryAfter: null,
      body: "OK",
    });
    expect(mocks.applyMolliePaymentSnapshot).not.toHaveBeenCalled();
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
      { level: "warn", errorCode: "BillingOperationError" }
    );
    expect(JSON.stringify(mocks.safeLog.mock.calls)).not.toContain(
      "provider response contained a secret"
    );
  });

  it("shares the configured request budget across separate app instances", async () => {
    process.env.MOLLIE_WEBHOOK_RATE_LIMIT_PER_MINUTE = "1";
    const counts = new Map<string, number>();
    const redis = {
      eval: vi.fn(async (_script: string, _numKeys: number, key: string) => {
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        return count;
      }),
    };
    mocks.getRedisClient.mockResolvedValue(redis);

    const first = await postWebhook({
      body: "id=invalid",
      contentType: "application/x-www-form-urlencoded",
      createClient: vi.fn(),
    });
    const second = await postWebhook({
      body: "id=invalid",
      contentType: "application/x-www-form-urlencoded",
      createClient: vi.fn(),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(503);
    expect(second.body).toBe("Retry");
    expect(second.contentType).toBe("text/plain; charset=utf-8");
    expect(second.rateLimitRemaining).toBe("0");
    expect(second.retryAfter).not.toBeNull();
    expect(mocks.safeLog).toHaveBeenCalledWith(
      "mollie_payment_webhook_rate_limited",
      { level: "warn" }
    );
    const [script, numKeys, redisKey, ttlSeconds] =
      redis.eval.mock.calls[0] ?? [];
    expect(script).toContain('redis.call("INCR", KEYS[1])');
    expect(script).toContain('redis.call("EXPIRE", KEYS[1], ARGV[1])');
    expect(numKeys).toBe(1);
    expect(ttlSeconds).toBeGreaterThan(0);
    expect(redisKey).toMatch(/^mollie-webhook-rate-limit:[a-f0-9]{64}:\d+$/);
    expect(redisKey).not.toContain("tr_");
  });

  it("fails closed with a redacted retryable response when Redis is unavailable", async () => {
    mocks.getRedisClient.mockRejectedValue(
      new Error("redis secret connection string leaked")
    );
    const createClient = vi.fn();

    const response = await postWebhook({
      body: "id=tr_payment123",
      contentType: "application/x-www-form-urlencoded",
      createClient,
    });

    expect(response.status).toBe(503);
    expect(response.body).toBe("Retry");
    expect(createClient).not.toHaveBeenCalled();
    expect(mocks.safeLog).toHaveBeenCalledWith(
      "mollie_payment_webhook_rate_limit_unavailable",
      { level: "warn", errorCode: "BillingOperationError" }
    );
    expect(JSON.stringify(mocks.safeLog.mock.calls)).not.toContain(
      "redis secret connection string leaked"
    );
  });

  it("has no in-memory fallback when shared Redis limiting is unavailable", async () => {
    mocks.isRedisEnabled.mockReturnValue(false);
    const createClient = vi.fn();

    const response = await postWebhook({
      body: "id=tr_payment123",
      contentType: "application/x-www-form-urlencoded",
      createClient,
    });

    expect(response.status).toBe(503);
    expect(response.body).toBe("Retry");
    expect(mocks.getRedisClient).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("normalizes IPv4 and IPv6 source keys before hashing", () => {
    const request = (ip: string) =>
      ({ method: "POST", ip, socket: {} }) as never;

    expect(getMollieWebhookRateLimitKey(request("203.0.113.9"))).toBe(
      "POST:203.0.113.9"
    );
    expect(getMollieWebhookRateLimitKey(request("2001:db8:85a3:1234::1"))).toBe(
      getMollieWebhookRateLimitKey(request("2001:db8:85a3:1234::ffff"))
    );
  });
});
