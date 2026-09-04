import { describe, expect, it } from "vitest";

import {
  getCreditOffer,
  getCreditOfferForStoredSnapshot,
  LEGACY_PREMIUM_IMAGE_CREDIT_OFFER_ID,
  LEGACY_PREMIUM_IMAGE_CREDIT_OFFER_VERSION,
  listCreditOffers,
  PREMIUM_IMAGE_CREDIT_OFFER_ID,
  PREMIUM_IMAGE_CREDIT_OFFER_VERSION,
  requireCreditOfferSelection,
} from "./creditCatalog";

describe("credit offer catalog", () => {
  it("keeps v1 immutable and publishes v2 as the current one-off offer", () => {
    expect(listCreditOffers()).toEqual([
      {
        offerId: "premium_images_8_medium_v1",
        offerVersion: 1,
        purchaseKind: "credit_purchase",
        publicName: "8 premium beeldcredits",
        amountMinor: 499,
        amount: { currency: "EUR", value: "4.99" },
        creditCount: 8,
        creditUnit: "premium_image",
        providerPolicy: { imageQuality: "medium" },
        validity: { expires: false, expiresAfterDays: null },
        paymentTerms: {
          kind: "one_time",
          automaticRenewal: false,
          mandateRequired: false,
          automaticTopUp: false,
          overageAllowed: false,
        },
        refundPolicyId: "premium_image_credit_refund",
        refundPolicyVersion: 1,
        mollieDescription: "Leaderbot - 8 premium beeldcredits",
      },
      {
        offerId: "premium_images_9_medium_v2",
        offerVersion: 2,
        purchaseKind: "credit_purchase",
        publicName: "9 premium beeldcredits",
        amountMinor: 500,
        amount: { currency: "EUR", value: "5.00" },
        creditCount: 9,
        creditUnit: "premium_image",
        providerPolicy: { imageQuality: "medium" },
        validity: { expires: false, expiresAfterDays: null },
        paymentTerms: {
          kind: "one_time",
          automaticRenewal: false,
          mandateRequired: false,
          automaticTopUp: false,
          overageAllowed: false,
        },
        refundPolicyId: "premium_image_credit_refund",
        refundPolicyVersion: 2,
        mollieDescription: "Leaderbot - 9 premium beeldcredits",
      },
    ]);
  });

  it("keeps the offer and all nested policy objects immutable", () => {
    const [legacyOffer, currentOffer] = listCreditOffers();

    expect(Object.isFrozen(listCreditOffers())).toBe(true);
    for (const offer of [legacyOffer, currentOffer]) {
      expect(Object.isFrozen(offer)).toBe(true);
      expect(Object.isFrozen(offer?.amount)).toBe(true);
      expect(Object.isFrozen(offer?.providerPolicy)).toBe(true);
      expect(Object.isFrozen(offer?.validity)).toBe(true);
      expect(Object.isFrozen(offer?.paymentTerms)).toBe(true);
    }
    expect(Reflect.set(legacyOffer!, "amountMinor", 1)).toBe(false);
    expect(legacyOffer?.amountMinor).toBe(499);
    expect(currentOffer?.amountMinor).toBe(500);
  });

  it("contains no recurring, subscription, mandate or expiry contract", () => {
    const offer = requireCreditOfferSelection({
      offerId: PREMIUM_IMAGE_CREDIT_OFFER_ID,
      offerVersion: PREMIUM_IMAGE_CREDIT_OFFER_VERSION,
    });

    expect(offer.paymentTerms).toEqual({
      kind: "one_time",
      automaticRenewal: false,
      mandateRequired: false,
      automaticTopUp: false,
      overageAllowed: false,
    });
    expect(offer.validity).toEqual({ expires: false, expiresAfterDays: null });
    expect(offer).toMatchObject({
      refundPolicyId: "premium_image_credit_refund",
      refundPolicyVersion: 2,
    });
    expect(offer).not.toHaveProperty("interval");
    expect(offer).not.toHaveProperty("subscription");
    expect(offer).not.toHaveProperty("recurringMethod");
  });

  it.each([
    ["", 1],
    ["unknown", 1],
    [PREMIUM_IMAGE_CREDIT_OFFER_ID, 0],
    [PREMIUM_IMAGE_CREDIT_OFFER_ID, 1],
    [PREMIUM_IMAGE_CREDIT_OFFER_ID, Number.NaN],
  ])("rejects unavailable offer %j version %j", (offerId, offerVersion) => {
    expect(getCreditOffer(offerId, offerVersion)).toBeNull();
    expect(() =>
      requireCreditOfferSelection({ offerId, offerVersion })
    ).toThrow("credit offer is unavailable");
  });

  it("resolves historical records only from their exact stored snapshot", () => {
    expect(
      getCreditOfferForStoredSnapshot({
        planCode: LEGACY_PREMIUM_IMAGE_CREDIT_OFFER_ID,
        expectedAmount: "4.99",
        currency: "EUR",
        creditCount: 8,
        mollieDescription: "Leaderbot - 8 premium beeldcredits",
      })
    ).toMatchObject({
      offerVersion: LEGACY_PREMIUM_IMAGE_CREDIT_OFFER_VERSION,
      refundPolicyVersion: 1,
    });
    expect(
      getCreditOfferForStoredSnapshot({
        planCode: LEGACY_PREMIUM_IMAGE_CREDIT_OFFER_ID,
        expectedAmount: "5.00",
        currency: "EUR",
        creditCount: 8,
        mollieDescription: "Leaderbot - 8 premium beeldcredits",
      })
    ).toBeNull();
  });

  it.each([
    null,
    [],
    PREMIUM_IMAGE_CREDIT_OFFER_ID,
    { offerId: PREMIUM_IMAGE_CREDIT_OFFER_ID },
    {
      offerId: PREMIUM_IMAGE_CREDIT_OFFER_ID,
      offerVersion: PREMIUM_IMAGE_CREDIT_OFFER_VERSION,
      amountMinor: 1,
    },
    {
      offerId: PREMIUM_IMAGE_CREDIT_OFFER_ID,
      offerVersion: PREMIUM_IMAGE_CREDIT_OFFER_VERSION,
      creditCount: 8_000,
    },
    {
      offerId: PREMIUM_IMAGE_CREDIT_OFFER_ID,
      offerVersion: String(PREMIUM_IMAGE_CREDIT_OFFER_VERSION),
    },
  ])("rejects forged selection %j", selection => {
    expect(() => requireCreditOfferSelection(selection)).toThrow(
      "credit offer is unavailable"
    );
  });
});
