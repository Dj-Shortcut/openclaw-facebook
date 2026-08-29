import { getLoginUrl } from "@/const";
import {
  PUBLIC_BUSINESS_DETAILS,
  formatPublicBusinessAddress,
} from "@shared/publicBusinessDetails";
import {
  ArrowRight,
  Check,
  Images,
  Lock,
  Mail,
  MessageCircle,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wand2,
} from "lucide-react";
import { SUPPORTED_LOCALES, type AppLocale } from "./portalLocales";

type LandingCopy = {
  languageLabel: string;
  interestSubject: string;
  nav: {
    product: string;
    howItWorks: string;
    pricing: string;
    faq: string;
    admin: string;
  };
  eyebrow: string;
  title: string;
  body: string;
  primaryCta: string;
  secondaryCta: string;
  noPayment: string;
  previewLabel: string;
  previewPrompt: string;
  previewReply: string;
  previewReady: string;
  trustItems: string[];
  productEyebrow: string;
  productTitle: string;
  productBody: string;
  features: Array<{ title: string; body: string }>;
  howEyebrow: string;
  howTitle: string;
  steps: Array<{ title: string; body: string }>;
  pricingEyebrow: string;
  pricingTitle: string;
  pricingBody: string;
  free: {
    name: string;
    price: string;
    suffix: string;
    body: string;
    features: string[];
    cta: string;
  };
  credits: {
    label: string;
    name: string;
    price: string;
    suffix: string;
    body: string;
    features: string[];
    cta: string;
  };
  pricingDisclosure: string;
  faqEyebrow: string;
  faqTitle: string;
  questions: Array<{ question: string; answer: string }>;
  contactEyebrow: string;
  contactTitle: string;
  contactBody: string;
  contactCta: string;
  companyTitle: string;
  enterpriseLabel: string;
  vatLabel: string;
  addressLabel: string;
  phoneLabel: string;
  emailLabel: string;
  loginUnavailable: string;
};

