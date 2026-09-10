import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";

import express from "express";
import { afterEach, describe, expect, it } from "vitest";

import type { MollieConfig } from "./_core/billing/config";
import {
  PREMIUM_IMAGE_CREDIT_OFFER_ID,
  PREMIUM_IMAGE_CREDIT_OFFER_VERSION,
  getCreditOffer,
} from "./_core/billing/creditCatalog";
import { deriveCreditCheckoutCapability } from "./_core/billing/creditCheckoutCapability";
import { deriveCreditCheckoutTestUserKeyHash } from "./_core/billing/creditCheckoutConfig";
import { confirmCreditCheckoutPayment } from "./_core/billing/creditCheckoutPaymentService";
import type { CreditCheckoutProviderScope } from "./_core/billing/creditCheckoutProviderStore";
import {
  CreditCheckoutReservationError,
  reserveMessengerCreditCheckout,
} from "./_core/billing/creditCheckoutReservationService";
import { registerCreditCheckoutRoutes } from "./_core/billing/creditCheckoutRoutes";
import {
  CREDIT_CHECKOUT_SESSION_COOKIE,
  claimCreditCheckoutBrowserSession,
  readCreditCheckoutBrowserSession,
} from "./_core/billing/creditCheckoutSession";
import type { CreditCheckoutSessionRecord } from "./_core/billing/creditCheckoutSessionStore";
import { validateCreditPaymentContract } from "./_core/billing/creditPaymentContract";
import { applyCreditPaymentWebhookSnapshot } from "./_core/billing/creditPaymentWebhook";
import { MollieClient, type MolliePayment } from "./_core/billing/mollieClient";
import { serveStatic } from "./_core/vite";

/**
 * End-to-end contract for the one Test Mode journey the owner runs with the
 * pinned tester: the personal Messenger link, the browser session it opens,
 * the provider handoff, and the credits the verified webhook grants.
 *
 * Every cryptographic, contract, and route module below is the production one.
 * Only the four database seams are replaced by an in-memory model that mirrors
 * the exact rows `credit_reserve_checkout_intent` writes, so the test proves
 * the seams between modules rather than any single module in isolation.
 */

const HMAC_SECRET = Buffer.alloc(32, 7);
const TESTER_USER_KEY = `u2.k1.${"a".repeat(64)}`;
const OTHER_USER_KEY = `u2.k1.${"b".repeat(64)}`;
const WORKSPACE_ID = 42;
const CHANNEL_CONNECTION_ID = 8;
const BINDING_EPOCH = 3;
const PRIVACY_EPOCH = 5;
const AUTHORIZATION_EPOCH = 7;
const NOW = new Date("2026-09-10T09:00:00.000Z");
const PAYMENT_ID = "tr_creditjourney1";
const MOLLIE_CHECKOUT_URL =
  "https://www.mollie.com/checkout/select-method/creditjourney";
const APP_HTTPS_BASE_URL = "https://app.leaderbot.live";

const TESTER_REQUEST = Object.freeze({
  workspaceId: WORKSPACE_ID,
  channelConnectionId: CHANNEL_CONNECTION_ID,
  bindingEpoch: BINDING_EPOCH,
  privacyEpoch: PRIVACY_EPOCH,
  userKey: TESTER_USER_KEY,
  requestId: "messenger-generation-request-journey",
});

const mollieConfig: MollieConfig = Object.freeze({
  apiKey: "test_journeyredacted",
  mode: "test",
  paymentWebhookUrl: `${APP_HTTPS_BASE_URL}/api/webhooks/mollie/payments`,
  appBaseUrl: APP_HTTPS_BASE_URL,
  billingSupportEmail: "support@example.com",
  liveBillingEnabled: false,
});

type IntentRow = {
  -readonly [
    K in keyof CreditCheckoutSessionRecord
  ]: CreditCheckoutSessionRecord[K];
};

type WalletRow = {
  walletId: string;
  workspaceId: number;
  mode: "test" | "live";
  channelConnectionId: number;
  bindingEpoch: number;
  privacyEpoch: number;
  userKey: string;
  financialSubjectRef: string;
  credits: number;
  grantEntryIds: Set<string>;
};

