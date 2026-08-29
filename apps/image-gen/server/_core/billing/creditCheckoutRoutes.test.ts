import { createServer, type Server } from "node:http";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CREDIT_CHECKOUT_SESSION_COOKIE,
  type CreditCheckoutPublicOffer,
} from "./creditCheckoutSession";
import type { CreditCheckoutSessionRecord } from "./creditCheckoutSessionStore";
import { registerCreditCheckoutRoutes } from "./creditCheckoutRoutes";

const INTENT_ID = "11111111-1111-8111-8111-111111111111";
const OTHER_INTENT_ID = "99999999-9999-4999-8999-999999999999";
const COOKIE_VALUE = `${INTENT_ID}.${"A".repeat(43)}`;
const OTHER_COOKIE_VALUE = `${OTHER_INTENT_ID}.${"B".repeat(43)}`;
const OFFER: CreditCheckoutPublicOffer = Object.freeze({
  mode: "test",
  amount: "4.99",
  currency: "EUR",
  creditCount: 8,
  imageQuality: "medium",
  expires: false,
  automaticRenewal: false,
  refundPolicyId: "premium_image_credit_refund",
  refundPolicyVersion: 1,
});

type BoundServer = Readonly<{ server: Server; baseUrl: string }>;

async function bind(app: express.Express): Promise<BoundServer> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("bind failed");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });
}

function session(
  status = "created",
  options: Readonly<{ intentId?: string; userKey?: string }> = {}
) {
  const intentId = options.intentId ?? INTENT_ID;
  const record: CreditCheckoutSessionRecord = {
    intentId,
    workspaceId: 42,
    mode: "test",
    planCode: "premium_image_credits_8_v1",
    kind: "credit_purchase",
    expectedAmount: "4.99",
    currency: "EUR",
    interval: "oneoff",
    entitlements: {},
    mollieDescription: "Leaderbot - 8 premium beeldcredits",
    status,
    molliePaymentId: status === "paid" ? "tr_payment123" : null,
    messengerSenderUserKey: options.userKey ?? "a".repeat(64),
    messengerChannelConnectionId: 7,
    messengerBindingEpoch: 3,
    messengerPrivacyEpoch: 5,
    creditWalletId: "22222222-2222-8222-8222-222222222222",
    creditFinancialSubjectRef: "b".repeat(64),
    creditCount: 8,
    creditMetadataHash: "c".repeat(64),
    checkoutCapabilityHash: "d".repeat(64),
    checkoutCapabilityExpiresAt: new Date("2026-08-28T13:15:00.000Z"),
    checkoutCapabilityConsumedAt: new Date("2026-08-28T13:01:00.000Z"),
    checkoutCapabilitySessionNonceHash: "e".repeat(64),
    creditIdentityErasedAt: null,
    billingProfileVersion: 0,
    authorizationEpoch: 4,
    urlExposedAt:
      status === "paid" ? new Date("2026-08-28T13:02:00.000Z") : null,
    paidAt: status === "paid" ? new Date("2026-08-28T13:03:00.000Z") : null,
  };
  return {
    intentId,
    offer: OFFER,
    record,
  };
}

