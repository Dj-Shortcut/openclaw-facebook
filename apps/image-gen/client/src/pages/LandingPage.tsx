import { getLoginUrl } from "@/const";
import { PUBLIC_BUSINESS_DETAILS } from "@shared/publicBusinessDetails";
import {
  ArrowRight,
  Check,
  CreditCard,
  Leaf,
  Lock,
  MessageCircle,
  Palette,
  RefreshCcw,
  Send,
  ShieldCheck,
  Sparkles,
  Sun,
  Image as ImageIcon,
  Trash2,
  Wand2,
} from "lucide-react";
import { lazy, Suspense, useEffect, useRef } from "react";
import { SUPPORTED_LOCALES, type AppLocale } from "./portalLocales";

const HeroOrbCanvas = lazy(() => import("@/components/HeroOrbCanvas"));

type LandingCopy = {
  languageLabel: string;
  nav: {
    howItWorks: string;
    examples: string;
    pricing: string;
    faq: string;
    admin: string;
  };
  eyebrow: string;
  title: string;
  body: string;
  primaryCta: string;
  secondaryCta: string;
  microTrust: string;
  trustItems: string[];
  chat: {
    label: string;
    prompt: string;
    reply: string;
    resultTag: string;
    resultCaption: string;
    quotaCaption: string;
  };
  howEyebrow: string;
  howTitle: string;
  steps: Array<{ title: string; body: string }>;
  examplesEyebrow: string;
  examplesTitle: string;
  examplesBody: string;
  examples: Array<{
    instruction: string;
    beforeLabel: string;
    afterLabel: string;
    resultCaption: string;
    illustrativeNote: string;
  }>;
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
  trustEyebrow: string;
  trustTitle: string;
  trustBody: string;
  trustCards: Array<{
    title: string;
    body: string;
    linkLabel?: string;
    linkHref?: string;
  }>;
  faqEyebrow: string;
  faqTitle: string;
  questions: Array<{ question: string; answer: string }>;
  closingEyebrow: string;
  closingTitle: string;
  closingBody: string;
  closingCta: string;
  loginUnavailable: string;
};

