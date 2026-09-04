import { describe, expect, it } from "vitest";

import {
  CREDIT_CHECKOUT_BILLING_POLICY_PATH,
  creditBillingPolicyCopy,
  creditCheckoutModeDisclosure,
  creditCheckoutRefundPolicyDisclosure,
  parseCreditCheckoutOffer,
} from "../client/src/pages/creditCheckoutOffer";

const exactOffer = Object.freeze({
  mode: "test",
  offerId: "premium_images_9_medium_v2",
  offerVersion: 2,
  amount: "5.00",
  currency: "EUR",
  creditCount: 9,
  imageQuality: "medium",
  expires: false,
  automaticRenewal: false,
  refundPolicyId: "premium_image_credit_refund",
  refundPolicyVersion: 2,
});

describe("credit checkout UI contract", () => {
  it("shows the exact versioned refund consequences before confirmation", () => {
    expect(parseCreditCheckoutOffer(exactOffer)).toBe(exactOffer);
    expect(creditCheckoutRefundPolicyDisclosure(exactOffer)).toContain(
      "Terugbetalingsbeleid versie 2"
    );
    expect(creditCheckoutRefundPolicyDisclosure(exactOffer)).toContain(
      "9 gekochte credits verwijderd"
    );
    expect(creditCheckoutRefundPolicyDisclosure(exactOffer)).toContain(
      "gereserveerd of gebruikt"
    );
    expect(creditCheckoutRefundPolicyDisclosure(exactOffer)).toContain(
      "handmatige controle"
    );
    expect(CREDIT_CHECKOUT_BILLING_POLICY_PATH).toBe("/billing-policy");
  });

  it("distinguishes a test checkout from a real payment", () => {
    expect(creditCheckoutModeDisclosure(exactOffer)).toBe(
      "Dit is Mollie Test Mode. Er wordt geen echt geld afgeschreven."
    );
    expect(
      creditCheckoutModeDisclosure({ ...exactOffer, mode: "live" })
    ).toContain("echte betaling van € 5,00");
  });

  it("publishes a version-neutral Dutch refund and consumer-rights policy", () => {
    const policy = [
      creditBillingPolicyCopy.title,
      creditBillingPolicyCopy.intro,
      ...creditBillingPolicyCopy.sections.flatMap(section => [
        section.heading,
        section.body,
      ]),
    ].join("\n");

    expect(policy).toContain("exacte eenmalige prijs");
    expect(policy).toContain("aantal beeldcredits");
    expect(policy).toContain("medium kwaliteit");
    expect(policy).toContain("Mollie Test Mode");
    expect(policy).toContain("schrijft geen echt geld af");
    expect(policy).toContain("met die betaling gekochte credits");
    expect(policy).toContain("terugboeking (chargeback)");
    expect(policy).toContain("handmatige controle");
    expect(policy).toContain("dubbel of technisch fout");
    expect(policy).toContain("wettelijke rechten van Belgische consumenten");
    expect(policy).toContain("geen afstandsverklaring");
    expect(policy).toContain("Finale juridische goedkeuring");
    expect(policy).toContain("geen automatische verlenging");
    expect(policy).toContain("geen abonnement");
    expect(policy).not.toContain("automatische incasso");
    expect(policy).not.toContain("14 dagen");
    expect(policy).not.toContain("€ 5,00");
    expect(policy).not.toContain("negen inbegrepen credits");
  });

  it("keeps an exact historical v1 return session readable", () => {
    const historical = {
      ...exactOffer,
      offerId: "premium_images_8_medium_v1",
      offerVersion: 1,
      amount: "4.99",
      creditCount: 8,
      refundPolicyVersion: 1,
    } as const;
    expect(parseCreditCheckoutOffer(historical)).toBe(historical);
    expect(
      creditCheckoutModeDisclosure({ ...historical, mode: "live" })
    ).toContain("echte betaling van € 4,99");
    expect(creditCheckoutRefundPolicyDisclosure(historical)).toContain(
      "Terugbetalingsbeleid versie 1"
    );
    expect(creditCheckoutRefundPolicyDisclosure(historical)).toContain(
      "8 gekochte credits"
    );
    expect(CREDIT_CHECKOUT_BILLING_POLICY_PATH).toBe("/billing-policy");
    const versionNeutralPolicy = [
      creditBillingPolicyCopy.intro,
      ...creditBillingPolicyCopy.sections.map(section => section.body),
    ].join("\n");
    expect(versionNeutralPolicy).toContain("bundelversie");
    expect(versionNeutralPolicy).not.toContain("€ 5,00");
    expect(versionNeutralPolicy).not.toContain("negen inbegrepen credits");
  });

  it.each([
    { ...exactOffer, refundPolicyId: "other_policy" },
    { ...exactOffer, refundPolicyVersion: 1 },
    Object.fromEntries(
      Object.entries(exactOffer).filter(([key]) => key !== "refundPolicyId")
    ),
    { ...exactOffer, legalApproval: true },
  ])("fails closed for a non-exact refund-policy offer %#", offer => {
    expect(() => parseCreditCheckoutOffer(offer)).toThrow(
      "Invalid checkout offer"
    );
  });
});
