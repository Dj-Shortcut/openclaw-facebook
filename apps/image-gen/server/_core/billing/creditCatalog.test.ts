import { describe, expect, it } from "vitest";

import {
  getCreditOffer,
  listCreditOffers,
  PREMIUM_IMAGE_CREDIT_OFFER_ID,
  PREMIUM_IMAGE_CREDIT_OFFER_VERSION,
  requireCreditOfferSelection,
} from "./creditCatalog";

describe("credit offer catalog", () => {
  it("publishes exactly the fixed one-off pilot offer", () => {
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
        mollieDescription: "Leaderbot - 8 premium beeldcredits",
      },
    ]);
  });

  it("keeps the offer and all nested policy objects immutable", () => {
    const [offer] = listCreditOffers();

    expect(Object.isFrozen(listCreditOffers())).toBe(true);
    expect(Object.isFrozen(offer)).toBe(true);
    expect(Object.isFrozen(offer?.amount)).toBe(true);
    expect(Object.isFrozen(offer?.providerPolicy)).toBe(true);
    expect(Object.isFrozen(offer?.validity)).toBe(true);
    expect(Object.isFrozen(offer?.paymentTerms)).toBe(true);
    expect(Reflect.set(offer!, "amountMinor", 1)).toBe(false);
    expect(offer?.amountMinor).toBe(499);
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
    expect(offer).not.toHaveProperty("interval");
    expect(offer).not.toHaveProperty("subscription");
    expect(offer).not.toHaveProperty("recurringMethod");
  });

  it.each([
    ["", 1],
    ["unknown", 1],
    [PREMIUM_IMAGE_CREDIT_OFFER_ID, 0],
    [PREMIUM_IMAGE_CREDIT_OFFER_ID, 2],
    [PREMIUM_IMAGE_CREDIT_OFFER_ID, Number.NaN],
  ])("rejects unavailable offer %j version %j", (offerId, offerVersion) => {
    expect(getCreditOffer(offerId, offerVersion)).toBeNull();
    expect(() =>
      requireCreditOfferSelection({ offerId, offerVersion })
    ).toThrow("credit offer is unavailable");
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
