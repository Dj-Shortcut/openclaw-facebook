import { createHash } from "node:crypto";

import {
  getCreditOffer,
  PREMIUM_IMAGE_CREDIT_OFFER_ID,
  PREMIUM_IMAGE_CREDIT_OFFER_VERSION,
} from "./creditCatalog";
import {
  getCreditCheckoutPilotConfig,
  isCreditCheckoutMessengerScopeAllowed,
  withCreditCheckoutHmacKeyring,
  type CreditCheckoutPilotConfig,
} from "./creditCheckoutConfig";
import { deriveCreditCheckoutIdentity } from "./creditCheckoutIdentity";
import { withSelectedCreditCheckoutHmacKey } from "./creditCheckoutKeyring";
import { readCurrentCreditWalletIdentity } from "./creditGenerationAdmissionStore";
import { readCreditCheckoutAuthorization } from "./creditCheckoutReservationStore";
import { reserveCreditCheckoutIntent } from "./creditWalletStore";

const MAX_DATABASE_ID = 2_147_483_647;
const PRIVACY_USER_KEY_PATTERN =
  /^(?:[0-9a-f]{64}|u2[.]k[1-9][0-9]{0,5}[.][0-9a-f]{64})$/;
const REQUEST_ID_MAX_LENGTH = 256;
const CAPABILITY_TTL_MS = 10 * 60_000;
const WALLET_SCOPE_CONFLICT = "credit checkout wallet scope conflicts";

export type MessengerCreditCheckoutRequest = Readonly<{
  workspaceId: number;
  channelConnectionId: number;
  bindingEpoch: number;
  privacyEpoch: number;
  userKey: string;
  requestId: string;
}>;

export type ReservedMessengerCreditCheckout = Readonly<{
  intentId: string;
  actionUrl: string;
  label: "8 premiumcredits - € 4,99";
  toJSON: () => Readonly<{ intentId: string; capability: "redacted" }>;
}>;

export class CreditCheckoutReservationError extends Error {
  constructor() {
    super("Credit checkout is unavailable");
    this.name = "CreditCheckoutReservationError";
  }
}

type Dependencies = Readonly<{
  config: () => CreditCheckoutPilotConfig;
  readAuthorization: typeof readCreditCheckoutAuthorization;
  readWalletIdentity: typeof readCurrentCreditWalletIdentity;
  reserve: typeof reserveCreditCheckoutIntent;
  withKeyring: typeof withCreditCheckoutHmacKeyring;
  now: () => Date;
  appBaseUrl: () => URL;
}>;

const defaultDependencies: Dependencies = Object.freeze({
  config: getCreditCheckoutPilotConfig,
  readAuthorization: readCreditCheckoutAuthorization,
  readWalletIdentity: readCurrentCreditWalletIdentity,
  reserve: reserveCreditCheckoutIntent,
  withKeyring: withCreditCheckoutHmacKeyring,
  now: () => new Date(),
  appBaseUrl: readCreditCheckoutAppBaseUrl,
});

function fail(): never {
  throw new CreditCheckoutReservationError();
}

function isWalletScopeConflict(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as Record<string, unknown>;
    if (
      candidate.code === "ER_SIGNAL_EXCEPTION" &&
      candidate.sqlState === "45000" &&
      candidate.sqlMessage === WALLET_SCOPE_CONFLICT
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

function isDatabaseId(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_DATABASE_ID
  );
}

function assertRequest(
  input: MessengerCreditCheckoutRequest
): asserts input is MessengerCreditCheckoutRequest {
  if (
    !input ||
    typeof input !== "object" ||
    !isDatabaseId(input.workspaceId) ||
    !isDatabaseId(input.channelConnectionId) ||
    !isDatabaseId(input.bindingEpoch) ||
    !isDatabaseId(input.privacyEpoch) ||
    typeof input.userKey !== "string" ||
    !PRIVACY_USER_KEY_PATTERN.test(input.userKey) ||
    typeof input.requestId !== "string" ||
    input.requestId.length < 1 ||
    input.requestId.length > REQUEST_ID_MAX_LENGTH
  ) {
    fail();
  }
}

function requestKeyHash(requestId: string): string {
  return createHash("sha256")
    .update("leaderbot.credit-checkout-request.v1\0", "utf8")
    .update(requestId, "utf8")
    .digest("hex");
}

export function readCreditCheckoutAppBaseUrl(
  env: NodeJS.ProcessEnv = process.env
): URL {
  const value = env.APP_BASE_URL?.trim() ?? "";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail();
  }
  const localHttp =
    env.NODE_ENV !== "production" &&
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if (
    (parsed.protocol !== "https:" && !localHttp) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    fail();
  }
  return new URL(parsed.origin);
}

