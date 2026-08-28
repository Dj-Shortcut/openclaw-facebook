import { createHash, createHmac } from "node:crypto";

import type { MollieMode } from "./config";
import {
  type CreditOffer,
  listCreditOffers,
  PREMIUM_IMAGE_CREDIT_OFFER_ID,
  PREMIUM_IMAGE_CREDIT_OFFER_VERSION,
  PREMIUM_IMAGE_CREDIT_REFUND_POLICY_ID,
  PREMIUM_IMAGE_CREDIT_REFUND_POLICY_VERSION,
} from "./creditCatalog";
import {
  deriveCreditCheckoutCapability,
  type CreditCheckoutCapabilityMaterial,
} from "./creditCheckoutCapability";

const MAX_DATABASE_ID = 2_147_483_647;
const MINIMUM_SECRET_BYTES = 32;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const PRIVACY_SUBJECT_USER_KEY_PATTERN =
  /^(?:[0-9a-f]{64}|u2[.]k[1-9][0-9]{0,5}[.][0-9a-f]{64})$/;
const CANONICAL_ENCODING_VERSION = 1;
const UUID_VERSION = 8;
const CHECKOUT_SCOPE_PREFIX = "credit-checkout:v1:";

const FINANCIAL_SUBJECT_DOMAIN = Buffer.from(
  "leaderbot.credit-financial-subject.v1\0",
  "ascii"
);
const WALLET_ID_DOMAIN = Buffer.from(
  "leaderbot.credit-wallet-id.v1\0",
  "ascii"
);
const INTENT_ID_DOMAIN = Buffer.from(
  "leaderbot.credit-checkout-intent-id.v1\0",
  "ascii"
);
const CHECKOUT_SCOPE_DOMAIN = Buffer.from(
  "leaderbot.credit-checkout-scope.v1\0",
  "ascii"
);

export type CreditCheckoutMessengerScope = Readonly<{
  workspaceId: number;
  mode: MollieMode;
  channel: "facebook_messenger";
  channelConnectionId: number;
  bindingEpoch: number;
  privacyEpoch: number;
  userKey: string;
}>;

export type CreditPaymentMetadataSnapshot = Readonly<{
  purpose: "premium_image_credits";
  version: 1;
  intentId: string;
  walletId: string;
  tenant: Readonly<{
    workspaceId: number;
    mode: MollieMode;
    channel: "facebook_messenger";
    channelConnectionId: number;
    bindingEpoch: number;
    privacyEpoch: number;
    financialSubjectRef: string;
    authorizationEpoch: number;
  }>;
  offer: Readonly<{
    offerId: typeof PREMIUM_IMAGE_CREDIT_OFFER_ID;
    offerVersion: typeof PREMIUM_IMAGE_CREDIT_OFFER_VERSION;
    amount: Readonly<{
      currency: "EUR";
      value: "4.99";
      minor: 499;
    }>;
    creditCount: 8;
    creditUnit: "premium_image";
    imageQuality: "medium";
    validity: Readonly<{
      expires: false;
      expiresAfterDays: null;
    }>;
    paymentTerms: Readonly<{
      kind: "one_time";
      automaticRenewal: false;
      mandateRequired: false;
      automaticTopUp: false;
      overageAllowed: false;
    }>;
    refundPolicyId: typeof PREMIUM_IMAGE_CREDIT_REFUND_POLICY_ID;
    refundPolicyVersion: typeof PREMIUM_IMAGE_CREDIT_REFUND_POLICY_VERSION;
    description: "Leaderbot - 8 premium beeldcredits";
  }>;
}>;

export type CreditCheckoutIdentityInput = Readonly<{
  dedicatedSecret: Uint8Array;
  scope: CreditCheckoutMessengerScope;
  expectedAuthorizationEpoch: number;
  requestKeyHash: string;
  offer: CreditOffer;
}>;

export type CreditWalletIdentityInput = Readonly<{
  dedicatedSecret: Uint8Array;
  scope: CreditCheckoutMessengerScope;
}>;

export type CreditWalletIdentity = Readonly<{
  financialSubjectRef: string;
  walletId: string;
}>;

export type CreditCheckoutIdentity = Readonly<{
  financialSubjectRef: string;
  walletId: string;
  intentId: string;
  checkoutScopeKey: string;
  idempotencyKey: string;
  metadataHash: string;
  paymentMetadataSnapshot: CreditPaymentMetadataSnapshot;
  checkoutCapability: CreditCheckoutCapabilityMaterial;
  toJSON: () => Readonly<{
    financialSubjectRef: string;
    walletId: string;
    intentId: string;
    checkoutScopeKey: string;
    idempotencyKey: string;
    metadataHash: string;
    paymentMetadataSnapshot: CreditPaymentMetadataSnapshot;
    capabilityHash: string;
  }>;
}>;