type BoundServer = Readonly<{ server: Server; baseUrl: string }>;

function pilotConfig() {
  return Object.freeze({
    checkoutEnabled: true,
    paidCreditsEnabled: true,
    workspaceId: WORKSPACE_ID,
    mode: "test" as const,
    paidImageProviderMaxCostUsd: 1,
    testPilotScope: Object.freeze({
      channelConnectionId: CHANNEL_CONNECTION_ID,
      bindingEpoch: BINDING_EPOCH,
      privacyEpoch: PRIVACY_EPOCH,
      userKeyHash: deriveCreditCheckoutTestUserKeyHash(TESTER_USER_KEY),
    }),
  });
}

function withKeyring<T>(
  callback: (
    keys: readonly Readonly<{ keyId: string; secret: Uint8Array }>[]
  ) => T
): T {
  return callback([{ keyId: "k1", secret: HMAC_SECRET }]);
}

/**
 * The in-memory stand-in for the exact `billing_intents` and `credit_wallets`
 * rows the reservation procedure creates and the later stages mutate.
 */
class CheckoutWorld {
  readonly intents = new Map<string, IntentRow>();
  readonly wallets = new Map<string, WalletRow>();
  now = NOW;

  reserve = async (input: {
    intentId: string;
    walletId: string;
    workspaceId: number;
    mode: "test" | "live";
    channelConnectionId: number;
    bindingEpoch: number;
    privacyEpoch: number;
    userKey: string;
    financialSubjectRef: string;
    authorizationEpoch: number;
    offerSnapshotCode: string;
    expectedAmount: string;
    creditCount: number;
    description: string;
    metadataHash: string;
    idempotencyKey: string;
    checkoutScopeKey: string;
    capabilityHash: string;
    capabilityExpiresAt: Date;
  }) => {
    if (!this.wallets.has(input.walletId)) {
      this.wallets.set(input.walletId, {
        walletId: input.walletId,
        workspaceId: input.workspaceId,
        mode: input.mode,
        channelConnectionId: input.channelConnectionId,
        bindingEpoch: input.bindingEpoch,
        privacyEpoch: input.privacyEpoch,
        userKey: input.userKey,
        financialSubjectRef: input.financialSubjectRef,
        credits: 0,
        grantEntryIds: new Set<string>(),
      });
    }
    const existing = this.intents.get(input.intentId);
    if (existing) {
      return {
        result: "already_applied" as const,
        intentId: existing.intentId,
        walletId: input.walletId,
      };
    }
    this.intents.set(input.intentId, {
      intentId: input.intentId,
      workspaceId: input.workspaceId,
      mode: input.mode,
      planCode: input.offerSnapshotCode,
      kind: "credit_purchase",
      expectedAmount: input.expectedAmount,
      currency: "EUR",
      interval: "oneoff",
      entitlements: {},
      mollieDescription: input.description,
      status: "created",
      molliePaymentId: null,
      messengerSenderUserKey: input.userKey,
      messengerChannelConnectionId: input.channelConnectionId,
      messengerBindingEpoch: input.bindingEpoch,
      messengerPrivacyEpoch: input.privacyEpoch,
      creditWalletId: input.walletId,
      creditFinancialSubjectRef: input.financialSubjectRef,
      creditCount: input.creditCount,
      creditMetadataHash: input.metadataHash,
      checkoutCapabilityHash: input.capabilityHash,
      checkoutCapabilityExpiresAt: input.capabilityExpiresAt,
      checkoutCapabilityConsumedAt: null,
      checkoutCapabilitySessionNonceHash: null,
      creditIdentityErasedAt: null,
      billingProfileVersion: 0,
      authorizationEpoch: input.authorizationEpoch,
      urlExposedAt: null,
      paidAt: null,
    });
    return {
      result: "applied" as const,
      intentId: input.intentId,
      walletId: input.walletId,
    };
  };

