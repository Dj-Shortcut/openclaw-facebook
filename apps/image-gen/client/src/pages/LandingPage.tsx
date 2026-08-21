import { getLoginUrl } from "@/const";
import {
  PUBLIC_BUSINESS_DETAILS,
  formatPublicBusinessAddress,
} from "@shared/publicBusinessDetails";
import {
  ArrowRight,
  Bot,
  Check,
  Database,
  Image,
  LogIn,
  Mail,
  MessageCircle,
  ShieldCheck,
  Sparkles,
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
    portal: string;
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
  premium: {
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
    interestSubject: "Interesse in Leaderbot Startpilot",
    nav: {
      product: "Product",
      howItWorks: "Hoe het werkt",
      pricing: "Prijs",
      faq: "Vragen",
      portal: "Inloggen met Facebook",
    },
    eyebrow: "AI-assistent voor Facebook Messenger",
    title: "Maak van je Facebookpagina een slimme klantenassistent.",
    body: "Leaderbot helpt je antwoorden, kennis en AI-beelden vanuit één afgeschermde werkruimte beheren. Je klant praat gewoon verder in Messenger.",
    primaryCta: "Bekijk hoe het werkt",
    secondaryCta: "Interesse doorgeven",
    noPayment:
      "Gratis verkennen. De Startpilot is nog niet publiek te koop en via deze pagina wordt niets aangerekend.",
    previewLabel: "Voorbeeldweergave",
    previewPrompt: "Maak een helder campagnebeeld voor onze zomeractie.",
    previewReply:
      "Komt eraan. Ik gebruik de instructies en merktoon uit je werkruimte.",
    previewReady: "AI-beeld klaar",
    trustItems: [
      "Aparte werkruimte per klant",
      "Messenger als vertrouwd kanaal",
      "Privacy- en gebruikscontrole",
    ],
    productEyebrow: "Eén werkruimte, één assistent",
    productTitle: "Jouw informatie blijft bij jouw organisatie.",
    productBody:
      "Stel de identiteit van je assistent in, verbind een Facebookpagina, voeg kennis toe en volg het gebruik zonder klantgegevens tussen werkruimtes te mengen.",
    features: [
      {
        title: "Eigen AI-identiteit",
        body: "Bepaal naam, toon, taal en instructies voor een herkenbare assistent.",
      },
      {
        title: "Kennis per werkruimte",
        body: "Beheer website-, tekst- en integratiebronnen binnen de juiste klantomgeving.",
      },
      {
        title: "Messenger-koppeling",
        body: "Verbind een Facebookpagina die je mag beheren en volg de kanaalstatus centraal.",
      },
      {
        title: "Tekst en AI-beelden",
        body: "Laat klanten natuurlijk vragen stellen en beelden genereren of bewerken.",
      },
      {
        title: "Gebruik en limieten",
        body: "Volg verbruik, quota en blokkades zodat kosten begrensd blijven.",
      },
      {
        title: "Privacybeheer",
        body: "Bied export, verwijdering en bewaarkeuzes vanuit dezelfde werkruimte.",
      },
    ],
    howEyebrow: "Zo werkt het",
    howTitle: "Van pagina naar assistent in drie duidelijke stappen.",
    steps: [
      {
        title: "Maak je werkruimte klaar",
        body: "Kies de identiteit, instructies en kennis die alleen voor jouw assistent gelden.",
      },
      {
        title: "Verbind Messenger",
        body: "Facebook Login koppelt één beheerbare Pagina automatisch; bij meerdere Pagina's kies je alleen de juiste.",
      },
      {
        title: "Test met echte vragen",
        body: "Begin gratis en beslis daarna of de eenmalige Startpilot voldoende waarde biedt.",
      },
    ],
    pricingEyebrow: "Eenmalige Startpilot",
    pricingTitle: "Test de kwaliteitsstap zonder abonnement.",
    pricingBody:
      "De geplande pilot geeft je 30 dagen afgebakend gebruik voor één vaste prijs. De publieke website verzamelt voorlopig alleen interesse.",
    free: {
      name: "Gratis toegang",
      price: "€0",
      suffix: "om te starten",
      body: "Verken de portal en test de basisfuncties binnen de beschikbare gratis limieten.",
      features: [
        "Werkruimte en AI-identiteit",
        "Messenger- en privacybeheer",
        "Beperkte gratis gebruikslimieten",
      ],
      cta: "Open het klantenportaal",
    },
    premium: {
      label: "Gepland — nog niet te koop",
      name: "Leaderbot Startpilot",
      price: "€19",
      suffix: "eenmalig in EUR",
      body: "Een afgebakende pilot om Leaderbot met je eigen Facebookpagina en de voelbare Images 2.0-kwaliteit te testen.",
      features: [
        "30 dagen · 1 werkruimte · 1 Facebookpagina",
        "300 AI-antwoorden",
        "20 Images 2.0-beelden · maximaal 5 per dag",
        "Geen abonnement, verlenging of kosten buiten het pakket",
      ],
      cta: "Laat weten dat je interesse hebt",
    },
    pricingDisclosure:
      "€19 is de geplande eenmalige prijs voor de Leaderbot Startpilot. Deze publieke pagina maakt nog geen aankoop aan. Checkout wordt pas in het ingelogde portaal zichtbaar nadat betaling, klantrechten en gebruikslimieten veilig zijn vrijgegeven.",
    faqEyebrow: "Veelgestelde vragen",
    faqTitle: "Duidelijk vóór je begint.",
    questions: [
      {
        question: "Kan ik de Startpilot nu al kopen?",
        answer:
          "Nog niet via deze publieke pagina. Je kunt interesse doorgeven zonder betaling. Na een gecontroleerde vrijgave kan een ingelogde klant de eenmalige checkout in het portaal zien.",
      },
      {
        question: "Wat gebeurt er na 30 dagen of wanneer een limiet op is?",
        answer:
          "De pilot stopt zonder automatische verlenging of extra kosten. Je kunt niet ongemerkt boven het inbegrepen gebruik gaan en er is geen automatische top-up.",
      },
      {
        question: "Is Leaderbot onderdeel van Meta of Facebook?",
        answer:
          "Nee. Leaderbot is een onafhankelijke dienst. Messenger, Facebookpagina’s en hun platformregels blijven onder beheer van Meta.",
      },
      {
        question: "Worden gegevens tussen klanten gedeeld?",
        answer:
          "Nee. Assistentinstellingen, kennis en klantcontext horen bij de eigen werkruimte en mogen niet tussen klanten worden vermengd.",
      },
      {
        question: "Voor wie wordt de Startpilot beschikbaar?",
        answer:
          "De eerste gecontroleerde lancering is gericht op België. Verkoop start pas wanneer betaling, facturatie, gebruiksrechten en voorwaarden aantoonbaar klaar zijn.",
      },
    ],
    contactEyebrow: "Interesse valideren",
    contactTitle: "Wil je Leaderbot voor €19 eenmalig testen?",
    contactBody:
      "Vertel kort waarvoor je de assistent wilt gebruiken. Je reactie helpt de gecontroleerde Startpilot plannen en maakt geen aankoop of abonnement aan.",
    contactCta: "Stuur je use-case",
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
    interestSubject: "Intérêt pour le pilote Leaderbot",
    nav: {
      product: "Produit",
      howItWorks: "Fonctionnement",
      pricing: "Prix",
      faq: "Questions",
      portal: "Se connecter avec Facebook",
    },
    eyebrow: "Assistant IA pour Facebook Messenger",
    title: "Transformez votre Page Facebook en assistant client intelligent.",
    body: "Leaderbot centralise les réponses, les connaissances et les images IA dans un espace de travail isolé. Vos clients continuent simplement dans Messenger.",
    primaryCta: "Voir le fonctionnement",
    secondaryCta: "Signaler mon intérêt",
    noPayment:
      "À découvrir gratuitement. Le pilote n'est pas encore en vente publique et cette page ne facture rien.",
    previewLabel: "Aperçu illustratif",
    previewPrompt: "Crée une image claire pour notre campagne d'été.",
    previewReply:
      "Je m'en occupe avec les instructions et le ton de votre espace.",
    previewReady: "Image IA prête",
    trustItems: [
      "Un espace par client",
      "Messenger comme canal familier",
      "Contrôles de confidentialité et d'usage",
    ],
    productEyebrow: "Un espace, un assistant",
    productTitle: "Vos informations restent dans votre organisation.",
    productBody:
      "Configurez l'identité, connectez une Page Facebook, ajoutez des connaissances et suivez l'usage sans mélanger les données des clients.",
    features: [
      {
        title: "Identité IA",
        body: "Définissez le nom, le ton, la langue et les instructions.",
      },
      {
        title: "Connaissances isolées",
        body: "Gérez les sources dans le bon espace client.",
      },
      {
        title: "Connexion Messenger",
        body: "Connectez une Page que vous êtes autorisé à gérer et suivez son état.",
      },
      {
        title: "Texte et images IA",
        body: "Répondez aux demandes et générez ou modifiez des images.",
      },
      {
        title: "Usage et limites",
        body: "Suivez les quotas et gardez les coûts sous contrôle.",
      },
      {
        title: "Contrôles de données",
        body: "Gérez l'export, la suppression et la conservation.",
      },
    ],
    howEyebrow: "Fonctionnement",
    howTitle: "De la Page à l'assistant en trois étapes claires.",
    steps: [
      {
        title: "Préparez l'espace",
        body: "Choisissez l'identité, les instructions et les connaissances.",
      },
      {
        title: "Connectez Messenger",
        body: "Facebook Login connecte automatiquement une Page administrable; s'il y en a plusieurs, choisissez simplement la bonne.",
      },
      {
        title: "Testez de vraies demandes",
        body: "Commencez gratuitement avant de décider si le pilote ponctuel vous convient.",
      },
    ],
    pricingEyebrow: "Pilote ponctuel",
    pricingTitle: "Testez la qualité sans abonnement.",
    pricingBody:
      "Le pilote prévu offre 30 jours d'usage délimité pour un prix fixe. Le site public recueille uniquement les marques d'intérêt pour l'instant.",
    free: {
      name: "Accès gratuit",
      price: "€0",
      suffix: "pour commencer",
      body: "Découvrez le portail et les fonctions de base dans les limites gratuites disponibles.",
      features: [
        "Espace et identité IA",
        "Gestion Messenger et confidentialité",
        "Limites gratuites",
      ],
      cta: "Ouvrir le portail client",
    },
    premium: {
      label: "Prévu — pas encore en vente",
      name: "Leaderbot Startpilot",
      price: "€19",
      suffix: "paiement unique en EUR",
      body: "Un pilote délimité pour tester Leaderbot avec votre Page Facebook et la qualité Images 2.0.",
      features: [
        "30 jours · 1 espace · 1 Page Facebook",
        "300 réponses IA",
        "20 images Images 2.0 · maximum 5 par jour",
        "Sans abonnement, renouvellement ni dépassement facturé",
      ],
      cta: "Signaler mon intérêt",
    },
    pricingDisclosure:
      "19 € est le prix unique prévu pour le pilote Leaderbot. Cette page publique ne crée aucun achat. Le checkout n'apparaîtra dans le portail connecté qu'après validation des paiements, droits et limites d'usage.",
    faqEyebrow: "Questions fréquentes",
    faqTitle: "Tout savoir avant de commencer.",
    questions: [
      {
        question: "Puis-je déjà acheter le pilote ?",
        answer:
          "Pas encore depuis cette page publique. Vous pouvez signaler votre intérêt sans paiement. Après une mise en service contrôlée, le checkout unique pourra apparaître dans le portail connecté.",
      },
      {
        question:
          "Que se passe-t-il après 30 jours ou lorsqu'une limite est atteinte ?",
        answer:
          "Le pilote s'arrête sans renouvellement automatique ni frais supplémentaires. Il n'y a ni dépassement facturé ni recharge automatique.",
      },
      {
        question: "Leaderbot fait-il partie de Meta ?",
        answer:
          "Non. Leaderbot est indépendant; les services et règles Facebook restent gérés par Meta.",
      },
      {
        question: "Les données sont-elles partagées entre clients ?",
        answer:
          "Non. Les paramètres, connaissances et contextes restent liés à leur espace.",
      },
      {
        question: "Où le pilote sera-t-il lancé ?",
        answer:
          "La première disponibilité contrôlée vise la Belgique, après validation complète des paiements, droits d'usage et conditions.",
      },
    ],
    contactEyebrow: "Valider l'intérêt",
    contactTitle: "Souhaitez-vous tester Leaderbot pour 19 € une seule fois ?",
    contactBody:
      "Expliquez brièvement votre usage. Votre réponse aide à organiser le pilote contrôlé et ne crée aucun achat ni abonnement.",
    contactCta: "Envoyer mon cas d'usage",
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
    interestSubject: "Interest in the Leaderbot Startpilot",
    nav: {
      product: "Product",
      howItWorks: "How it works",
      pricing: "Pricing",
      faq: "FAQ",
      portal: "Sign in with Facebook",
    },
    eyebrow: "AI assistant for Facebook Messenger",
    title: "Turn your Facebook Page into a focused customer assistant.",
    body: "Leaderbot keeps replies, knowledge and AI images in one isolated workspace while your customers continue the conversation in Messenger.",
    primaryCta: "See how it works",
    secondaryCta: "Share your interest",
    noPayment:
      "Explore for free. The Startpilot is not on public sale yet and this page does not charge you.",
    previewLabel: "Illustrative preview",
    previewPrompt: "Create a clear campaign image for our summer promotion.",
    previewReply:
      "On it. I will use the instructions and brand tone from your workspace.",
    previewReady: "AI image ready",
    trustItems: [
      "A separate workspace per customer",
      "Messenger as a familiar channel",
      "Privacy and usage controls",
    ],
    productEyebrow: "One workspace, one assistant",
    productTitle: "Your information stays with your organisation.",
    productBody:
      "Set the assistant identity, connect a Facebook Page, add knowledge and monitor usage without mixing customer data across workspaces.",
    features: [
      {
        title: "Owned AI identity",
        body: "Set the name, tone, language and instructions.",
      },
      {
        title: "Workspace knowledge",
        body: "Keep sources inside the right customer environment.",
      },
      {
        title: "Messenger connection",
        body: "Connect a Page you are authorized to manage and monitor channel health.",
      },
      {
        title: "Text and AI images",
        body: "Answer requests and generate or edit images naturally.",
      },
      {
        title: "Usage and limits",
        body: "Monitor quotas and keep billable usage bounded.",
      },
      {
        title: "Privacy controls",
        body: "Manage export, deletion and retention choices.",
      },
    ],
    howEyebrow: "How it works",
    howTitle: "From Page to assistant in three clear steps.",
    steps: [
      {
        title: "Prepare the workspace",
        body: "Choose the identity, instructions and knowledge.",
      },
      {
        title: "Connect Messenger",
        body: "Facebook Login connects one manageable Page automatically; if there are several, just choose the right one.",
      },
      {
        title: "Test real questions",
        body: "Start for free before deciding whether the one-time pilot is worthwhile.",
      },
    ],
    pricingEyebrow: "One-time Startpilot",
    pricingTitle: "Test the quality step without a subscription.",
    pricingBody:
      "The planned pilot provides 30 days of bounded usage for one fixed price. The public website only collects interest for now.",
    free: {
      name: "Free access",
      price: "€0",
      suffix: "to get started",
      body: "Explore the portal and core features within the available free limits.",
      features: [
        "Workspace and AI identity",
        "Messenger and privacy controls",
        "Limited free usage",
      ],
      cta: "Open the customer portal",
    },
    premium: {
      label: "Planned — not for sale yet",
      name: "Leaderbot Startpilot",
      price: "€19",
      suffix: "one-time in EUR",
      body: "A bounded pilot to test Leaderbot with your own Facebook Page and the visible Images 2.0 quality step.",
      features: [
        "30 days · 1 workspace · 1 Facebook Page",
        "300 AI answers",
        "20 Images 2.0 images · maximum 5 per day",
        "No subscription, renewal or overage charges",
      ],
      cta: "Tell us you are interested",
    },
    pricingDisclosure:
      "€19 is the planned one-time price for the Leaderbot Startpilot. This public page does not create a purchase. Checkout will appear in the signed-in portal only after payments, entitlements and usage limits are safely released.",
    faqEyebrow: "Frequently asked questions",
    faqTitle: "Clear before you begin.",
    questions: [
      {
        question: "Can I buy the Startpilot now?",
        answer:
          "Not through this public page yet. You can share interest without payment. After a controlled release, signed-in customers may see the one-time checkout in the portal.",
      },
      {
        question: "What happens after 30 days or when a limit is used?",
        answer:
          "The pilot stops without automatic renewal or extra charges. There are no overage charges or automatic top-ups.",
      },
      {
        question: "Is Leaderbot part of Meta?",
        answer:
          "No. Leaderbot is independent; Facebook services and platform rules remain with Meta.",
      },
      {
        question: "Is customer data shared?",
        answer:
          "No. Assistant settings, knowledge and customer context remain bound to their workspace.",
      },
      {
        question: "Where will the Startpilot launch first?",
        answer:
          "The first controlled release is aimed at Belgium, after payments, invoicing, entitlements and terms are validated.",
      },
    ],
    contactEyebrow: "Validate demand",
    contactTitle: "Would you test Leaderbot for a one-time €19?",
    contactBody:
      "Tell us briefly how you would use it. Your response helps plan the controlled Startpilot and does not create a purchase or subscription.",
    contactCta: "Send your use case",
    companyTitle: "Business information",
    enterpriseLabel: "Enterprise number",
    vatLabel: "VAT number",
    addressLabel: "Address",
    phoneLabel: "Phone",
    emailLabel: "Email",
    loginUnavailable: "Sign-in is not configured in this environment.",
  },
};

