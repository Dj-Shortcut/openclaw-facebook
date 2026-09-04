export const LEGACY_PREMIUM_IMAGE_CREDIT_OFFER_ID =
  "premium_images_8_medium_v1" as const;
export const LEGACY_PREMIUM_IMAGE_CREDIT_OFFER_VERSION = 1 as const;

/** The only offer selected for a new checkout. */
export const PREMIUM_IMAGE_CREDIT_OFFER_ID =
  "premium_images_9_medium_v2" as const;
export const PREMIUM_IMAGE_CREDIT_OFFER_VERSION = 2 as const;
export const PREMIUM_IMAGE_CREDIT_REFUND_POLICY_ID =
  "premium_image_credit_refund" as const;
export const LEGACY_PREMIUM_IMAGE_CREDIT_REFUND_POLICY_VERSION = 1 as const;
export const PREMIUM_IMAGE_CREDIT_REFUND_POLICY_VERSION = 2 as const;

export type CreditOfferId =
  | typeof LEGACY_PREMIUM_IMAGE_CREDIT_OFFER_ID
  | typeof PREMIUM_IMAGE_CREDIT_OFFER_ID;
export type CreditOfferVersion =
  | typeof LEGACY_PREMIUM_IMAGE_CREDIT_OFFER_VERSION
  | typeof PREMIUM_IMAGE_CREDIT_OFFER_VERSION;

export type CreditOffer = Readonly<{
  offerId: CreditOfferId;
  offerVersion: CreditOfferVersion;
  purchaseKind: "credit_purchase";
  publicName: string;
  amountMinor: 499 | 500;
  amount: Readonly<{
    currency: "EUR";
    value: "4.99" | "5.00";
  }>;
  creditCount: 8 | 9;
  creditUnit: "premium_image";
  providerPolicy: Readonly<{
    imageQuality: "medium";
  }>;
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
  refundPolicyVersion:
    | typeof LEGACY_PREMIUM_IMAGE_CREDIT_REFUND_POLICY_VERSION
    | typeof PREMIUM_IMAGE_CREDIT_REFUND_POLICY_VERSION;
  mollieDescription: string;
}>;

/** Historical v1 evidence; never mutate or remove this record. */
const LEGACY_PREMIUM_IMAGE_CREDIT_OFFER = Object.freeze({
  offerId: LEGACY_PREMIUM_IMAGE_CREDIT_OFFER_ID,
  offerVersion: LEGACY_PREMIUM_IMAGE_CREDIT_OFFER_VERSION,
  purchaseKind: "credit_purchase" as const,
  publicName: "8 premium beeldcredits",
  amountMinor: 499,
  amount: Object.freeze({
    currency: "EUR" as const,
    value: "4.99" as const,
  }),
  creditCount: 8 as const,
  creditUnit: "premium_image" as const,
  providerPolicy: Object.freeze({
    imageQuality: "medium" as const,
  }),
  validity: Object.freeze({
    expires: false as const,
    expiresAfterDays: null,
  }),
  paymentTerms: Object.freeze({
    kind: "one_time" as const,
    automaticRenewal: false as const,
    mandateRequired: false as const,
    automaticTopUp: false as const,
    overageAllowed: false as const,
  }),
  refundPolicyId: PREMIUM_IMAGE_CREDIT_REFUND_POLICY_ID,
  refundPolicyVersion: LEGACY_PREMIUM_IMAGE_CREDIT_REFUND_POLICY_VERSION,
  mollieDescription: "Leaderbot - 8 premium beeldcredits",
}) satisfies CreditOffer;

/** Server-owned offer for every newly-created checkout. */
const PREMIUM_IMAGE_CREDIT_OFFER = Object.freeze({
  offerId: PREMIUM_IMAGE_CREDIT_OFFER_ID,
  offerVersion: PREMIUM_IMAGE_CREDIT_OFFER_VERSION,
  purchaseKind: "credit_purchase" as const,
  publicName: "9 premium beeldcredits",
  amountMinor: 500 as const,
  amount: Object.freeze({
    currency: "EUR" as const,
    value: "5.00" as const,
  }),
  creditCount: 9 as const,
  creditUnit: "premium_image" as const,
  providerPolicy: Object.freeze({
    imageQuality: "medium" as const,
  }),
  validity: Object.freeze({
    expires: false as const,
    expiresAfterDays: null,
  }),
  paymentTerms: Object.freeze({
    kind: "one_time" as const,
    automaticRenewal: false as const,
    mandateRequired: false as const,
    automaticTopUp: false as const,
    overageAllowed: false as const,
  }),
  refundPolicyId: PREMIUM_IMAGE_CREDIT_REFUND_POLICY_ID,
  refundPolicyVersion: PREMIUM_IMAGE_CREDIT_REFUND_POLICY_VERSION,
  mollieDescription: "Leaderbot - 9 premium beeldcredits",
}) satisfies CreditOffer;

const CREDIT_OFFERS = Object.freeze([
  LEGACY_PREMIUM_IMAGE_CREDIT_OFFER,
  PREMIUM_IMAGE_CREDIT_OFFER,
]);

export function listCreditOffers(): readonly CreditOffer[] {
  return CREDIT_OFFERS;
}

export function getCreditOffer(
  offerId: string,
  offerVersion: number
): CreditOffer | null {
  return (
    CREDIT_OFFERS.find(
      offer => offer.offerId === offerId && offer.offerVersion === offerVersion
    ) ?? null
  );
}

/** Resolve an immutable database record without consulting the current offer. */
export function getCreditOfferById(offerId: string): CreditOffer | null {
  return CREDIT_OFFERS.find(offer => offer.offerId === offerId) ?? null;
}

export type StoredCreditOfferSnapshot = Readonly<{
  planCode: string;
  expectedAmount: string;
  currency: string;
  creditCount: number | null;
  mollieDescription: string;
}>;

/** Resolve only an exact server-owned stored snapshot. */
export function getCreditOfferForStoredSnapshot(
  snapshot: StoredCreditOfferSnapshot
): CreditOffer | null {
  const offer = getCreditOfferById(snapshot.planCode);
  if (
    !offer ||
    snapshot.expectedAmount !== offer.amount.value ||
    snapshot.currency !== offer.amount.currency ||
    snapshot.creditCount !== offer.creditCount ||
    snapshot.mollieDescription !== offer.mollieDescription
  ) {
    return null;
  }
  return offer;
}

export function requireCreditOfferSelection(selection: unknown): CreditOffer {
  if (!isExactCreditOfferSelection(selection)) {
    throw new Error("credit offer is unavailable");
  }

  const offer = getCreditOffer(selection.offerId, selection.offerVersion);
  if (!offer) {
    throw new Error("credit offer is unavailable");
  }

  return offer;
}

function isExactCreditOfferSelection(value: unknown): value is {
  offerId: string;
  offerVersion: number;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const keys = Object.keys(value);
  if (
    keys.length !== 2 ||
    !Object.prototype.hasOwnProperty.call(value, "offerId") ||
    !Object.prototype.hasOwnProperty.call(value, "offerVersion")
  ) {
    return false;
  }

  const selection = value as Record<string, unknown>;
  return (
    typeof selection.offerId === "string" &&
    Number.isSafeInteger(selection.offerVersion)
  );
}