  readWalletIdentity = async (scope: {
    workspaceId: number;
    mode: "test" | "live";
    channelConnectionId: number;
    bindingEpoch: number;
    privacyEpoch: number;
    userKey: string;
  }) => {
    for (const wallet of this.wallets.values()) {
      if (
        wallet.workspaceId === scope.workspaceId &&
        wallet.mode === scope.mode &&
        wallet.channelConnectionId === scope.channelConnectionId &&
        wallet.bindingEpoch === scope.bindingEpoch &&
        wallet.privacyEpoch === scope.privacyEpoch &&
        wallet.userKey === scope.userKey
      ) {
        return Object.freeze({
          walletId: wallet.walletId,
          financialSubjectRef: wallet.financialSubjectRef,
          checkoutAvailable: true,
        });
      }
    }
    return null;
  };

  /** Mirrors `credit_consume_checkout_capability`: exact scope, once only. */
  consume = async (input: {
    workspaceId: number;
    mode: "test" | "live";
    channelConnectionId: number;
    bindingEpoch: number;
    privacyEpoch: number;
    userKey: string;
    walletId: string;
    financialSubjectRef: string;
    intentId: string;
    capabilityHash: string;
    sessionNonceHash: string;
  }) => {
    const row = this.intents.get(input.intentId);
    if (
      !row ||
      row.workspaceId !== input.workspaceId ||
      row.mode !== input.mode ||
      row.messengerChannelConnectionId !== input.channelConnectionId ||
      row.messengerBindingEpoch !== input.bindingEpoch ||
      row.messengerPrivacyEpoch !== input.privacyEpoch ||
      row.messengerSenderUserKey !== input.userKey ||
      row.creditWalletId !== input.walletId ||
      row.creditFinancialSubjectRef !== input.financialSubjectRef ||
      row.checkoutCapabilityHash !== input.capabilityHash ||
      row.checkoutCapabilityConsumedAt !== null
    ) {
      throw new Error("credit checkout capability is not consumable");
    }
    row.checkoutCapabilityConsumedAt = this.now;
    row.checkoutCapabilitySessionNonceHash = input.sessionNonceHash;
    return { result: "applied" as const, intentId: input.intentId };
  };

  requireIntent(intentId: string): IntentRow {
    const row = this.intents.get(intentId);
    if (!row) throw new Error("intent row is missing");
    return row;
  }

  requireWallet(walletId: string): WalletRow {
    const wallet = this.wallets.get(walletId);
    if (!wallet) throw new Error("wallet row is missing");
    return wallet;
  }
}

function sessionDependencies(world: CheckoutWorld) {
  return {
    config: pilotConfig,
    readRecord: async (intentId: string) => world.intents.get(intentId) ?? null,
    consume: world.consume,
    now: () => world.now,
  } as unknown as Parameters<typeof claimCreditCheckoutBrowserSession>[1];
}

function providerDependencies(
  world: CheckoutWorld,
  client: MollieClient
): Parameters<typeof confirmCreditCheckoutPayment>[1] {
  const claimed = new Map<string, string>();
  return {
    mollieConfig: () => mollieConfig,
    pilotConfig,
    createClient: () => client,
    claim: async (scope: CreditCheckoutProviderScope) => {
      const row = world.requireIntent(scope.intentId);
      const expiresAt = row.checkoutCapabilityExpiresAt;
      if (
        row.status !== "created" ||
        !row.checkoutCapabilityConsumedAt ||
        !expiresAt ||
        expiresAt.getTime() < world.now.getTime()
      ) {
        return { claimed: false as const };
      }
      row.status = "creating_payment";
      const leaseToken = randomUUID();
      claimed.set(scope.intentId, leaseToken);
      return {
        claimed: true as const,
        operationId: randomUUID(),
        leaseToken,
      };
    },
    markTransportStarted: async (operation: { intentId: string }) =>
      claimed.has(operation.intentId),
    finalize: async (operation: {
      intentId: string;
      outcome: { kind: string; paymentId?: string };
    }) => {
      const row = world.requireIntent(operation.intentId);
      if (
        operation.outcome.kind === "known_succeeded" &&
        operation.outcome.paymentId
      ) {
        row.molliePaymentId = operation.outcome.paymentId;
      }
      return {
        recorded: true,
        authorized: true,
        revokedAuthorizationEpoch: null,
      };
    },
    expose: async (operation: { intentId: string; paymentId: string }) => {
      const row = world.requireIntent(operation.intentId);
      row.urlExposedAt = world.now;
      row.status = "open";
      return true;
    },
  } as unknown as Parameters<typeof confirmCreditCheckoutPayment>[1];
}