const landingCopies: Record<AppLocale, LandingCopy> = {
  "nl-BE": {
    languageLabel: "Taal",
    interestSubject: "Vraag over Leaderbot",
    nav: {
      product: "Wat Leaderbot doet",
      howItWorks: "Hoe het werkt",
      pricing: "Gratis & credits",
      faq: "Vragen",
      admin: "Beheerder",
    },
    eyebrow: "AI-beelden in Facebook Messenger",
    title: "Typ een zin. Krijg een beeld. Rechtstreeks in Messenger.",
    body: "Leaderbot is één Facebook-bot die AI-beelden maakt en bewerkt terwijl je gewoon verder chat. Geen account, geen app — stuur een bericht en je hebt elke dag gratis beelden.",
    primaryCta: "Chat nu met Leaderbot",
    secondaryCta: "Bekijk hoe het werkt",
    noPayment:
      "5 gratis beelden per dag, tot 20 per maand. Loop je tegen de limiet aan, dan stuurt Leaderbot je zelf een veilige eenmalige aankooplink — geen abonnement.",
    previewLabel: "Voorbeeldgesprek",
    previewPrompt: "Maak een helder zomerbeeld met citrusfruit en zon.",
    previewReply: "Komt eraan — even geduld.",
    previewReady: "Beeld klaar · 1 van je 5 gratis beelden vandaag",
    trustItems: [
      "5 gratis beelden per dag",
      "Eenmalig €4,99 voor 8 extra credits, geen vervaldatum",
      "Vraag verwijdering van je gegevens wanneer je wil",
    ],
    productEyebrow: "Eén bot, gemaakt om te chatten",
    productTitle: "Alles gebeurt in het gesprek zelf.",
    productBody:
      "Geen dashboard nodig om een beeld te maken. Typ wat je wil, stuur een foto om te bewerken, en Leaderbot antwoordt met het resultaat — net als elk ander Messenger-gesprek.",
    features: [
      {
        title: "Tekst naar beeld",
        body: "Beschrijf wat je wil zien en krijg een AI-beeld terug in de chat.",
      },
      {
        title: "Foto's bewerken",
        body: "Stuur een eigen foto en laat Leaderbot ze aanpassen op jouw vraag.",
      },
      {
        title: "Meerdere foto's combineren",
        body: "Voeg foto's samen tot één nieuw beeld.",
      },
      {
        title: "Duidelijke dagquota",
        body: "Je ziet altijd hoeveel gratis beelden je vandaag nog hebt.",
      },
      {
        title: "Eenmalige credits",
        body: "Nood aan meer? Eén vaste aankoop van €4,99 voor 8 extra beelden, zonder abonnement.",
      },
      {
        title: "Verwijdering op aanvraag",
        body: "Vraag je gegevens te wissen wanneer je maar wil, rechtstreeks vanuit Messenger.",
      },
    ],
    howEyebrow: "Zo simpel is het",
    howTitle: "Van bericht naar beeld in drie stappen.",
    steps: [
      {
        title: "Stuur een bericht",
        body: "Open Messenger en zeg gewoon wat je wil maken of bewerken.",
      },
      {
        title: "Leaderbot maakt het beeld",
        body: "Binnen enkele seconden krijg je het resultaat terug in de chat.",
      },
      {
        title: "Gratis op? Ga verder",
        body: "Zijn je vijf gratis beelden op, dan stuurt de bot een eenmalige aankooplink voor 8 extra credits.",
      },
    ],
    pricingEyebrow: "Gratis om te starten",
    pricingTitle: "Elke dag gratis beelden, bijkopen kan wanneer je wil.",
    pricingBody:
      "Geen abonnement, geen automatische verlenging. Je betaalt alleen als je zelf kiest om bij te kopen.",
    free: {
      name: "Dagelijks gratis",
      price: "€0",
      suffix: "elke dag opnieuw",
      body: "5 beelden per dag, tot 20 per maand. Geen kaart nodig om te starten.",
      features: [
        "5 gratis beelden per dag",
        "Tot 20 per maand",
        "Tekst-naar-beeld en foto-bewerking",
        "Geen account nodig",
      ],
      cta: "Start gratis op Messenger",
    },
    credits: {
      label: "Als je gratis limiet op is",
      name: "Extra credit-bundel",
      price: "€4,99",
      suffix: "eenmalig, geen vervaldatum",
      body: "8 extra beelden in medium kwaliteit. Je krijgt de aankooplink rechtstreeks van Leaderbot in de chat.",
      features: [
        "8 extra beelden",
        "Credits vervallen niet",
        "Geen abonnement of automatische verlenging",
        "Betaling veilig via Mollie",
      ],
      cta: "Chat met Leaderbot om te kopen",
    },
    pricingDisclosure:
      "€4,99 is de vaste, eenmalige prijs voor 8 extra beelden in medium kwaliteit. Een aankoop start nooit via deze website: de link komt van Leaderbot zelf in Messenger, en je bevestigt het bedrag altijd eerst op de beveiligde Mollie-pagina.",
    faqEyebrow: "Veelgestelde vragen",
    faqTitle: "Duidelijk vóór je begint.",
    questions: [
      {
        question: "Moet ik een account maken?",
        answer:
          "Nee. Je hebt alleen Facebook Messenger nodig. Er is geen aparte app of inlog om te starten.",
      },
      {
        question: "Wat gebeurt er als mijn gratis limiet op is?",
        answer:
          "Leaderbot laat het weten en stuurt je een eenmalige aankooplink voor 8 extra beelden van €4,99. Er is geen automatische top-up en geen verborgen kost.",
      },
      {
        question: "Is dit een abonnement?",
        answer:
          "Nee. De €4,99-bundel is een eenmalige aankoop. Er is geen verlenging, geen domiciliëring en geen doorlopende betaling.",
      },
      {
        question: "Is Leaderbot onderdeel van Meta of Facebook?",
        answer:
          "Nee. Leaderbot is een onafhankelijke dienst; Messenger en de platformregels blijven beheerd door Meta.",
      },
      {
        question: "Kan ik mijn gegevens laten verwijderen?",
        answer:
          "Ja, op elk moment. Vraag het rechtstreeks in Messenger en Leaderbot verwijdert je gegevens volgens het privacybeleid.",
      },
    ],
    contactEyebrow: "Vraag vooraf?",
    contactTitle: "Iets niet duidelijk voor je begint?",
    contactBody:
      "Stuur ons gerust een vraag. Een bericht hier start nooit automatisch een aankoop.",
    contactCta: "Stuur je vraag",
    companyTitle: "Bedrijfsgegevens",
    enterpriseLabel: "Ondernemingsnummer",
    vatLabel: "Btw-nummer",
    addressLabel: "Adres",
    phoneLabel: "Telefoon",
    emailLabel: "E-mail",
    loginUnavailable: "Aanmelden is in deze omgeving nog niet ingesteld.",
  },
  "fr-BE": {
    languageLabel: "Langue",
    interestSubject: "Question sur Leaderbot",
    nav: {
      product: "Ce que fait Leaderbot",
      howItWorks: "Fonctionnement",
      pricing: "Gratuit et crédits",
      faq: "Questions",
      admin: "Administrateur",
    },
    eyebrow: "Images IA dans Facebook Messenger",
    title: "Tapez une phrase. Recevez une image. Directement dans Messenger.",
    body: "Leaderbot est un bot Facebook qui crée et modifie des images IA pendant que vous discutez. Pas de compte, pas d'application — envoyez un message et recevez des images gratuites chaque jour.",
    primaryCta: "Discuter avec Leaderbot",
    secondaryCta: "Voir comment ça marche",
    noPayment:
      "5 images gratuites par jour, jusqu'à 20 par mois. Si vous atteignez la limite, Leaderbot vous envoie lui-même un lien d'achat unique sécurisé — sans abonnement.",
    previewLabel: "Exemple de conversation",
    previewPrompt: "Crée une image d'été lumineuse avec des agrumes et du soleil.",
    previewReply: "C'est parti — un instant.",
    previewReady: "Image prête · 1 de vos 5 images gratuites aujourd'hui",
    trustItems: [
      "5 images gratuites chaque jour",
      "4,99 € une fois pour 8 crédits supplémentaires, sans expiration",
      "Demandez la suppression de vos données à tout moment",
    ],
    productEyebrow: "Un bot pensé pour discuter",
    productTitle: "Tout se passe dans la conversation.",
    productBody:
      "Pas besoin de tableau de bord. Décrivez ce que vous voulez, envoyez une photo à modifier, et Leaderbot répond avec le résultat — comme une conversation Messenger normale.",
    features: [
      {
        title: "Texte vers image",
        body: "Décrivez ce que vous voulez voir et recevez une image IA dans le chat.",
      },
      {
        title: "Modifier des photos",
        body: "Envoyez votre propre photo et laissez Leaderbot l'adapter à votre demande.",
      },
      {
        title: "Combiner plusieurs photos",
        body: "Assemblez plusieurs photos en une nouvelle image.",
      },
      {
        title: "Quota journalier clair",
        body: "Vous voyez toujours combien d'images gratuites il vous reste aujourd'hui.",
      },
      {
        title: "Crédits à l'achat unique",
        body: "Besoin de plus ? Un achat fixe de 4,99 € pour 8 images supplémentaires, sans abonnement.",
      },
      {
        title: "Suppression sur demande",
        body: "Demandez la suppression de vos données à tout moment, directement dans Messenger.",
      },
    ],
    howEyebrow: "C'est aussi simple que ça",
    howTitle: "Du message à l'image en trois étapes.",
    steps: [
      {
        title: "Envoyez un message",
        body: "Ouvrez Messenger et dites simplement ce que vous voulez créer ou modifier.",
      },
      {
        title: "Leaderbot crée l'image",
        body: "Vous recevez le résultat dans le chat en quelques secondes.",
      },
      {
        title: "Gratuit épuisé ? Continuez",
        body: "Vos cinq images gratuites sont épuisées ? Le bot envoie un lien d'achat unique pour 8 crédits supplémentaires.",
      },
    ],
    pricingEyebrow: "Gratuit pour commencer",
    pricingTitle: "Des images gratuites chaque jour, achetez-en plus quand vous voulez.",
    pricingBody:
      "Pas d'abonnement, pas de renouvellement automatique. Vous ne payez que si vous choisissez d'acheter plus.",
    free: {
      name: "Gratuit chaque jour",
      price: "0 €",
      suffix: "renouvelé chaque jour",
      body: "5 images par jour, jusqu'à 20 par mois. Aucune carte requise pour commencer.",
      features: [
        "5 images gratuites par jour",
        "Jusqu'à 20 par mois",
        "Texte vers image et retouche photo",
        "Aucun compte requis",
      ],
      cta: "Commencer gratuitement sur Messenger",
    },
    credits: {
      label: "Quand votre gratuit est épuisé",
      name: "Pack de crédits supplémentaires",
      price: "4,99 €",
      suffix: "une fois, sans expiration",
      body: "8 images supplémentaires en qualité medium. Le lien d'achat vous est envoyé directement par Leaderbot dans le chat.",
      features: [
        "8 images supplémentaires",
        "Les crédits n'expirent pas",
        "Pas d'abonnement ni de renouvellement",
        "Paiement sécurisé via Mollie",
      ],
      cta: "Discuter avec Leaderbot pour acheter",
    },
    pricingDisclosure:
      "4,99 € est le prix fixe et unique pour 8 images supplémentaires en qualité medium. Un achat ne démarre jamais depuis ce site : le lien vient de Leaderbot dans Messenger, et vous confirmez toujours le montant sur la page Mollie sécurisée.",
    faqEyebrow: "Questions fréquentes",
    faqTitle: "Tout savoir avant de commencer.",
    questions: [
      {
        question: "Dois-je créer un compte ?",
        answer:
          "Non. Il vous faut seulement Facebook Messenger. Aucune application ni connexion séparée n'est nécessaire pour commencer.",
      },
      {
        question: "Que se passe-t-il quand mon gratuit est épuisé ?",
        answer:
          "Leaderbot vous prévient et envoie un lien d'achat unique pour 8 images supplémentaires à 4,99 €. Aucune recharge automatique ni frais caché.",
      },
      {
        question: "Est-ce un abonnement ?",
        answer:
          "Non. Le pack à 4,99 € est un achat unique. Pas de renouvellement, pas de prélèvement, pas de paiement récurrent.",
      },
      {
        question: "Leaderbot fait-il partie de Meta ou Facebook ?",
        answer:
          "Non. Leaderbot est un service indépendant ; Messenger et ses règles restent gérés par Meta.",
      },
      {
        question: "Puis-je faire supprimer mes données ?",
        answer:
          "Oui, à tout moment. Demandez-le directement dans Messenger et Leaderbot supprime vos données selon la politique de confidentialité.",
      },
    ],
    contactEyebrow: "Une question avant de commencer ?",
    contactTitle: "Quelque chose n'est pas clair ?",
    contactBody:
      "Envoyez-nous votre question. Un message ici ne déclenche jamais d'achat automatique.",
    contactCta: "Envoyer ma question",
    companyTitle: "Informations d'entreprise",
    enterpriseLabel: "Numéro d'entreprise",
    vatLabel: "Numéro de TVA",
    addressLabel: "Adresse",
    phoneLabel: "Téléphone",
    emailLabel: "E-mail",
    loginUnavailable:
      "La connexion n'est pas configurée dans cet environnement.",
  },
  en: {
    languageLabel: "Language",
    interestSubject: "Question about Leaderbot",
    nav: {
      product: "What Leaderbot does",
      howItWorks: "How it works",
      pricing: "Free & credits",
      faq: "FAQ",
      admin: "Admin",
    },
    eyebrow: "AI images inside Facebook Messenger",
    title: "Type a sentence. Get an image. Right inside Messenger.",
    body: "Leaderbot is one Facebook bot that creates and edits AI images while you chat. No account, no app — just send a message and get free images every day.",
    primaryCta: "Chat with Leaderbot",
    secondaryCta: "See how it works",
    noPayment:
      "5 free images a day, up to 20 a month. Hit the limit and Leaderbot itself sends you a secure one-time purchase link — no subscription.",
    previewLabel: "Example conversation",
    previewPrompt: "Make a bright summer image with citrus fruit and sunshine.",
    previewReply: "On it — one moment.",
    previewReady: "Image ready · 1 of your 5 free images today",
    trustItems: [
      "5 free images every day",
      "One-time €4.99 for 8 extra credits, no expiry",
      "Ask for your data to be deleted anytime",
    ],
    productEyebrow: "One bot, built for chatting",
    productTitle: "Everything happens inside the conversation.",
    productBody:
      "No dashboard needed to make an image. Describe what you want, send a photo to edit, and Leaderbot replies with the result — like any normal Messenger chat.",
    features: [
      {
        title: "Text to image",
        body: "Describe what you want to see and get an AI image back in the chat.",
      },
      {
        title: "Edit your photos",
        body: "Send your own photo and let Leaderbot adjust it to your request.",
      },
      {
        title: "Combine multiple photos",
        body: "Merge several photos into one new image.",
      },
      {
        title: "Clear daily quota",
        body: "You always see how many free images you have left today.",
      },
      {
        title: "One-time credits",
        body: "Need more? One fixed €4.99 purchase for 8 extra images, no subscription.",
      },
      {
        title: "Deletion on request",
        body: "Ask for your data to be deleted anytime, right inside Messenger.",
      },
    ],
    howEyebrow: "It's this simple",
    howTitle: "From message to image in three steps.",
    steps: [
      {
        title: "Send a message",
        body: "Open Messenger and just say what you want to create or edit.",
      },
      {
        title: "Leaderbot makes the image",
        body: "You get the result back in the chat within seconds.",
      },
      {
        title: "Out of free? Keep going",
        body: "Used your five free images? The bot sends a one-time purchase link for 8 extra credits.",
      },
    ],
    pricingEyebrow: "Free to start",
    pricingTitle: "Free images every day, top up whenever you want.",
    pricingBody:
      "No subscription, no automatic renewal. You only pay if you choose to buy more.",
    free: {
      name: "Free every day",
      price: "€0",
      suffix: "resets daily",
      body: "5 images a day, up to 20 a month. No card needed to start.",
      features: [
        "5 free images a day",
        "Up to 20 a month",
        "Text-to-image and photo editing",
        "No account required",
      ],
      cta: "Start free on Messenger",
    },
    credits: {
      label: "When your free limit is used up",
      name: "Extra credit pack",
      price: "€4.99",
      suffix: "one-time, no expiry",
      body: "8 extra images in medium quality. Leaderbot sends you the purchase link directly in the chat.",
      features: [
        "8 extra images",
        "Credits never expire",
        "No subscription or renewal",
        "Secure payment via Mollie",
      ],
      cta: "Chat with Leaderbot to buy",
    },
    pricingDisclosure:
      "€4.99 is the fixed, one-time price for 8 extra images in medium quality. A purchase never starts on this website: the link comes from Leaderbot itself in Messenger, and you always confirm the amount on the secure Mollie page first.",
    faqEyebrow: "Frequently asked questions",
    faqTitle: "Clear before you begin.",
    questions: [
      {
        question: "Do I need to create an account?",
        answer:
          "No. All you need is Facebook Messenger. There's no separate app or login to get started.",
      },
      {
        question: "What happens when my free limit runs out?",
        answer:
          "Leaderbot lets you know and sends a one-time purchase link for 8 extra images at €4.99. There's no automatic top-up and no hidden cost.",
      },
      {
        question: "Is this a subscription?",
        answer:
          "No. The €4.99 pack is a one-time purchase. There's no renewal, no direct debit and no recurring charge.",
      },
      {
        question: "Is Leaderbot part of Meta or Facebook?",
        answer:
          "No. Leaderbot is an independent service; Messenger and its platform rules stay managed by Meta.",
      },
      {
        question: "Can I have my data deleted?",
        answer:
          "Yes, anytime. Ask directly in Messenger and Leaderbot deletes your data according to the privacy policy.",
      },
    ],
    contactEyebrow: "Questions before you start?",
    contactTitle: "Something not clear yet?",
    contactBody:
      "Send us your question. A message here never triggers a purchase automatically.",
    contactCta: "Send your question",
    companyTitle: "Business information",
    enterpriseLabel: "Enterprise number",
    vatLabel: "VAT number",
    addressLabel: "Address",
    phoneLabel: "Phone",
    emailLabel: "Email",
    loginUnavailable: "Sign-in is not configured in this environment.",
  },
};

