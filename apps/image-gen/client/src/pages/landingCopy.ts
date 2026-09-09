import type { AppLocale } from "./appLocales";

/**
 * All public marketing copy for the landing page, kept out of the component
 * so it can be checked by plain unit tests. The premium bundle price and
 * credit count here must match the checkout offer contract in
 * `creditCheckoutOffer.ts`; `landingCopy.test.ts` enforces that.
 */
export type LandingCopy = {
  languageLabel: string;
  nav: {
    howItWorks: string;
    examples: string;
    pricing: string;
    faq: string;
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
    disclaimer: string;
  };
  howEyebrow: string;
  howTitle: string;
  howBody: string;
  steps: Array<{ title: string; body: string }>;
  examplesEyebrow: string;
  examplesTitle: string;
  examplesBody: string;
  examplesDisclaimer: string;
  examples: Array<{ title: string; instruction: string; outcome: string }>;
  examplesCta: { title: string; body: string; cta: string };
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
  closing: { title: string; body: string; cta: string };
};

export const landingCopies: Record<AppLocale, LandingCopy> = {
  "nl-BE": {
    languageLabel: "Taal",
    nav: {
      howItWorks: "Hoe het werkt",
      examples: "Wat je kan vragen",
      pricing: "Prijs",
      faq: "Vragen",
      admin: "Beheerder",
    },
    headerCta: "Openen in Messenger",
    eyebrow: "Jouw fotohulp in Messenger",
    title: "Zeg wat je wil zien. Leaderbot maakt het.",
    subtitle:
      "Stuur een berichtje of een foto in Messenger. Leaderbot maakt er een nieuw beeld van, of past je eigen foto aan zoals jij het beschrijft. Geen extra app en geen apart account: alles gebeurt gewoon in het gesprek.",
    heroPrimaryCta: "Open Leaderbot in Messenger",
    heroSecondaryCta: "Bekijk wat je kan vragen",
    microLine:
      "Elke dag gratis beeldtegoed • Geen abonnement • Veilig betalen via Mollie",
    chat: {
      label: "Voorbeeldgesprek",
      prompt: "Vervang de achtergrond door een rustig kantoor met veel licht.",
      reply: "Doe ik. Eén moment.",
      resultTag: "Nieuwe achtergrond",
      resultCaption: "Zo komt je beeld terug in het gesprek",
      quotaCaption: "1 gratis beeld van vandaag gebruikt",
      disclaimer:
        "Nagebouwd gesprek ter illustratie. De tegels hierboven zijn geen echte resultaten.",
    },
    howEyebrow: "In drie stappen",
    howTitle: "Van berichtje naar beeld",
    howBody:
      "Je hoeft niets te installeren en niets in te stellen. Je typt gewoon wat je wil.",
    steps: [
      {
        title: "Open het gesprek",
        body: "Tik op een Messenger-knop op deze pagina. Het gesprek met Leaderbot opent meteen — installeren hoeft niet.",
      },
      {
        title: "Beschrijf wat je wil",
        body: "Typ in gewone taal wat je voor ogen hebt. Wil je je eigen foto aanpassen? Stuur ze mee met je vraag.",
      },
      {
        title: "Krijg je beeld terug",
        body: "Je resultaat komt in datzelfde gesprek. Niet helemaal juist? Vraag gerust een aanpassing.",
      },
    ],
    examplesEyebrow: "Wat je kan vragen",
    examplesTitle: "Opdrachten die je zo kan overnemen",
    examplesBody:
      "Dit zijn voorbeelden van vragen die je letterlijk in Messenger kan typen. Sommige werken op een foto die je meestuurt, andere maken een volledig nieuw beeld.",
    examplesDisclaimer:
      "De gekleurde tegels zijn abstracte illustraties, geen beelden die Leaderbot heeft gemaakt.",
    examples: [
      {
        title: "Achtergrond vervangen",
        instruction:
          "Vervang de achtergrond door een rustig kantoor met veel licht.",
        outcome: "Jij blijft zoals je bent, alleen je omgeving verandert.",
      },
      {
        title: "Foto opfrissen",
        instruction: "Maak deze foto strakker en stijlvoller.",
        outcome: "Dezelfde foto, met een verzorgdere look.",
      },
      {
        title: "Productfoto klaarmaken",
        instruction: "Verbeter deze productfoto voor mijn webshop.",
        outcome: "Scherper beeld op een rustige, neutrale achtergrond.",
      },
      {
        title: "Nieuw beeld uit tekst",
        instruction:
          "Maak een rustige illustratie van een koffiehoekje in de ochtendzon.",
        outcome: "Een volledig nieuw beeld, zonder dat je een foto stuurt.",
      },
      {
        title: "Licht en kleur bijstellen",
        instruction: "Maak de belichting warmer en de kleuren levendiger.",
        outcome: "Een zachtere, warmere sfeer in dezelfde foto.",
      },
    ],
    examplesCta: {
      title: "Iets anders in gedachten?",
      body: "Je bent niet gebonden aan deze voorbeelden. Beschrijf gewoon wat je wil zien.",
      cta: "Stel je eigen vraag",
    },
    pricingEyebrow: "Gratis en premium",
    pricingTitle: "Elke dag gratis beginnen",
    pricingBody:
      "Je krijgt elke dag opnieuw gratis beeldtegoed. Is dat op, dan kan je zelf kiezen om één keer bij te kopen. Verplicht is dat nooit.",
    free: {
      name: "Gratis",
      price: "€0",
      suffix: "elke dag opnieuw",
      features: [
        "Elke dag opnieuw gratis beeldtegoed",
        "Nieuwe beelden maken én je eigen foto's bewerken",
        "Reset automatisch, jij hoeft niets te doen",
      ],
      cta: "Gratis beginnen",
    },
    credits: {
      name: "Premiumbundel",
      price: "€4,99",
      suffix: "eenmalig",
      features: [
        "8 premium beeldcredits",
        "Medium beeldkwaliteit",
        "Credits vervallen niet",
        "Geen abonnement of automatische verlenging",
      ],
      note: "Je krijgt de aankoopoptie pas in Messenger te zien wanneer zowel je gratis dagtegoed als eventuele premiumcredits op zijn.",
    },
    trustEyebrow: "Duidelijk en eerlijk",
    trustTitle: "Wat er met je betaling en je gegevens gebeurt",
    trustCards: [
      {
        title: "Veilig betalen via Mollie",
        body: "Elke aankoop verloopt via de beveiligde betaalpagina van Mollie.",
      },
      {
        title: "Geen betaalgegevens in het gesprek",
        body: "Leaderbot vraagt of verzamelt nooit kaart- of bankgegevens in Messenger zelf.",
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
          "Wanneer zowel je gratis dagtegoed als eventuele premiumcredits op zijn, stuurt Leaderbot je in Messenger een persoonlijke, beveiligde betaallink. Die link opent een eenmalige Mollie-checkout van €4,99 voor 8 premiumcredits.",
      },
      {
        question: "Vervallen mijn premiumcredits?",
        answer:
          "Nee. Eenmaal aangekocht, blijven je 8 premiumcredits beschikbaar tot je ze gebruikt — zonder vervaldatum.",
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
        question: "Wat als een betaling mislukt of onduidelijk blijft?",
        answer:
          "Premiumcredits worden alleen toegevoegd nadat Mollie de betaling bevestigt. Blijft het resultaat onduidelijk, wacht dan tot die status bevestigd is en start geen tweede betaalpoging zolang de eerste niet duidelijk is. Twijfel je over een afschrijving, neem dan contact op via privacy@leaderbot.live.",
      },
    ],
    closing: {
      title: "Zin om iets te proberen?",
      body: "Open het gesprek en stuur je eerste opdracht. Je gratis dagtegoed staat klaar.",
      cta: "Open Leaderbot in Messenger",
    },
  },
  "fr-BE": {
    languageLabel: "Langue",
    nav: {
      howItWorks: "Comment ça marche",
      examples: "Que demander",
      pricing: "Prix",
      faq: "Questions",
      admin: "Administrateur",
    },
    headerCta: "Ouvrir dans Messenger",
    eyebrow: "Votre assistant photo dans Messenger",
    title: "Dites ce que vous voulez voir. Leaderbot le crée.",
    subtitle:
      "Envoyez un message ou une photo dans Messenger. Leaderbot en fait une nouvelle image, ou modifie votre propre photo comme vous le décrivez. Pas d'application en plus, pas de compte séparé : tout se passe dans la conversation.",
    heroPrimaryCta: "Ouvrir Leaderbot dans Messenger",
    heroSecondaryCta: "Voir ce que vous pouvez demander",
    microLine:
      "Crédit d'images gratuit chaque jour • Sans abonnement • Paiement sécurisé via Mollie",
    chat: {
      label: "Exemple de conversation",
      prompt: "Remplace l'arrière-plan par un bureau lumineux et calme.",
      reply: "C'est parti, un instant.",
      resultTag: "Nouvel arrière-plan",
      resultCaption: "Votre image revient dans la conversation",
      quotaCaption: "1 image gratuite utilisée aujourd'hui",
      disclaimer:
        "Conversation reconstituée à titre d'illustration. Les tuiles ci-dessus ne sont pas de vrais résultats.",
    },
    howEyebrow: "En trois étapes",
    howTitle: "Du message à l'image",
    howBody:
      "Rien à installer, rien à configurer. Vous écrivez simplement ce que vous voulez.",
    steps: [
      {
        title: "Ouvrez la conversation",
        body: "Touchez un bouton Messenger sur cette page. La conversation avec Leaderbot s’ouvre aussitôt — aucune installation nécessaire.",
      },
      {
        title: "Décrivez votre idée",
        body: "Écrivez en langage courant ce que vous imaginez. Vous voulez modifier votre propre photo ? Joignez-la à votre demande.",
      },
      {
        title: "Recevez votre image",
        body: "Le résultat arrive dans la même conversation. Pas tout à fait juste ? Demandez simplement un ajustement.",
      },
    ],
    examplesEyebrow: "Que demander",
    examplesTitle: "Des demandes que vous pouvez reprendre telles quelles",
    examplesBody:
      "Voici des exemples que vous pouvez taper littéralement dans Messenger. Certains s'appliquent à une photo que vous envoyez, d'autres créent une image entièrement nouvelle.",
    examplesDisclaimer:
      "Les tuiles colorées sont des illustrations abstraites, pas des images créées par Leaderbot.",
    examples: [
      {
        title: "Remplacer l'arrière-plan",
        instruction: "Remplace l'arrière-plan par un bureau lumineux et calme.",
        outcome: "Vous restez vous-même, seul le décor change.",
      },
      {
        title: "Rafraîchir une photo",
        instruction: "Rends cette photo plus nette et plus stylée.",
        outcome: "La même photo, avec un rendu plus soigné.",
      },
      {
        title: "Préparer une photo produit",
        instruction: "Améliore cette photo produit pour ma boutique en ligne.",
        outcome: "Une image plus nette sur un fond neutre et calme.",
      },
      {
        title: "Nouvelle image à partir d'un texte",
        instruction:
          "Crée une illustration calme d'un coin café au petit matin.",
        outcome: "Une image entièrement nouvelle, sans envoyer de photo.",
      },
      {
        title: "Ajuster lumière et couleurs",
        instruction: "Rends la lumière plus chaude et les couleurs plus vives.",
        outcome: "Une ambiance plus douce et plus chaleureuse.",
      },
    ],
    examplesCta: {
      title: "Une autre idée en tête ?",
      body: "Vous n'êtes pas limité à ces exemples. Décrivez simplement ce que vous voulez voir.",
      cta: "Posez votre propre question",
    },
    pricingEyebrow: "Gratuit et premium",
    pricingTitle: "Commencer gratuitement, chaque jour",
    pricingBody:
      "Vous recevez chaque jour un crédit d'images gratuit. Une fois épuisé, vous pouvez choisir d'acheter une seule fois. Ce n'est jamais obligatoire.",
    free: {
      name: "Gratuit",
      price: "0 €",
      suffix: "chaque jour",
      features: [
        "Crédit d'images gratuit chaque jour",
        "Créer de nouvelles images et retoucher les vôtres",
        "Renouvellement automatique, sans rien faire",
      ],
      cta: "Commencer gratuitement",
    },
    credits: {
      name: "Pack premium",
      price: "4,99 €",
      suffix: "une fois",
      features: [
        "8 crédits d'images premium",
        "Qualité d'image medium",
        "Les crédits n'expirent pas",
        "Pas d'abonnement ni de renouvellement automatique",
      ],
      note: "L'option d'achat n'apparaît dans Messenger que lorsque votre crédit gratuit quotidien et vos éventuels crédits premium sont épuisés.",
    },
    trustEyebrow: "Clair et honnête",
    trustTitle: "Ce qui arrive à votre paiement et à vos données",
    trustCards: [
      {
        title: "Paiement sécurisé via Mollie",
        body: "Chaque achat passe par la page de paiement sécurisée de Mollie.",
      },
      {
        title: "Aucune donnée de paiement dans la conversation",
        body: "Leaderbot ne demande ni ne collecte jamais de données de carte ou bancaires dans Messenger.",
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
          "Quand votre crédit gratuit et vos éventuels crédits premium sont épuisés, Leaderbot vous envoie dans Messenger un lien de paiement personnel et sécurisé. Ce lien ouvre un paiement unique de 4,99 € via Mollie pour 8 crédits premium.",
      },
      {
        question: "Mes crédits premium expirent-ils ?",
        answer:
          "Non. Une fois achetés, vos 8 crédits premium restent disponibles jusqu'à ce que vous les utilisiez — sans date d'expiration.",
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
        question:
          "Que se passe-t-il si un paiement échoue ou reste incertain ?",
        answer:
          "Les crédits premium ne sont ajoutés qu'après confirmation du paiement par Mollie. Si le résultat reste incertain, attendez que ce statut soit confirmé et ne lancez pas de deuxième tentative de paiement tant que la première n'est pas claire. En cas de doute sur un débit, contactez privacy@leaderbot.live.",
      },
    ],
    closing: {
      title: "Envie d'essayer ?",
      body: "Ouvrez la conversation et envoyez votre première demande. Votre crédit gratuit du jour vous attend.",
      cta: "Ouvrir Leaderbot dans Messenger",
    },
  },
  en: {
    languageLabel: "Language",
    nav: {
      howItWorks: "How it works",
      examples: "What to ask",
      pricing: "Pricing",
      faq: "Questions",
      admin: "Admin",
    },
    headerCta: "Open in Messenger",
    eyebrow: "Your photo helper in Messenger",
    title: "Say what you want to see. Leaderbot makes it.",
    subtitle:
      "Send a message or a photo in Messenger. Leaderbot turns it into a new image, or edits your own photo the way you describe it. No extra app and no separate account: it all happens in the chat.",
    heroPrimaryCta: "Open Leaderbot in Messenger",
    heroSecondaryCta: "See what you can ask",
    microLine:
      "Free image credits every day • No subscription • Secure payment via Mollie",
    chat: {
      label: "Example conversation",
      prompt: "Replace the background with a bright, calm office.",
      reply: "On it, one moment.",
      resultTag: "New background",
      resultCaption: "Your image comes back in the chat",
      quotaCaption: "1 free image used today",
      disclaimer:
        "Mocked-up conversation for illustration. The tiles above are not real results.",
    },
    howEyebrow: "In three steps",
    howTitle: "From message to image",
    howBody:
      "Nothing to install, nothing to set up. You just type what you want.",
    steps: [
      {
        title: "Open the chat",
        body: "Tap any Messenger button on this page. The chat with Leaderbot opens right away — no install needed.",
      },
      {
        title: "Describe what you want",
        body: "Write in plain language what you have in mind. Want to edit your own photo? Attach it to your request.",
      },
      {
        title: "Get your image back",
        body: "The result arrives in the same chat. Not quite right? Just ask for a tweak.",
      },
    ],
    examplesEyebrow: "What to ask",
    examplesTitle: "Requests you can copy as they are",
    examplesBody:
      "These are examples you can type straight into Messenger. Some work on a photo you attach, others create a brand-new image.",
    examplesDisclaimer:
      "The coloured tiles are abstract illustrations, not images made by Leaderbot.",
    examples: [
      {
        title: "Replace the background",
        instruction: "Replace the background with a bright, calm office.",
        outcome: "You stay exactly as you are, only the setting changes.",
      },
      {
        title: "Freshen up a photo",
        instruction: "Make this photo sharper and more stylish.",
        outcome: "The same photo, with a more polished look.",
      },
      {
        title: "Prepare a product photo",
        instruction: "Improve this product photo for my webshop.",
        outcome: "A sharper image on a calm, neutral background.",
      },
      {
        title: "New image from text",
        instruction:
          "Create a calm illustration of a coffee corner in the morning sun.",
        outcome: "A brand-new image, without attaching a photo.",
      },
      {
        title: "Adjust light and colour",
        instruction: "Make the lighting warmer and the colours more vivid.",
        outcome: "A softer, warmer mood in the same photo.",
      },
    ],
    examplesCta: {
      title: "Something else in mind?",
      body: "You are not limited to these examples. Just describe what you want to see.",
      cta: "Ask your own question",
    },
    pricingEyebrow: "Free & premium",
    pricingTitle: "Start free, every day",
    pricingBody:
      "You get free image credits every day. Once your daily allowance runs out, you can choose to buy once. It is never required.",
    free: {
      name: "Free",
      price: "€0",
      suffix: "resets daily",
      features: [
        "Free image credits every day",
        "Create new images and edit your own photos",
        "Resets automatically, nothing to do",
      ],
      cta: "Start free",
    },
    credits: {
      name: "Premium pack",
      price: "€4.99",
      suffix: "one-time",
      features: [
        "8 premium image credits",
        "Medium image quality",
        "Credits never expire",
        "No subscription or automatic renewal",
      ],
      note: "You'll only see the purchase option in Messenger once both your free daily allowance and any premium credits are used up.",
    },
    trustEyebrow: "Clear and honest",
    trustTitle: "What happens to your payment and your data",
    trustCards: [
      {
        title: "Secure payment via Mollie",
        body: "Every purchase runs through Mollie's secure payment page.",
      },
      {
        title: "No payment details in the chat",
        body: "Leaderbot never asks for or collects card or bank details inside Messenger.",
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
          "No. Leaderbot works without a subscription. You use a free daily allowance, and only buy more if you choose to, through a one-time premium pack.",
      },
      {
        question: "When do I get free images again?",
        answer:
          "Your free daily allowance refreshes automatically every day, up to a monthly maximum. Once you reach that monthly maximum, you'll need to wait until next month for free images to return.",
      },
      {
        question: "How do I buy premium credits?",
        answer:
          "Once both your free daily allowance and any premium credits are used up, Leaderbot sends you a personal, secure payment link in Messenger. That link opens a one-time €4.99 Mollie checkout for 8 premium credits.",
      },
      {
        question: "Do my premium credits expire?",
        answer:
          "No. Once purchased, your 8 premium credits stay available until you use them — with no expiry date.",
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
        question: "What if a payment fails or stays unclear?",
        answer:
          "Premium credits are only added after Mollie confirms the payment. If the outcome stays unclear, wait until that status is confirmed and do not start a second payment attempt while the first one is still uncertain. If you are unsure about a charge, contact privacy@leaderbot.live.",
      },
    ],
    closing: {
      title: "Feel like trying it?",
      body: "Open the chat and send your first request. Your free daily allowance is waiting.",
      cta: "Open Leaderbot in Messenger",
    },
  },
};

