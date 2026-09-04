import {
  assertCreditCheckoutCapabilityToken,
  createCreditCheckoutBrowserSession,
  hashCreditCheckoutBrowserNonce,
  hashCreditCheckoutCapability,
  verifyCreditCheckoutBrowserNonce,
} from "./creditCheckoutCapability";
import {
  getCreditCheckoutPilotConfig,
  isCreditCheckoutMessengerScopeAllowed,
  type CreditCheckoutPilotConfig,
} from "./creditCheckoutConfig";
import {
  type CreditOffer,
  getCreditOfferForStoredSnapshot,
} from "./creditCatalog";
import {
  consumeCreditCheckoutCapability,
  type CreditWalletScope,
} from "./creditWalletStore";
import {
  readCreditCheckoutSessionRecord,
  type CreditCheckoutSessionRecord,
} from "./creditCheckoutSessionStore";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PRIVACY_USER_KEY_PATTERN =
  /^(?:[0-9a-f]{64}|u2[.]k[1-9][0-9]{0,5}[.][0-9a-f]{64})$/;
const BROWSER_SESSION_PATTERN = new RegExp(
  `^(${UUID_PATTERN.source.slice(1, -1)})[.]([A-Za-z0-9_-]{43})$`
);

export const CREDIT_CHECKOUT_SESSION_COOKIE = "lb_credit_checkout";
export const CREDIT_CHECKOUT_SESSION_MAX_AGE_MS = 60 * 60_000;

export type CreditCheckoutPublicOffer = Readonly<{
  mode: "test" | "live";
  offerId: CreditOffer["offerId"];
  offerVersion: CreditOffer["offerVersion"];
  amount: CreditOffer["amount"]["value"];
  currency: "EUR";
  creditCount: CreditOffer["creditCount"];
  imageQuality: "medium";
  expires: false;
  automaticRenewal: false;
  refundPolicyId: CreditOffer["refundPolicyId"];
  refundPolicyVersion: CreditOffer["refundPolicyVersion"];
}>;

export type ClaimedCreditCheckoutSession = Readonly<{
  cookieValue: string;
  intentId: string;
  offer: CreditCheckoutPublicOffer;
}>;

export type CreditCheckoutReturnStatus =
  "processing" | "paid" | "failed" | "canceled" | "expired";

export class CreditCheckoutSessionError extends Error {
  constructor() {
    super("Credit checkout session is unavailable");
    this.name = "CreditCheckoutSessionError";
  }
}

type Dependencies = Readonly<{
  config: () => CreditCheckoutPilotConfig;
  readRecord: (intentId: string) => Promise<CreditCheckoutSessionRecord | null>;
  consume: typeof consumeCreditCheckoutCapability;
  now: () => Date;
}>;

const defaultDependencies: Dependencies = Object.freeze({
  config: getCreditCheckoutPilotConfig,
  readRecord: readCreditCheckoutSessionRecord,
  consume: consumeCreditCheckoutCapability,
  now: () => new Date(),
});

function fail(): never {
  throw new CreditCheckoutSessionError();
}