const commercialUnavailableCopies: Record<
  AppLocale,
  Pick<LandingCopy, "noPayment" | "pricingDisclosure"> & {
    creditsLabel: string;
    creditsCta: string;
    firstFaqAnswer: string;
  }
> = {
  "nl-BE": {
    noPayment:
      "Je kan nu al gratis chatten met Leaderbot op Messenger. De eenmalige creditaankoop verschijnt zodra de beveiligde Mollie-testfase live is.",
    creditsLabel: "Nog niet beschikbaar",
    creditsCta: "Chat gratis op Messenger",
    pricingDisclosure:
      "€4,99 is de geplande eenmalige prijs voor 8 extra beelden. Er verschijnt pas een aankooplink zodra de beveiligde betaalroute live is.",
    firstFaqAnswer:
      "Nog niet. Chat nu al gratis met Leaderbot; de eenmalige aankoop verschijnt zodra de beveiligde Mollie-testfase live is.",
  },
  "fr-BE": {
    noPayment:
      "Vous pouvez déjà discuter gratuitement avec Leaderbot sur Messenger. L'achat unique de crédits apparaîtra dès que la phase de test Mollie sécurisée sera active.",
    creditsLabel: "Pas encore disponible",
    creditsCta: "Discuter gratuitement sur Messenger",
    pricingDisclosure:
      "4,99 € est le prix unique prévu pour 8 images supplémentaires. Un lien d'achat n'apparaîtra que lorsque le parcours de paiement sécurisé sera actif.",
    firstFaqAnswer:
      "Pas encore. Discutez dès maintenant gratuitement avec Leaderbot ; l'achat unique apparaîtra dès que la phase de test Mollie sécurisée sera active.",
  },
  en: {
    noPayment:
      "You can already chat with Leaderbot for free on Messenger. The one-time credit purchase appears once the secured Mollie test phase is live.",
    creditsLabel: "Not available yet",
    creditsCta: "Chat for free on Messenger",
    pricingDisclosure:
      "€4.99 is the planned one-time price for 8 extra images. A purchase link appears only once the secure payment route is live.",
    firstFaqAnswer:
      "Not yet. Chat with Leaderbot for free right now; the one-time purchase appears once the secured Mollie test phase is live.",
  },
};

