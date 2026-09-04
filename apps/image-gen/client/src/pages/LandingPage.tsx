import { getLoginUrl } from "@/const";
import { PUBLIC_BUSINESS_DETAILS } from "@shared/publicBusinessDetails";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  CreditCard,
  Layers,
  Lock,
  MessageCircle,
  Package,
  Send,
  ShieldCheck,
  Sparkles,
  SunMedium,
  Type,
  Image as ImageIcon,
  Trash2,
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
    admin: string;
  };
  headerCta: string;
  eyebrow: string;
  title: string;
  subtitle: string;
  heroPrimaryCta: string;
  heroSecondaryCta: string;
  microLine: string;
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
    title: string;
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
    features: string[];
    cta: string;
  };
  credits: {
    name: string;
    price: string;
    suffix: string;
    features: string[];
    note: string;
  };
  trustEyebrow: string;
  trustTitle: string;
  trustCards: Array<{
    title: string;
    body: string;
    links?: Array<{ label: string; href: string }>;
  }>;
  faqEyebrow: string;
  faqTitle: string;
  questions: Array<{ question: string; answer: string }>;
};

const landingCopies: Record<AppLocale, LandingCopy> = {
  "nl-BE": {
    languageLabel: "Taal",
    nav: {
      howItWorks: "Hoe werkt het?",
      examples: "Voorbeelden",
      pricing: "Prijzen",
      admin: "Beheerder",
    },
    headerCta: "Probeer gratis in Messenger",
    eyebrow: "Foto's maken en bewerken via Messenger",
    title: "Maak en bewerk foto's gewoon via Messenger",
    subtitle:
      "Stuur Leaderbot wat je wilt zien. Maak een nieuwe afbeelding of bewerk je eigen foto met een eenvoudige tekstbeschrijving.",
    heroPrimaryCta: "Open Leaderbot in Messenger",
    heroSecondaryCta: "Bekijk voorbeelden",
    microLine:
      "Dagelijks gratis proberen • Geen abonnement • Veilig betalen via Mollie",
    chat: {
      label: "Voorbeeldgesprek",
      prompt: "Vervang de achtergrond door een rustig kantoor met veel licht.",
      reply: "Komt eraan, even geduld.",
      resultTag: "Nieuwe achtergrond",
      resultCaption: "Scherp en professioneel resultaat.",
      quotaCaption: "1 van je gratis beelden vandaag gebruikt",
    },
    howEyebrow: "Zo simpel is het",
    howTitle: "Van bericht naar beeld in drie stappen",
    steps: [
      { title: "Open Messenger", body: "Open Leaderbot in Messenger." },
      { title: "Stuur je opdracht", body: "Stuur een opdracht of foto." },
      {
        title: "Ontvang je beeld",
        body: "Ontvang je afbeelding rechtstreeks in het gesprek.",
      },
    ],
    examplesEyebrow: "Realistische voorbeelden",
    examplesTitle: "Wat je allemaal met Leaderbot kan maken",
    examplesBody:
      "Een greep uit de dingen die je rechtstreeks in Messenger aan Leaderbot kan vragen.",
    examples: [
      {
        title: "Achtergrond vervangen",
        instruction:
          "“Vervang de achtergrond door een rustig kantoor met veel licht.”",
        beforeLabel: "Voor",
        afterLabel: "Na",
        resultCaption: "Nieuwe achtergrond, jij blijft jezelf",
        illustrativeNote: "Illustratief voorbeeld",
      },
      {
        title: "Foto stijlvoller maken",
        instruction: "“Maak deze foto strakker en stijlvoller.”",
        beforeLabel: "Voor",
        afterLabel: "Na",
        resultCaption: "Verfijnde look, dezelfde foto",
        illustrativeNote: "Illustratief voorbeeld",
      },
      {
        title: "Productfoto verbeteren",
        instruction: "“Verbeter deze productfoto voor mijn webshop.”",
        beforeLabel: "Voor",
        afterLabel: "Na",
        resultCaption: "Scherper, met een neutrale achtergrond",
        illustrativeNote: "Illustratief voorbeeld",
      },
      {
        title: "Nieuwe afbeelding uit tekst maken",
        instruction:
          "“Maak een rustige illustratie van een koffiehoekje in de ochtendzon.”",
        beforeLabel: "Voor",
        afterLabel: "Na",
        resultCaption: "Volledig nieuw beeld, puur uit tekst",
        illustrativeNote: "Illustratief voorbeeld",
      },
      {
        title: "Belichting en kleuren aanpassen",
        instruction: "“Maak de belichting warmer en de kleuren levendiger.”",
        beforeLabel: "Voor",
        afterLabel: "Na",
        resultCaption: "Zachtere, warmere kleurtoon",
        illustrativeNote: "Illustratief voorbeeld",
      },
    ],
    pricingEyebrow: "Gratis & premium",
    pricingTitle: "Elke dag gratis. Bijkopen kan, maar hoeft niet.",
    pricingBody:
      "Je start altijd gratis. Nadien kan je zelf kiezen om bij te kopen — nooit verplicht.",
    free: {
      name: "Gratis",
      price: "€0",
      suffix: "elke dag opnieuw",
      features: [
        "Dagelijks gratis beeldtegoed",
        "Nieuwe afbeeldingen en fotobewerking",
        "Automatische dagelijkse reset",
      ],
      cta: "Start gratis",
    },
    credits: {
      name: "Premiumbundel",
      price: "€5,00",
      suffix: "eenmalig",
      features: [
        "9 premium beeldcredits",
        "1 bruikbaar geleverd premiumresultaat = 1 credit",
        "Medium beeldkwaliteit",
        "Credits vervallen niet",
        "Geen abonnement of automatische verlenging",
      ],
      note: "Je krijgt de aankoopoptie pas in Messenger te zien wanneer zowel je gratis dagtegoed als eventuele premiumcredits op zijn.",
    },
    trustEyebrow: "Vertrouwen",
    trustTitle: "Duidelijk over betalen en je gegevens",
    trustCards: [
      {
        title: "Veilig betalen via Mollie",
        body: "Elke aankoop verloopt via de beveiligde betaalpagina van Mollie.",
      },
      {
        title: "Geen betaalgegevens in Messenger",
        body: "Leaderbot verzamelt nooit kaart- of betaalgegevens rechtstreeks in het gesprek.",
      },
      {
        title: "Credits pas na bevestigde betaling",
        body: "Je premiumcredits worden pas toegevoegd nadat Mollie de betaling bevestigt.",
      },
      {
        title: "Privacy en verwijdering",
        body: "Je gegevens worden zorgvuldig behandeld. Vraag verwijdering wanneer je wil — voor zover wettelijke bewaarplicht of door Meta beheerde gegevens dat toelaten.",
        links: [
          { label: "Privacybeleid", href: "/privacy" },
          { label: "Gegevens verwijderen", href: "/data-deletion" },
        ],
      },
    ],
    faqEyebrow: "Veelgestelde vragen",
    faqTitle: "Alles wat je wil weten",
    questions: [
      {
        question: "Moet ik een abonnement nemen?",
        answer:
          "Nee. Leaderbot werkt zonder abonnement. Je gebruikt een gratis dagtegoed en koopt enkel bij als je dat zelf kiest, via een eenmalige premiumbundel.",
      },
      {
        question: "Wanneer krijg ik opnieuw gratis afbeeldingen?",
        answer:
          "Je gratis dagtegoed wordt elke dag automatisch ververst, tot een maandelijks maximum. Zodra je dat maandmaximum bereikt, moet je wachten tot de volgende maand voor er opnieuw gratis beelden vrijkomen.",
      },
      {
        question: "Hoe koop ik premiumcredits?",
        answer:
          "Wanneer zowel je gratis dagtegoed als eventuele premiumcredits op zijn, stuurt Leaderbot je in Messenger een persoonlijke, beveiligde betaallink. Die link opent een eenmalige Mollie-checkout van €5,00 voor 9 premium beeld- of bewerkingscredits. Eén succesvol geleverd bruikbaar premiumresultaat verbruikt één credit.",
      },
      {
        question: "Vervallen mijn premiumcredits?",
        answer:
          "Nee. Eenmaal aangekocht, blijven je 9 premiumcredits beschikbaar tot je ze gebruikt — zonder vervaldatum.",
      },
      {
        question: "Kan ik mijn eigen foto bewerken?",
        answer:
          "Ja. Stuur een foto naar Leaderbot in Messenger samen met een beschrijving van de aanpassing die je wil, en je krijgt de bewerkte versie terug.",
      },
      {
        question: "Hoe worden mijn foto's en gegevens behandeld?",
        answer:
          "Leaderbot verwerkt enkel wat nodig is om je afbeeldingen te maken en je tegoed bij te houden. Je kan op elk moment vragen om je gegevens te verwijderen.",
      },
      {
        question: "Wat gebeurt er bij een mislukte betaling?",
        answer:
          "Bij een mislukte of niet-bevestigde betaling worden er geen premiumcredits toegevoegd en wordt er niets van je rekening afgeschreven. Je kan de aankoop gewoon opnieuw proberen via Messenger.",
      },
    ],
  },
  "fr-BE": {
    languageLabel: "Langue",
    nav: {
      howItWorks: "Fonctionnement",
      examples: "Exemples",
      pricing: "Tarifs",
      admin: "Administrateur",
    },
    headerCta: "Essayer gratuitement sur Messenger",
    eyebrow: "Créer et modifier des photos via Messenger",
    title: "Créez et modifiez des photos, simplement via Messenger",
    subtitle:
      "Dites à Leaderbot ce que vous voulez voir. Créez une nouvelle image ou modifiez votre propre photo avec une simple description en texte.",
    heroPrimaryCta: "Ouvrir Leaderbot dans Messenger",
    heroSecondaryCta: "Voir des exemples",
    microLine:
      "Essai gratuit chaque jour • Sans abonnement • Paiement sécurisé via Mollie",
    chat: {
      label: "Exemple de conversation",
      prompt: "Remplace l'arrière-plan par un bureau lumineux et calme.",
      reply: "C'est parti, un instant.",
      resultTag: "Nouvel arrière-plan",
      resultCaption: "Résultat net et professionnel.",
      quotaCaption: "1 de vos images gratuites utilisée aujourd'hui",
    },
    howEyebrow: "C'est aussi simple que ça",
    howTitle: "Du message à l'image, en trois étapes",
    steps: [
      { title: "Ouvrez Messenger", body: "Ouvrez Leaderbot dans Messenger." },
      {
        title: "Envoyez votre demande",
        body: "Envoyez une instruction ou une photo.",
      },
      {
        title: "Recevez votre image",
        body: "Recevez votre image directement dans la conversation.",
      },
    ],
    examplesEyebrow: "Exemples concrets",
    examplesTitle: "Tout ce que vous pouvez créer avec Leaderbot",
    examplesBody:
      "Un aperçu de ce que vous pouvez demander directement à Leaderbot dans Messenger.",
    examples: [
      {
        title: "Remplacer l'arrière-plan",
        instruction:
          "« Remplace l'arrière-plan par un bureau lumineux et calme. »",
        beforeLabel: "Avant",
        afterLabel: "Après",
        resultCaption: "Nouvel arrière-plan, vous restez vous-même",
        illustrativeNote: "Exemple illustratif",
      },
      {
        title: "Rendre une photo plus stylée",
        instruction: "« Rends cette photo plus nette et plus stylée. »",
        beforeLabel: "Avant",
        afterLabel: "Après",
        resultCaption: "Un rendu plus soigné, la même photo",
        illustrativeNote: "Exemple illustratif",
      },
      {
        title: "Améliorer une photo produit",
        instruction:
          "« Améliore cette photo produit pour ma boutique en ligne. »",
        beforeLabel: "Avant",
        afterLabel: "Après",
        resultCaption: "Plus net, avec un fond neutre",
        illustrativeNote: "Exemple illustratif",
      },
      {
        title: "Créer une image à partir d'un texte",
        instruction:
          "« Crée une illustration calme d'un coin café au petit matin. »",
        beforeLabel: "Avant",
        afterLabel: "Après",
        resultCaption: "Une image entièrement nouvelle, à partir d'un texte",
        illustrativeNote: "Exemple illustratif",
      },
      {
        title: "Ajuster la lumière et les couleurs",
        instruction:
          "« Rends la lumière plus chaude et les couleurs plus vives. »",
        beforeLabel: "Avant",
        afterLabel: "Après",
        resultCaption: "Des teintes plus douces et chaleureuses",
        illustrativeNote: "Exemple illustratif",
      },
    ],
    pricingEyebrow: "Gratuit et premium",
    pricingTitle: "Gratuit chaque jour. Achetez plus si vous voulez.",
    pricingBody:
      "Vous commencez toujours gratuitement. Vous pouvez ensuite choisir d'acheter plus — jamais obligatoire.",
    free: {
      name: "Gratuit",
      price: "0 €",
      suffix: "chaque jour",
      features: [
        "Crédit d'images gratuit chaque jour",
        "Nouvelles images et retouche photo",
        "Renouvellement automatique chaque jour",
      ],
      cta: "Commencer gratuitement",
    },
    credits: {
      name: "Pack premium",
      price: "5,00 €",
      suffix: "une fois",
      features: [
        "9 crédits d'images premium",
        "1 résultat premium utilisable livré = 1 crédit",
        "Qualité d'image medium",
        "Les crédits n'expirent pas",
        "Pas d'abonnement ni de renouvellement automatique",
      ],
      note: "L'option d'achat n'apparaît dans Messenger que lorsque votre crédit gratuit quotidien et vos éventuels crédits premium sont épuisés.",
    },
    trustEyebrow: "Confiance",
    trustTitle: "Clarté sur le paiement et vos données",
    trustCards: [
      {
        title: "Paiement sécurisé via Mollie",
        body: "Chaque achat passe par la page de paiement sécurisée de Mollie.",
      },
      {
        title: "Aucune donnée de paiement dans Messenger",
        body: "Leaderbot ne collecte jamais vos données de carte ou de paiement dans la conversation.",
      },
      {
        title: "Crédits ajoutés après confirmation",
        body: "Vos crédits premium ne sont ajoutés qu'une fois le paiement confirmé par Mollie.",
      },
      {
        title: "Confidentialité et suppression",
        body: "Vos données sont traitées avec soin. Demandez leur suppression quand vous le souhaitez — dans la limite des obligations légales de conservation ou des données gérées par Meta.",
        links: [
          { label: "Politique de confidentialité", href: "/privacy" },
          { label: "Supprimer mes données", href: "/data-deletion" },
        ],
      },
    ],
    faqEyebrow: "Questions fréquentes",
    faqTitle: "Tout ce que vous voulez savoir",
    questions: [
      {
        question: "Dois-je souscrire un abonnement ?",
        answer:
          "Non. Leaderbot fonctionne sans abonnement. Vous utilisez un crédit gratuit quotidien et n'achetez que si vous le choisissez, via un pack premium unique.",
      },
      {
        question: "Quand est-ce que je récupère des images gratuites ?",
        answer:
          "Votre crédit gratuit quotidien se renouvelle automatiquement chaque jour, jusqu'à un maximum mensuel. Une fois ce maximum atteint, vous devez attendre le mois suivant pour retrouver des images gratuites.",
      },
      {
        question: "Comment acheter des crédits premium ?",
        answer:
          "Quand votre crédit gratuit et vos éventuels crédits premium sont épuisés, Leaderbot vous envoie dans Messenger un lien de paiement personnel et sécurisé. Ce lien ouvre un paiement unique de 5,00 € via Mollie pour 9 crédits d'image ou de retouche premium. Un résultat premium utilisable livré avec succès consomme un crédit.",
      },
      {
        question: "Mes crédits premium expirent-ils ?",
        answer:
          "Non. Une fois achetés, vos 9 crédits premium restent disponibles jusqu'à ce que vous les utilisiez — sans date d'expiration.",
      },
      {
        question: "Puis-je modifier ma propre photo ?",
        answer:
          "Oui. Envoyez une photo à Leaderbot dans Messenger avec une description de la modification souhaitée, et vous recevrez la version modifiée.",
      },
      {
        question: "Comment mes photos et mes données sont-elles traitées ?",
        answer:
          "Leaderbot ne traite que ce qui est nécessaire pour créer vos images et suivre votre solde. Vous pouvez demander la suppression de vos données à tout moment.",
      },
      {
        question: "Que se passe-t-il en cas d'échec du paiement ?",
        answer:
          "En cas de paiement échoué ou non confirmé, aucun crédit premium n'est ajouté et rien n'est débité. Vous pouvez simplement réessayer l'achat via Messenger.",
      },
    ],
  },
  en: {
    languageLabel: "Language",
    nav: {
      howItWorks: "How it works",
      examples: "Examples",
      pricing: "Pricing",
      admin: "Admin",
    },
    headerCta: "Try it free on Messenger",
    eyebrow: "Create and edit photos via Messenger",
    title: "Create and edit photos, right inside Messenger",
    subtitle:
      "Tell Leaderbot what you want to see. Create a new image or edit your own photo with a simple text description.",
    heroPrimaryCta: "Open Leaderbot in Messenger",
    heroSecondaryCta: "See examples",
    microLine:
      "Free to try every day • No subscription • Secure payment via Mollie",
    chat: {
      label: "Example conversation",
      prompt: "Replace the background with a bright, calm office.",
      reply: "On it, one moment.",
      resultTag: "New background",
      resultCaption: "Sharp, professional result.",
      quotaCaption: "1 of your free images used today",
    },
    howEyebrow: "It's this simple",
    howTitle: "From message to image in three steps",
    steps: [
      { title: "Open Messenger", body: "Open Leaderbot in Messenger." },
      { title: "Send your request", body: "Send an instruction or a photo." },
      {
        title: "Get your image",
        body: "Get your image right inside the conversation.",
      },
    ],
    examplesEyebrow: "Real-world examples",
    examplesTitle: "What you can create with Leaderbot",
    examplesBody: "A few things you can ask Leaderbot directly in Messenger.",
    examples: [
      {
        title: "Replace the background",
        instruction: "“Replace the background with a bright, calm office.”",
        beforeLabel: "Before",
        afterLabel: "After",
        resultCaption: "New background, still you",
        illustrativeNote: "Illustrative example",
      },
      {
        title: "Make a photo more stylish",
        instruction: "“Make this photo sharper and more stylish.”",
        beforeLabel: "Before",
        afterLabel: "After",
        resultCaption: "A more polished look, same photo",
        illustrativeNote: "Illustrative example",
      },
      {
        title: "Improve a product photo",
        instruction: "“Improve this product photo for my webshop.”",
        beforeLabel: "Before",
        afterLabel: "After",
        resultCaption: "Sharper, with a clean background",
        illustrativeNote: "Illustrative example",
      },
      {
        title: "Create a new image from text",
        instruction:
          "“Create a calm illustration of a coffee corner in the morning sun.”",
        beforeLabel: "Before",
        afterLabel: "After",
        resultCaption: "A brand-new image, purely from text",
        illustrativeNote: "Illustrative example",
      },
      {
        title: "Adjust lighting and colours",
        instruction: "“Make the lighting warmer and the colours more vivid.”",
        beforeLabel: "Before",
        afterLabel: "After",
        resultCaption: "Softer, warmer tones",
        illustrativeNote: "Illustrative example",
      },
    ],
    pricingEyebrow: "Free & premium",
    pricingTitle: "Free every day. Top up if you ever want to.",
    pricingBody:
      "You always start for free. Afterwards you can choose to buy more — never required.",
    free: {
      name: "Free",
      price: "€0",
      suffix: "resets daily",
      features: [
        "Daily free image credit",
        "New images and photo editing",
        "Automatic daily reset",
      ],
      cta: "Start free",
    },
    credits: {
      name: "Premium pack",
      price: "€5.00",
      suffix: "one-time",
      features: [
        "9 premium image credits",
        "1 usable delivered premium result = 1 credit",
        "Medium image quality",
        "Credits never expire",
        "No subscription or automatic renewal",
      ],
      note: "You'll only see the purchase option in Messenger once both your daily free credit and any premium credits are used up.",
    },
    trustEyebrow: "Trust",
    trustTitle: "Clear about payment and your data",
    trustCards: [
      {
        title: "Secure payment via Mollie",
        body: "Every purchase runs through Mollie's secure payment page.",
      },
      {
        title: "No payment details in Messenger",
        body: "Leaderbot never collects card or payment details directly in the chat.",
      },
      {
        title: "Credits added after confirmed payment",
        body: "Your premium credits are only added once Mollie confirms the payment.",
      },
      {
        title: "Privacy and deletion",
        body: "Your data is handled carefully. Ask for it to be deleted whenever you want — within legal retention duties or data Meta controls.",
        links: [
          { label: "Privacy policy", href: "/privacy" },
          { label: "Delete your data", href: "/data-deletion" },
        ],
      },
    ],
    faqEyebrow: "Frequently asked questions",
    faqTitle: "Everything you want to know",
    questions: [
      {
        question: "Do I need a subscription?",
        answer:
          "No. Leaderbot works without a subscription. You use a daily free credit, and only buy more if you choose to, through a one-time premium pack.",
      },
      {
        question: "When do I get free images again?",
        answer:
          "Your daily free credit refreshes automatically every day, up to a monthly maximum. Once you reach that monthly maximum, you'll need to wait until next month for free images to return.",
      },
      {
        question: "How do I buy premium credits?",
        answer:
          "Once both your free daily credit and any premium credits are used up, Leaderbot sends you a personal, secure payment link in Messenger. That link opens a one-time €5.00 Mollie checkout for 9 premium image or editing credits. One successfully delivered usable premium result uses one credit.",
      },
      {
        question: "Do my premium credits expire?",
        answer:
          "No. Once purchased, your 9 premium credits stay available until you use them — with no expiry date.",
      },
      {
        question: "Can I edit my own photo?",
        answer:
          "Yes. Send a photo to Leaderbot in Messenger along with a description of the edit you want, and you'll get the edited version back.",
      },
      {
        question: "How are my photos and data handled?",
        answer:
          "Leaderbot only processes what's needed to create your images and track your balance. You can ask for your data to be deleted at any time.",
      },
      {
        question: "What happens if a payment fails?",
        answer:
          "If a payment fails or isn't confirmed, no premium credits are added and nothing is charged. You can simply try the purchase again through Messenger.",
      },
    ],
  },
};

