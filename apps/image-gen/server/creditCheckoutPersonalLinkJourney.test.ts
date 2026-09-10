import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";

import express from "express";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * End-to-end contract for the one Test Mode journey the owner runs: the free
 * allowance runs out, the bot sends that user a personal checkout link, the
 * browser opens it, Mollie confirms the payment through the webhook, and the
 * credits land on that same user's wallet.
 *
 * Everything between those points is the production code path — the generation
 * job runner and its Messenger rendering, the registered checkout router, the
 * real `MollieClient`, and `handleMollieWebhook`. Only the boundaries the test
 * may not cross are replaced: the Messenger Send API, the image provider, the
 * Mollie HTTP transport, and the database stores, which are backed by an
 * in-memory model of the rows `credit_reserve_checkout_intent` writes.
 */

const {
  executeGenerationFlowMock,
  reserveMessengerProviderAttemptFenceMock,
  markMessengerProviderAttemptStartedMock,
  finalizeMessengerProviderAttemptFenceMock,
  reservePaidCreditGenerationMock,
  assertMessengerPrivacySubjectMock,
  assertMessengerGenerationOwnershipMock,
  resolveWorkspaceRuntimePolicyMock,
  sendButtonTemplateMock,
  sendImageMock,
  sendQuickRepliesMock,
  sendTextMock,
  safeLogMock,
  world,
} = vi.hoisted(() => {
  type IntentRow = Record<string, unknown> & {
    intentId: string;
    mode: "test" | "live";
    status: string;
    molliePaymentId: string | null;
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

  /** In-memory stand-in for `billing_intents` and `credit_wallets`. */
  const store = {
    intents: new Map<string, IntentRow>(),
    wallets: new Map<string, WalletRow>(),
    now: new Date("2026-09-10T09:00:00.000Z"),
    checkoutAuthorized: true,
    reset() {
      store.intents.clear();
      store.wallets.clear();
      store.checkoutAuthorized = true;
    },
    intent(intentId: string): IntentRow {
      const row = store.intents.get(intentId);
      if (!row) throw new Error(`missing intent ${intentId}`);
      return row;
    },
    wallet(walletId: string): WalletRow {
      const row = store.wallets.get(walletId);
      if (!row) throw new Error(`missing wallet ${walletId}`);
      return row;
    },
    walletForUser(userKey: string): WalletRow | undefined {
      return [...store.wallets.values()].find(row => row.userKey === userKey);
    },
    intentForPayment(paymentId: string): IntentRow | undefined {
      return [...store.intents.values()].find(
        row => row.molliePaymentId === paymentId
      );
    },
  };

  return {
    executeGenerationFlowMock: vi.fn(),
    reserveMessengerProviderAttemptFenceMock: vi.fn(),
    markMessengerProviderAttemptStartedMock: vi.fn(),
    finalizeMessengerProviderAttemptFenceMock: vi.fn(),
    reservePaidCreditGenerationMock: vi.fn(),
    assertMessengerPrivacySubjectMock: vi.fn(),
    assertMessengerGenerationOwnershipMock: vi.fn(),
    resolveWorkspaceRuntimePolicyMock: vi.fn(),
    sendButtonTemplateMock: vi.fn(async () => ({ sent: true })),
    sendImageMock: vi.fn(async () => ({ sent: true })),
    sendQuickRepliesMock: vi.fn(async () => ({ sent: true })),
    sendTextMock: vi.fn(async () => ({ sent: true })),
    safeLogMock: vi.fn(),
    world: store,
  };
});

// --- Boundaries the test may not cross -------------------------------------

vi.mock("./_core/generationFlow", () => ({
  executeGenerationFlow: executeGenerationFlowMock,
}));

vi.mock("./_core/messengerApi", () => ({
  safeLog: safeLogMock,
  sendButtonTemplate: sendButtonTemplateMock,
  sendImage: sendImageMock,
  sendQuickReplies: sendQuickRepliesMock,
  sendText: sendTextMock,
}));

vi.mock("./_core/logger", async importOriginal => {
  const actual = await importOriginal<typeof import("./_core/logger")>();
  return { ...actual, safeLog: safeLogMock };
});

vi.mock("./_core/messengerProviderAttemptFence", () => ({
  reserveMessengerProviderAttemptFence:
    reserveMessengerProviderAttemptFenceMock,
  markMessengerProviderAttemptStarted: markMessengerProviderAttemptStartedMock,
  finalizeMessengerProviderAttemptFence:
    finalizeMessengerProviderAttemptFenceMock,
}));

vi.mock("./_core/workspaceEntitlementRuntime", () => ({
  assertMessengerGenerationOwnership: assertMessengerGenerationOwnershipMock,
  resolveWorkspaceRuntimePolicy: resolveWorkspaceRuntimePolicyMock,
}));

vi.mock("./_core/messengerPrivacySubject", async importOriginal => {
  const actual =
    await importOriginal<typeof import("./_core/messengerPrivacySubject")>();
  return {
    ...actual,
    assertMessengerPrivacySubject: assertMessengerPrivacySubjectMock,
  };
});

// The paid-wallet read is a database call. The rest of the exhaustion branch,
// including the decision to offer checkout, stays production code.
vi.mock("./_core/billing/creditGenerationAdmission", async importOriginal => {
  const actual =
    await importOriginal<
      typeof import("./_core/billing/creditGenerationAdmission")
    >();
  return {
    ...actual,
    reservePaidCreditGeneration: reservePaidCreditGenerationMock,
  };
});

// --- Database stores -------------------------------------------------------

vi.mock("./_core/billing/creditCheckoutReservationStore", () => ({
  readCreditCheckoutAuthorization: async () =>
    world.checkoutAuthorized ? { authorizationEpoch: 7 } : null,
}));

vi.mock(
  "./_core/billing/creditGenerationAdmissionStore",
  async importOriginal => {
    const actual =
      await importOriginal<
        typeof import("./_core/billing/creditGenerationAdmissionStore")
      >();
    return {
      ...actual,
      readCurrentCreditWalletIdentity: async (scope: {
        workspaceId: number;
        mode: "test" | "live";
        channelConnectionId: number;
        bindingEpoch: number;
        privacyEpoch: number;
        userKey: string;
      }) => {
        const wallet = [...world.wallets.values()].find(
          row =>
            row.workspaceId === scope.workspaceId &&
            row.mode === scope.mode &&
            row.channelConnectionId === scope.channelConnectionId &&
            row.bindingEpoch === scope.bindingEpoch &&
            row.privacyEpoch === scope.privacyEpoch &&
            row.userKey === scope.userKey
        );
        return wallet
          ? Object.freeze({
              walletId: wallet.walletId,
              financialSubjectRef: wallet.financialSubjectRef,
              checkoutAvailable: true,
            })
          : null;
      },
    };
  }
);

vi.mock("./_core/billing/creditWalletStore", async importOriginal => {
  const actual =
    await importOriginal<typeof import("./_core/billing/creditWalletStore")>();
  return {
    ...actual,
    /** Mirrors `credit_reserve_checkout_intent`. */
    reserveCreditCheckoutIntent: async (input: Record<string, never>) => {
      const row = input as unknown as {
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
      };
      if (!world.wallets.has(row.walletId)) {
        world.wallets.set(row.walletId, {
          walletId: row.walletId,
          workspaceId: row.workspaceId,
          mode: row.mode,
          channelConnectionId: row.channelConnectionId,
          bindingEpoch: row.bindingEpoch,
          privacyEpoch: row.privacyEpoch,
          userKey: row.userKey,
          financialSubjectRef: row.financialSubjectRef,
          credits: 0,
          grantEntryIds: new Set<string>(),
        });
      }
      if (world.intents.has(row.intentId)) {
        return {
          result: "already_applied" as const,
          intentId: row.intentId,
          walletId: row.walletId,
        };
      }
      world.intents.set(row.intentId, {
        intentId: row.intentId,
        workspaceId: row.workspaceId,
        mode: row.mode,
        planCode: row.offerSnapshotCode,
        kind: "credit_purchase",
        expectedAmount: row.expectedAmount,
        currency: "EUR",
        interval: "oneoff",
        entitlements: {},
        mollieDescription: row.description,
        status: "created",
        molliePaymentId: null,
        messengerSenderUserKey: row.userKey,
        messengerChannelConnectionId: row.channelConnectionId,
        messengerBindingEpoch: row.bindingEpoch,
        messengerPrivacyEpoch: row.privacyEpoch,
        creditWalletId: row.walletId,
        creditFinancialSubjectRef: row.financialSubjectRef,
        creditCount: row.creditCount,
        creditMetadataHash: row.metadataHash,
        checkoutCapabilityHash: row.capabilityHash,
        checkoutCapabilityExpiresAt: row.capabilityExpiresAt,
        checkoutCapabilityConsumedAt: null,
        checkoutCapabilitySessionNonceHash: null,
        creditIdentityErasedAt: null,
        billingProfileVersion: 0,
        authorizationEpoch: row.authorizationEpoch,
        urlExposedAt: null,
        paidAt: null,
      });
      return {
        result: "applied" as const,
        intentId: row.intentId,
        walletId: row.walletId,
      };
    },
    /** Mirrors `credit_consume_checkout_capability`: exact scope, once only. */
    consumeCreditCheckoutCapability: async (input: Record<string, never>) => {
      const scope = input as unknown as {
        intentId: string;
        walletId: string;
        userKey: string;
        capabilityHash: string;
        sessionNonceHash: string;
      };
      const row = world.intent(scope.intentId);
      if (
        row.creditWalletId !== scope.walletId ||
        row.messengerSenderUserKey !== scope.userKey ||
        row.checkoutCapabilityHash !== scope.capabilityHash ||
        row.checkoutCapabilityConsumedAt !== null
      ) {
        throw new Error("credit checkout capability is not consumable");
      }
      row.checkoutCapabilityConsumedAt = world.now;
      row.checkoutCapabilitySessionNonceHash = scope.sessionNonceHash;
      return { result: "applied" as const, intentId: scope.intentId };
    },
    /** Mirrors `credit_grant_purchase`: one exact wallet, one immutable entry. */
    grantCreditPurchase: async (input: Record<string, never>) => {
      const grant = input as unknown as {
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
      };
      const wallet = world.wallet(grant.walletId);
      const row = world.intent(grant.intentId);
      if (
        wallet.workspaceId !== grant.workspaceId ||
        wallet.mode !== grant.mode ||
        wallet.channelConnectionId !== grant.channelConnectionId ||
        wallet.bindingEpoch !== grant.bindingEpoch ||
        wallet.privacyEpoch !== grant.privacyEpoch ||
        wallet.userKey !== grant.userKey ||
        wallet.financialSubjectRef !== grant.financialSubjectRef ||
        row.creditWalletId !== grant.walletId
      ) {
        throw new Error("credit grant scope conflicts");
      }
      if (wallet.grantEntryIds.has(grant.entryId)) {
        return { result: "already_applied" as const, entryId: grant.entryId };
      }
      wallet.grantEntryIds.add(grant.entryId);
      wallet.credits += Number(row.creditCount ?? 0);
      return { result: "applied" as const, entryId: grant.entryId };
    },
  };
});

vi.mock("./_core/billing/creditCheckoutSessionStore", () => ({
  readCreditCheckoutSessionRecord: async (intentId: string) =>
    (world.intents.get(intentId) as never) ?? null,
}));

vi.mock("./_core/billing/creditCheckoutProviderStore", () => {
  const leases = new Map<string, string>();
  return {
    claimCreditPaymentCreation: async (scope: { intentId: string }) => {
      const row = world.intent(scope.intentId);
      const expiresAt = row.checkoutCapabilityExpiresAt as Date | null;
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
      leases.set(scope.intentId, leaseToken);
      return { claimed: true as const, operationId: randomUUID(), leaseToken };
    },
    markCreditPaymentTransportStarted: async (operation: {
      intentId: string;
      leaseToken: string;
    }) => leases.get(operation.intentId) === operation.leaseToken,
    finalizeCreditPaymentProviderOperation: async (operation: {
      intentId: string;
      outcome: { kind: string; paymentId?: string };
    }) => {
      const row = world.intent(operation.intentId);
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
    exposeCreditPaymentCheckout: async (operation: { intentId: string }) => {
      const row = world.intent(operation.intentId);
      row.urlExposedAt = world.now;
      row.status = "open";
      return true;
    },
  };
});

vi.mock("./_core/billing/creditPaymentWebhookStore", async importOriginal => {
  const actual =
    await importOriginal<
      typeof import("./_core/billing/creditPaymentWebhookStore")
    >();
  const { validateCreditPaymentContract } =
    await import("./_core/billing/creditPaymentContract");
  const {
    getCreditOffer,
    PREMIUM_IMAGE_CREDIT_OFFER_ID,
    PREMIUM_IMAGE_CREDIT_OFFER_VERSION,
  } = await import("./_core/billing/creditCatalog");
  return {
    ...actual,
    persistCreditPaymentWebhookSnapshot: async (input: {
      webhookPaymentId: string;
      expectedMode: "test" | "live";
      payment: { status: string };
    }) => {
      const row = world.intentForPayment(input.webhookPaymentId);
      if (!row || row.mode !== input.expectedMode) {
        return { result: "unknown" as const };
      }
      const offer = getCreditOffer(
        PREMIUM_IMAGE_CREDIT_OFFER_ID,
        PREMIUM_IMAGE_CREDIT_OFFER_VERSION
      );
      if (!offer) throw new Error("credit offer is unavailable");
      const contract = validateCreditPaymentContract(
        input.payment as never,
        {
          intentId: row.intentId,
          mode: input.expectedMode,
          metadataHash: String(row.creditMetadataHash ?? ""),
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
          workspaceId: row.workspaceId as number,
          mode: row.mode,
          channelConnectionId: row.messengerChannelConnectionId as number,
          bindingEpoch: row.messengerBindingEpoch as number,
          privacyEpoch: row.messengerPrivacyEpoch as number,
          userKey: row.messengerSenderUserKey as string,
          walletId: row.creditWalletId as string,
          financialSubjectRef: row.creditFinancialSubjectRef as string,
          intentId: row.intentId,
          authorizationEpoch: row.authorizationEpoch as number,
          providerPaymentId: input.webhookPaymentId,
          evidenceHash: "f".repeat(64),
          webhookPaymentId: input.webhookPaymentId,
          deliverySnapshotHash: "e".repeat(64),
        },
      };
    },
    finishCreditPaymentGrant: async (grant: { intentId: string }) => {
      const row = world.intent(grant.intentId);
      row.status = "paid";
      row.paidAt = world.now;
    },
    resolveCreditGrantFailure: async () => "retryable" as const,
    isCreditPaymentGrantComplete: async (input: { intentId: string }) => {
      const row = world.intents.get(input.intentId);
      return row?.status === "paid";
    },
  };
});

vi.mock("./_core/billing/legacyPaymentDrain", () => ({
  applyLegacyPaymentDrainSnapshot: async () => "unknown" as const,
}));

// --- Production code under test --------------------------------------------

import { createHandlerContext } from "./_core/webhookHandlerContext";
import { createMessengerGenerationJobRunner } from "./_core/webhookGenerationJobs";
import { registerCreditCheckoutRoutes } from "./_core/billing/creditCheckoutRoutes";
import { confirmCreditCheckoutPayment } from "./_core/billing/creditCheckoutPaymentService";
import { getMollieConfig } from "./_core/billing/config";
import { getCreditCheckoutPilotConfig } from "./_core/billing/creditCheckoutConfig";
import {
  claimCreditPaymentCreation,
  exposeCreditPaymentCheckout,
  finalizeCreditPaymentProviderOperation,
  markCreditPaymentTransportStarted,
} from "./_core/billing/creditCheckoutProviderStore";
import { CREDIT_CHECKOUT_SESSION_COOKIE } from "./_core/billing/creditCheckoutSession";
import { deriveCreditCheckoutCapability } from "./_core/billing/creditCheckoutCapability";
import { handleMollieWebhook } from "./_core/billing/webhookRoutes";
import { MollieClient } from "./_core/billing/mollieClient";
import { serveStatic } from "./_core/vite";
import type { HandlerContext } from "./_core/webhookHandlerTypes";

const APP_ORIGIN = "https://app.leaderbot.live";
const HMAC_SECRET = "7".repeat(64);
const USER_A = `u2.k1.${"a".repeat(64)}`;
const USER_B = `u2.k1.${"b".repeat(64)}`;
const MOLLIE_CHECKOUT_URL =
  "https://www.mollie.com/checkout/select-method/creditjourney";
const TESTER_RESTRICTION_FIELDS = [
  "MOLLIE_CREDIT_TEST_CHANNEL_CONNECTION_ID",
  "MOLLIE_CREDIT_TEST_BINDING_EPOCH",
  "MOLLIE_CREDIT_TEST_PRIVACY_EPOCH",
  "MOLLIE_CREDIT_TEST_USER_KEY_HASH",
] as const;

const savedEnv = new Map<string, string | undefined>();

function setEnv(name: string, value: string): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  process.env[name] = value;
}

function restoreEnv(): void {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
}

function generationJob(userKey: string, suffix: string) {
  return {
    psid: `journey-${suffix}-psid`,
    userId: userKey,
    pageId: "journey-page",
    workspaceId: 42,
    channelConnectionId: 8,
    bindingEpoch: 3,
    privacyEpoch: 5,
    reqId: `req-${suffix}`,
    lang: "nl" as const,
  };
}

function contextBackedRunner() {
  let ctx!: HandlerContext;
  const runner = createMessengerGenerationJobRunner({
    maybeSendInFlightMessage: (psid, reqId) =>
      ctx.maybeSendInFlightMessage(psid, reqId, "nl"),
    sendLoggedImage: (psid, imageUrl, reqId) =>
      ctx.sendLoggedImage(psid, imageUrl, reqId),
    sendLoggedActions: (psid, text, actions, reqId, deliveryControl) =>
      ctx.sendLoggedActions(psid, text, actions, reqId, deliveryControl),
    sendLoggedText: (psid, text, reqId, deliveryControl) =>
      ctx.sendLoggedText(psid, text, reqId, deliveryControl),
  });
  ctx = createHandlerContext({
    defaultLang: "nl",
    runImageGeneration: runner.runImageGeneration,
  });
  return runner;
}

/**
 * Runs the production quota-exhaustion path for one Messenger user and returns
 * the personal link exactly as the Messenger button carried it.
 */
async function runExhaustedGeneration(
  userKey: string,
  suffix: string
): Promise<{ url: URL; buttonText: string }> {
  const job = generationJob(userKey, suffix);
  await contextBackedRunner().processMessengerGenerationJob(job);

  const call = sendButtonTemplateMock.mock.calls.at(-1) as
    | [
        string,
        string,
        Array<{ type: string; title: string; url: string }>,
        unknown,
      ]
    | undefined;
  if (!call) throw new Error("no Messenger button template was sent");
  const [psid, text, buttons] = call;
  expect(psid).toBe(job.psid);
  expect(buttons).toHaveLength(1);
  expect(buttons[0]?.type).toBe("web_url");
  return { url: new URL(buttons[0]!.url), buttonText: text };
}

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

const mollieRequests: Array<{ url: string; body: Record<string, unknown> }> =
  [];

function mollieFetchStub(paymentId: string): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    mollieRequests.push({ url: String(url), body });
    const isCreate = init?.method === "POST";
    const intent = isCreate
      ? null
      : (world.intentForPayment(paymentId) ?? null);
    const metadata = isCreate
      ? body.metadata
      : {
          billingIntentId: intent?.intentId,
          purpose: "premium_image_credits",
          version: 1,
          metadataHash: intent?.creditMetadataHash,
        };
    return new Response(
      JSON.stringify({
        resource: "payment",
        id: paymentId,
        mode: "test",
        status: isCreate ? "open" : "paid",
        amount: { currency: "EUR", value: "4.99" },
        description: "Leaderbot - 8 premium beeldcredits",
        method: "bancontact",
        sequenceType: "oneoff",
        metadata,
        createdAt: "2026-09-10T09:00:30.000Z",
        ...(isCreate ? {} : { paidAt: "2026-09-10T09:02:00.000Z" }),
        _links: { checkout: { href: MOLLIE_CHECKOUT_URL } },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as unknown as typeof fetch;
}

/**
 * The production router with production defaults. Only the Mollie HTTP
 * transport is replaced; `claim`, `readSession` and `grantComplete` are the
 * real implementations reading the mocked database stores.
 */
async function startCheckoutServer(paymentId: string): Promise<BoundServer> {
  const app = express();
  registerCreditCheckoutRoutes(app, {
    confirm: session =>
      confirmCreditCheckoutPayment(session, {
        mollieConfig: getMollieConfig,
        pilotConfig: getCreditCheckoutPilotConfig,
        createClient: config =>
          new MollieClient(config, mollieFetchStub(paymentId)),
        claim: claimCreditPaymentCreation,
        markTransportStarted: markCreditPaymentTransportStarted,
        finalize: finalizeCreditPaymentProviderOperation,
        expose: exposeCreditPaymentCheckout,
      }),
  });
  return await bind(app);
}

function browserHeaders(cookie?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Origin: APP_ORIGIN,
    "Sec-Fetch-Site": "same-origin",
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

function sessionCookie(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const value = header.split(";")[0] ?? "";
  if (!value.startsWith(`${CREDIT_CHECKOUT_SESSION_COOKIE}=`)) {
    throw new Error("checkout session cookie is missing");
  }
  return value;
}

/** Opens the personal link in a browser and pays it through to Mollie. */
async function payThroughBrowser(
  target: BoundServer,
  link: URL
): Promise<{ cookie: string; intentId: string }> {
  const intentId = link.pathname.split("/").at(-1)!;
  const claimed = await fetch(
    `${target.baseUrl}/api/credits/checkout/${intentId}/claim`,
    {
      method: "POST",
      headers: browserHeaders(),
      body: JSON.stringify({ capability: link.hash.slice(1) }),
    }
  );
  expect(claimed.status).toBe(200);
  const cookie = sessionCookie(claimed);

  const confirmed = await fetch(
    `${target.baseUrl}/api/credits/checkout/${intentId}/confirm`,
    { method: "POST", headers: browserHeaders(cookie), body: "{}" }
  );
  expect(confirmed.status).toBe(200);
  expect(await confirmed.json()).toEqual({ checkoutUrl: MOLLIE_CHECKOUT_URL });
  return { cookie, intentId };
}

beforeEach(() => {
  vi.clearAllMocks();
  world.reset();
  mollieRequests.length = 0;

  setEnv("NODE_ENV", "test");
  setEnv("PRIVACY_PEPPER", "credit-checkout-journey-pepper");
  setEnv("MESSENGER_FREE_DAILY_LIMIT", "0");
  setEnv("MESSENGER_FREE_MONTHLY_LIMIT", "0");
  setEnv("APP_BASE_URL", APP_ORIGIN);
  setEnv("MOLLIE_MODE", "test");
  setEnv("MOLLIE_API_KEY", "test_journeyredacted");
  setEnv(
    "MOLLIE_PAYMENT_WEBHOOK_URL",
    `${APP_ORIGIN}/api/webhooks/mollie/payments`
  );
  setEnv("BILLING_SUPPORT_EMAIL", "privacy@leaderbot.live");
  setEnv("MOLLIE_BILLING_ENABLED", "false");
  setEnv("MOLLIE_LIVE_BILLING_ENABLED", "false");
  setEnv("MOLLIE_BILLING_DRAIN_ENABLED", "true");
  setEnv("BILLING_NOTIFICATION_PLANE_ENABLED", "true");
  setEnv("MESSENGER_PAID_CREDITS_ENABLED", "true");
  setEnv("MOLLIE_CREDIT_CHECKOUT_ENABLED", "true");
  setEnv("MOLLIE_CREDIT_WORKSPACE_ID", "42");
  setEnv("MESSENGER_PAID_IMAGE_PROVIDER_MAX_COST_USD", "1.00");
  setEnv("CREDIT_CHECKOUT_HMAC_ACTIVE_KEY_ID", "k1");
  setEnv("CREDIT_CHECKOUT_HMAC_SECRET", HMAC_SECRET);
  // Open Test Mode: no tester is registered up front. The four optional
  // restriction fields stay unset for every user in this file.
  for (const field of TESTER_RESTRICTION_FIELDS) {
    if (!savedEnv.has(field)) savedEnv.set(field, process.env[field]);
    delete process.env[field];
  }

  resolveWorkspaceRuntimePolicyMock.mockResolvedValue({ kind: "free" });
  assertMessengerPrivacySubjectMock.mockResolvedValue(undefined);
  assertMessengerGenerationOwnershipMock.mockResolvedValue(undefined);
  reserveMessengerProviderAttemptFenceMock.mockResolvedValue({
    leaseToken: "journey-lease",
    attemptKeyHash: "journey-attempt",
    privacyEpoch: 5,
  });
  markMessengerProviderAttemptStartedMock.mockResolvedValue(undefined);
  finalizeMessengerProviderAttemptFenceMock.mockResolvedValue(undefined);
  // The free allowance is spent and the paid wallet is empty: exactly the
  // state in which production offers the one-time checkout.
  reservePaidCreditGenerationMock.mockResolvedValue({
    available: false,
    reason: "empty",
  });
  sendButtonTemplateMock.mockResolvedValue({ sent: true });
  sendTextMock.mockResolvedValue({ sent: true });
  sendQuickRepliesMock.mockResolvedValue({ sent: true });
  sendImageMock.mockResolvedValue({ sent: true });
});

afterAll(() => {
  restoreEnv();
});

describe("quota-exhaustion call to action", () => {
  it("sends the exhausted user a personal signed checkout button", async () => {
    const { url, buttonText } = await runExhaustedGeneration(USER_A, "cta");

    expect(url.origin).toBe(APP_ORIGIN);
    expect(url.pathname).toMatch(
      /^\/credits\/checkout\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(url.hash.slice(1)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.toString()).not.toContain(USER_A);

    // The honest offer copy, rendered by production, not restated here.
    expect(buttonText).toContain("8 premiumcredits voor € 4,99");
    expect(buttonText).toContain("Geen abonnement of automatische verlenging");
    expect(buttonText).toContain("vervalt nooit");

    // No provider work happened on the way to the offer.
    expect(executeGenerationFlowMock).not.toHaveBeenCalled();
    expect(sendImageMock).not.toHaveBeenCalled();

    const intentId = url.pathname.split("/").at(-1)!;
    const row = world.intent(intentId);
    expect(row.messengerSenderUserKey).toBe(USER_A);
    expect(row.creditCount).toBe(8);
    expect(row.expectedAmount).toBe("4.99");
    expect(world.wallet(row.creditWalletId as string).credits).toBe(0);
  });

  it("falls back to the plain notice when checkout is not authorized", async () => {
    // The execution control is the production gate that keeps checkout dark.
    world.checkoutAuthorized = false;

    await contextBackedRunner().processMessengerGenerationJob(
      generationJob(USER_A, "cta-fallback")
    );

    expect(sendButtonTemplateMock).not.toHaveBeenCalled();
    expect(sendTextMock).toHaveBeenCalled();
    expect(executeGenerationFlowMock).not.toHaveBeenCalled();
  });
});

describe("browser checkout on the production router", () => {
  let bound: BoundServer | undefined;

  afterEach(async () => {
    if (bound) await close(bound.server);
    bound = undefined;
  });

  it("opens one session from the link and hands the browser to Mollie", async () => {
    const { url } = await runExhaustedGeneration(USER_A, "browser");
    bound = await startCheckoutServer("tr_journeya");
    const { cookie, intentId } = await payThroughBrowser(bound, url);

    // The provider request carries the offer and no Messenger identity.
    const created = mollieRequests.at(-1);
    expect(created?.url).toBe("https://api.mollie.com/v2/payments");
    expect(created?.body).toMatchObject({
      amount: { currency: "EUR", value: "4.99" },
      sequenceType: "oneoff",
      redirectUrl: `${APP_ORIGIN}/credits/checkout/return`,
      webhookUrl: `${APP_ORIGIN}/api/webhooks/mollie/payments`,
      metadata: { billingIntentId: intentId, purpose: "premium_image_credits" },
    });
    expect(JSON.stringify(created?.body)).not.toContain(USER_A);
    expect(JSON.stringify(created?.body)).not.toContain(url.hash.slice(1));

    // The link is single use and useless without the cookie it created.
    const replay = await fetch(
      `${bound.baseUrl}/api/credits/checkout/${intentId}/claim`,
      {
        method: "POST",
        headers: browserHeaders(),
        body: JSON.stringify({ capability: url.hash.slice(1) }),
      }
    );
    expect(replay.status).toBe(404);
    const anonymous = await fetch(
      `${bound.baseUrl}/api/credits/checkout/${intentId}/session`
    );
    expect(anonymous.status).toBe(404);
    const owner = await fetch(
      `${bound.baseUrl}/api/credits/checkout/${intentId}/session`,
      { headers: { Cookie: cookie } }
    );
    expect(owner.status).toBe(200);

    // Returning from Mollie is presentation only.
    const returned = await fetch(
      `${bound.baseUrl}/api/credits/checkout/return-status`,
      { headers: { Cookie: cookie } }
    );
    expect(await returned.json()).toEqual({ status: "processing" });
    expect(world.walletForUser(USER_A)?.credits).toBe(0);
  });

  it("rejects a capability derived for another checkout identity", async () => {
    const { url } = await runExhaustedGeneration(USER_A, "foreign-capability");
    bound = await startCheckoutServer("tr_journeyforeign");
    const intentId = url.pathname.split("/").at(-1)!;
    const foreign = deriveCreditCheckoutCapability({
      dedicatedSecret: Buffer.from(HMAC_SECRET, "hex"),
      intentId: "99999999-9999-4999-8999-999999999999",
      metadataHash: "c".repeat(64),
    });

    const response = await fetch(
      `${bound.baseUrl}/api/credits/checkout/${intentId}/claim`,
      {
        method: "POST",
        headers: browserHeaders(),
        body: JSON.stringify({ capability: foreign.toUrlFragment() }),
      }
    );

    expect(response.status).toBe(404);
    expect(world.intent(intentId).checkoutCapabilityConsumedAt).toBeNull();
  });
});

describe("verified Mollie webhook", () => {
  let bound: BoundServer | undefined;

  afterEach(async () => {
    if (bound) await close(bound.server);
    bound = undefined;
  });

  it("grants the eight credits only after the authoritative payment fetch", async () => {
    const paymentId = "tr_journeywebhook";
    const { url } = await runExhaustedGeneration(USER_A, "webhook");
    bound = await startCheckoutServer(paymentId);
    const { cookie } = await payThroughBrowser(bound, url);
    expect(world.walletForUser(USER_A)?.credits).toBe(0);
    mollieRequests.length = 0;

    // Exactly what Mollie POSTs to the webhook route: the payment id only.
    const result = await handleMollieWebhook(
      { id: paymentId },
      {
        createClient: () =>
          new MollieClient(getMollieConfig(), mollieFetchStub(paymentId)),
      }
    );

    expect(result).toBe("processed");
    // The handler re-fetched the payment from Mollie rather than trusting input.
    expect(mollieRequests).toHaveLength(1);
    expect(mollieRequests[0]?.url).toBe(
      `https://api.mollie.com/v2/payments/${paymentId}?embed=refunds%2Cchargebacks`
    );
    expect(world.walletForUser(USER_A)?.credits).toBe(8);

    const replayed = await handleMollieWebhook(
      { id: paymentId },
      {
        createClient: () =>
          new MollieClient(getMollieConfig(), mollieFetchStub(paymentId)),
      }
    );
    expect(replayed).toBe("duplicate");
    expect(world.walletForUser(USER_A)?.credits).toBe(8);

    const returned = await fetch(
      `${bound.baseUrl}/api/credits/checkout/return-status`,
      { headers: { Cookie: cookie } }
    );
    expect(await returned.json()).toEqual({ status: "paid" });
  });

  it("ignores a payment id that belongs to no credit intent", async () => {
    await runExhaustedGeneration(USER_A, "webhook-unknown");

    const result = await handleMollieWebhook(
      { id: "tr_unrelated" },
      {
        createClient: () =>
          new MollieClient(getMollieConfig(), mollieFetchStub("tr_unrelated")),
      }
    );

    expect(result).toBe("unknown");
    expect(world.walletForUser(USER_A)?.credits).toBe(0);
  });
});

describe("two Messenger users", () => {
  let servers: BoundServer[] = [];

  afterEach(async () => {
    for (const server of servers) await close(server.server);
    servers = [];
  });

  it("keeps each user's own payment and credits", async () => {
    const paymentA = "tr_journeyusera";
    const paymentB = "tr_journeyuserb";

    // One open Test Mode configuration serves both users. No tester is
    // registered up front, and neither user changes the configuration.
    const openConfig = getCreditCheckoutPilotConfig();
    expect(openConfig.mode).toBe("test");
    expect(openConfig.testPilotScope).toBeNull();
    for (const field of TESTER_RESTRICTION_FIELDS) {
      expect(process.env[field]).toBeUndefined();
    }

    const linkA = (await runExhaustedGeneration(USER_A, "user-a")).url;
    const serverA = await startCheckoutServer(paymentA);
    servers.push(serverA);
    await payThroughBrowser(serverA, linkA);

    const linkB = (await runExhaustedGeneration(USER_B, "user-b")).url;
    const serverB = await startCheckoutServer(paymentB);
    servers.push(serverB);
    await payThroughBrowser(serverB, linkB);

    // Two users, two intents, two wallets, two payments — nothing shared.
    const intentA = world.intent(linkA.pathname.split("/").at(-1)!);
    const intentB = world.intent(linkB.pathname.split("/").at(-1)!);
    expect(intentA.intentId).not.toBe(intentB.intentId);
    expect(intentA.creditWalletId).not.toBe(intentB.creditWalletId);
    expect(intentA.messengerSenderUserKey).toBe(USER_A);
    expect(intentB.messengerSenderUserKey).toBe(USER_B);
    expect(linkA.hash).not.toBe(linkB.hash);

    // Only user A's payment settles.
    await handleMollieWebhook(
      { id: paymentA },
      {
        createClient: () =>
          new MollieClient(getMollieConfig(), mollieFetchStub(paymentA)),
      }
    );
    expect(world.walletForUser(USER_A)?.credits).toBe(8);
    expect(world.walletForUser(USER_B)?.credits).toBe(0);

    // Then user B's, on B's own wallet only.
    await handleMollieWebhook(
      { id: paymentB },
      {
        createClient: () =>
          new MollieClient(getMollieConfig(), mollieFetchStub(paymentB)),
      }
    );
    expect(world.walletForUser(USER_A)?.credits).toBe(8);
    expect(world.walletForUser(USER_B)?.credits).toBe(8);

    // The configuration never moved between the two users.
    expect(getCreditCheckoutPilotConfig()).toEqual(openConfig);

    // Neither user's link can open the other's checkout.
    const crossed = await fetch(
      `${serverA.baseUrl}/api/credits/checkout/${intentB.intentId}/claim`,
      {
        method: "POST",
        headers: browserHeaders(),
        body: JSON.stringify({ capability: linkA.hash.slice(1) }),
      }
    );
    expect(crossed.status).toBe(404);
  });
});

describe("checkout API ahead of the SPA fallback", () => {
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
   * The behaviour above is only safe while production keeps that order, so
   * pin the real composition in `index.ts` rather than only this test's app.
   */
  it("registers the checkout router before any static handler in index.ts", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, "_core", "index.ts"),
      "utf8"
    );
    const checkoutAt = source.indexOf("registerCreditCheckoutRoutes(app");
    const staticAt = source.indexOf("express.static(publicDir)");
    const fallbackAt = source.indexOf("serveStatic(app)");

    expect(checkoutAt).toBeGreaterThan(-1);
    expect(staticAt).toBeGreaterThan(-1);
    expect(fallbackAt).toBeGreaterThan(-1);
    expect(checkoutAt).toBeLessThan(staticAt);
    expect(checkoutAt).toBeLessThan(fallbackAt);
  });

  it("keeps the checkout JSON contract when the SPA fallback is mounted", async () => {
    const app = express();
    registerCreditCheckoutRoutes(app, {
      confirm: async () => {
        throw new Error("not part of this routing test");
      },
    });
    serveStatic(app, createTempBuild());
    bound = await bind(app);

    const api = await fetch(
      `${bound.baseUrl}/api/credits/checkout/return-status`
    );
    expect(api.status).toBe(404);
    expect(api.headers.get("content-type")).toContain("application/json");
    expect(await api.json()).toEqual({ error: "checkout unavailable" });

    for (const spaPath of [
      "/credits/checkout/11111111-1111-8111-8111-111111111111",
      "/credits/checkout/return",
    ]) {
      const page = await fetch(`${bound.baseUrl}${spaPath}`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(await page.text()).toContain("Leaderbot UI");
    }
  });
});