const featureIcons = [Wand2, Images, Sparkles, MessageCircle, Sparkles, Trash2];

function LanguagePicker({
  copy,
  locale,
  onChange,
}: {
  copy: LandingCopy;
  locale: AppLocale;
  onChange: (locale: AppLocale) => void;
}) {
  return (
    <div
      aria-label={copy.languageLabel}
      className="inline-flex rounded-full border border-white/15 bg-white/10 p-1"
      role="group"
    >
      {SUPPORTED_LOCALES.map(option => (
        <button
          aria-pressed={option === locale}
          className={`min-h-9 rounded-full px-3 text-xs font-semibold transition-colors ${
            option === locale
              ? "bg-lime-300 text-[#10211d]"
              : "text-stone-200 hover:bg-white/10 hover:text-white"
          }`}
          key={option}
          type="button"
          onClick={() => onChange(option)}
        >
          {option === "nl-BE" ? "NL" : option === "fr-BE" ? "FR" : "EN"}
        </button>
      ))}
    </div>
  );
}

function MessengerCta({
  label,
  variant = "accent",
}: {
  label: string;
  variant?: "accent" | "light" | "outline";
}) {
  const classes =
    variant === "accent"
      ? "min-h-12 bg-lime-300 px-6 font-bold text-[#10211d] hover:bg-lime-200"
      : variant === "light"
        ? "min-h-11 border border-stone-300 bg-white px-5 font-semibold text-stone-900 hover:border-stone-400 hover:bg-stone-50"
        : "min-h-12 border border-white/20 px-6 font-bold text-white hover:bg-white/10";
  return (
    <a
      className={`inline-flex items-center justify-center gap-2 rounded-full text-sm shadow-sm transition ${classes}`}
      href={PUBLIC_BUSINESS_DETAILS.messengerUrl}
      rel="noreferrer"
      target="_blank"
    >
      <MessageCircle className="h-4 w-4" aria-hidden="true" />
      {label}
    </a>
  );
}

