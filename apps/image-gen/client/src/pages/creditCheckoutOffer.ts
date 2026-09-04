export type CreditCheckoutOffer = Readonly<{
  mode: "test" | "live";
  offerId: "premium_images_8_medium_v1" | "premium_images_9_medium_v2";
  offerVersion: 1 | 2;
  amount: "4.99" | "5.00";
  currency: "EUR";
  creditCount: 8 | 9;
  imageQuality: "medium";
  expires: false;
  automaticRenewal: false;
  refundPolicyId: "premium_image_credit_refund";
  refundPolicyVersion: 1 | 2;
}>;

export const CREDIT_CHECKOUT_BILLING_POLICY_PATH = "/billing-policy" as const;

export const creditBillingPolicyCopy = {
  title: "Betaling en terugbetaling van premiumcredits",
  intro:
    "Leaderbot biedt één eenmalige bundel premium beeldcredits aan. Je start alleen vanuit een ondertekende checkoutlink in Messenger en bevestigt de bundel eerst op de checkoutpagina.",
  sections: [
    {
      heading: "Eén vaste aankoop",
      body: "De checkout toont de exacte eenmalige prijs, het aantal beeldcredits en de toepasselijke bundelversie. De credits hebben medium kwaliteit en vervallen niet. Dit is geen abonnement: er is geen automatische verlenging, automatische top-up, overage, domiciliëring of andere terugkerende aanrekening.",
    },
    {
      heading: "Test Mode en live betaling",
      body: "Een checkout die duidelijk Mollie Test Mode vermeldt, simuleert de betaling en schrijft geen echt geld af. Alleen een checkout die uitdrukkelijk als echte betaling wordt getoond, kan na je bevestiging de exact getoonde eenmalige prijs aanrekenen.",
    },
    {
      heading: "Volledige terugbetaling en terugboeking",
      body: "Na een volledige terugbetaling die Mollie bevestigt, verwijderen we de met die betaling gekochte credits uit de betaalde balans. Als credits al gereserveerd of gebruikt zijn, of als betaal- of terugbetalingsbewijzen elkaar tegenspreken, pauzeren we premiumgebruik en volgt een handmatige controle. Een terugboeking (chargeback) kan dezelfde veiligheidscontrole starten. De checkout vermeldt vóór bevestiging welke versie van dit beleid geldt.",
    },
    {
      heading: "Dubbele of technische aanrekening",
      body: "Vermoed je dat dezelfde aankoop dubbel of technisch fout is aangerekend, neem dan contact op via privacy@leaderbot.live. Stuur geen bankkaartgegevens, bankgegevens, API-sleutels of andere betaalgeheimen per e-mail.",
    },
    {
      heading: "Belgische consumentenrechten en juridische goedkeuring",
      body: "Deze operationele regels beperken geen dwingende wettelijke rechten van Belgische consumenten. Deze tekst vormt geen afstandsverklaring van het herroepingsrecht en doet geen ongereviewde juridische belofte. Finale juridische goedkeuring van de verkooptekst blijft een afzonderlijke voorwaarde voordat live betalingen worden geactiveerd.",
    },
    {
      heading: "Vóór je bevestigt",
      body: "De checkout toont de exacte totale prijs, het exacte aantal inbegrepen credits, medium kwaliteit, geen vervaldatum, geen abonnement of extra kosten, en het toepasselijke terugbetalingsbeleid met versienummer. Eén succesvol geleverde bruikbare premium generatie of bewerking verbruikt één credit. Een Messengerbericht of het openen van de link rekent nog niets aan.",
    },
  ],
} as const;

const CREDIT_CHECKOUT_OFFER_KEYS = Object.freeze([
  "amount",
  "automaticRenewal",
  "creditCount",
  "currency",
  "expires",
  "imageQuality",
  "mode",
  "offerId",
  "offerVersion",
  "refundPolicyId",
  "refundPolicyVersion",
]);

export function parseCreditCheckoutOffer(value: unknown): CreditCheckoutOffer {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid checkout offer");
  }
  const offer = value as Record<string, unknown>;
  const keys = Object.keys(offer).sort();
  if (
    keys.length !== CREDIT_CHECKOUT_OFFER_KEYS.length ||
    !keys.every((key, index) => key === CREDIT_CHECKOUT_OFFER_KEYS[index]) ||
    (offer.mode !== "test" && offer.mode !== "live") ||
    offer.currency !== "EUR" ||
    offer.imageQuality !== "medium" ||
    offer.expires !== false ||
    offer.automaticRenewal !== false ||
    offer.refundPolicyId !== "premium_image_credit_refund" ||
    !(
      (offer.offerId === "premium_images_8_medium_v1" &&
        offer.offerVersion === 1 &&
        offer.amount === "4.99" &&
        offer.creditCount === 8 &&
        offer.refundPolicyVersion === 1) ||
      (offer.offerId === "premium_images_9_medium_v2" &&
        offer.offerVersion === 2 &&
        offer.amount === "5.00" &&
        offer.creditCount === 9 &&
        offer.refundPolicyVersion === 2)
    )
  ) {
    throw new Error("Invalid checkout offer");
  }
  return offer as CreditCheckoutOffer;
}

export function creditCheckoutRefundPolicyDisclosure(value: unknown): string {
  const offer = parseCreditCheckoutOffer(value);
  return `Terugbetalingsbeleid versie ${offer.refundPolicyVersion}: na een volledige, door Mollie bevestigde terugbetaling worden de ${offer.creditCount} gekochte credits verwijderd. Als credits al gereserveerd of gebruikt zijn, of betaalbewijzen elkaar tegenspreken, pauzeren we premiumgebruik voor handmatige controle.`;
}

export function creditCheckoutModeDisclosure(value: unknown): string {
  const offer = parseCreditCheckoutOffer(value);
  if (offer.mode === "test") {
    return "Dit is Mollie Test Mode. Er wordt geen echt geld afgeschreven.";
  }
  return `Dit is een echte betaling van € ${offer.amount.replace(".", ",")}. Na je bevestiging opent de beveiligde Mollie-checkout.`;
}