const landingCopies: Record<AppLocale, LandingCopy> = {
  "nl-BE": {
    languageLabel: "Taal",
    nav: {
      howItWorks: "Hoe het werkt",
      examples: "Voorbeelden",
      pricing: "Gratis & credits",
      faq: "Vragen",
      admin: "Beheerder",
    },
    eyebrow: "AI-beelden maken in Facebook Messenger",
    title:
      "Typ wat je wil zien. Leaderbot maakt het beeld — meteen in Messenger.",
    body: "Leaderbot is een Messenger-bot waarmee je met gewone tekst foto's maakt en bewerkt. Geen app, geen account: stuur een berichtje en beschrijf wat je wil zien.",
    primaryCta: "Probeer gratis in Messenger",
    secondaryCta: "Bekijk hoe het werkt",
    microTrust: "Elke dag gratis beelden · geen betaalgegevens nodig om te starten",
    trustItems: [
      "5 gratis beelden per dag, tot 20 per maand",
      "Nadien optioneel 8 extra beelden voor eenmalig €4,99",
      "Geen abonnement, geen automatische verlenging, geen verborgen kosten",
    ],
    chat: {
      label: "Voorbeeldgesprek",
      prompt: "Maak van deze foto een warme zonsondergang met zachte kleuren.",
      reply: "Komt eraan, even geduld.",
      resultTag: "Zomerlicht",
      resultCaption: "Warme tinten, zachte gloed.",
      quotaCaption: "1 van je gratis beelden vandaag gebruikt",
    },
    howEyebrow: "Zo simpel is het",
    howTitle: "Van bericht naar beeld, in drie stappen",
    steps: [
      {
        title: "Stuur je instructie",
        body: "Open Messenger en typ in gewone taal wat je wil: een nieuw beeld, of een foto die je wil laten aanpassen.",
      },
      {
        title: "Je krijgt een beeld terug",
        body: "Leaderbot verwerkt je vraag en stuurt het resultaat terug, rechtstreeks in dezelfde chat.",
      },
      {
        title: "Werk verder aan het resultaat",
        body: "Nog niet helemaal wat je zocht? Stuur een nieuwe instructie en Leaderbot past het beeld verder aan.",
      },
    ],
    examplesEyebrow: "In actie",
    examplesTitle: "Zo verandert een gewone zin in een nieuw beeld",
    examplesBody:
      "Een paar illustratieve voorbeelden van instructies die je rechtstreeks in Messenger naar Leaderbot kan sturen.",
    examples: [
      {
        instruction:
          "“Maak van deze foto een warme zonsondergang met zachte kleuren.”",
        beforeLabel: "Voor",
        afterLabel: "Na",
        resultCaption: "Zachte, warme kleurtonen",
        illustrativeNote: "Illustratief voorbeeld",
      },
      {
        instruction: "“Zet een gezellig terras met plantjes achter mij.”",
        beforeLabel: "Voor",
        afterLabel: "Na",
        resultCaption: "Nieuwe achtergrond, jij blijft jezelf",
        illustrativeNote: "Illustratief voorbeeld",
      },
      {
        instruction: "“Maak er een speelse illustratie van met felle kleuren.”",
        beforeLabel: "Voor",
        afterLabel: "Na",
        resultCaption: "Speelse illustratiestijl",
        illustrativeNote: "Illustratief voorbeeld",
      },
    ],
    pricingEyebrow: "Gratis om te starten",
    pricingTitle: "Elke dag gratis beelden. Bijkopen kan, maar hoeft niet.",
    pricingBody:
      "Je begint gratis. Loop je tegen je daglimiet aan, dan kan je zelf kiezen om bij te kopen — nooit verplicht, nooit automatisch.",
    free: {
      name: "Dagelijks gratis",
      price: "€0",
      suffix: "elke dag opnieuw",
      body: "5 beelden per dag, tot 20 per maand. Geen kaart nodig om te starten.",
      features: [
        "5 gratis beelden per dag",
        "Tot 20 per maand",
        "Tekst-naar-beeld en foto-bewerking",
        "Geen account of app nodig",
      ],
      cta: "Start gratis op Messenger",
    },
    credits: {
      label: "Als je gratis limiet op is",
      name: "Extra credit-bundel",
      price: "€4,99",
      suffix: "eenmalig, geen vervaldatum",
      body: "8 extra beelden in medium kwaliteit. Leaderbot stuurt je de aankooplink zelf, rechtstreeks in de chat.",
      features: [
        "8 extra beelden",
        "Geen vervaldatum",
        "Geen abonnement of automatische verlenging",
        "Veilig betalen via Mollie",
      ],
      cta: "Chat met Leaderbot om bij te kopen",
    },
    pricingDisclosure:
      "€4,99 is de vaste, eenmalige prijs voor 8 extra beelden in medium kwaliteit. Een aankoop start nooit automatisch op deze website: de link komt van Leaderbot zelf in Messenger, en je bevestigt het bedrag altijd eerst zelf op de beveiligde Mollie-pagina.",
    trustEyebrow: "Vertrouwen",
    trustTitle: "Duidelijk over betalen, privacy en je gegevens",
    trustBody: "Geen verrassingen. Zo werkt het achter de schermen.",
    trustCards: [
      {
        title: "Veilig betalen via Mollie",
        body: "Een aankoop verloopt via de beveiligde betaalpagina van Mollie. De betaling start pas nadat je het bedrag daar zelf uitdrukkelijk bevestigt — nooit automatisch, nooit vanaf deze website.",
      },
      {
        title: "Jouw gegevens blijven beperkt",
        body: "Leaderbot verwerkt alleen wat nodig is om je beelden te maken en je gratis en betaalde saldo bij te houden.",
        linkLabel: "Lees het privacybeleid",
        linkHref: "/privacy",
      },
      {
        title: "Verwijderen wanneer je wil",
        body: "Stuur op elk moment “verwijder mijn data” naar Leaderbot in Messenger, en je gegevens worden verwijderd volgens ons beleid.",
        linkLabel: "Meer over gegevens verwijderen",
        linkHref: "/data-deletion",
      },
    ],
    faqEyebrow: "Veelgestelde vragen",
    faqTitle: "Duidelijk vóór je begint",
    questions: [
      {
        question: "Moet ik een account maken?",
        answer:
          "Nee. Je hebt alleen Facebook Messenger nodig. Er is geen aparte app of inlog om te starten.",
      },
      {
        question: "Wat gebeurt er als mijn gratis limiet op is?",
        answer:
          "Leaderbot laat het weten en stuurt je, als je dat zelf wil, een eenmalige aankooplink voor 8 extra beelden van €4,99. Er is geen automatische top-up en geen verborgen kost.",
      },
      {
        question: "Is dit een abonnement?",
        answer:
          "Nee. De €4,99-bundel is een eenmalige aankoop. Er is geen verlenging, geen domiciliëring en geen doorlopende betaling.",
      },
      {
        question: "Wat als een beeld mislukt?",
        answer:
          "Lukt het maken van een beeld niet, dan verlies je daarvoor geen gratis beeld of credit. Je kan het gewoon opnieuw proberen, eventueel met een duidelijkere instructie.",
      },
      {
        question: "Hoe verloopt de betaling precies?",
        answer:
          "Via de beveiligde betaalpagina van Mollie. Je krijgt de link van Leaderbot in Messenger, ziet daar het bedrag en bevestigt zelf voor de betaling start.",
      },
      {
        question: "Kan ik mijn gegevens laten verwijderen?",
        answer:
          "Ja, op elk moment. Vraag het rechtstreeks in Messenger met “verwijder mijn data”, en Leaderbot verwijdert je gegevens volgens het privacybeleid.",
      },
    ],
    closingEyebrow: "Klaar om te beginnen?",
    closingTitle: "Open Leaderbot in Messenger",
    closingBody:
      "Stuur een berichtje en beschrijf het beeld dat je wil. De eerste beelden zijn gratis.",
    closingCta: "Open Leaderbot in Messenger",
    loginUnavailable: "Aanmelden is in deze omgeving nog niet ingesteld.",
  },
  "fr-BE": {
    languageLabel: "Langue",
    nav: {
      howItWorks: "Fonctionnement",
      examples: "Exemples",
      pricing: "Gratuit et crédits",
      faq: "Questions",
      admin: "Administrateur",
    },
    eyebrow: "Images IA dans Facebook Messenger",
    title: "Tapez ce que vous voulez voir. Leaderbot crée l'image — directement dans Messenger.",
    body: "Leaderbot est un bot Messenger qui crée et modifie des images à partir d'un simple texte. Pas d'application, pas de compte : envoyez un message et décrivez ce que vous voulez voir.",
    primaryCta: "Essayer gratuitement sur Messenger",
    secondaryCta: "Voir comment ça marche",
    microTrust: "Images gratuites chaque jour · aucune donnée de paiement requise pour commencer",
    trustItems: [
      "5 images gratuites par jour, jusqu'à 20 par mois",
      "Ensuite, en option, 8 images de plus pour 4,99 € une fois",
      "Pas d'abonnement, pas de renouvellement automatique, pas de frais cachés",
    ],
    chat: {
      label: "Exemple de conversation",
      prompt: "Transforme cette photo en un coucher de soleil chaleureux aux couleurs douces.",
      reply: "C'est parti, un instant.",
      resultTag: "Lumière d'été",
      resultCaption: "Teintes chaudes, lumière douce.",
      quotaCaption: "1 de vos images gratuites utilisée aujourd'hui",
    },
    howEyebrow: "C'est aussi simple que ça",
    howTitle: "Du message à l'image, en trois étapes",
    steps: [
      {
        title: "Envoyez votre instruction",
        body: "Ouvrez Messenger et décrivez en langage naturel ce que vous voulez : une nouvelle image, ou une photo à modifier.",
      },
      {
        title: "Vous recevez une image",
        body: "Leaderbot traite votre demande et vous renvoie le résultat, directement dans la même conversation.",
      },
      {
        title: "Continuez à affiner le résultat",
        body: "Pas encore tout à fait ce que vous cherchiez ? Envoyez une nouvelle instruction et Leaderbot ajuste l'image.",
      },
    ],
    examplesEyebrow: "En pratique",
    examplesTitle: "Comment une simple phrase devient une nouvelle image",
    examplesBody:
      "Quelques exemples illustratifs d'instructions que vous pouvez envoyer directement à Leaderbot dans Messenger.",
    examples: [
      {
        instruction:
          "« Transforme cette photo en un coucher de soleil chaleureux aux couleurs douces. »",
        beforeLabel: "Avant",
        afterLabel: "Après",
        resultCaption: "Teintes douces et chaleureuses",
        illustrativeNote: "Exemple illustratif",
      },
      {
        instruction: "« Mets une terrasse conviviale avec des plantes derrière moi. »",
        beforeLabel: "Avant",
        afterLabel: "Après",
        resultCaption: "Nouvel arrière-plan, vous restez vous-même",
        illustrativeNote: "Exemple illustratif",
      },
      {
        instruction: "« Fais-en une illustration ludique avec des couleurs vives. »",
        beforeLabel: "Avant",
        afterLabel: "Après",
        resultCaption: "Style d'illustration ludique",
        illustrativeNote: "Exemple illustratif",
      },
    ],
    pricingEyebrow: "Gratuit pour commencer",
    pricingTitle: "Des images gratuites chaque jour. Achetez-en plus si vous voulez.",
    pricingBody:
      "Vous commencez gratuitement. Si vous atteignez votre limite quotidienne, vous pouvez choisir d'acheter plus — jamais obligatoire, jamais automatique.",
    free: {
      name: "Gratuit chaque jour",
      price: "0 €",
      suffix: "renouvelé chaque jour",
      body: "5 images par jour, jusqu'à 20 par mois. Aucune carte requise pour commencer.",
      features: [
        "5 images gratuites par jour",
        "Jusqu'à 20 par mois",
        "Texte vers image et retouche photo",
        "Aucun compte ni application requis",
      ],
      cta: "Commencer gratuitement sur Messenger",
    },
    credits: {
      label: "Quand votre gratuit est épuisé",
      name: "Pack de crédits supplémentaires",
      price: "4,99 €",
      suffix: "une fois, sans expiration",
      body: "8 images supplémentaires en qualité medium. Leaderbot vous envoie lui-même le lien d'achat, directement dans le chat.",
      features: [
        "8 images supplémentaires",
        "Sans expiration",
        "Pas d'abonnement ni de renouvellement automatique",
        "Paiement sécurisé via Mollie",
      ],
      cta: "Discuter avec Leaderbot pour acheter",
    },
    pricingDisclosure:
      "4,99 € est le prix fixe et unique pour 8 images supplémentaires en qualité medium. Un achat ne démarre jamais automatiquement sur ce site : le lien vient de Leaderbot lui-même dans Messenger, et vous confirmez toujours vous-même le montant sur la page Mollie sécurisée.",
    trustEyebrow: "Confiance",
    trustTitle: "Clarté sur le paiement, la vie privée et vos données",
    trustBody: "Pas de surprise. Voici comment ça fonctionne en coulisses.",
    trustCards: [
      {
        title: "Paiement sécurisé via Mollie",
        body: "Un achat passe par la page de paiement sécurisée de Mollie. Le paiement ne démarre qu'après votre confirmation explicite du montant — jamais automatiquement, jamais depuis ce site.",
      },
      {
        title: "Vos données restent limitées",
        body: "Leaderbot ne traite que ce qui est nécessaire pour créer vos images et suivre votre solde gratuit et payant.",
        linkLabel: "Lire la politique de confidentialité",
        linkHref: "/privacy",
      },
      {
        title: "Suppression quand vous le souhaitez",
        body: "Envoyez à tout moment « supprime mes données » à Leaderbot dans Messenger, et vos données sont supprimées selon notre politique.",
        linkLabel: "En savoir plus sur la suppression des données",
        linkHref: "/data-deletion",
      },
    ],
    faqEyebrow: "Questions fréquentes",
    faqTitle: "Tout savoir avant de commencer",
    questions: [
      {
        question: "Dois-je créer un compte ?",
        answer:
          "Non. Il vous faut seulement Facebook Messenger. Aucune application ni connexion séparée n'est nécessaire pour commencer.",
      },
      {
        question: "Que se passe-t-il quand mon gratuit est épuisé ?",
        answer:
          "Leaderbot vous prévient et, si vous le souhaitez, vous envoie un lien d'achat unique pour 8 images supplémentaires à 4,99 €. Aucune recharge automatique ni frais caché.",
      },
      {
        question: "Est-ce un abonnement ?",
        answer:
          "Non. Le pack à 4,99 € est un achat unique. Pas de renouvellement, pas de prélèvement, pas de paiement récurrent.",
      },
      {
        question: "Que se passe-t-il si une image échoue ?",
        answer:
          "Si la création d'une image échoue, vous ne perdez pas d'image gratuite ni de crédit pour autant. Vous pouvez simplement réessayer, avec une instruction plus précise si besoin.",
      },
      {
        question: "Comment se déroule exactement le paiement ?",
        answer:
          "Via la page de paiement sécurisée de Mollie. Vous recevez le lien de Leaderbot dans Messenger, y voyez le montant et confirmez vous-même avant que le paiement ne démarre.",
      },
      {
        question: "Puis-je faire supprimer mes données ?",
        answer:
          "Oui, à tout moment. Demandez-le directement dans Messenger avec « supprime mes données », et Leaderbot supprime vos données selon la politique de confidentialité.",
      },
    ],
    closingEyebrow: "Prêt à commencer ?",
    closingTitle: "Ouvrez Leaderbot dans Messenger",
    closingBody:
      "Envoyez un message et décrivez l'image que vous voulez. Les premières images sont gratuites.",
    closingCta: "Ouvrir Leaderbot dans Messenger",
    loginUnavailable: "La connexion n'est pas configurée dans cet environnement.",
  },
  en: {
    languageLabel: "Language",
    nav: {
      howItWorks: "How it works",
      examples: "Examples",
      pricing: "Free & credits",
      faq: "FAQ",
      admin: "Admin",
    },
    eyebrow: "AI images inside Facebook Messenger",
    title: "Type what you want to see. Leaderbot makes the image — right inside Messenger.",
    body: "Leaderbot is a Messenger bot that creates and edits images from plain text. No app, no account: send a message and describe what you want to see.",
    primaryCta: "Try it free on Messenger",
    secondaryCta: "See how it works",
    microTrust: "Free images every day · no payment details needed to start",
    trustItems: [
      "5 free images a day, up to 20 a month",
      "Afterwards, optionally, 8 more images for a one-time €4.99",
      "No subscription, no automatic renewal, no hidden costs",
    ],
    chat: {
      label: "Example conversation",
      prompt: "Turn this photo into a warm sunset with soft colours.",
      reply: "On it, one moment.",
      resultTag: "Summer light",
      resultCaption: "Warm tones, soft glow.",
      quotaCaption: "1 of your free images used today",
    },
    howEyebrow: "It's this simple",
    howTitle: "From message to image, in three steps",
    steps: [
      {
        title: "Send your instruction",
        body: "Open Messenger and describe in plain language what you want: a new image, or a photo you'd like adjusted.",
      },
      {
        title: "You get an image back",
        body: "Leaderbot processes your request and sends the result back, right inside the same chat.",
      },
      {
        title: "Keep refining the result",
        body: "Not quite what you were after? Send a new instruction and Leaderbot adjusts the image further.",
      },
    ],
    examplesEyebrow: "In action",
    examplesTitle: "How a plain sentence becomes a new image",
    examplesBody:
      "A few illustrative examples of instructions you can send straight to Leaderbot in Messenger.",
    examples: [
      {
        instruction: "“Turn this photo into a warm sunset with soft colours.”",
        beforeLabel: "Before",
        afterLabel: "After",
        resultCaption: "Soft, warm colour tones",
        illustrativeNote: "Illustrative example",
      },
      {
        instruction: "“Put a cosy terrace with plants behind me.”",
        beforeLabel: "Before",
        afterLabel: "After",
        resultCaption: "New background, still you",
        illustrativeNote: "Illustrative example",
      },
      {
        instruction: "“Turn it into a playful illustration with bright colours.”",
        beforeLabel: "Before",
        afterLabel: "After",
        resultCaption: "Playful illustration style",
        illustrativeNote: "Illustrative example",
      },
    ],
    pricingEyebrow: "Free to start",
    pricingTitle: "Free images every day. Top up if you ever want to.",
    pricingBody:
      "You start for free. If you hit your daily limit, you can choose to buy more — never required, never automatic.",
    free: {
      name: "Free every day",
      price: "€0",
      suffix: "resets daily",
      body: "5 images a day, up to 20 a month. No card needed to start.",
      features: [
        "5 free images a day",
        "Up to 20 a month",
        "Text-to-image and photo editing",
        "No account or app required",
      ],
      cta: "Start free on Messenger",
    },
    credits: {
      label: "When your free limit is used up",
      name: "Extra credit pack",
      price: "€4.99",
      suffix: "one-time, no expiry",
      body: "8 extra images in medium quality. Leaderbot sends you the purchase link itself, right in the chat.",
      features: [
        "8 extra images",
        "No expiry",
        "No subscription or automatic renewal",
        "Secure payment via Mollie",
      ],
      cta: "Chat with Leaderbot to buy",
    },
    pricingDisclosure:
      "€4.99 is the fixed, one-time price for 8 extra images in medium quality. A purchase never starts automatically on this website: the link comes from Leaderbot itself in Messenger, and you always confirm the amount yourself on the secure Mollie page first.",
    trustEyebrow: "Trust",
    trustTitle: "Clear about payment, privacy and your data",
    trustBody: "No surprises. Here's how it works behind the scenes.",
    trustCards: [
      {
        title: "Secure payment via Mollie",
        body: "A purchase runs through Mollie's secure payment page. Payment only starts once you explicitly confirm the amount there — never automatically, never from this website.",
      },
      {
        title: "Your data stays limited",
        body: "Leaderbot only processes what's needed to make your images and track your free and paid balance.",
        linkLabel: "Read the privacy policy",
        linkHref: "/privacy",
      },
      {
        title: "Delete it whenever you want",
        body: "Send “delete my data” to Leaderbot in Messenger at any time, and your data is deleted according to our policy.",
        linkLabel: "More on deleting your data",
        linkHref: "/data-deletion",
      },
    ],
    faqEyebrow: "Frequently asked questions",
    faqTitle: "Clear before you begin",
    questions: [
      {
        question: "Do I need to create an account?",
        answer:
          "No. All you need is Facebook Messenger. There's no separate app or login to get started.",
      },
      {
        question: "What happens when my free limit runs out?",
        answer:
          "Leaderbot lets you know and, if you choose to, sends a one-time purchase link for 8 extra images at €4.99. There's no automatic top-up and no hidden cost.",
      },
      {
        question: "Is this a subscription?",
        answer:
          "No. The €4.99 pack is a one-time purchase. There's no renewal, no direct debit and no recurring charge.",
      },
      {
        question: "What happens if an image fails?",
        answer:
          "If generating an image fails, you don't lose a free image or a credit for it. You can simply try again, ideally with a clearer instruction.",
      },
      {
        question: "How exactly does payment work?",
        answer:
          "Through Mollie's secure payment page. You get the link from Leaderbot in Messenger, see the amount there, and confirm it yourself before payment starts.",
      },
      {
        question: "Can I have my data deleted?",
        answer:
          "Yes, anytime. Ask directly in Messenger with “delete my data”, and Leaderbot deletes your data according to the privacy policy.",
      },
    ],
    closingEyebrow: "Ready to start?",
    closingTitle: "Open Leaderbot in Messenger",
    closingBody:
      "Send a message and describe the image you want. The first images are free.",
    closingCta: "Open Leaderbot in Messenger",
    loginUnavailable: "Sign-in is not configured in this environment.",
  },
};