function webhookDependencies(world: CheckoutWorld) {
  const offer = getCreditOffer(
    PREMIUM_IMAGE_CREDIT_OFFER_ID,
    PREMIUM_IMAGE_CREDIT_OFFER_VERSION
  );
  if (!offer) throw new Error("credit offer is unavailable");
  const unexpected = async () => {
    throw new Error("adjustment path is not part of this journey");
  };
  return {
    persist: async (input: {
      webhookPaymentId: string;
      expectedMode: "test" | "live";
      payment: MolliePayment;
    }) => {
      const row = [...world.intents.values()].find(
        intent =>
          intent.mode === input.expectedMode &&
          intent.molliePaymentId === input.webhookPaymentId
      );
      if (!row) return { result: "unknown" as const };
      const contract = validateCreditPaymentContract(
        input.payment,
        {
          intentId: row.intentId,
          mode: input.expectedMode,
          metadataHash: row.creditMetadataHash ?? "",
          offer,
        },
        "webhook"
      );
      if (!contract.exact || input.payment.status !== "paid") {
        return { result: "mismatch" as const };
      }
      return {
        result: "grant_pending" as const,
        duplicateSnapshot: false,
        grant: {
          workspaceId: row.workspaceId,
          mode: row.mode,
          channelConnectionId: row.messengerChannelConnectionId ?? 0,
          bindingEpoch: row.messengerBindingEpoch ?? 0,
          privacyEpoch: row.messengerPrivacyEpoch ?? 0,
          userKey: row.messengerSenderUserKey ?? "",
          walletId: row.creditWalletId ?? "",
          financialSubjectRef: row.creditFinancialSubjectRef ?? "",
          intentId: row.intentId,
          authorizationEpoch: row.authorizationEpoch,
          providerPaymentId: input.webhookPaymentId,
          evidenceHash: "f".repeat(64),
          webhookPaymentId: input.webhookPaymentId,
          deliverySnapshotHash: "e".repeat(64),
        },
      };
    },
    /** Mirrors `credit_grant_purchase`: one exact wallet, one immutable entry. */
    grant: async (input: {
      workspaceId: number;
      mode: "test" | "live";
      channelConnectionId: number;
      bindingEpoch: number;
      privacyEpoch: number;
      userKey: string;
      walletId: string;
      financialSubjectRef: string;
      intentId: string;
      entryId: string;
    }) => {
      const wallet = world.requireWallet(input.walletId);
      const row = world.requireIntent(input.intentId);
      if (
        wallet.workspaceId !== input.workspaceId ||
        wallet.mode !== input.mode ||
        wallet.channelConnectionId !== input.channelConnectionId ||
        wallet.bindingEpoch !== input.bindingEpoch ||
        wallet.privacyEpoch !== input.privacyEpoch ||
        wallet.userKey !== input.userKey ||
        wallet.financialSubjectRef !== input.financialSubjectRef
      ) {
        throw new Error("credit grant scope conflicts");
      }
      if (wallet.grantEntryIds.has(input.entryId)) {
        return { result: "already_applied" as const, entryId: input.entryId };
      }
      wallet.grantEntryIds.add(input.entryId);
      wallet.credits += row.creditCount ?? 0;
      return { result: "applied" as const, entryId: input.entryId };
    },
    finish: async (grant: { intentId: string }) => {
      const row = world.requireIntent(grant.intentId);
      row.status = "paid";
      row.paidAt = world.now;
    },
    resolveGrantFailure: async () => "retryable" as const,
    refundDebit: unexpected,
    chargebackDebit: unexpected,
    chargebackRestore: unexpected,
    finishAdjustment: unexpected,
  } as unknown as Parameters<typeof applyCreditPaymentWebhookSnapshot>[1];
}