export type CreditCheckoutIdentityErrorCode =
  | "invalid_input"
  | "invalid_secret"
  | "invalid_scope"
  | "invalid_authorization_epoch"
  | "invalid_request_key_hash"
  | "invalid_offer";

export class CreditCheckoutIdentityError extends Error {
  readonly code: CreditCheckoutIdentityErrorCode;

  constructor(code: CreditCheckoutIdentityErrorCode) {
    super("Credit checkout identity input is invalid");
    this.name = "CreditCheckoutIdentityError";
    this.code = code;
  }
}

type CanonicalField = string | number | Uint8Array;

function fail(code: CreditCheckoutIdentityErrorCode): never {
  throw new CreditCheckoutIdentityError(code);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[]
): boolean {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

function isDatabaseId(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_DATABASE_ID
  );
}

function assertInput(
  input: CreditCheckoutIdentityInput
): asserts input is CreditCheckoutIdentityInput {
  if (
    !isPlainRecord(input) ||
    !hasExactKeys(input, [
      "dedicatedSecret",
      "scope",
      "expectedAuthorizationEpoch",
      "requestKeyHash",
      "offer",
    ])
  ) {
    fail("invalid_input");
  }

  if (
    !(input.dedicatedSecret instanceof Uint8Array) ||
    input.dedicatedSecret.byteLength < MINIMUM_SECRET_BYTES
  ) {
    fail("invalid_secret");
  }

  assertScope(input.scope);

  if (!isDatabaseId(input.expectedAuthorizationEpoch)) {
    fail("invalid_authorization_epoch");
  }
  if (
    typeof input.requestKeyHash !== "string" ||
    !SHA256_HEX_PATTERN.test(input.requestKeyHash)
  ) {
    fail("invalid_request_key_hash");
  }

  const canonicalOffer = listCreditOffers().find(
    offer => offer === input.offer
  );
  if (!canonicalOffer || !isExactPilotOffer(canonicalOffer)) {
    fail("invalid_offer");
  }
}

function assertScope(
  scope: unknown
): asserts scope is CreditCheckoutMessengerScope {
  if (
    !isPlainRecord(scope) ||
    !hasExactKeys(scope, [
      "workspaceId",
      "mode",
      "channel",
      "channelConnectionId",
      "bindingEpoch",
      "privacyEpoch",
      "userKey",
    ]) ||
    !isDatabaseId(scope.workspaceId) ||
    (scope.mode !== "test" && scope.mode !== "live") ||
    scope.channel !== "facebook_messenger" ||
    !isDatabaseId(scope.channelConnectionId) ||
    !isDatabaseId(scope.bindingEpoch) ||
    !isDatabaseId(scope.privacyEpoch) ||
    typeof scope.userKey !== "string" ||
    !PRIVACY_SUBJECT_USER_KEY_PATTERN.test(scope.userKey)
  ) {
    fail("invalid_scope");
  }
}

function assertWalletIdentityInput(
  input: CreditWalletIdentityInput
): asserts input is CreditWalletIdentityInput {
  if (
    !isPlainRecord(input) ||
    !hasExactKeys(input, ["dedicatedSecret", "scope"])
  ) {
    fail("invalid_input");
  }
  if (
    !(input.dedicatedSecret instanceof Uint8Array) ||
    input.dedicatedSecret.byteLength < MINIMUM_SECRET_BYTES
  ) {
    fail("invalid_secret");
  }
  assertScope(input.scope);
}

function isExactPilotOffer(offer: CreditOffer): boolean {
  return (
    offer.offerId === PREMIUM_IMAGE_CREDIT_OFFER_ID &&
    offer.offerVersion === PREMIUM_IMAGE_CREDIT_OFFER_VERSION &&
    offer.purchaseKind === "credit_purchase" &&
    offer.publicName === "8 premium beeldcredits" &&
    offer.amountMinor === 499 &&
    offer.amount.currency === "EUR" &&
    offer.amount.value === "4.99" &&
    offer.creditCount === 8 &&
    offer.creditUnit === "premium_image" &&
    offer.providerPolicy.imageQuality === "medium" &&
    offer.validity.expires === false &&
    offer.validity.expiresAfterDays === null &&
    offer.paymentTerms.kind === "one_time" &&
    offer.paymentTerms.automaticRenewal === false &&
    offer.paymentTerms.mandateRequired === false &&
    offer.paymentTerms.automaticTopUp === false &&
    offer.paymentTerms.overageAllowed === false &&
    offer.refundPolicyId === PREMIUM_IMAGE_CREDIT_REFUND_POLICY_ID &&
    offer.refundPolicyVersion === PREMIUM_IMAGE_CREDIT_REFUND_POLICY_VERSION &&
    offer.mollieDescription === "Leaderbot - 8 premium beeldcredits"
  );
}