const commercialUnavailableCopies: Record<
  AppLocale,
  {
    microTrust: string;
    creditsTrustItem: string;
    creditsLabel: string;
    creditsCta: string;
    pricingDisclosure: string;
    faqAnswer: string;
    paymentFaqAnswer: string;
    trustPaymentTitle: string;
    trustPaymentBody: string;
  }
> = {
  "nl-BE": {
    microTrust:
      "Elke dag gratis beelden · geen betaalgegevens nodig om te starten",
    creditsTrustItem:
      "Eenmalige extra credits komen eraan zodra de beveiligde Mollie-betaling live is",
    creditsLabel: "Nog niet beschikbaar",
    creditsCta: "Chat gratis op Messenger",
    pricingDisclosure:
      "€4,99 is de geplande eenmalige prijs voor 8 extra beelden. Er verschijnt pas een aankooplink zodra de beveiligde betaalroute via Mollie live is.",
    faqAnswer:
      "Nog niet. Chat nu al gratis met Leaderbot; de eenmalige aankoop verschijnt zodra de beveiligde Mollie-testfase live is.",
    paymentFaqAnswer:
      "Dat is nog niet actief. Chat nu al gratis met Leaderbot; zodra de beveiligde betaling via Mollie live is, verloopt een aankoop via hun betaalpagina en bevestig je zelf het bedrag voor de betaling start.",
    trustPaymentTitle: "Veilig betalen komt eraan",
    trustPaymentBody:
      "De eenmalige aankoop van extra credits is nog niet actief. Zodra dat wel zo is, verloopt betalen via de beveiligde pagina van Mollie en bevestig je zelf het bedrag — nooit automatisch, nooit vanaf deze website.",
  },
  "fr-BE": {
    microTrust:
      "Images gratuites chaque jour · aucune donnée de paiement requise pour commencer",
    creditsTrustItem:
      "Les crédits supplémentaires arrivent dès que le paiement sécurisé via Mollie sera actif",
    creditsLabel: "Pas encore disponible",
    creditsCta: "Discuter gratuitement sur Messenger",
    pricingDisclosure:
      "4,99 € est le prix unique prévu pour 8 images supplémentaires. Un lien d'achat n'apparaîtra que lorsque le parcours de paiement sécurisé via Mollie sera actif.",
    faqAnswer:
      "Pas encore. Discutez dès maintenant gratuitement avec Leaderbot ; l'achat unique apparaîtra dès que la phase de test Mollie sécurisée sera active.",
    paymentFaqAnswer:
      "Ce n'est pas encore actif. Discutez dès maintenant gratuitement avec Leaderbot ; dès que le paiement sécurisé via Mollie sera actif, un achat passera par leur page de paiement et vous confirmerez vous-même le montant avant que le paiement ne démarre.",
    trustPaymentTitle: "Le paiement sécurisé arrive bientôt",
    trustPaymentBody:
      "L'achat unique de crédits supplémentaires n'est pas encore actif. Une fois actif, le paiement passera par la page sécurisée de Mollie et vous confirmerez vous-même le montant — jamais automatiquement, jamais depuis ce site.",
  },
  en: {
    microTrust: "Free images every day · no payment details needed to start",
    creditsTrustItem:
      "One-time extra credits are coming once secure Mollie payment is live",
    creditsLabel: "Not available yet",
    creditsCta: "Chat for free on Messenger",
    pricingDisclosure:
      "€4.99 is the planned one-time price for 8 extra images. A purchase link appears only once the secure payment route via Mollie is live.",
    faqAnswer:
      "Not yet. Chat with Leaderbot for free right now; the one-time purchase appears once the secured Mollie test phase is live.",
    paymentFaqAnswer:
      "Not yet. Chat with Leaderbot for free right now; once secure payment via Mollie is live, a purchase will run through their payment page and you'll confirm the amount yourself before payment starts.",
    trustPaymentTitle: "Secure payment is coming soon",
    trustPaymentBody:
      "The one-time purchase of extra credits isn't live yet. Once it is, payment will run through Mollie's secure page and you'll confirm the amount yourself — never automatically, never from this website.",
  },
};