const unavailablePremiumCopies: Record<
  AppLocale,
  {
    badge: string;
    note: string;
    faqAnswer: string;
    microLine: string;
    mollieCardBody: string;
    creditsCardBody: string;
  }
> = {
  "nl-BE": {
    badge: "Nog niet beschikbaar",
    note: "De aankoopoptie verschijnt in Messenger zodra ze beschikbaar is.",
    faqAnswer:
      "Nog niet beschikbaar. Deze optie verschijnt in Messenger zodra ze actief is.",
    microLine:
      "Dagelijks gratis proberen • Geen abonnement • Betalen komt eraan",
    mollieCardBody:
      "Betalen via Mollie is nog niet actief. Zodra dat wel zo is, verloopt elke aankoop via hun beveiligde betaalpagina.",
    creditsCardBody:
      "Er worden nog geen premiumcredits toegevoegd, want betalen is nog niet actief. Zodra dat zo is, gebeurt dat pas na bevestiging door Mollie.",
  },
  "fr-BE": {
    badge: "Pas encore disponible",
    note: "L'option d'achat apparaîtra dans Messenger dès qu'elle sera disponible.",
    faqAnswer:
      "Pas encore disponible. Cette option apparaîtra dans Messenger dès qu'elle sera active.",
    microLine:
      "Essai gratuit chaque jour • Sans abonnement • Paiement bientôt disponible",
    mollieCardBody:
      "Le paiement via Mollie n'est pas encore actif. Une fois actif, chaque achat passera par leur page de paiement sécurisée.",
    creditsCardBody:
      "Aucun crédit premium n'est encore ajouté, le paiement n'étant pas actif. Une fois actif, l'ajout se fera après confirmation par Mollie.",
  },
  en: {
    badge: "Not available yet",
    note: "The purchase option will appear in Messenger once it's live.",
    faqAnswer:
      "Not available yet. This option will appear in Messenger once it's live.",
    microLine: "Free to try every day • No subscription • Payment coming soon",
    mollieCardBody:
      "Payment via Mollie isn't live yet. Once it is, every purchase will run through their secure payment page.",
    creditsCardBody:
      "No premium credits are added yet, since payment isn't live. Once it is, that only happens after Mollie confirms the payment.",
  },
};

