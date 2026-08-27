import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PREMIUM_IMAGE_CREDITS_PLAN_CODE } from "./_core/billing/catalog";
import { registerPremiumCreditRoutes } from "./_core/billing/premiumCreditRoutes";

const originalSupportEmail = process.env.BILLING_SUPPORT_EMAIL;
const userKey = "a".repeat(64);
const capability = Object.freeze({
  workspaceId: 7,
  channelConnectionId: 11,
  bindingEpoch: 3,
  privacyEpoch: 5,
  userKey,
  pageId: "page-123",
  offer: PREMIUM_IMAGE_CREDITS_PLAN_CODE,
  nonce: "opaque-token-nonce-1234",
  issuedAt: 1_000,
  expiresAt: 601_000,
  checkoutScopeKey: `premium:${"b".repeat(64)}`,
});

beforeEach(() => {
  process.env.BILLING_SUPPORT_EMAIL = "billing@example.com";
});

afterEach(() => {
  if (originalSupportEmail === undefined) {
    delete process.env.BILLING_SUPPORT_EMAIL;
  } else {
    process.env.BILLING_SUPPORT_EMAIL = originalSupportEmail;
  }
});

describe("premium credit checkout routes", () => {
  it("shows an explicit one-time offer without subscription claims", async () => {
    const server = await startServer();
    try {
      const response = await fetch(`${server.baseUrl}/credits?token=opaque`);
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(body).toContain("5 premium credits");
      expect(body).toContain("Eenmalige betaling via Mollie");
      expect(body).toContain("Geen abonnement");
      expect(body).toContain('value="opaque"');
      expect(body).not.toContain(userKey);
    } finally {
      await server.close();
    }
  });

  it("binds checkout creation to the exact Messenger privacy subject", async () => {
    const startCheckout = vi.fn(async () => ({
      intentId: "intent-1",
      checkoutUrl: "https://www.mollie.com/checkout/test",
    }));
    const assertPrivacySubject = vi.fn(async () => undefined);
    const server = await startServer({ startCheckout, assertPrivacySubject });
    try {
      const response = await fetch(`${server.baseUrl}/api/credits/checkout`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: "opaque" }),
        redirect: "manual",
      });

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(
        "https://www.mollie.com/checkout/test"
      );
      expect(assertPrivacySubject).toHaveBeenCalledWith({
        workspaceId: 7,
        channelConnectionId: 11,
        userKey,
        privacyEpoch: 5,
      });
      expect(startCheckout).toHaveBeenCalledWith({
        workspaceId: 7,
        planCode: PREMIUM_IMAGE_CREDITS_PLAN_CODE,
        kind: "premium_credit_purchase",
        messengerSenderUserKey: userKey,
        messengerPageId: "page-123",
        messengerChannelConnectionId: 11,
        messengerPrivacyEpoch: 5,
        checkoutScopeKey: capability.checkoutScopeKey,
      });
    } finally {
      await server.close();
    }
  });

  it("fails closed when Page ownership changed", async () => {
    const startCheckout = vi.fn();
    const server = await startServer({
      startCheckout,
      resolveOwnership: vi.fn(async () => ({
        workspaceId: 8,
        channelConnectionId: 11,
        bindingEpoch: 3,
        pageId: "page-123",
      })),
    });
    try {
      const response = await fetch(`${server.baseUrl}/api/credits/checkout`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: "opaque" }),
      });

      expect(response.status).toBe(404);
      expect(startCheckout).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});

async function startServer(overrides: Record<string, unknown> = {}) {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  registerPremiumCreditRoutes(app, {
    readCheckoutToken: (() => capability) as never,
    assertPrivacySubject: (async () => undefined) as never,
    resolveOwnership: (async () => ({
      workspaceId: 7,
      channelConnectionId: 11,
      bindingEpoch: 3,
      pageId: "page-123",
    })) as never,
    startCheckout: (async () => ({
      intentId: "intent-default",
      checkoutUrl: "https://www.mollie.com/checkout/default",
    })) as never,
    ...overrides,
  });
  const listener = app.listen(0);
  await new Promise<void>(resolve => listener.once("listening", resolve));
  const { port } = listener.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        listener.close(error => (error ? reject(error) : resolve()))
      ),
  };
}