function fieldBytes(value: CanonicalField): Buffer {
  if (typeof value === "number") {
    const encoded = Buffer.alloc(8);
    encoded.writeBigUInt64BE(BigInt(value));
    return encoded;
  }
  if (typeof value === "string") {
    return Buffer.from(value, "utf8");
  }
  return Buffer.from(value);
}

function encodeCanonicalFields(fields: readonly CanonicalField[]): Buffer {
  if (fields.length > 255) fail("invalid_input");
  const values = fields.map(fieldBytes);
  try {
    const totalLength = values.reduce(
      (total, value) => total + 1 + 4 + value.byteLength,
      2
    );
    const encoded = Buffer.alloc(totalLength);
    encoded.writeUInt8(CANONICAL_ENCODING_VERSION, 0);
    encoded.writeUInt8(values.length, 1);
    let offset = 2;
    values.forEach((value, index) => {
      encoded.writeUInt8(index + 1, offset);
      encoded.writeUInt32BE(value.byteLength, offset + 1);
      value.copy(encoded, offset + 5);
      offset += 5 + value.byteLength;
    });
    return encoded;
  } finally {
    values.forEach(value => value.fill(0));
  }
}

function deriveHmac(
  secret: Uint8Array,
  domain: Uint8Array,
  fields: readonly CanonicalField[]
): Buffer {
  const encoded = encodeCanonicalFields(fields);
  try {
    return createHmac("sha256", secret).update(domain).update(encoded).digest();
  } finally {
    encoded.fill(0);
  }
}

function uuidFromDigest(digest: Uint8Array): string {
  const bytes = Buffer.from(digest.subarray(0, 16));
  try {
    bytes[6] = (bytes[6] & 0x0f) | (UUID_VERSION << 4);
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
      12,
      16
    )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } finally {
    bytes.fill(0);
  }
}