describe("credit checkout public routes", () => {
  let bound: BoundServer | undefined;
  const claim = vi.fn(async () => ({
    cookieValue: COOKIE_VALUE,
    intentId: INTENT_ID,
    offer: OFFER,
  }));
  const readSession = vi.fn(async () => session());
  const confirm = vi.fn(async () => ({
    checkoutUrl: "https://www.mollie.com/checkout/test-payment",
  }));
  const grantComplete = vi.fn(async () => true);

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = "test";
  });

  afterEach(async () => {
    if (bound) await close(bound.server);
    bound = undefined;
    delete process.env.APP_BASE_URL;
  });

  async function start() {
    const app = express();
    registerCreditCheckoutRoutes(app, {
      claim,
      readSession,
      grantComplete,
      confirm,
    });
    bound = await bind(app);
    process.env.APP_BASE_URL = `${bound.baseUrl}/`;
    return bound;
  }

  it("claims the fragment capability once and sets a protected browser cookie", async () => {
    const target = await start();
    const response = await fetch(
      `${target.baseUrl}/api/credits/checkout/${INTENT_ID}/claim`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: target.baseUrl,
          "Sec-Fetch-Site": "same-origin",
          "X-Forwarded-Proto": "https",
        },
        body: JSON.stringify({ capability: "C".repeat(43) }),
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ offer: OFFER });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${CREDIT_CHECKOUT_SESSION_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("C".repeat(43));
    expect(claim).toHaveBeenCalledWith({
      intentId: INTENT_ID,
      capability: "C".repeat(43),
    });
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each([
    ["cross-site origin", "https://evil.invalid", "same-origin"],
    ["cross-site fetch metadata", "__BASE__", "cross-site"],
  ])(
    "rejects %s before capability consumption",
    async (_label, origin, site) => {
      const target = await start();
      const response = await fetch(
        `${target.baseUrl}/api/credits/checkout/${INTENT_ID}/claim`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: origin === "__BASE__" ? target.baseUrl : origin,
            "Sec-Fetch-Site": site,
          },
          body: JSON.stringify({ capability: "C".repeat(43) }),
        }
      );
      expect(response.status).toBe(404);
      expect(claim).not.toHaveBeenCalled();
    }
  );

  it("loads an existing session without a provider call", async () => {
    const target = await start();
    const response = await fetch(
      `${target.baseUrl}/api/credits/checkout/${INTENT_ID}/session`,
      {
        headers: {
          Cookie: `${CREDIT_CHECKOUT_SESSION_COOKIE}=${COOKIE_VALUE}`,
        },
      }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ offer: OFFER });
    expect(readSession).toHaveBeenCalledWith(COOKIE_VALUE, {
      requireUnexpired: true,
    });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("rejects a cookie claimed for a different visible intent", async () => {
    const target = await start();
    const otherIntent = "33333333-3333-8333-8333-333333333333";
    const response = await fetch(
      `${target.baseUrl}/api/credits/checkout/${otherIntent}/session`,
      {
        headers: {
          Cookie: `${CREDIT_CHECKOUT_SESSION_COOKIE}=${COOKIE_VALUE}`,
        },
      }
    );

    expect(response.status).toBe(404);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("rejects confirmation when the path and cookie intents differ", async () => {
    const target = await start();
    const otherIntent = "33333333-3333-8333-8333-333333333333";
    const response = await fetch(
      `${target.baseUrl}/api/credits/checkout/${otherIntent}/confirm`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: target.baseUrl,
          Cookie: `${CREDIT_CHECKOUT_SESSION_COOKIE}=${COOKIE_VALUE}`,
        },
        body: "{}",
      }
    );

    expect(response.status).toBe(404);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("calls the provider path only after an explicit same-origin confirmation", async () => {
    const target = await start();
    const response = await fetch(
      `${target.baseUrl}/api/credits/checkout/${INTENT_ID}/confirm`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: target.baseUrl,
          "Sec-Fetch-Site": "same-origin",
          Cookie: `${CREDIT_CHECKOUT_SESSION_COOKIE}=${COOKIE_VALUE}`,
        },
        body: "{}",
      }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      checkoutUrl: "https://www.mollie.com/checkout/test-payment",
    });
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("rejects a cookie session that belongs to another visible checkout intent", async () => {
    const target = await start();
    const read = await fetch(
      `${target.baseUrl}/api/credits/checkout/${OTHER_INTENT_ID}/session`,
      {
        headers: {
          Cookie: `${CREDIT_CHECKOUT_SESSION_COOKIE}=${COOKIE_VALUE}`,
        },
      }
    );
    const confirmResponse = await fetch(
      `${target.baseUrl}/api/credits/checkout/${OTHER_INTENT_ID}/confirm`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: target.baseUrl,
          "Sec-Fetch-Site": "same-origin",
          Cookie: `${CREDIT_CHECKOUT_SESSION_COOKIE}=${COOKIE_VALUE}`,
        },
        body: "{}",
      }
    );

    expect(read.status).toBe(404);
    expect(confirmResponse.status).toBe(404);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("keeps two checkout tabs bound to their visible identity after the shared cookie is overwritten", async () => {
    const firstSession = session("created", {
      intentId: INTENT_ID,
      userKey: "a".repeat(64),
    });
    const secondSession = session("created", {
      intentId: OTHER_INTENT_ID,
      userKey: "f".repeat(64),
    });
    readSession.mockImplementation(async cookieValue => {
      if (cookieValue === COOKIE_VALUE) return firstSession;
      if (cookieValue === OTHER_COOKIE_VALUE) return secondSession;
      throw new Error("unknown checkout session");
    });
    const target = await start();

    // Both tabs share one origin cookie. Claiming the second identity replaces
    // the first tab's cookie, but must not let that tab load or confirm it.
    const staleTabRead = await fetch(
      `${target.baseUrl}/api/credits/checkout/${INTENT_ID}/session`,
      {
        headers: {
          Cookie: `${CREDIT_CHECKOUT_SESSION_COOKIE}=${OTHER_COOKIE_VALUE}`,
        },
      }
    );
    const staleTabConfirm = await fetch(
      `${target.baseUrl}/api/credits/checkout/${INTENT_ID}/confirm`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: target.baseUrl,
          "Sec-Fetch-Site": "same-origin",
          Cookie: `${CREDIT_CHECKOUT_SESSION_COOKIE}=${OTHER_COOKIE_VALUE}`,
        },
        body: "{}",
      }
    );

    expect(staleTabRead.status).toBe(404);
    expect(staleTabConfirm.status).toBe(404);
    expect(confirm).not.toHaveBeenCalled();

    const currentTabConfirm = await fetch(
      `${target.baseUrl}/api/credits/checkout/${OTHER_INTENT_ID}/confirm`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: target.baseUrl,
          "Sec-Fetch-Site": "same-origin",
          Cookie: `${CREDIT_CHECKOUT_SESSION_COOKIE}=${OTHER_COOKIE_VALUE}`,
        },
        body: "{}",
      }
    );

    expect(currentTabConfirm.status).toBe(200);
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith(secondSession);
  });

  it("rejects a non-Mollie redirect returned by the provider service", async () => {
    confirm.mockResolvedValueOnce({
      checkoutUrl: "https://mollie.com.evil.invalid/checkout",
    });
    const target = await start();
    const response = await fetch(
      `${target.baseUrl}/api/credits/checkout/${INTENT_ID}/confirm`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: target.baseUrl,
          Cookie: `${CREDIT_CHECKOUT_SESSION_COOKIE}=${COOKIE_VALUE}`,
        },
        body: "{}",
      }
    );
    expect(response.status).toBe(404);
  });

  it("returns only the server-side payment status after redirect", async () => {
    readSession.mockResolvedValueOnce(session("paid"));
    const target = await start();
    const response = await fetch(
      `${target.baseUrl}/api/credits/checkout/return-status`,
      {
        headers: {
          Cookie: `${CREDIT_CHECKOUT_SESSION_COOKIE}=${COOKIE_VALUE}`,
        },
      }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "paid" });
    expect(readSession).toHaveBeenCalledWith(COOKIE_VALUE, {
      requireUnexpired: false,
    });
    expect(grantComplete).toHaveBeenCalledWith({
      workspaceId: 42,
      mode: "test",
      intentId: INTENT_ID,
      providerPaymentId: "tr_payment123",
      walletId: "22222222-2222-8222-8222-222222222222",
      metadataHash: "c".repeat(64),
    });
  });

  it("keeps showing processing until the paid credit grant is durable", async () => {
    readSession.mockResolvedValueOnce(session("paid"));
    grantComplete.mockResolvedValueOnce(false);
    const target = await start();
    const response = await fetch(
      `${target.baseUrl}/api/credits/checkout/return-status`,
      {
        headers: {
          Cookie: `${CREDIT_CHECKOUT_SESSION_COOKIE}=${COOKIE_VALUE}`,
        },
      }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "processing" });
  });
});