function isEmptyEntitlements(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function isValidDate(value: Date | null): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function readExactScope(
  record: CreditCheckoutSessionRecord,
  config: CreditCheckoutPilotConfig
): Readonly<{ scope: CreditWalletScope; offer: CreditOffer }> {
  const channelConnectionId = record.messengerChannelConnectionId;
  const bindingEpoch = record.messengerBindingEpoch;
  const privacyEpoch = record.messengerPrivacyEpoch;
  const userKey = record.messengerSenderUserKey;
  const walletId = record.creditWalletId;
  const financialSubjectRef = record.creditFinancialSubjectRef;
  const metadataHash = record.creditMetadataHash;
  const capabilityHash = record.checkoutCapabilityHash;
  const capabilityExpiresAt = record.checkoutCapabilityExpiresAt;
  const offer = getCreditOfferForStoredSnapshot(record);
  if (
    !config.checkoutEnabled ||
    !config.paidCreditsEnabled ||
    config.workspaceId === null ||
    record.workspaceId !== config.workspaceId ||
    record.mode !== config.mode ||
    record.kind !== "credit_purchase" ||
    !offer ||
    record.interval !== "oneoff" ||
    !isEmptyEntitlements(record.entitlements) ||
    record.billingProfileVersion !== 0 ||
    !Number.isSafeInteger(record.authorizationEpoch) ||
    record.authorizationEpoch < 1 ||
    typeof channelConnectionId !== "number" ||
    !Number.isSafeInteger(channelConnectionId) ||
    channelConnectionId < 1 ||
    typeof bindingEpoch !== "number" ||
    !Number.isSafeInteger(bindingEpoch) ||
    bindingEpoch < 1 ||
    typeof privacyEpoch !== "number" ||
    !Number.isSafeInteger(privacyEpoch) ||
    privacyEpoch < 1 ||
    !userKey ||
    !PRIVACY_USER_KEY_PATTERN.test(userKey) ||
    !walletId ||
    !UUID_PATTERN.test(walletId) ||
    !financialSubjectRef ||
    !SHA256_PATTERN.test(financialSubjectRef) ||
    !metadataHash ||
    !SHA256_PATTERN.test(metadataHash) ||
    !capabilityHash ||
    !SHA256_PATTERN.test(capabilityHash) ||
    !isValidDate(capabilityExpiresAt) ||
    record.creditIdentityErasedAt !== null
  ) {
    fail();
  }
  if (
    !isCreditCheckoutMessengerScopeAllowed(config, {
      workspaceId: record.workspaceId,
      channelConnectionId,
      bindingEpoch,
      privacyEpoch,
      userKey,
    })
  ) {
    fail();
  }
  return {
    scope: {
      workspaceId: record.workspaceId,
      mode: record.mode,
      channelConnectionId,
      bindingEpoch,
      privacyEpoch,
      userKey,
      walletId,
      financialSubjectRef,
    },
    offer,
  };
}

function publicOffer(
  mode: "test" | "live",
  offer: CreditOffer
): CreditCheckoutPublicOffer {
  return Object.freeze({
    mode,
    offerId: offer.offerId,
    offerVersion: offer.offerVersion,
    amount: offer.amount.value,
    currency: offer.amount.currency,
    creditCount: offer.creditCount,
    imageQuality: offer.providerPolicy.imageQuality,
    expires: offer.validity.expires,
    automaticRenewal: offer.paymentTerms.automaticRenewal,
    refundPolicyId: offer.refundPolicyId,
    refundPolicyVersion: offer.refundPolicyVersion,
  });
}

export async function claimCreditCheckoutBrowserSession(
  input: Readonly<{ intentId: string; capability: unknown }>,
  dependencies: Dependencies = defaultDependencies
): Promise<ClaimedCreditCheckoutSession> {
  if (!UUID_PATTERN.test(input.intentId)) fail();
  assertCreditCheckoutCapabilityToken(input.capability);
  const capabilityHash = hashCreditCheckoutCapability(input.capability);
  const config = dependencies.config();
  const record = await dependencies.readRecord(input.intentId);
  if (!record || record.intentId !== input.intentId) fail();
  const { scope, offer } = readExactScope(record, config);
  const now = dependencies.now();
  const capabilityExpiresAt = record.checkoutCapabilityExpiresAt;
  if (!isValidDate(capabilityExpiresAt)) fail();
  if (
    record.status !== "created" ||
    record.molliePaymentId !== null ||
    record.urlExposedAt !== null ||
    record.paidAt !== null ||
    record.checkoutCapabilityConsumedAt !== null ||
    record.checkoutCapabilitySessionNonceHash !== null ||
    capabilityExpiresAt.getTime() < now.getTime()
  ) {
    fail();
  }

  const session = createCreditCheckoutBrowserSession();
  const sessionNonce = session.revealSessionNonce();
  await dependencies.consume({
    ...scope,
    intentId: record.intentId,
    capabilityHash,
    sessionNonceHash: session.sessionNonceHash,
  });
  return Object.freeze({
    cookieValue: `${record.intentId}.${sessionNonce}`,
    intentId: record.intentId,
    offer: publicOffer(record.mode, offer),
  });
}

export async function readCreditCheckoutBrowserSession(
  cookieValue: unknown,
  options: Readonly<{ requireUnexpired: boolean }>,
  dependencies: Dependencies = defaultDependencies
): Promise<
  Readonly<{
    intentId: string;
    record: CreditCheckoutSessionRecord;
    offer: CreditCheckoutPublicOffer;
  }>
> {
  if (typeof cookieValue !== "string") fail();
  const match = BROWSER_SESSION_PATTERN.exec(cookieValue);
  if (!match?.[1] || !match[2]) fail();
  const intentId = match[1];
  const nonce = match[2];
  const config = dependencies.config();
  const record = await dependencies.readRecord(intentId);
  if (!record || record.intentId !== intentId) fail();
  const { offer } = readExactScope(record, config);
  const capabilityExpiresAt = record.checkoutCapabilityExpiresAt;
  if (!isValidDate(capabilityExpiresAt)) fail();
  if (
    !record.checkoutCapabilityConsumedAt ||
    !record.checkoutCapabilitySessionNonceHash ||
    !verifyCreditCheckoutBrowserNonce(
      nonce,
      record.checkoutCapabilitySessionNonceHash
    ) ||
    (options.requireUnexpired &&
      capabilityExpiresAt.getTime() < dependencies.now().getTime())
  ) {
    fail();
  }
  // Hashing validates canonical nonce bytes even when the constant-time check
  // above receives a future implementation with a broader input type.
  void hashCreditCheckoutBrowserNonce(nonce);
  return Object.freeze({
    intentId,
    record,
    offer: publicOffer(record.mode, offer),
  });
}

export function mapCreditCheckoutReturnStatus(
  status: string
): CreditCheckoutReturnStatus {
  switch (status) {
    case "paid":
      return "paid";
    case "failed":
    case "mismatch":
    case "contained":
      return "failed";
    case "canceled":
      return "canceled";
    case "expired":
      return "expired";
    case "created":
    case "creating_payment":
    case "open":
    case "api_unknown":
      return "processing";
    default:
      return fail();
  }
}