export async function reserveMessengerCreditCheckout(
  input: MessengerCreditCheckoutRequest,
  dependencies: Dependencies = defaultDependencies
): Promise<ReservedMessengerCreditCheckout> {
  assertRequest(input);
  const config = dependencies.config();
  if (
    !config.checkoutEnabled ||
    !config.paidCreditsEnabled ||
    !isCreditCheckoutMessengerScopeAllowed(config, input)
  ) {
    fail();
  }
  const boundary = await dependencies.readAuthorization({
    workspaceId: input.workspaceId,
    mode: config.mode,
  });
  if (!boundary) fail();
  const offer = getCreditOffer(
    PREMIUM_IMAGE_CREDIT_OFFER_ID,
    PREMIUM_IMAGE_CREDIT_OFFER_VERSION
  );
  if (!offer) fail();
  const scope = Object.freeze({
    workspaceId: input.workspaceId,
    mode: config.mode,
    channel: "facebook_messenger" as const,
    channelConnectionId: input.channelConnectionId,
    bindingEpoch: input.bindingEpoch,
    privacyEpoch: input.privacyEpoch,
    userKey: input.userKey,
  });
  const persistedIdentity = await dependencies.readWalletIdentity(scope);
  if (persistedIdentity && !persistedIdentity.checkoutAvailable) fail();
  const identity = dependencies.withKeyring(keys =>
    withSelectedCreditCheckoutHmacKey({
      keys,
      scope,
      persistedIdentity,
      callback: ({ key }) =>
        deriveCreditCheckoutIdentity({
          dedicatedSecret: key.secret,
          scope,
          expectedAuthorizationEpoch: boundary.authorizationEpoch,
          requestKeyHash: requestKeyHash(input.requestId),
          offer,
        }),
    })
  );
  const identitySnapshot = identity.toJSON();
  const now = dependencies.now();
  if (!Number.isFinite(now.getTime())) fail();
  const capabilityExpiresAt = new Date(now.getTime() + CAPABILITY_TTL_MS);
  try {
    await dependencies.reserve({
      intentId: identity.intentId,
      walletId: identity.walletId,
      workspaceId: input.workspaceId,
      mode: config.mode,
      channelConnectionId: input.channelConnectionId,
      bindingEpoch: input.bindingEpoch,
      privacyEpoch: input.privacyEpoch,
      userKey: input.userKey,
      financialSubjectRef: identity.financialSubjectRef,
      authorizationEpoch: boundary.authorizationEpoch,
      offerSnapshotCode: offer.offerId,
      expectedAmount: offer.amount.value,
      creditCount: offer.creditCount,
      description: "Leaderbot - 8 premium beeldcredits",
      metadataHash: identity.metadataHash,
      idempotencyKey: identity.idempotencyKey,
      checkoutScopeKey: identity.checkoutScopeKey,
      capabilityHash: identitySnapshot.capabilityHash,
      capabilityExpiresAt,
    });
  } catch (error) {
    // A refund may win the wallet row lock after the identity read. Translate
    // only that exact stored-routine policy fence; database outages and all
    // other failures remain retryable to the durable generation worker.
    if (isWalletScopeConflict(error)) fail();
    throw error;
  }

  const checkoutUrl = new URL(
    `/credits/checkout/${encodeURIComponent(identity.intentId)}`,
    dependencies.appBaseUrl()
  );
  checkoutUrl.hash = identity.checkoutCapability.toUrlFragment();
  const jsonView = Object.freeze({
    intentId: identity.intentId,
    capability: "redacted" as const,
  });
  return Object.freeze({
    intentId: identity.intentId,
    actionUrl: checkoutUrl.toString(),
    label: "8 premiumcredits - € 4,99" as const,
    toJSON: () => jsonView,
  });
}

/**
 * Test-only checkout entry point for the owner-operated Mollie pilot.
 * It deliberately derives the pilot scope from the current authenticated
 * Messenger request rather than exposing a reusable public bypass.
 */
export async function reserveMessengerCreditCheckoutForTestCommand(
  input: MessengerCreditCheckoutRequest,
  dependencies: Dependencies = defaultDependencies
): Promise<ReservedMessengerCreditCheckout> {
  if (process.env.MOLLIE_MODE?.trim() !== "test") fail();
  if (process.env.MOLLIE_TEST_COMMAND_ENABLED?.trim() !== "true") fail();

  const baseConfig = dependencies.config();
  const testPilotScope = Object.freeze({
    channelConnectionId: input.channelConnectionId,
    bindingEpoch: input.bindingEpoch,
    privacyEpoch: input.privacyEpoch,
    userKeyHash: createHash("sha256")
      .update("leaderbot.credit-checkout-test-user.v1\\0", "utf8")
      .update(input.userKey, "utf8")
      .digest("hex"),
  });
  return reserveMessengerCreditCheckout(input, {
    ...dependencies,
    config: () =>
      Object.freeze({
        ...baseConfig,
        checkoutEnabled: true,
        paidCreditsEnabled: true,
        testPilotScope,
      }),
  });
}
