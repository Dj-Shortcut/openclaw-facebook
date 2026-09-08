import { describe, expect, it } from "vitest";
import { landingCopies, unavailablePremiumCopies } from "./landingCopy";
import { parseCreditCheckoutOffer } from "./creditCheckoutOffer";
import { SUPPORTED_LOCALES } from "./portalLocales";

/**
 * The landing page is the only place where the premium bundle is described to
 * the public, and its numbers are copied by hand into three locales. These
 * tests pin those numbers to the checkout offer contract so a copy edit can
 * never advertise a price or bundle size that the checkout does not sell.
 */
const offer = parseCreditCheckoutOffer({
  amount: "4.99",
  automaticRenewal: false,
  creditCount: 8,
  currency: "EUR",
  expires: false,
  imageQuality: "medium",
  mode: "test",
  refundPolicyId: "premium_image_credit_refund",
  refundPolicyVersion: 1,
});

/**
 * Every credit count named anywhere in a piece of copy, as a number.
 *
 * A substring check is not good enough here: `"18 premiumcredits".includes("8")`
 * is true, so a drifted bundle size would sail through. This pulls out the whole
 * integer that introduces a credit word (allowing a few words in between, as in
 * "8 premium image credits") so it can be compared numerically.
 */
const CREDIT_COUNT_PATTERN =
  /(\d+)\s+(?:[\p{L}'\u2019-]+\s+){0,3}(?:beeldcredits|premiumcredits|credits|cr\u00e9dits)/giu;

export function creditCountsIn(text: string): number[] {
  return [...text.matchAll(CREDIT_COUNT_PATTERN)].map(match =>
    Number(match[1])
  );
}

const localisedPrices: Record<string, string[]> = {
  "nl-BE": ["€4,99"],
  "fr-BE": ["4,99 €"],
  en: ["€4.99"],
};

describe("landing page premium bundle copy", () => {
  it("covers every supported locale", () => {
    expect(Object.keys(landingCopies).sort()).toEqual(
      [...SUPPORTED_LOCALES].sort()
    );
    expect(Object.keys(unavailablePremiumCopies).sort()).toEqual(
      [...SUPPORTED_LOCALES].sort()
    );
  });

  for (const locale of SUPPORTED_LOCALES) {
    describe(locale, () => {
      const copy = landingCopies[locale];

      it("shows the offer price from the checkout contract", () => {
        expect(localisedPrices[locale]).toContain(copy.credits.price);
      });

      it("shows the offer credit count in the bundle features", () => {
        const counts = copy.credits.features.flatMap(creditCountsIn);
        expect(counts).not.toHaveLength(0);
        expect(counts.every(count => count === offer.creditCount)).toBe(true);
      });

      it("never names a credit count other than the offer's", () => {
        const counts = creditCountsIn(JSON.stringify(copy));
        expect(counts).not.toHaveLength(0);
        for (const count of counts) {
          expect(count).toBe(offer.creditCount);
        }
      });

      it("never names a price other than the offer's", () => {
        const haystack = JSON.stringify(copy);
        const priceLike = haystack.match(
          /(?:€\s?\d+[.,]\d{2}|\d+[.,]\d{2}\s?€)/g
        );
        for (const price of priceLike ?? []) {
          expect(localisedPrices[locale]).toContain(price);
        }
      });

      it("keeps the one-time, no-subscription promise", () => {
        expect(offer.automaticRenewal).toBe(false);
        const haystack = JSON.stringify(copy).toLowerCase();
        expect(haystack).toMatch(/abonnement|subscription/);
      });

      it("does not advertise a working purchase in the free plan card", () => {
        expect(copy.free.price).toMatch(/0/);
        expect(copy.free.features.join(" ")).not.toMatch(/4[.,]99/);
      });
    });
  }
});

/**
 * Two claims the page must never make, in any locale:
 *
 * 1. An unconfirmed payment does not prove the bank was left untouched, and it
 *    is not safe to invite a second attempt while the first is still open.
 * 2. "No purchase option is shown" only proves that a new purchase cannot be
 *    started here. It does not prove that an already-confirmed or test payment
 *    can no longer add credits.
 */
const forbiddenClaims: Record<string, RegExp[]> = {
  "nl-BE": [
    /niets van je rekening afgeschreven/i,
    /opnieuw proberen via Messenger/i,
    /tot dan blijft alles gratis/i,
    /worden (er )?nog geen premiumcredits toegevoegd/i,
    /betalen is nog niet actief/i,
  ],
  "fr-BE": [
    /rien n'est débité/i,
    /réessayer l'achat/i,
    /tout reste gratuit/i,
    /aucun crédit premium n'est encore ajouté/i,
    /le paiement n'est pas encore actif/i,
  ],
  en: [
    /nothing is charged/i,
    /try the purchase again/i,
    /everything stays free/i,
    /no premium credits are added yet/i,
    /payment is not live yet/i,
  ],
};

const requiredPaymentGuidance: Record<string, RegExp[]> = {
  "nl-BE": [/Mollie de betaling bevestigt/i, /geen tweede betaalpoging/i],
  "fr-BE": [
    /confirmation du paiement par Mollie/i,
    /pas de deuxième tentative de paiement/i,
  ],
  en: [/Mollie confirms the payment/i, /not start a second payment attempt/i],
};

describe("landing page payment-status copy", () => {
  for (const locale of SUPPORTED_LOCALES) {
    describe(locale, () => {
      const haystack = [
        JSON.stringify(landingCopies[locale]),
        JSON.stringify(unavailablePremiumCopies[locale]),
      ].join(" ");

      it("makes no unproven claim about charges or availability", () => {
        for (const pattern of forbiddenClaims[locale]) {
          expect(haystack).not.toMatch(pattern);
        }
      });

      it("tells the reader to wait for a confirmed status", () => {
        for (const pattern of requiredPaymentGuidance[locale]) {
          expect(haystack).toMatch(pattern);
        }
      });

      it("still points at the existing support address", () => {
        expect(haystack).toContain("privacy@leaderbot.live");
      });

      it("scopes the unavailable state to starting a new purchase", () => {
        const unavailable = unavailablePremiumCopies[locale];
        expect(unavailable.creditsCardBody).toMatch(/Mollie/);
        expect(unavailable.badge.length).toBeGreaterThan(0);
      });
    });
  }
});

describe("credit count extraction", () => {
  it("reads the whole number, so 18 is never mistaken for 8", () => {
    expect(creditCountsIn("18 premiumcredits")).toEqual([18]);
    expect(creditCountsIn("8 premium beeldcredits")).toEqual([8]);
    expect(creditCountsIn("8 cr\u00e9dits d'images premium")).toEqual([8]);
    expect(creditCountsIn("8 premium image credits")).toEqual([8]);
  });

  it("rejects a bundle whose credit line drifted to 18", () => {
    const drifted = ["18 premium beeldcredits", "Medium beeldkwaliteit"];
    const counts = drifted.flatMap(creditCountsIn);
    expect(counts).toEqual([18]);
    expect(counts.every(count => count === offer.creditCount)).toBe(false);
  });

  it("catches a credit count buried in prose", () => {
    const counts = creditCountsIn(
      "Die link opent een eenmalige Mollie-checkout van \u20ac4,99 voor 9 premiumcredits."
    );
    expect(counts).toEqual([9]);
    expect(counts[0]).not.toBe(offer.creditCount);
  });
});

/**
 * The free daily allowance is a balance, not a fixed number of images, and the
 * page must not imply otherwise.
 *
 * `server/_core/quotaPolicy.ts` currently defaults to five free images a day
 * (`DEFAULT_IMAGE_GENERATION_DAILY_LIMIT`, asserted in production), and that
 * value is configurable per deployment. So the copy must neither promise a
 * single daily credit — which the English wording used to do — nor pin a
 * number that a configuration change would silently invalidate. These tests
 * deliberately do not assert "five": naming any figure here would create a
 * product promise the frontend cannot keep on its own.
 */
const singularDailyClaims: RegExp[] = [
  /free image credit every day/i,
  /\bdaily free credit\b/i,
  /\bfree daily credit\b/i,
  /\b(a|one) free (image )?credit\b/i,
  /\bone image (a|per) day\b/i,
  /\b(1|one|een|één) gratis beeld(credit)? per dag\b/i,
  /\bun (seul )?cr\u00e9dit gratuit par jour\b/i,
  /\bune (seule )?image gratuite par jour\b/i,
];

const dailyWord: Record<string, RegExp> = {
  "nl-BE": /\bdag\b|\bdagelijks|\bdagtegoed\b/i,
  "fr-BE": /\bjour\b|quotidien/i,
  en: /\bday\b|\bdaily\b/i,
};

describe("landing page free daily allowance copy", () => {
  for (const locale of SUPPORTED_LOCALES) {
    describe(locale, () => {
      const copy = landingCopies[locale];
      const unavailable = unavailablePremiumCopies[locale];

      // Everything that describes the free allowance. The premium FAQ answer is
      // excluded on purpose: it legitimately names the bundle price and size.
      const allowanceCopy = [
        copy.microLine,
        unavailable.microLine,
        copy.pricingBody,
        copy.free.suffix,
        ...copy.free.features,
        copy.credits.note,
        unavailable.note,
        copy.closing.body,
      ].join(" ");

      it("never claims a single free image per day", () => {
        const haystack = [
          JSON.stringify(copy),
          JSON.stringify(unavailable),
        ].join(" ");
        for (const pattern of singularDailyClaims) {
          expect(haystack).not.toMatch(pattern);
        }
      });

      it("names no exact free daily quantity", () => {
        expect(allowanceCopy).not.toMatch(/\d/);
      });

      it("still says the allowance returns every day", () => {
        expect(allowanceCopy).toMatch(dailyWord[locale]);
      });
    });
  }
});