function paidPaymentFrom(createdBody: Record<string, unknown>): MolliePayment {
  const metadata = createdBody.metadata as Record<string, unknown>;
  return {
    resource: "payment",
    id: PAYMENT_ID,
    mode: "test",
    status: "paid",
    amount: createdBody.amount as MolliePayment["amount"],
    description: createdBody.description as string,
    method: "bancontact",
    sequenceType: "oneoff",
    metadata,
    createdAt: "2026-09-10T09:00:30.000Z",
    paidAt: "2026-09-10T09:02:00.000Z",
    _links: { checkout: { href: MOLLIE_CHECKOUT_URL } },
  };
}

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

function readSessionCookie(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const value = header.split(";")[0] ?? "";
  if (!value.startsWith(`${CREDIT_CHECKOUT_SESSION_COOKIE}=`)) {
    throw new Error("checkout session cookie is missing");
  }
  return value;
}

describe("Messenger credit checkout personal link journey", () => {
  let bound: BoundServer | undefined;
  const originalAppBaseUrl = process.env.APP_BASE_URL;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(async () => {
    if (bound) await close(bound.server);
    bound = undefined;
    if (originalAppBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = originalAppBaseUrl;
    process.env.NODE_ENV = originalNodeEnv;
  });

  async function startJourney() {
    process.env.NODE_ENV = "test";
    const world = new CheckoutWorld();
    const createdBodies: Record<string, unknown>[] = [];
    const client = new MollieClient(mollieConfig, (async (
      _url: string,
      init?: RequestInit
    ) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;
      createdBodies.push(body);
      return new Response(
        JSON.stringify({
          resource: "payment",
          id: PAYMENT_ID,
          mode: "test",
          status: "open",
          amount: body.amount,
          description: body.description,
          method: "bancontact",
          sequenceType: "oneoff",
          metadata: body.metadata,
          createdAt: "2026-09-10T09:00:30.000Z",
          _links: { checkout: { href: MOLLIE_CHECKOUT_URL } },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch);
    const app = express();
    registerCreditCheckoutRoutes(app, {
      claim: input =>
        claimCreditCheckoutBrowserSession(input, sessionDependencies(world)),
      readSession: (cookieValue, options) =>
        readCreditCheckoutBrowserSession(
          cookieValue,
          options,
          sessionDependencies(world)
        ),
      grantComplete: async input => {
        const row = world.requireIntent(input.intentId);
        const wallet = world.requireWallet(input.walletId);
        return row.status === "paid" && wallet.grantEntryIds.size === 1;
      },
      confirm: session =>
        confirmCreditCheckoutPayment(
          session,
          providerDependencies(world, client)
        ),
    });
    const target = await bind(app);
    bound = target;
    process.env.APP_BASE_URL = `${target.baseUrl}/`;

    const checkout = await reserveMessengerCreditCheckout(TESTER_REQUEST, {
      config: pilotConfig,
      readAuthorization: async () => ({
        authorizationEpoch: AUTHORIZATION_EPOCH,
      }),
      readWalletIdentity: world.readWalletIdentity,
      reserve: world.reserve,
      withKeyring,
      now: () => world.now,
      appBaseUrl: () => new URL(target.baseUrl),
    } as unknown as Parameters<typeof reserveMessengerCreditCheckout>[1]);

    return { world, checkout, target, createdBodies };
  }

  it("opens exactly one browser session from the personal Messenger link", async () => {
    const { world, checkout, target } = await startJourney();
    const link = new URL(checkout.actionUrl);

    expect(link.origin).toBe(target.baseUrl);
    expect(link.pathname).toBe(`/credits/checkout/${checkout.intentId}`);
    expect(link.hash.slice(1)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(checkout.actionUrl).not.toContain(TESTER_USER_KEY);
    expect(JSON.stringify(checkout)).not.toContain(link.hash.slice(1));

    const claimed = await fetch(
      `${target.baseUrl}/api/credits/checkout/${checkout.intentId}/claim`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: target.baseUrl,
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify({ capability: link.hash.slice(1) }),
      }
    );

    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toEqual({
      offer: {
        mode: "test",
        amount: "4.99",
        currency: "EUR",
        creditCount: 8,
        imageQuality: "medium",
        expires: false,
        automaticRenewal: false,
        refundPolicyId: "premium_image_credit_refund",
        refundPolicyVersion: 1,
      },
    });
    const cookie = readSessionCookie(claimed);
    expect(cookie).toContain(checkout.intentId);

    // The link is single use: the same fragment never opens a second session.
    const replayed = await fetch(
      `${target.baseUrl}/api/credits/checkout/${checkout.intentId}/claim`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: target.baseUrl,
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify({ capability: link.hash.slice(1) }),
      }
    );
    expect(replayed.status).toBe(404);

    // A browser without the claimed cookie cannot read the intent.
    const anonymous = await fetch(
      `${target.baseUrl}/api/credits/checkout/${checkout.intentId}/session`
    );
    expect(anonymous.status).toBe(404);

    const owner = await fetch(
      `${target.baseUrl}/api/credits/checkout/${checkout.intentId}/session`,
      { headers: { Cookie: cookie } }
    );
    expect(owner.status).toBe(200);

    const row = world.requireIntent(checkout.intentId);
    expect(row.messengerSenderUserKey).toBe(TESTER_USER_KEY);
    expect(world.requireWallet(row.creditWalletId ?? "").credits).toBe(0);
  });

  it("rejects a capability derived for another checkout identity", async () => {
    const { checkout, target } = await startJourney();
    const foreign = deriveCreditCheckoutCapability({
      dedicatedSecret: HMAC_SECRET,
      intentId: "99999999-9999-4999-8999-999999999999",
      metadataHash: "c".repeat(64),
    });

    const response = await fetch(
      `${target.baseUrl}/api/credits/checkout/${checkout.intentId}/claim`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: target.baseUrl,
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify({ capability: foreign.toUrlFragment() }),
      }
    );

    expect(response.status).toBe(404);
  });

  it("never issues a link for another Messenger user in Test Mode", async () => {
    const { world, target } = await startJourney();
    const reserve = async () =>
      reserveMessengerCreditCheckout(
        { ...TESTER_REQUEST, userKey: OTHER_USER_KEY },
        {
          config: pilotConfig,
          readAuthorization: async () => ({
            authorizationEpoch: AUTHORIZATION_EPOCH,
          }),
          readWalletIdentity: world.readWalletIdentity,
          reserve: world.reserve,
          withKeyring,
          now: () => world.now,
          appBaseUrl: () => new URL(target.baseUrl),
        } as unknown as Parameters<typeof reserveMessengerCreditCheckout>[1]
      );

    await expect(reserve()).rejects.toBeInstanceOf(
      CreditCheckoutReservationError
    );
    expect(world.intents.size).toBe(1);
    expect(world.wallets.size).toBe(1);
  });

  it("grants the eight credits only from the verified webhook, on the tester wallet", async () => {
    const { world, checkout, target, createdBodies } = await startJourney();
    const link = new URL(checkout.actionUrl);
    const claimed = await fetch(
      `${target.baseUrl}/api/credits/checkout/${checkout.intentId}/claim`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: target.baseUrl,
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify({ capability: link.hash.slice(1) }),
      }
    );
    const cookie = readSessionCookie(claimed);

    const confirmed = await fetch(
      `${target.baseUrl}/api/credits/checkout/${checkout.intentId}/confirm`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: target.baseUrl,
          "Sec-Fetch-Site": "same-origin",
          Cookie: cookie,
        },
        body: "{}",
      }
    );
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toEqual({
      checkoutUrl: MOLLIE_CHECKOUT_URL,
    });

    const created = createdBodies[0] ?? {};
    const serializedRequest = JSON.stringify(created);
    expect(created).toMatchObject({
      amount: { currency: "EUR", value: "4.99" },
      sequenceType: "oneoff",
      description: "Leaderbot - 8 premium beeldcredits",
      redirectUrl: `${APP_HTTPS_BASE_URL}/credits/checkout/return`,
      webhookUrl: mollieConfig.paymentWebhookUrl,
      metadata: {
        billingIntentId: checkout.intentId,
        purpose: "premium_image_credits",
        version: 1,
      },
    });
    expect(serializedRequest).not.toContain(TESTER_USER_KEY);
    expect(serializedRequest).not.toContain(link.hash.slice(1));

    const walletId =
      world.requireIntent(checkout.intentId).creditWalletId ?? "";

    // The browser return is presentation only: no credits before the webhook.
    const beforeWebhook = await fetch(
      `${target.baseUrl}/api/credits/checkout/return-status`,
      { headers: { Cookie: cookie } }
    );
    expect(await beforeWebhook.json()).toEqual({ status: "processing" });
    expect(world.requireWallet(walletId).credits).toBe(0);

    const payment = paidPaymentFrom(created);
    const applied = await applyCreditPaymentWebhookSnapshot(
      {
        webhookPaymentId: PAYMENT_ID,
        expectedMode: "test",
        payment,
      },
      webhookDependencies(world)
    );
    expect(applied).toBe("processed");
    expect(world.requireWallet(walletId).credits).toBe(8);
    expect(world.requireWallet(walletId).userKey).toBe(TESTER_USER_KEY);

    // A replayed webhook must not fund a second grant.
    const replayed = await applyCreditPaymentWebhookSnapshot(
      {
        webhookPaymentId: PAYMENT_ID,
        expectedMode: "test",
        payment,
      },
      webhookDependencies(world)
    );
    expect(replayed).toBe("duplicate");
    expect(world.requireWallet(walletId).credits).toBe(8);

    const afterWebhook = await fetch(
      `${target.baseUrl}/api/credits/checkout/return-status`,
      { headers: { Cookie: cookie } }
    );
    expect(await afterWebhook.json()).toEqual({ status: "paid" });
  });
});

