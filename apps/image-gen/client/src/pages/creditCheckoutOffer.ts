export type CreditCheckoutOffer = Readonly<{
  mode: "test" | "live";
  amount: "4.99";
  currency: "EUR";
  creditCount: 8;
  imageQuality: "medium";
  expires: false;
  automaticRenewal: false;
  refundPolicyId: "premium_image_credit_refund";
  refundPolicyVersion: 1;
}>;

export const CREDIT_CHECKOUT_BILLING_POLICY_PATH = "/billing-policy" as const;

export const creditBillingPolicyCopy = {
  title: "Betaling en terugbetaling van premiumcredits",
  intro:
    "Leaderbot biedt één eenmalige bundel premium beeldcredits aan. Je start alleen vanuit een ondertekende checkoutlink in Messenger en bevestigt de bundel eerst op de checkoutpagina.",
  sections: [
    {
      heading: "Eén vaste aankoop",
      body: "De bundel kost € 4,99 en voegt acht beeldcredits in medium kwaliteit toe. De credits vervallen niet. Dit is geen abonnement: er is geen automatische verlenging, automatische top-up, overage, domiciliëring of andere terugkerende aanrekening.",
    },
    {
      heading: "Test Mode en live betaling",
      body: "Een checkout die duidelijk Mollie Test Mode vermeldt, simuleert de betaling en schrijft geen echt geld af. Alleen een checkout die uitdrukkelijk als echte betaling wordt getoond, kan na je bevestiging een echte betaling van € 4,99 starten.",
    },
    {
      heading: "Volledige terugbetaling en terugboeking",
      body: "Na een volledige terugbetaling die Mollie bevestigt, verwijderen we de acht met die betaling gekochte credits uit de betaalde balans. Als credits al gereserveerd of gebruikt zijn, of als betaal- of terugbetalingsbewijzen elkaar tegenspreken, pauzeren we premiumgebruik en volgt een handmatige controle. Een terugboeking (chargeback) kan dezelfde veiligheidscontrole starten.",
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
      body: "De checkout toont de totale prijs van € 4,99, de acht inbegrepen credits, medium kwaliteit, geen vervaldatum, geen abonnement of extra kosten, en het toepasselijke terugbetalingsbeleid. Een Messengerbericht of het openen van de link rekent nog niets aan.",
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
    offer.amount !== "4.99" ||
    offer.currency !== "EUR" ||
    offer.creditCount !== 8 ||
    offer.imageQuality !== "medium" ||
    offer.expires !== false ||
    offer.automaticRenewal !== false ||
    offer.refundPolicyId !== "premium_image_credit_refund" ||
    offer.refundPolicyVersion !== 1
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