const exampleIcons = [Layers, Sparkles, Package, Type, SunMedium];
const trustCardIcons = [Lock, ShieldCheck, CheckCircle2, Trash2];

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
      className="inline-flex rounded-full border border-[#14203D]/10 bg-white p-1"
      role="group"
    >
      {SUPPORTED_LOCALES.map(option => (
        <button
          aria-pressed={option === locale}
          className={`min-h-8 rounded-full px-3 text-xs font-semibold transition-colors ${
            option === locale
              ? "bg-[#2541C9] text-white"
              : "text-[#14203D]/60 hover:bg-[#14203D]/5 hover:text-[#14203D]"
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
  const sizeClasses =
    size === "lg" ? "min-h-14 px-7 text-base" : "min-h-11 px-5 text-sm";
  const variantClasses =
    variant === "solid"
      ? "bg-[linear-gradient(120deg,#2541C9,#8B2FE0)] text-white shadow-[0_14px_30px_-14px_rgba(37,65,201,0.6)] transition hover:brightness-110"
      : variant === "onDark"
        ? "bg-white text-[#2541C9] hover:bg-white/90"
        : "border border-[#14203D]/15 text-[#14203D] hover:border-[#14203D]/30 hover:bg-[#14203D]/5";
  return (
    <a
      className={`inline-flex items-center justify-center gap-2 rounded-full font-bold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2541C9] ${sizeClasses} ${variantClasses}`}
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
  if (!loginConfigured) return null;
  return (
    <button
      className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#14203D]/50 transition hover:text-[#14203D]"
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

/** Free-image dots plus a distinct "+9" credit badge — the whole
 * free/paid mechanic in one glance inside the hero chat mockup. */
function QuotaMeter({ usedToday = 1 }: { usedToday?: number }) {
  return (
    <div className="flex items-center gap-2" aria-hidden="true">
      {Array.from({ length: 5 }).map((_, index) => (
        <span
          key={index}
          className={`h-2.5 w-2.5 rounded-full ${
            index < usedToday ? "bg-[#2541C9]" : "bg-[#14203D]/15"
          }`}
        />
      ))}
      <span className="ml-1 flex h-5 items-center rounded-full bg-gradient-to-r from-blue-100 to-violet-100 px-2 text-[10px] font-bold uppercase tracking-wide text-[#6D28D9]">
        +9
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
    <p className="text-sm font-bold uppercase tracking-[0.16em] text-[#2541C9]">
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
  const copy = landingCopies[locale];
  const unavailable = unavailablePremiumCopies[locale];
  const microLine = commercialBillingAvailable
    ? copy.microLine
    : unavailable.microLine;
  const premiumNote = commercialBillingAvailable
    ? copy.credits.note
    : unavailable.note;
  const trustCards = copy.trustCards.map((card, index) => {
    if (commercialBillingAvailable) return card;
    if (index === 0) return { ...card, body: unavailable.mollieCardBody };
    if (index === 2) return { ...card, body: unavailable.creditsCardBody };
    return card;
  });
  const questions = copy.questions.map((question, index) =>
    index === 2 && !commercialBillingAvailable
      ? { ...question, answer: unavailable.faqAnswer }
      : question
  );

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: questions.map(item => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.answer },
    })),
  };

  return (
    <main className="min-h-full bg-[#f6f2ea] text-[#14203D]">
      <a
        className="sr-only z-50 rounded-md bg-white px-4 py-2 text-[#14203D] focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
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
        <header className="flex min-h-20 flex-wrap items-center justify-between gap-4 border-b border-[#14203D]/10 py-3">
          <a
            className="flex items-center gap-3"
            href="/"
            aria-label="Leaderbot home"
          >
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-[linear-gradient(135deg,#2541C9,#8B2FE0)] font-black text-white">
              L
            </span>
            <span>
              <strong className="block text-base">Leaderbot</strong>
              <span className="block text-xs text-[#14203D]/50">
                leaderbot.live
              </span>
            </span>
          </a>
          <nav
            className="hidden items-center gap-6 text-sm text-[#14203D]/70 lg:flex"
            aria-label="Primary"
          >
            <a className="hover:text-[#14203D]" href="#how-it-works">
              {copy.nav.howItWorks}
            </a>
            <a className="hover:text-[#14203D]" href="#examples">
              {copy.nav.examples}
            </a>
            <a className="hover:text-[#14203D]" href="#pricing">
              {copy.nav.pricing}
            </a>
          </nav>
          <div className="flex items-center gap-4">
            <AdminLink copy={copy} loginConfigured={loginConfigured} />
            <LanguagePicker
              copy={copy}
              locale={locale}
              onChange={onLocaleChange}
            />
            <MessengerCta label={copy.headerCta} variant="solid" />
          </div>
        </header>

        <div
          className="grid gap-12 py-14 sm:py-20 lg:grid-cols-[minmax(0,1fr)_minmax(420px,0.85fr)] lg:items-center lg:py-24"
          id="main-content"
        >
          <div>
            <p className="text-sm font-bold uppercase tracking-[0.18em] text-[#2541C9]">
              {copy.eyebrow}
            </p>
            <h1 className="mt-5 max-w-3xl text-4xl font-semibold leading-[1.08] tracking-[-0.03em] text-[#14203D] sm:text-5xl lg:text-6xl">
              {copy.title}
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-[#14203D]/70">
              {copy.subtitle}
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              <MessengerCta
                label={copy.heroPrimaryCta}
                variant="solid"
                size="lg"
              />
              <a
                className="inline-flex min-h-14 items-center justify-center gap-2 rounded-full border border-[#14203D]/15 px-7 text-base font-bold text-[#14203D] transition hover:border-[#14203D]/30 hover:bg-[#14203D]/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2541C9]"
                href="#examples"
              >
                {copy.heroSecondaryCta}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </a>
            </div>
            <p className="mt-5 flex max-w-2xl items-start gap-2 text-sm leading-6 text-[#14203D]/60">
              <ShieldCheck
                className="mt-0.5 h-4 w-4 shrink-0 text-[#2541C9]"
                aria-hidden="true"
              />
              {microLine}
            </p>
          </div>

          <div className="relative mx-auto w-full max-w-xl">
            <div
              className="absolute -inset-10 rounded-full bg-gradient-to-br from-blue-200/50 via-violet-200/40 to-transparent blur-3xl"
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
            <div className="relative overflow-hidden rounded-[2rem] border border-[#14203D]/10 bg-white p-3 shadow-[0_30px_70px_-35px_rgba(20,32,61,0.35)]">
              <PointerGlow />
              <div className="rounded-[1.45rem] bg-[#f7f8fb] p-5 sm:p-6">
                <div className="flex items-center justify-between border-b border-[#14203D]/10 pb-4">
                  <div className="flex items-center gap-3">
                    <span className="grid h-10 w-10 place-items-center rounded-full bg-[linear-gradient(135deg,#2541C9,#8B2FE0)] text-white">
                      <MessageCircle className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <div>
                      <div className="font-semibold text-[#14203D]">
                        Leaderbot
                      </div>
                      <div className="text-xs text-emerald-700">
                        Messenger · online
                      </div>
                    </div>
                  </div>
                  <span className="rounded-full bg-[#14203D]/5 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-[#14203D]/60">
                    {copy.chat.label}
                  </span>
                </div>
                <div className="mt-5 grid gap-4">
                  <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-[#2541C9] px-4 py-3 text-sm leading-6 text-white">
                    {copy.chat.prompt}
                  </div>
                  <div className="max-w-[88%] rounded-2xl rounded-bl-md bg-white px-4 py-3 text-sm leading-6 text-[#14203D]/80 shadow-sm ring-1 ring-[#14203D]/10">
                    {copy.chat.reply}
                  </div>
                  <div className="overflow-hidden rounded-2xl border border-[#14203D]/10 bg-white p-4 shadow-sm">
                    <div className="flex min-h-32 items-end justify-between rounded-xl bg-[radial-gradient(circle_at_25%_20%,rgba(255,255,255,0.35),transparent_45%),linear-gradient(135deg,#2541C9,#6D28D9_60%,#8B2FE0)] p-4 text-white">
                      <div>
                        <div className="text-xs font-semibold uppercase tracking-[0.16em] text-white/80">
                          {copy.chat.resultTag}
                        </div>
                        <div className="mt-1 text-xl font-semibold">
                          {copy.chat.resultCaption}
                        </div>
                      </div>
                      <Sparkles
                        className="h-7 w-7 text-white"
                        aria-hidden="true"
                      />
                    </div>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                      <span className="flex items-center gap-2 text-xs text-[#14203D]/60">
                        <Check
                          className="h-4 w-4 text-[#2541C9]"
                          aria-hidden="true"
                        />
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
      </div>

      <section
        className="bg-white px-4 py-20 sm:px-6 lg:px-8 lg:py-28"
        id="how-it-works"
      >
        <div className="mx-auto max-w-7xl">
          <SectionEyebrow>{copy.howEyebrow}</SectionEyebrow>
          <h2 className="mt-4 max-w-3xl text-3xl font-semibold tracking-[-0.025em] text-[#14203D] sm:text-5xl">
            {copy.howTitle}
          </h2>
          <div className="mt-12 grid gap-5 lg:grid-cols-3">
            {copy.steps.map((step, index) => {
              const Icon = [MessageCircle, Send, ImageIcon][index] ?? Send;
              return (
                <article
                  className="relative overflow-hidden rounded-3xl border border-[#14203D]/10 bg-[#f6f2ea] p-7 shadow-sm transition hover:-translate-y-1 hover:shadow-md"
                  key={step.title}
                >
                  <div className="flex items-center gap-3">
                    <span className="grid h-11 w-11 place-items-center rounded-2xl bg-[#2541C9]/10 text-[#2541C9]">
                      <Icon className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <span className="text-4xl font-black tracking-[-0.06em] text-[#14203D]/10">
                      0{index + 1}
                    </span>
                  </div>
                  <h3 className="mt-6 text-xl font-semibold text-[#14203D]">
                    {step.title}
                  </h3>
                  <p className="mt-3 text-sm leading-6 text-[#14203D]/65">
                    {step.body}
                  </p>
                </article>
              );
            })}
          </div>
          <div className="mt-8">
            <MessengerCta label={copy.headerCta} variant="solid" />
          </div>
        </div>
      </section>

      <section className="px-4 py-20 sm:px-6 lg:px-8 lg:py-28" id="examples">
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr] lg:items-end">
            <div>
              <SectionEyebrow>{copy.examplesEyebrow}</SectionEyebrow>
              <h2 className="mt-4 text-3xl font-semibold tracking-[-0.025em] text-[#14203D] sm:text-5xl">
                {copy.examplesTitle}
              </h2>
            </div>
            <p className="max-w-2xl text-lg leading-8 text-[#14203D]/70">
              {copy.examplesBody}
            </p>
          </div>
          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {copy.examples.map((example, index) => {
              const Icon = exampleIcons[index] ?? Sparkles;
              return (
                <article
                  className="overflow-hidden rounded-3xl border border-[#14203D]/10 bg-white shadow-sm transition hover:-translate-y-1 hover:shadow-md"
                  key={example.title}
                >
                  <div className="grid grid-cols-2 gap-px bg-[#14203D]/10">
                    <div className="flex flex-col items-center justify-center gap-2 bg-[#f1ede3] px-3 py-8">
                      <ImageIcon
                        className="h-7 w-7 text-[#14203D]/35"
                        aria-hidden="true"
                      />
                      <span className="text-xs font-semibold uppercase tracking-wide text-[#14203D]/45">
                        {example.beforeLabel}
                      </span>
                    </div>
                    <div className="flex flex-col items-center justify-center gap-2 bg-[linear-gradient(160deg,#2541C9,#6D28D9_55%,#8B2FE0)] px-3 py-8 text-white">
                      <Icon className="h-7 w-7" aria-hidden="true" />
                      <span className="text-xs font-semibold uppercase tracking-wide">
                        {example.afterLabel}
                      </span>
                    </div>
                  </div>
                  <div className="p-6">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-[#14203D]/40">
                      {example.illustrativeNote}
                    </p>
                    <h3 className="mt-2 text-base font-semibold text-[#14203D]">
                      {example.title}
                    </h3>
                    <p className="mt-2 text-sm leading-6 text-[#14203D]/70">
                      {example.instruction}
                    </p>
                    <p className="mt-3 text-sm leading-6 text-[#14203D]/50">
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
            <h2 className="mx-auto mt-4 max-w-3xl text-3xl font-semibold tracking-[-0.025em] text-[#14203D] sm:text-5xl">
              {copy.pricingTitle}
            </h2>
            <p className="mx-auto mt-5 max-w-3xl text-lg leading-8 text-[#14203D]/70">
              {copy.pricingBody}
            </p>
          </div>
          <div className="mt-12 grid gap-5 lg:grid-cols-2">
            <article className="rounded-3xl border border-[#14203D]/10 bg-white p-7 shadow-sm sm:p-9">
              <h3 className="text-xl font-semibold text-[#14203D]">
                {copy.free.name}
              </h3>
              <div className="mt-6 flex items-end gap-3">
                <span className="text-5xl font-semibold tracking-[-0.04em] text-[#14203D]">
                  {copy.free.price}
                </span>
                <span className="pb-1 text-sm text-[#14203D]/50">
                  {copy.free.suffix}
                </span>
              </div>
              <ul className="mt-6 grid gap-3 text-sm text-[#14203D]/80">
                {copy.free.features.map(feature => (
                  <li className="flex items-start gap-3" key={feature}>
                    <Check
                      className="mt-0.5 h-4 w-4 shrink-0 text-[#2541C9]"
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

            <article className="relative overflow-hidden rounded-3xl border border-[#14203D]/10 bg-[#14203D] p-7 text-white shadow-xl sm:p-9">
              <div
                className="absolute -right-16 -top-16 h-48 w-48 rounded-full bg-gradient-to-br from-violet-500/40 to-blue-400/30 blur-3xl"
                aria-hidden="true"
              />
              {!commercialBillingAvailable ? (
                <span className="relative inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs font-bold uppercase tracking-wide text-white">
                  <CreditCard className="h-3.5 w-3.5" aria-hidden="true" />
                  {unavailable.badge}
                </span>
              ) : null}
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
              <ul className="relative mt-6 grid gap-3 text-sm text-white/85">
                {copy.credits.features.map(feature => (
                  <li className="flex items-start gap-3" key={feature}>
                    <Check
                      className="mt-0.5 h-4 w-4 shrink-0 text-[#8B2FE0]"
                      aria-hidden="true"
                    />
                    {feature}
                  </li>
                ))}
              </ul>
              <p className="relative mt-8 flex items-start gap-2 text-sm leading-6 text-white/70">
                <MessageCircle
                  className="mt-0.5 h-4 w-4 shrink-0 text-white/50"
                  aria-hidden="true"
                />
                {premiumNote}
              </p>
            </article>
          </div>
        </div>
      </section>

      <section className="bg-white px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
        <div className="mx-auto max-w-7xl">
          <div className="max-w-2xl">
            <SectionEyebrow>{copy.trustEyebrow}</SectionEyebrow>
            <h2 className="mt-4 text-3xl font-semibold tracking-[-0.025em] text-[#14203D] sm:text-5xl">
              {copy.trustTitle}
            </h2>
          </div>
          <div className="mt-12 grid gap-5 sm:grid-cols-2">
            {trustCards.map((card, index) => {
              const Icon = trustCardIcons[index] ?? ShieldCheck;
              return (
                <article
                  className="rounded-3xl border border-[#14203D]/10 bg-[#f6f2ea] p-7 shadow-sm"
                  key={card.title}
                >
                  <span className="grid h-11 w-11 place-items-center rounded-2xl bg-[#2541C9]/10 text-[#2541C9]">
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <h3 className="mt-5 text-lg font-semibold text-[#14203D]">
                    {card.title}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-[#14203D]/65">
                    {card.body}
                  </p>
                  {card.links ? (
                    <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
                      {card.links.map(link => (
                        <a
                          className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#2541C9] hover:underline"
                          href={link.href}
                          key={link.href}
                        >
                          {link.label}
                          <ArrowRight
                            className="h-3.5 w-3.5"
                            aria-hidden="true"
                          />
                        </a>
                      ))}
                    </div>
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
            <h2 className="mt-4 text-3xl font-semibold tracking-[-0.025em] text-[#14203D] sm:text-5xl">
              {copy.faqTitle}
            </h2>
          </div>
          <div className="divide-y divide-[#14203D]/10 border-y border-[#14203D]/10">
            {questions.map(item => (
              <details className="group py-5" key={item.question}>
                <summary className="flex cursor-pointer list-none items-center justify-between gap-5 font-semibold text-[#14203D]">
                  {item.question}
                  <span
                    className="text-2xl font-light text-[#2541C9] transition group-open:rotate-45"
                    aria-hidden="true"
                  >
                    +
                  </span>
                </summary>
                <p className="max-w-2xl pt-3 text-sm leading-6 text-[#14203D]/65">
                  {item.answer}
                </p>
              </details>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