describe("credit checkout pages behind the production SPA fallback", () => {
  const tempDirs: string[] = [];
  let bound: BoundServer | undefined;

  afterEach(async () => {
    if (bound) await close(bound.server);
    bound = undefined;
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function createTempBuild(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leaderbot-checkout-"));
    tempDirs.push(dir);
    fs.writeFileSync(
      path.join(dir, "index.html"),
      "<html><body><h1>Leaderbot UI</h1></body></html>"
    );
    return dir;
  }

  /**
   * The checkout API must stay registered ahead of the SPA fallback. If that
   * order ever regresses, the browser receives `index.html` instead of the
   * JSON contract and the tester sees a permanently loading checkout page.
   */
  it("serves the checkout pages while the checkout API keeps its JSON contract", async () => {
    const intentId = "11111111-1111-8111-8111-111111111111";
    const app = express();
    registerCreditCheckoutRoutes(app, {
      claim: async () => {
        throw new Error("not part of this routing test");
      },
      readSession: async () => {
        throw new Error("not part of this routing test");
      },
      grantComplete: async () => false,
      confirm: async () => {
        throw new Error("not part of this routing test");
      },
    });
    serveStatic(app, createTempBuild());
    const target = await bind(app);
    bound = target;

    for (const spaPath of [
      `/credits/checkout/${intentId}`,
      "/credits/checkout/return",
    ]) {
      const page = await fetch(`${target.baseUrl}${spaPath}`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(await page.text()).toContain("Leaderbot UI");
    }

    const api = await fetch(
      `${target.baseUrl}/api/credits/checkout/return-status`
    );
    expect(api.status).toBe(404);
    expect(api.headers.get("content-type")).toContain("application/json");
    expect(await api.json()).toEqual({ error: "checkout unavailable" });
  });
});