const featureIcons = [
  Bot,
  Database,
  MessageCircle,
  Image,
  Sparkles,
  ShieldCheck,
];

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

function PortalButton({
  copy,
  loginConfigured,
  variant = "light",
}: {
  copy: LandingCopy;
  loginConfigured: boolean;
  variant?: "accent" | "light";
}) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-full text-sm shadow-sm transition disabled:cursor-not-allowed disabled:opacity-60 ${
        variant === "accent"
          ? "min-h-12 bg-lime-300 px-6 font-bold text-[#10211d] hover:bg-lime-200"
          : "min-h-11 border border-stone-300 bg-white px-5 font-semibold text-stone-900 hover:border-stone-400 hover:bg-stone-50"
      }`}
      disabled={!loginConfigured}
      title={!loginConfigured ? copy.loginUnavailable : undefined}
      type="button"
      onClick={() => {
        const loginUrl = getLoginUrl("/portal");
        if (loginUrl) window.location.href = loginUrl;
      }}
    >
      <LogIn className="h-4 w-4" aria-hidden="true" />
      {copy.nav.portal}
    </button>
  );
}

export default function LandingPage({
  locale,
  loginConfigured,
  onLocaleChange,
}: {
  locale: AppLocale;
  loginConfigured: boolean;
  onLocaleChange: (locale: AppLocale) => void;
}) {
  const copy = landingCopies[locale];
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
            <LanguagePicker
              copy={copy}
              locale={locale}
              onChange={onLocaleChange}
            />
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
                <PortalButton
                  copy={copy}
                  loginConfigured={loginConfigured}
                  variant="accent"
                />
                <a
                  className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full border border-white/20 px-6 text-sm font-bold text-white transition hover:bg-white/10"
                  href="#how-it-works"
                >
                  {copy.primaryCta}
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </a>
                <a
                  className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full border border-white/20 px-6 text-sm font-bold text-white transition hover:bg-white/10"
                  href={interestHref}
                >
                  <Mail className="h-4 w-4" aria-hidden="true" />
                  {copy.secondaryCta}
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
                        <Bot className="h-5 w-5" aria-hidden="true" />
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
                      <div className="mt-3 flex items-center gap-2 text-xs text-stone-300">
                        <Check
                          className="h-4 w-4 text-lime-300"
                          aria-hidden="true"
                        />
                        {copy.previewReady}
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
                <PortalButton copy={copy} loginConfigured={loginConfigured} />
              </div>
            </article>

            <article className="rounded-3xl border border-[#10211d] bg-[#10211d] p-7 text-white shadow-xl shadow-stone-900/10 sm:p-9">
              <span className="inline-flex rounded-full bg-lime-300 px-3 py-1 text-xs font-bold uppercase tracking-wide text-[#10211d]">
                {copy.premium.label}
              </span>
              <h3 className="mt-5 text-xl font-semibold">
                {copy.premium.name}
              </h3>
              <div className="mt-6 flex items-end gap-3">
                <span className="text-5xl font-semibold tracking-[-0.04em]">
                  {copy.premium.price}
                </span>
                <span className="pb-1 text-sm text-stone-400">
                  {copy.premium.suffix}
                </span>
              </div>
              <p className="mt-5 text-sm leading-6 text-stone-300">
                {copy.premium.body}
              </p>
              <ul className="mt-6 grid gap-3 text-sm text-stone-200">
                {copy.premium.features.map(feature => (
                  <li className="flex items-start gap-3" key={feature}>
                    <Check
                      className="mt-0.5 h-4 w-4 shrink-0 text-lime-300"
                      aria-hidden="true"
                    />
                    {feature}
                  </li>
                ))}
              </ul>
              <a
                className="mt-8 inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-lime-300 px-5 text-sm font-bold text-[#10211d] transition hover:bg-lime-200"
                href={interestHref}
              >
                <Mail className="h-4 w-4" aria-hidden="true" />
                {copy.premium.cta}
              </a>
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