function deepFreeze<T>(value: T): T {
  if (
    (typeof value === "object" && value !== null) ||
    typeof value === "function"
  ) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function walletScopeFields(
  scope: CreditCheckoutMessengerScope
): readonly CanonicalField[] {
  return [
    scope.workspaceId,
    scope.mode,
    scope.channel,
    scope.channelConnectionId,
    scope.bindingEpoch,
    scope.privacyEpoch,
    scope.userKey,
  ];
}

/**
 * Derives only the stable financial identity needed to spend an existing
 * wallet. Checkout authorization and request identity deliberately do not
 * participate, so disabling new sales cannot strand already-purchased
 * credits.
 */
export function deriveCreditWalletIdentity(
  input: CreditWalletIdentityInput
): CreditWalletIdentity {
  assertWalletIdentityInput(input);
  const secretCopy = Buffer.from(input.dedicatedSecret);
  let financialDigest: Buffer | undefined;
  let walletDigest: Buffer | undefined;
  try {
    financialDigest = deriveHmac(
      secretCopy,
      FINANCIAL_SUBJECT_DOMAIN,
      walletScopeFields(input.scope)
    );
    walletDigest = deriveHmac(secretCopy, WALLET_ID_DOMAIN, [financialDigest]);
    return deepFreeze({
      financialSubjectRef: financialDigest.toString("hex"),
      walletId: uuidFromDigest(walletDigest),
    });
  } finally {
    secretCopy.fill(0);
    financialDigest?.fill(0);
    walletDigest?.fill(0);
  }
}

function buildPaymentMetadataSnapshot(input: {
  scope: CreditCheckoutMessengerScope;
  expectedAuthorizationEpoch: number;
  financialSubjectRef: string;
  walletId: string;
  intentId: string;
  offer: CreditOffer;
}): CreditPaymentMetadataSnapshot {
  return deepFreeze({
    purpose: "premium_image_credits" as const,
    version: 1 as const,
    intentId: input.intentId,
    walletId: input.walletId,
    tenant: {
      workspaceId: input.scope.workspaceId,
      mode: input.scope.mode,
      channel: input.scope.channel,
      channelConnectionId: input.scope.channelConnectionId,
      bindingEpoch: input.scope.bindingEpoch,
      privacyEpoch: input.scope.privacyEpoch,
      financialSubjectRef: input.financialSubjectRef,
      authorizationEpoch: input.expectedAuthorizationEpoch,
    },
    offer: {
      offerId: input.offer.offerId,
      offerVersion: input.offer.offerVersion,
      amount: {
        currency: input.offer.amount.currency,
        value: input.offer.amount.value,
        minor: 499 as const,
      },
      creditCount: input.offer.creditCount,
      creditUnit: input.offer.creditUnit,
      imageQuality: input.offer.providerPolicy.imageQuality,
      validity: {
        expires: input.offer.validity.expires,
        expiresAfterDays: input.offer.validity.expiresAfterDays,
      },
      paymentTerms: {
        kind: input.offer.paymentTerms.kind,
        automaticRenewal: input.offer.paymentTerms.automaticRenewal,
        mandateRequired: input.offer.paymentTerms.mandateRequired,
        automaticTopUp: input.offer.paymentTerms.automaticTopUp,
        overageAllowed: input.offer.paymentTerms.overageAllowed,
      },
      refundPolicyId: input.offer.refundPolicyId,
      refundPolicyVersion: input.offer.refundPolicyVersion,
      description: "Leaderbot - 8 premium beeldcredits" as const,
    },
  });
}

/**
 * Derives the stable, opaque identity for one immutable credit checkout.
 *
 * This function is provider-silent. The raw Messenger user key and request
 * hash take part in the HMAC boundary but are never copied into payment
 * metadata or JSON output. The only revealable secret-like value is the
 * capability fragment behind `checkoutCapability.toUrlFragment()`.
 */
export function deriveCreditCheckoutIdentity(
  input: CreditCheckoutIdentityInput
): CreditCheckoutIdentity {
  assertInput(input);

  const secretCopy = Buffer.from(input.dedicatedSecret);
  const requestHashBytes = Buffer.from(input.requestKeyHash, "hex");
  let financialDigest: Buffer | undefined;
  let walletDigest: Buffer | undefined;
  let intentDigest: Buffer | undefined;
  let checkoutScopeDigest: Buffer | undefined;

  try {
    const scopeFields = walletScopeFields(input.scope);
    financialDigest = deriveHmac(
      secretCopy,
      FINANCIAL_SUBJECT_DOMAIN,
      scopeFields
    );
    const financialSubjectRef = financialDigest.toString("hex");

    walletDigest = deriveHmac(secretCopy, WALLET_ID_DOMAIN, [financialDigest]);
    const walletId = uuidFromDigest(walletDigest);

    const checkoutFields: readonly CanonicalField[] = [
      ...scopeFields,
      financialDigest,
      input.expectedAuthorizationEpoch,
      requestHashBytes,
      input.offer.offerId,
      input.offer.offerVersion,
      input.offer.amount.currency,
      input.offer.amount.value,
      input.offer.amountMinor,
      input.offer.creditCount,
      input.offer.creditUnit,
      input.offer.providerPolicy.imageQuality,
      input.offer.paymentTerms.kind,
      input.offer.paymentTerms.automaticRenewal ? 1 : 0,
      input.offer.paymentTerms.mandateRequired ? 1 : 0,
      input.offer.paymentTerms.automaticTopUp ? 1 : 0,
      input.offer.paymentTerms.overageAllowed ? 1 : 0,
      input.offer.refundPolicyId,
      input.offer.refundPolicyVersion,
      input.offer.mollieDescription,
    ];
    intentDigest = deriveHmac(secretCopy, INTENT_ID_DOMAIN, checkoutFields);
    const intentId = uuidFromDigest(intentDigest);

    checkoutScopeDigest = deriveHmac(
      secretCopy,
      CHECKOUT_SCOPE_DOMAIN,
      checkoutFields
    );
    const checkoutScopeKey = `${CHECKOUT_SCOPE_PREFIX}${checkoutScopeDigest.toString(
      "hex"
    )}`;
    const idempotencyKey = `credit-payment:${intentId}`;

    const paymentMetadataSnapshot = buildPaymentMetadataSnapshot({
      scope: input.scope,
      expectedAuthorizationEpoch: input.expectedAuthorizationEpoch,
      financialSubjectRef,
      walletId,
      intentId,
      offer: input.offer,
    });
    const metadataHash = createHash("sha256")
      .update(JSON.stringify(paymentMetadataSnapshot), "utf8")
      .digest("hex");
    const checkoutCapability = deriveCreditCheckoutCapability({
      dedicatedSecret: secretCopy,
      intentId,
      metadataHash,
    });
    const jsonView = deepFreeze({
      financialSubjectRef,
      walletId,
      intentId,
      checkoutScopeKey,
      idempotencyKey,
      metadataHash,
      paymentMetadataSnapshot,
      capabilityHash: checkoutCapability.capabilityHash,
    });

    return deepFreeze({
      financialSubjectRef,
      walletId,
      intentId,
      checkoutScopeKey,
      idempotencyKey,
      metadataHash,
      paymentMetadataSnapshot,
      checkoutCapability,
      toJSON: () => jsonView,
    });
  } finally {
    secretCopy.fill(0);
    requestHashBytes.fill(0);
    financialDigest?.fill(0);
    walletDigest?.fill(0);
    intentDigest?.fill(0);
    checkoutScopeDigest?.fill(0);
  }
}