export const unavailablePremiumCopies: Record<
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
    badge: "Nu geen aankoopoptie",
    note: "Deze pagina toont op dit moment geen aankoopoptie. Zodra ze er is, verschijnt ze in Messenger.",
    faqAnswer:
      "Er is hier op dit moment geen aankoopoptie te zien. Zodra ze beschikbaar is, stuurt Leaderbot je in Messenger een persoonlijke, beveiligde betaallink.",
    microLine:
      "Elke dag gratis beeldtegoed • Geen abonnement • Nu geen nieuwe aankoop mogelijk",
    mollieCardBody:
      "Je kan hier op dit moment geen nieuwe aankoop starten. Een aankoop die wel doorgaat, verloopt altijd via de beveiligde betaalpagina van Mollie.",
    creditsCardBody:
      "Premiumcredits worden alleen toegevoegd nadat Mollie de betaling bevestigt. Zolang je hier geen aankoopoptie ziet, kan je geen nieuwe bundel starten.",
  },
  "fr-BE": {
    badge: "Pas d'option d'achat",
    note: "Cette page n'affiche pas d'option d'achat pour l'instant. Dès qu'elle existe, elle apparaît dans Messenger.",
    faqAnswer:
      "Aucune option d'achat n'est visible ici pour l'instant. Dès qu'elle sera disponible, Leaderbot vous enverra dans Messenger un lien de paiement personnel et sécurisé.",
    microLine:
      "Crédit d'images gratuit chaque jour • Sans abonnement • Pas de nouvel achat pour l'instant",
    mollieCardBody:
      "Vous ne pouvez pas lancer de nouvel achat ici pour l'instant. Un achat qui aboutit passe toujours par la page de paiement sécurisée de Mollie.",
    creditsCardBody:
      "Les crédits premium ne sont ajoutés qu'après confirmation du paiement par Mollie. Tant qu'aucune option d'achat n'apparaît ici, vous ne pouvez pas lancer de nouveau pack.",
  },
  en: {
    badge: "No purchase option",
    note: "This page is not showing a purchase option right now. Once there is one, it appears in Messenger.",
    faqAnswer:
      "There is no purchase option visible here right now. Once it is available, Leaderbot sends you a personal, secure payment link in Messenger.",
    microLine:
      "Free image credits every day • No subscription • No new purchase right now",
    mollieCardBody:
      "You cannot start a new purchase here right now. A purchase that does go ahead always runs through Mollie's secure payment page.",
    creditsCardBody:
      "Premium credits are only added after Mollie confirms the payment. While no purchase option appears here, you cannot start a new pack.",
  },
};