function AdminLink({
  copy,
  loginConfigured,
}: {
  copy: LandingCopy;
  loginConfigured: boolean;
}) {
  return (
    <button
      className="inline-flex items-center gap-1.5 text-xs font-semibold text-stone-400 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
      disabled={!loginConfigured}
      title={!loginConfigured ? copy.loginUnavailable : undefined}
      type="button"
      onClick={() => {
        const loginUrl = getLoginUrl("/portal");
        if (loginUrl) window.location.href = loginUrl;
      }}
    >
      <Lock className="h-3.5 w-3.5" aria-hidden="true" />
      {copy.nav.admin}
    </button>
  );
}

/** Five dots for the daily free images, then a distinct "+8" credit badge —
 * the whole free/paid mechanic in one glance. This is the page's signature
 * element: it's what the product actually is, not a decoration. */
function QuotaMeter({ usedToday = 1 }: { usedToday?: number }) {
  return (
    <div className="flex items-center gap-2" aria-hidden="true">
      {Array.from({ length: 5 }).map((_, index) => (
        <span
          key={index}
          className={`h-2.5 w-2.5 rounded-full ${
            index < usedToday ? "bg-lime-300" : "bg-white/20"
          }`}
        />
      ))}
      <span className="ml-1 flex h-5 items-center rounded-full bg-white/10 px-2 text-[10px] font-bold uppercase tracking-wide text-stone-300">
        +8
      </span>
    </div>
  );
}