const exampleIcons = [Sun, Leaf, Palette];
const trustCardIcons = [Lock, ShieldCheck, Trash2];

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
      className="inline-flex rounded-full border border-[#132A4C]/10 bg-white p-1"
      role="group"
    >
      {SUPPORTED_LOCALES.map(option => (
        <button
          aria-pressed={option === locale}
          className={`min-h-8 rounded-full px-3 text-xs font-semibold transition-colors ${
            option === locale
              ? "bg-[#0084FF] text-white"
              : "text-[#132A4C]/60 hover:bg-[#132A4C]/5 hover:text-[#132A4C]"
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
  variant = "solid",
  size = "md",
}: {
  label: string;
  variant?: "solid" | "ghost" | "onDark";
  size?: "md" | "lg";
}) {
  const sizeClasses = size === "lg" ? "min-h-14 px-7 text-base" : "min-h-12 px-6 text-sm";
  const variantClasses =
    variant === "solid"
      ? "bg-[#0084FF] text-white shadow-[0_14px_30px_-14px_rgba(0,132,255,0.65)] hover:bg-[#0070d8]"
      : variant === "onDark"
        ? "bg-white text-[#0084FF] hover:bg-white/90"
        : "border border-[#132A4C]/15 text-[#132A4C] hover:border-[#132A4C]/30 hover:bg-[#132A4C]/5";
  return (
    <a
      className={`inline-flex items-center justify-center gap-2 rounded-full font-bold transition ${sizeClasses} ${variantClasses}`}
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
      className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#132A4C]/50 transition hover:text-[#132A4C] disabled:cursor-not-allowed disabled:opacity-50"
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

/** Free-image dots plus a distinct "+8" credit badge — the whole
 * free/paid mechanic in one glance inside the hero chat mockup. */
function QuotaMeter({ usedToday = 1 }: { usedToday?: number }) {
  return (
    <div className="flex items-center gap-2" aria-hidden="true">
      {Array.from({ length: 5 }).map((_, index) => (
        <span
          key={index}
          className={`h-2.5 w-2.5 rounded-full ${
            index < usedToday ? "bg-[#0084FF]" : "bg-[#132A4C]/15"
          }`}
        />
      ))}
      <span className="ml-1 flex h-5 items-center rounded-full bg-gradient-to-r from-violet-100 to-pink-100 px-2 text-[10px] font-bold uppercase tracking-wide text-[#7A3FD1]">
        +8
      </span>
    </div>
  );
}

/** Subtle cursor-following spotlight over the hero mockup card — a plain
 * CSS/pointer-events micro-interaction layered on top of the WebGL orb. */
function PointerGlow() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;

    const onMove = (event: PointerEvent) => {
      const rect = parent.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * 100;
      const y = ((event.clientY - rect.top) / rect.height) * 100;
      el.style.setProperty("--gx", `${x}%`);
      el.style.setProperty("--gy", `${y}%`);
      el.style.opacity = "1";
    };
    const onLeave = () => {
      el.style.opacity = "0";
    };
    parent.addEventListener("pointermove", onMove);
    parent.addEventListener("pointerleave", onLeave);
    return () => {
      parent.removeEventListener("pointermove", onMove);
      parent.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-10 opacity-0 transition-opacity duration-300"
      ref={ref}
      style={{
        background:
          "radial-gradient(280px circle at var(--gx, 50%) var(--gy, 50%), rgba(255,255,255,0.55), transparent 70%)",
      }}
    />
  );
}

function SectionEyebrow({ children }: { children: string }) {
  return (
    <p className="text-sm font-bold uppercase tracking-[0.16em] text-[#0084FF]">
      {children}
    </p>
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
        microTrust: unavailable.microTrust,
        trustItems: baseCopy.trustItems.map((item, index) =>
          index === 1 ? unavailable.creditsTrustItem : item
        ),
        credits: {
          ...baseCopy.credits,
          label: unavailable.creditsLabel,
          cta: unavailable.creditsCta,
        },
        pricingDisclosure: unavailable.pricingDisclosure,
        trustCards: baseCopy.trustCards.map((card, index) =>
          index === 0
            ? {
                ...card,
                title: unavailable.trustPaymentTitle,
                body: unavailable.trustPaymentBody,
              }
            : card
        ),
        questions: baseCopy.questions.map((question, index) => {
          if (index === 1) return { ...question, answer: unavailable.faqAnswer };
          if (index === 4) {
            return { ...question, answer: unavailable.paymentFaqAnswer };
          }
          return question;
        }),
      };

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: copy.questions.map(item => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.answer },
    })),
  };

  return (
    <main className="min-h-full bg-[#f6f2ea] text-[#132A4C]">
      <a
        className="sr-only z-50 rounded-md bg-white px-4 py-2 text-[#132A4C] focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
        href="#main-content"
      >
        Skip to content
      </a>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(faqSchema).replace(/</g, "\\u003c"),
        }}
      />

      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <header className="flex min-h-20 items-center justify-between gap-4 border-b border-[#132A4C]/10">
          <a className="flex items-center gap-3" href="/" aria-label="Leaderbot home">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-[#0084FF] font-black text-white">
              L
            </span>
            <span>
              <strong className="block text-base">Leaderbot</strong>
              <span className="block text-xs text-[#132A4C]/50">leaderbot.live</span>
            </span>
          </a>
          <nav
            className="hidden items-center gap-6 text-sm text-[#132A4C]/70 lg:flex"
            aria-label="Primary"
          >
            <a className="hover:text-[#132A4C]" href="#how-it-works">
              {copy.nav.howItWorks}
            </a>
            <a className="hover:text-[#132A4C]" href="#examples">
              {copy.nav.examples}
            </a>
            <a className="hover:text-[#132A4C]" href="#pricing">
              {copy.nav.pricing}
            </a>
            <a className="hover:text-[#132A4C]" href="#faq">
              {copy.nav.faq}
            </a>
          </nav>
          <div className="flex items-center gap-4">
            <AdminLink copy={copy} loginConfigured={loginConfigured} />
            <LanguagePicker copy={copy} locale={locale} onChange={onLocaleChange} />
          </div>
        </header>

        <div
          className="grid gap-12 py-14 sm:py-20 lg:grid-cols-[minmax(0,1fr)_minmax(420px,0.85fr)] lg:items-center lg:py-24"
          id="main-content"
        >
          <div>
            <p className="text-sm font-bold uppercase tracking-[0.18em] text-[#0084FF]">
              {copy.eyebrow}
            </p>
            <h1 className="mt-5 max-w-3xl text-4xl font-semibold leading-[1.08] tracking-[-0.03em] text-[#132A4C] sm:text-5xl lg:text-6xl">
              {copy.title}
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-[#132A4C]/70">
              {copy.body}
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              <MessengerCta label={copy.primaryCta} variant="solid" size="lg" />
              <a
                className="inline-flex min-h-14 items-center justify-center gap-2 rounded-full border border-[#132A4C]/15 px-7 text-base font-bold text-[#132A4C] transition hover:border-[#132A4C]/30 hover:bg-[#132A4C]/5"
                href="#how-it-works"
              >
                {copy.secondaryCta}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </a>
            </div>
            <p className="mt-5 flex max-w-2xl items-start gap-2 text-sm leading-6 text-[#132A4C]/60">
              <ShieldCheck
                className="mt-0.5 h-4 w-4 shrink-0 text-[#0084FF]"
                aria-hidden="true"
              />
              {copy.microTrust}
            </p>
          </div>

          <div className="relative mx-auto w-full max-w-xl">
            <div
              className="absolute -inset-10 rounded-full bg-gradient-to-br from-violet-200/50 via-pink-200/40 to-transparent blur-3xl"
              aria-hidden="true"
            />
            <div
              className="absolute -inset-10 opacity-90 [mask-image:radial-gradient(closest-side,black,transparent)]"
              aria-hidden="true"
            >
              <Suspense fallback={null}>
                <HeroOrbCanvas />
              </Suspense>
            </div>
            <div className="relative overflow-hidden rounded-[2rem] border border-[#132A4C]/10 bg-white p-3 shadow-[0_30px_70px_-35px_rgba(19,42,76,0.35)]">
              <PointerGlow />
              <div className="rounded-[1.45rem] bg-[#f7f8fb] p-5 sm:p-6">
                <div className="flex items-center justify-between border-b border-[#132A4C]/10 pb-4">
                  <div className="flex items-center gap-3">
                    <span className="grid h-10 w-10 place-items-center rounded-full bg-[#0084FF] text-white">
                      <MessageCircle className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <div>
                      <div className="font-semibold text-[#132A4C]">Leaderbot</div>
                      <div className="text-xs text-emerald-700">
                        Messenger · online
                      </div>
                    </div>
                  </div>
                  <span className="rounded-full bg-[#132A4C]/5 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-[#132A4C]/60">
                    {copy.chat.label}
                  </span>
                </div>
                <div className="mt-5 grid gap-4">
                  <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-[#0084FF] px-4 py-3 text-sm leading-6 text-white">
                    {copy.chat.prompt}
                  </div>
                  <div className="max-w-[88%] rounded-2xl rounded-bl-md bg-white px-4 py-3 text-sm leading-6 text-[#132A4C]/80 shadow-sm ring-1 ring-[#132A4C]/10">
                    {copy.chat.reply}
                  </div>
                  <div className="overflow-hidden rounded-2xl border border-[#132A4C]/10 bg-white p-4 shadow-sm">
                    <div className="flex min-h-32 items-end justify-between rounded-xl bg-[radial-gradient(circle_at_25%_20%,rgba(255,255,255,0.35),transparent_45%),linear-gradient(135deg,#ff9a5a,#ff6f9c_55%,#8b5cf6)] p-4 text-white">
                      <div>
                        <div className="text-xs font-semibold uppercase tracking-[0.16em] text-white/80">
                          {copy.chat.resultTag}
                        </div>
                        <div className="mt-1 text-xl font-semibold">
                          {copy.chat.resultCaption}
                        </div>
                      </div>
                      <Sparkles className="h-7 w-7 text-white" aria-hidden="true" />
                    </div>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                      <span className="flex items-center gap-2 text-xs text-[#132A4C]/60">
                        <Check className="h-4 w-4 text-[#0084FF]" aria-hidden="true" />
                        {copy.chat.quotaCaption}
                      </span>
                      <QuotaMeter usedToday={1} />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="grid gap-3 border-t border-[#132A4C]/10 py-8 sm:grid-cols-3">
          {copy.trustItems.map(item => (
            <div
              className="flex items-start gap-2 text-sm leading-6 text-[#132A4C]/70"
              key={item}
            >
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#0084FF]" />
              {item}
            </div>
          ))}
        </div>
      </div>

      <section
        className="bg-white px-4 py-20 sm:px-6 lg:px-8 lg:py-28"
        id="how-it-works"
      >
        <div className="mx-auto max-w-7xl">
          <SectionEyebrow>{copy.howEyebrow}</SectionEyebrow>
          <h2 className="mt-4 max-w-3xl text-3xl font-semibold tracking-[-0.025em] text-[#132A4C] sm:text-5xl">
            {copy.howTitle}
          </h2>
          <div className="mt-12 grid gap-5 lg:grid-cols-3">
            {copy.steps.map((step, index) => {
              const Icon = [Send, Wand2, RefreshCcw][index] ?? Send;
              return (
                <article
                  className="relative overflow-hidden rounded-3xl border border-[#132A4C]/10 bg-[#f6f2ea] p-7 shadow-sm transition hover:-translate-y-1 hover:shadow-md"
                  key={step.title}
                >
                  <div className="flex items-center gap-3">
                    <span className="grid h-11 w-11 place-items-center rounded-2xl bg-[#0084FF]/10 text-[#0084FF]">
                      <Icon className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <span className="text-4xl font-black tracking-[-0.06em] text-[#132A4C]/10">
                      0{index + 1}
                    </span>
                  </div>
                  <h3 className="mt-6 text-xl font-semibold text-[#132A4C]">
                    {step.title}
                  </h3>
                  <p className="mt-3 text-sm leading-6 text-[#132A4C]/65">
                    {step.body}
                  </p>
                </article>
              );
            })}
          </div>
          <div className="mt-8">
            <MessengerCta label={copy.primaryCta} variant="solid" />
          </div>
        </div>
      </section>

      <section className="px-4 py-20 sm:px-6 lg:px-8 lg:py-28" id="examples">
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr] lg:items-end">
            <div>
              <SectionEyebrow>{copy.examplesEyebrow}</SectionEyebrow>
              <h2 className="mt-4 text-3xl font-semibold tracking-[-0.025em] text-[#132A4C] sm:text-5xl">
                {copy.examplesTitle}
              </h2>
            </div>
            <p className="max-w-2xl text-lg leading-8 text-[#132A4C]/70">
              {copy.examplesBody}
            </p>
          </div>
          <div className="mt-12 grid gap-6 lg:grid-cols-3">
            {copy.examples.map((example, index) => {
              const Icon = exampleIcons[index] ?? Sparkles;
              return (
                <article
                  className="overflow-hidden rounded-3xl border border-[#132A4C]/10 bg-white shadow-sm transition hover:-translate-y-1 hover:shadow-md"
                  key={example.instruction}
                >
                  <div className="grid grid-cols-2 gap-px bg-[#132A4C]/10">
                    <div className="flex flex-col items-center justify-center gap-2 bg-[#f1ede3] px-3 py-8">
                      <ImageIcon
                        className="h-7 w-7 text-[#132A4C]/35"
                        aria-hidden="true"
                      />
                      <span className="text-xs font-semibold uppercase tracking-wide text-[#132A4C]/45">
                        {example.beforeLabel}
                      </span>
                    </div>
                    <div className="flex flex-col items-center justify-center gap-2 bg-[linear-gradient(160deg,#ffb37a,#ff7fa6_55%,#9b6bf2)] px-3 py-8 text-white">
                      <Icon className="h-7 w-7" aria-hidden="true" />
                      <span className="text-xs font-semibold uppercase tracking-wide">
                        {example.afterLabel}
                      </span>
                    </div>
                  </div>
                  <div className="p-6">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-[#132A4C]/40">
                      {example.illustrativeNote}
                    </p>
                    <p className="mt-2 text-sm font-medium leading-6 text-[#132A4C]">
                      {example.instruction}
                    </p>
                    <p className="mt-3 text-sm leading-6 text-[#132A4C]/60">
                      {example.resultCaption}
                    </p>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section
        className="bg-[#f1ece1] px-4 py-20 sm:px-6 lg:px-8 lg:py-28"
        id="pricing"
      >
        <div className="mx-auto max-w-6xl">
          <div className="text-center">
            <SectionEyebrow>{copy.pricingEyebrow}</SectionEyebrow>
            <h2 className="mx-auto mt-4 max-w-3xl text-3xl font-semibold tracking-[-0.025em] text-[#132A4C] sm:text-5xl">
              {copy.pricingTitle}
            </h2>
            <p className="mx-auto mt-5 max-w-3xl text-lg leading-8 text-[#132A4C]/70">
              {copy.pricingBody}
            </p>
          </div>
          <div className="mt-12 grid gap-5 lg:grid-cols-2">
            <article className="rounded-3xl border border-[#132A4C]/10 bg-white p-7 shadow-sm sm:p-9">
              <h3 className="text-xl font-semibold text-[#132A4C]">
                {copy.free.name}
              </h3>
              <div className="mt-6 flex items-end gap-3">
                <span className="text-5xl font-semibold tracking-[-0.04em] text-[#132A4C]">
                  {copy.free.price}
                </span>
                <span className="pb-1 text-sm text-[#132A4C]/50">
                  {copy.free.suffix}
                </span>
              </div>
              <p className="mt-5 text-sm leading-6 text-[#132A4C]/65">
                {copy.free.body}
              </p>
              <ul className="mt-6 grid gap-3 text-sm text-[#132A4C]/80">
                {copy.free.features.map(feature => (
                  <li className="flex items-start gap-3" key={feature}>
                    <Check
                      className="mt-0.5 h-4 w-4 shrink-0 text-[#0084FF]"
                      aria-hidden="true"
                    />
                    {feature}
                  </li>
                ))}
              </ul>
              <div className="mt-8">
                <MessengerCta label={copy.free.cta} variant="ghost" />
              </div>
            </article>

            <article className="relative overflow-hidden rounded-3xl border border-[#132A4C]/10 bg-[#132A4C] p-7 text-white shadow-xl sm:p-9">
              <div
                className="absolute -right-16 -top-16 h-48 w-48 rounded-full bg-gradient-to-br from-violet-500/40 to-pink-400/30 blur-3xl"
                aria-hidden="true"
              />
              <span className="relative inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs font-bold uppercase tracking-wide text-white">
                <CreditCard className="h-3.5 w-3.5" aria-hidden="true" />
                {copy.credits.label}
              </span>
              <h3 className="relative mt-5 text-xl font-semibold">
                {copy.credits.name}
              </h3>
              <div className="relative mt-6 flex items-end gap-3">
                <span className="text-5xl font-semibold tracking-[-0.04em]">
                  {copy.credits.price}
                </span>
                <span className="pb-1 text-sm text-white/60">
                  {copy.credits.suffix}
                </span>
              </div>
              <p className="relative mt-5 text-sm leading-6 text-white/75">
                {copy.credits.body}
              </p>
              <ul className="relative mt-6 grid gap-3 text-sm text-white/85">
                {copy.credits.features.map(feature => (
                  <li className="flex items-start gap-3" key={feature}>
                    <Check
                      className="mt-0.5 h-4 w-4 shrink-0 text-[#4fb2ff]"
                      aria-hidden="true"
                    />
                    {feature}
                  </li>
                ))}
              </ul>
              <div className="relative mt-8">
                <MessengerCta label={copy.credits.cta} variant="solid" />
              </div>
            </article>
          </div>
          <p className="mx-auto mt-6 max-w-4xl rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm leading-6 text-amber-950">
            {copy.pricingDisclosure}
          </p>
        </div>
      </section>

      <section className="bg-white px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
        <div className="mx-auto max-w-7xl">
          <div className="max-w-2xl">
            <SectionEyebrow>{copy.trustEyebrow}</SectionEyebrow>
            <h2 className="mt-4 text-3xl font-semibold tracking-[-0.025em] text-[#132A4C] sm:text-5xl">
              {copy.trustTitle}
            </h2>
            <p className="mt-5 text-lg leading-8 text-[#132A4C]/70">
              {copy.trustBody}
            </p>
          </div>
          <div className="mt-12 grid gap-5 md:grid-cols-3">
            {copy.trustCards.map((card, index) => {
              const Icon = trustCardIcons[index] ?? ShieldCheck;
              return (
                <article
                  className="rounded-3xl border border-[#132A4C]/10 bg-[#f6f2ea] p-7 shadow-sm"
                  key={card.title}
                >
                  <span className="grid h-11 w-11 place-items-center rounded-2xl bg-[#0084FF]/10 text-[#0084FF]">
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <h3 className="mt-5 text-lg font-semibold text-[#132A4C]">
                    {card.title}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-[#132A4C]/65">
                    {card.body}
                  </p>
                  {card.linkHref && card.linkLabel ? (
                    <a
                      className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-[#0084FF] hover:underline"
                      href={card.linkHref}
                    >
                      {card.linkLabel}
                      <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </a>
                  ) : null}
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section
        className="bg-[#f1ece1] px-4 py-20 sm:px-6 lg:px-8 lg:py-28"
        id="faq"
      >
        <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[0.72fr_1.28fr]">
          <div>
            <SectionEyebrow>{copy.faqEyebrow}</SectionEyebrow>
            <h2 className="mt-4 text-3xl font-semibold tracking-[-0.025em] text-[#132A4C] sm:text-5xl">
              {copy.faqTitle}
            </h2>
          </div>
          <div className="divide-y divide-[#132A4C]/10 border-y border-[#132A4C]/10">
            {copy.questions.map(item => (
              <details className="group py-5" key={item.question}>
                <summary className="flex cursor-pointer list-none items-center justify-between gap-5 font-semibold text-[#132A4C]">
                  {item.question}
                  <span
                    className="text-2xl font-light text-[#0084FF] transition group-open:rotate-45"
                    aria-hidden="true"
                  >
                    +
                  </span>
                </summary>
                <p className="max-w-2xl pt-3 text-sm leading-6 text-[#132A4C]/65">
                  {item.answer}
                </p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="px-4 py-20 sm:px-6 lg:px-8 lg:py-24">
        <div className="mx-auto max-w-7xl">
          <div className="relative overflow-hidden rounded-[2.5rem] bg-[linear-gradient(120deg,#0084FF,#7c5cf2_55%,#ec6fa8)] px-6 py-16 text-center text-white sm:px-12 sm:py-20">
            <div
              className="absolute -left-10 -top-10 h-56 w-56 rounded-full bg-white/10 blur-3xl"
              aria-hidden="true"
            />
            <div
              className="absolute -bottom-16 -right-10 h-64 w-64 rounded-full bg-white/10 blur-3xl"
              aria-hidden="true"
            />
            <p className="relative text-sm font-bold uppercase tracking-[0.18em] text-white/80">
              {copy.closingEyebrow}
            </p>
            <h2 className="relative mx-auto mt-4 max-w-2xl text-3xl font-semibold tracking-[-0.025em] sm:text-5xl">
              {copy.closingTitle}
            </h2>
            <p className="relative mx-auto mt-5 max-w-xl text-lg leading-8 text-white/85">
              {copy.closingBody}
            </p>
            <div className="relative mt-9 flex justify-center">
              <MessengerCta label={copy.closingCta} variant="onDark" size="lg" />
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
