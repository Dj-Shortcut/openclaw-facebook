import { createHash } from "node:crypto";

import {
  getCreditOffer,
  PREMIUM_IMAGE_CREDIT_OFFER_ID,
  PREMIUM_IMAGE_CREDIT_OFFER_VERSION,
} from "./creditCatalog";
import {
  getCreditCheckoutPilotConfig,
  withCreditCheckoutHmacSecret,
  type CreditCheckoutPilotConfig,
} from "./creditCheckoutConfig";
import { deriveCreditCheckoutIdentity } from "./creditCheckoutIdentity";
import { readCreditCheckoutAuthorization } from "./creditCheckoutReservationStore";
import { reserveCreditCheckoutIntent } from "./creditWalletStore";

const MAX_DATABASE_ID = 2_147_483_647;
const PRIVACY_USER_KEY_PATTERN =
  /^(?:[0-9a-f]{64}|u2[.]k[1-9][0-9]{0,5}[.][0-9a-f]{64})$/;
const REQUEST_ID_MAX_LENGTH = 256;
const CAPABILITY_TTL_MS = 10 * 60_000;

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
  reserve: typeof reserveCreditCheckoutIntent;
  withSecret: typeof withCreditCheckoutHmacSecret;
  now: () => Date;
  appBaseUrl: () => URL;
}>;

const defaultDependencies: Dependencies = Object.freeze({
  config: getCreditCheckoutPilotConfig,
  readAuthorization: readCreditCheckoutAuthorization,
  reserve: reserveCreditCheckoutIntent,
  withSecret: withCreditCheckoutHmacSecret,
  now: () => new Date(),
  appBaseUrl: readCreditCheckoutAppBaseUrl,
});

function fail(): never {
  throw new CreditCheckoutReservationError();
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
    config.workspaceId !== input.workspaceId
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
  const identity = dependencies.withSecret(secret =>
    deriveCreditCheckoutIdentity({
      dedicatedSecret: secret,
      scope: {
        workspaceId: input.workspaceId,
        mode: config.mode,
        channel: "facebook_messenger",
        channelConnectionId: input.channelConnectionId,
        bindingEpoch: input.bindingEpoch,
        privacyEpoch: input.privacyEpoch,
        userKey: input.userKey,
      },
      expectedAuthorizationEpoch: boundary.authorizationEpoch,
      requestKeyHash: requestKeyHash(input.requestId),
      offer,
    })
  );
  const identitySnapshot = identity.toJSON();
  const now = dependencies.now();
  if (!Number.isFinite(now.getTime())) fail();
  const capabilityExpiresAt = new Date(now.getTime() + CAPABILITY_TTL_MS);
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