export default function LandingPage({
  locale,
  loginConfigured,
  commercialBillingAvailable,
  onLocaleChange,
}: {
  locale: AppLocale;
  loginConfigured: boolean;
  commercialBillingAvailable: boolean;
  onLocaleChange: (locale: AppLocale) => void;
}) {
  const baseCopy = landingCopies[locale];
  const unavailable = commercialUnavailableCopies[locale];
  const copy = commercialBillingAvailable
    ? baseCopy
    : {
        ...baseCopy,
        noPayment: unavailable.noPayment,
        credits: {
          ...baseCopy.credits,
          label: unavailable.creditsLabel,
          cta: unavailable.creditsCta,
        },
        pricingDisclosure: unavailable.pricingDisclosure,
        questions: baseCopy.questions.map((question, index) =>
          index === 1
            ? { ...question, answer: unavailable.firstFaqAnswer }
            : question
        ),
      };
  const interestHref = `mailto:${PUBLIC_BUSINESS_DETAILS.email}?subject=${encodeURIComponent(
    copy.interestSubject
  )}`;

  return (
    <main className="min-h-full bg-[#f6f2ea] text-[#14201d]">
      <a
        className="sr-only z-50 rounded-md bg-white px-4 py-2 text-stone-950 focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
        href="#main-content"
      >
        Skip to content
      </a>

      <section className="overflow-hidden bg-[#10211d] text-white">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <header className="flex min-h-20 items-center justify-between gap-4 border-b border-white/10">
            <a
              className="flex items-center gap-3"
              href="/"
              aria-label="Leaderbot home"
            >
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-lime-300 font-black text-[#10211d]">
                L
              </span>
              <span>
                <strong className="block text-base">Leaderbot</strong>
                <span className="block text-xs text-stone-400">
                  leaderbot.live
                </span>
              </span>
            </a>
            <nav
              className="hidden items-center gap-6 text-sm text-stone-300 lg:flex"
              aria-label="Primary"
            >
              <a className="hover:text-white" href="#product">
                {copy.nav.product}
              </a>
              <a className="hover:text-white" href="#how-it-works">
                {copy.nav.howItWorks}
              </a>
              <a className="hover:text-white" href="#pricing">
                {copy.nav.pricing}
              </a>
              <a className="hover:text-white" href="#faq">
                {copy.nav.faq}
              </a>
            </nav>
            <div className="flex items-center gap-4">
              <AdminLink copy={copy} loginConfigured={loginConfigured} />
              <LanguagePicker
                copy={copy}
                locale={locale}
                onChange={onLocaleChange}
              />
            </div>
          </header>

          <div
            className="grid gap-12 py-16 sm:py-20 lg:grid-cols-[minmax(0,1fr)_minmax(420px,0.82fr)] lg:items-center lg:py-24"
            id="main-content"
          >
            <div>
              <p className="text-sm font-bold uppercase tracking-[0.18em] text-lime-300">
                {copy.eyebrow}
              </p>
              <h1 className="mt-5 max-w-3xl text-4xl font-semibold leading-[1.05] tracking-[-0.035em] text-white sm:text-6xl">
                {copy.title}
              </h1>
              <p className="mt-6 max-w-2xl text-lg leading-8 text-stone-300">
                {copy.body}
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                <MessengerCta label={copy.primaryCta} variant="accent" />
                <a
                  className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full border border-white/20 px-6 text-sm font-bold text-white transition hover:bg-white/10"
                  href="#how-it-works"
                >
                  {copy.secondaryCta}
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </a>
              </div>
              <p className="mt-5 flex max-w-2xl items-start gap-2 text-sm leading-6 text-stone-400">
                <ShieldCheck
                  className="mt-0.5 h-4 w-4 shrink-0 text-lime-300"
                  aria-hidden="true"
                />
                {copy.noPayment}
              </p>
            </div>

            <div className="relative mx-auto w-full max-w-xl">
              <div
                className="absolute -inset-10 rounded-full bg-lime-300/10 blur-3xl"
                aria-hidden="true"
              />
              <div className="relative overflow-hidden rounded-[2rem] border border-white/15 bg-white/10 p-3 shadow-2xl shadow-black/20 backdrop-blur">
                <div className="rounded-[1.45rem] bg-[#f7f8f5] p-5 text-stone-950 sm:p-6">
                  <div className="flex items-center justify-between border-b border-stone-200 pb-4">
                    <div className="flex items-center gap-3">
                      <span className="grid h-10 w-10 place-items-center rounded-full bg-[#10211d] text-lime-300">
                        <MessageCircle className="h-5 w-5" aria-hidden="true" />
                      </span>
                      <div>
                        <div className="font-semibold">Leaderbot</div>
                        <div className="text-xs text-emerald-700">
                          Messenger · online
                        </div>
                      </div>
                    </div>
                    <span className="rounded-full bg-stone-200 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-stone-600">
                      {copy.previewLabel}
                    </span>
                  </div>
                  <div className="mt-5 grid gap-4">
                    <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-blue-600 px-4 py-3 text-sm leading-6 text-white">
                      {copy.previewPrompt}
                    </div>
                    <div className="max-w-[88%] rounded-2xl rounded-bl-md bg-white px-4 py-3 text-sm leading-6 text-stone-700 shadow-sm ring-1 ring-stone-200">
                      {copy.previewReply}
                    </div>
                    <div className="overflow-hidden rounded-2xl border border-stone-200 bg-[#172c27] p-5 text-white">
                      <div className="flex min-h-36 items-end justify-between rounded-xl bg-[radial-gradient(circle_at_25%_20%,rgba(190,242,100,0.4),transparent_35%),linear-gradient(135deg,#294c43,#10211d)] p-4">
                        <div>
                          <div className="text-xs font-semibold uppercase tracking-[0.16em] text-lime-200">
                            Summer
                          </div>
                          <div className="mt-1 text-2xl font-semibold">
                            Bright ideas.
                          </div>
                        </div>
                        <Sparkles
                          className="h-7 w-7 text-lime-300"
                          aria-hidden="true"
                        />
                      </div>
                      <div className="mt-3 flex items-center justify-between gap-2">
                        <span className="flex items-center gap-2 text-xs text-stone-300">
                          <Check
                            className="h-4 w-4 text-lime-300"
                            aria-hidden="true"
                          />
                          {copy.previewReady}
                        </span>
                        <QuotaMeter usedToday={1} />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="grid gap-px border-t border-white/10 bg-white/10 sm:grid-cols-3">
            {copy.trustItems.map(item => (
              <div
                className="bg-[#10211d] px-5 py-5 text-sm text-stone-300"
                key={item}
              >
                <span className="mr-2 text-lime-300">●</span>
                {item}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="px-4 py-20 sm:px-6 lg:px-8 lg:py-28" id="product">
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr] lg:items-end">
            <div>
              <p className="text-sm font-bold uppercase tracking-[0.16em] text-teal-700">
                {copy.productEyebrow}
              </p>
              <h2 className="mt-4 text-3xl font-semibold tracking-[-0.025em] text-stone-950 sm:text-5xl">
                {copy.productTitle}
              </h2>
            </div>
            <p className="max-w-2xl text-lg leading-8 text-stone-600">
              {copy.productBody}
            </p>
          </div>
          <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {copy.features.map((feature, index) => {
              const Icon = featureIcons[index] ?? Sparkles;
              return (
                <article
                  className="rounded-3xl border border-stone-200 bg-white p-6 shadow-sm"
                  key={feature.title}
                >
                  <span className="grid h-11 w-11 place-items-center rounded-2xl bg-teal-50 text-teal-800">
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <h3 className="mt-5 text-lg font-semibold text-stone-950">
                    {feature.title}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-stone-600">
                    {feature.body}
                  </p>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section
        className="bg-[#e8eee9] px-4 py-20 sm:px-6 lg:px-8 lg:py-28"
        id="how-it-works"
      >
        <div className="mx-auto max-w-7xl">
          <p className="text-sm font-bold uppercase tracking-[0.16em] text-teal-700">
            {copy.howEyebrow}
          </p>
          <h2 className="mt-4 max-w-3xl text-3xl font-semibold tracking-[-0.025em] text-stone-950 sm:text-5xl">
            {copy.howTitle}
          </h2>
          <div className="mt-12 grid gap-5 lg:grid-cols-3">
            {copy.steps.map((step, index) => (
              <article
                className="relative overflow-hidden rounded-3xl bg-white p-7 shadow-sm"
                key={step.title}
              >
                <span className="text-6xl font-black tracking-[-0.06em] text-lime-300">
                  0{index + 1}
                </span>
                <h3 className="mt-8 text-xl font-semibold text-stone-950">
                  {step.title}
                </h3>
                <p className="mt-3 text-sm leading-6 text-stone-600">
                  {step.body}
                </p>
              </article>
            ))}
          </div>
          <div className="mt-8">
            <MessengerCta label={copy.primaryCta} variant="light" />
          </div>
        </div>
      </section>

      <section className="px-4 py-20 sm:px-6 lg:px-8 lg:py-28" id="pricing">
        <div className="mx-auto max-w-6xl">
          <div className="text-center">
            <p className="text-sm font-bold uppercase tracking-[0.16em] text-teal-700">
              {copy.pricingEyebrow}
            </p>
            <h2 className="mx-auto mt-4 max-w-3xl text-3xl font-semibold tracking-[-0.025em] text-stone-950 sm:text-5xl">
              {copy.pricingTitle}
            </h2>
            <p className="mx-auto mt-5 max-w-3xl text-lg leading-8 text-stone-600">
              {copy.pricingBody}
            </p>
          </div>
          <div className="mt-12 grid gap-5 lg:grid-cols-2">
            <article className="rounded-3xl border border-stone-200 bg-white p-7 shadow-sm sm:p-9">
              <h3 className="text-xl font-semibold text-stone-950">
                {copy.free.name}
              </h3>
              <div className="mt-6 flex items-end gap-3">
                <span className="text-5xl font-semibold tracking-[-0.04em] text-stone-950">
                  {copy.free.price}
                </span>
                <span className="pb-1 text-sm text-stone-500">
                  {copy.free.suffix}
                </span>
              </div>
              <p className="mt-5 text-sm leading-6 text-stone-600">
                {copy.free.body}
              </p>
              <ul className="mt-6 grid gap-3 text-sm text-stone-700">
                {copy.free.features.map(feature => (
                  <li className="flex items-start gap-3" key={feature}>
                    <Check
                      className="mt-0.5 h-4 w-4 shrink-0 text-teal-700"
                      aria-hidden="true"
                    />
                    {feature}
                  </li>
                ))}
              </ul>
              <div className="mt-8">
                <MessengerCta label={copy.free.cta} variant="light" />
              </div>
            </article>

            <article className="rounded-3xl border border-[#10211d] bg-[#10211d] p-7 text-white shadow-xl shadow-stone-900/10 sm:p-9">
              <span className="inline-flex rounded-full bg-lime-300 px-3 py-1 text-xs font-bold uppercase tracking-wide text-[#10211d]">
                {copy.credits.label}
              </span>
              <h3 className="mt-5 text-xl font-semibold">
                {copy.credits.name}
              </h3>
              <div className="mt-6 flex items-end gap-3">
                <span className="text-5xl font-semibold tracking-[-0.04em]">
                  {copy.credits.price}
                </span>
                <span className="pb-1 text-sm text-stone-400">
                  {copy.credits.suffix}
                </span>
              </div>
              <p className="mt-5 text-sm leading-6 text-stone-300">
                {copy.credits.body}
              </p>
              <ul className="mt-6 grid gap-3 text-sm text-stone-200">
                {copy.credits.features.map(feature => (
                  <li className="flex items-start gap-3" key={feature}>
                    <Check
                      className="mt-0.5 h-4 w-4 shrink-0 text-lime-300"
                      aria-hidden="true"
                    />
                    {feature}
                  </li>
                ))}
              </ul>
              <div className="mt-8">
                <MessengerCta label={copy.credits.cta} variant="accent" />
              </div>
            </article>
          </div>
          <p className="mx-auto mt-6 max-w-4xl rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm leading-6 text-amber-950">
            {copy.pricingDisclosure}
          </p>
        </div>
      </section>

      <section
        className="bg-white px-4 py-20 sm:px-6 lg:px-8 lg:py-28"
        id="faq"
      >
        <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[0.72fr_1.28fr]">
          <div>
            <p className="text-sm font-bold uppercase tracking-[0.16em] text-teal-700">
              {copy.faqEyebrow}
            </p>
            <h2 className="mt-4 text-3xl font-semibold tracking-[-0.025em] text-stone-950 sm:text-5xl">
              {copy.faqTitle}
            </h2>
          </div>
          <div className="divide-y divide-stone-200 border-y border-stone-200">
            {copy.questions.map(item => (
              <details className="group py-5" key={item.question}>
                <summary className="flex cursor-pointer list-none items-center justify-between gap-5 font-semibold text-stone-950">
                  {item.question}
                  <span
                    className="text-2xl font-light text-teal-700 transition group-open:rotate-45"
                    aria-hidden="true"
                  >
                    +
                  </span>
                </summary>
                <p className="max-w-2xl pt-3 text-sm leading-6 text-stone-600">
                  {item.answer}
                </p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section
        className="bg-[#10211d] px-4 py-20 text-white sm:px-6 lg:px-8"
        id="contact"
      >
        <div className="mx-auto grid max-w-7xl gap-8 lg:grid-cols-[1.1fr_0.9fr] lg:items-stretch">
          <div className="rounded-3xl bg-lime-300 p-7 text-[#10211d] sm:p-10">
            <p className="text-sm font-bold uppercase tracking-[0.16em]">
              {copy.contactEyebrow}
            </p>
            <h2 className="mt-4 max-w-2xl text-3xl font-semibold tracking-[-0.025em] sm:text-5xl">
              {copy.contactTitle}
            </h2>
            <p className="mt-5 max-w-2xl text-base leading-7 text-[#29473f]">
              {copy.contactBody}
            </p>
            <a
              className="mt-8 inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-[#10211d] px-6 text-sm font-bold text-white transition hover:bg-[#1c3931]"
              href={interestHref}
            >
              <Mail className="h-4 w-4" aria-hidden="true" />
              {copy.contactCta}
            </a>
          </div>

          <address className="not-italic rounded-3xl border border-white/15 bg-white/5 p-7 sm:p-10">
            <h2 className="text-2xl font-semibold">{copy.companyTitle}</h2>
            <p className="mt-2 text-stone-300">
              {PUBLIC_BUSINESS_DETAILS.brandName} ·{" "}
              {PUBLIC_BUSINESS_DETAILS.legalName}
            </p>
            <dl className="mt-7 grid gap-4 text-sm">
              <div>
                <dt className="text-stone-500">{copy.enterpriseLabel}</dt>
                <dd className="mt-1 text-stone-200">
                  {PUBLIC_BUSINESS_DETAILS.enterpriseNumber}
                </dd>
              </div>
              <div>
                <dt className="text-stone-500">{copy.vatLabel}</dt>
                <dd className="mt-1 text-stone-200">
                  {PUBLIC_BUSINESS_DETAILS.vatNumber}
                </dd>
              </div>
              <div>
                <dt className="text-stone-500">{copy.addressLabel}</dt>
                <dd className="mt-1 text-stone-200">
                  {formatPublicBusinessAddress()}
                </dd>
              </div>
              <div>
                <dt className="text-stone-500">{copy.phoneLabel}</dt>
                <dd className="mt-1">
                  <a
                    className="text-lime-300 hover:underline"
                    href={`tel:${PUBLIC_BUSINESS_DETAILS.phoneHref}`}
                  >
                    {PUBLIC_BUSINESS_DETAILS.phoneDisplay}
                  </a>
                </dd>
              </div>
              <div>
                <dt className="text-stone-500">{copy.emailLabel}</dt>
                <dd className="mt-1">
                  <a
                    className="text-lime-300 hover:underline"
                    href={`mailto:${PUBLIC_BUSINESS_DETAILS.email}`}
                  >
                    {PUBLIC_BUSINESS_DETAILS.email}
                  </a>
                </dd>
              </div>
            </dl>
          </address>
        </div>
      </section>
    </main>
  );
}
