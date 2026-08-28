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
  amount: "4.99",
  currency: "EUR",
  creditCount: 8,
  imageQuality: "medium",
  expires: false,
  automaticRenewal: false,
  refundPolicyId: "premium_image_credit_refund",
  refundPolicyVersion: 1,
});

describe("credit checkout UI contract", () => {
  it("shows the exact versioned refund consequences before confirmation", () => {
    expect(parseCreditCheckoutOffer(exactOffer)).toBe(exactOffer);
    expect(creditCheckoutRefundPolicyDisclosure(exactOffer)).toContain(
      "Terugbetalingsbeleid versie 1"
    );
    expect(creditCheckoutRefundPolicyDisclosure(exactOffer)).toContain(
      "8 gekochte credits verwijderd"
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
    ).toContain("echte betaling van € 4,99");
  });

  it("publishes the bounded Dutch refund and consumer-rights policy", () => {
    const policy = [
      creditBillingPolicyCopy.title,
      creditBillingPolicyCopy.intro,
      ...creditBillingPolicyCopy.sections.flatMap(section => [
        section.heading,
        section.body,
      ]),
    ].join("\n");

    expect(policy).toContain("€ 4,99");
    expect(policy).toContain("acht beeldcredits in medium kwaliteit");
    expect(policy).toContain("Mollie Test Mode");
    expect(policy).toContain("schrijft geen echt geld af");
    expect(policy).toContain("verwijderen we de acht");
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
  });

  it.each([
    { ...exactOffer, refundPolicyId: "other_policy" },
    { ...exactOffer, refundPolicyVersion: 2 },
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
