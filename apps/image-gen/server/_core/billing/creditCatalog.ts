export const PREMIUM_IMAGE_CREDIT_OFFER_ID =
  "premium_images_8_medium_v1" as const;
export const PREMIUM_IMAGE_CREDIT_OFFER_VERSION = 1 as const;
export const PREMIUM_IMAGE_CREDIT_REFUND_POLICY_ID =
  "premium_image_credit_refund" as const;
export const PREMIUM_IMAGE_CREDIT_REFUND_POLICY_VERSION = 1 as const;

export type CreditOffer = Readonly<{
  offerId: typeof PREMIUM_IMAGE_CREDIT_OFFER_ID;
  offerVersion: typeof PREMIUM_IMAGE_CREDIT_OFFER_VERSION;
  purchaseKind: "credit_purchase";
  publicName: string;
  amountMinor: number;
  amount: Readonly<{
    currency: "EUR";
    value: "4.99";
  }>;
  creditCount: 8;
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
  refundPolicyVersion: typeof PREMIUM_IMAGE_CREDIT_REFUND_POLICY_VERSION;
  mollieDescription: string;
}>;

/**
 * Server-owned credit offer for the first bounded Mollie Test Mode pilot.
 *
 * Callers may select only the immutable offer ID and version. Price, credit
 * quantity, quality and payment terms always come from this catalog.
 */
const PREMIUM_IMAGE_CREDIT_OFFER = Object.freeze({
  offerId: PREMIUM_IMAGE_CREDIT_OFFER_ID,
  offerVersion: PREMIUM_IMAGE_CREDIT_OFFER_VERSION,
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
  refundPolicyVersion: PREMIUM_IMAGE_CREDIT_REFUND_POLICY_VERSION,
  mollieDescription: "Leaderbot - 8 premium beeldcredits",
}) satisfies CreditOffer;

const CREDIT_OFFERS = Object.freeze([PREMIUM_IMAGE_CREDIT_OFFER]);

export function listCreditOffers(): readonly CreditOffer[] {
  return CREDIT_OFFERS;
}

export function getCreditOffer(
  offerId: string,
  offerVersion: number
): CreditOffer | null {
  if (
    offerId !== PREMIUM_IMAGE_CREDIT_OFFER_ID ||
    offerVersion !== PREMIUM_IMAGE_CREDIT_OFFER_VERSION
  ) {
    return null;
  }

  return PREMIUM_IMAGE_CREDIT_OFFER;
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
