export const SUPPORTED_LOCALES = ["nl-BE", "fr-BE", "en"] as const;
export type AppLocale = typeof SUPPORTED_LOCALES[number];

export const DEFAULT_LOCALE: AppLocale = "nl-BE";
export const FALLBACK_LOCALE: AppLocale = "en";

const enCopy = {
  brand: {
    subtitle: "Customer portal",
  },
  locale: {
    label: "Language",
    nl: "NL",
    fr: "FR",
    en: "EN",
  },
  navAria: "Main navigation",
  nav: {
    dashboard: "Dashboard",
    identity: "AI identity",
    channels: "Channels",
    knowledge: "Knowledge",
    usage: "Usage",
    privacy: "Privacy",
  },
  sidebar: {
    dataScoped: "Customer data stays workspace-scoped.",
  },
  account: {
    signedIn: "Signed in",
  },
  notices: {
    previewData: "Portal data could not be loaded. Showing local preview data.",
    loading: "Loading portal data...",
    identitySaved: "AI identity saved.",
    identitySaveError: "Could not save AI identity.",
    facebookAppMissing: "Facebook app id is not configured on the portal backend.",
    facebookAuthorizationOpened:
      "Facebook authorization opened. Return here after approving the Page.",
    facebookConnectError: "Could not start Facebook connect.",
  },
  date: {
    notAvailable: "Not available",
    notUpdated: "Not updated yet",
  },
  common: {
    workspace: "Workspace",
    today: "Today",
    saving: "Saving",
    opening: "Opening",
    enabled: "Enabled",
    disabled: "Disabled",
    freePlan: "Free plan",
    items: "items",
    page: "Page",
    transport: "Transport",
    messenger: "Messenger",
    noPageConnected: "No Page connected",
    customerPageRequired: "Customer-owned Page required",
  },
  status: {
    connected: "Connected",
    missing_permissions: "Missing permissions",
    token_expired: "Token expired",
    webhook_unhealthy: "Webhook unhealthy",
    disconnected: "Disconnected",
  },
  sourceTypes: {
    upload: "Upload",
    website: "Website",
    manual_text: "Manual text",
    integration: "Integration",
  },
  sourceStatus: {
    active: "Active",
    queued: "Queued",
    indexing: "Indexing",
    error: "Error",
    disabled: "Disabled",
  },
  upgradeStatus: {
    requested: "Requested",
    contacted: "Contacted",
    completed: "Completed",
    rejected: "Rejected",
  },
  upgradeReasons: {
    image_limit_reached: "Image limit reached",
    blocked_usage: "Blocked usage today",
    none: "No upgrade trigger",
  },
  plan: {
    free: "Free plan",
  },
  dashboard: {
    title: "Workspace command center",
    body:
      "Customer-owned AI settings, channel health, usage, and privacy controls stay scoped to this workspace.",
    metrics: {
      imagesLeft: "Images left",
      messages: "Messages",
      activeSources: "Active sources",
      blocked: "Blocked",
    },
    nextAction: "Next action",
    connectedChannel: "connected channel",
    connectedChannels: "connected channels",
    actions: {
      upgradeTitle: "Review plan upgrade",
      connectTitle: "Connect Facebook Page",
      connectBody: "Messenger stays inactive until a customer-owned Page is authorized.",
      knowledgeTitle: "Add customer knowledge",
      knowledgeBody:
        "The assistant can answer from its workspace profile, but no active knowledge sources are registered.",
      identityTitle: "Review AI identity",
      identityBody:
        "Keep the assistant name, tone, and instructions aligned before broader customer traffic.",
    },
    setup: {
      facebookLabel: "Facebook Messenger",
      facebookAuthorized: "Page authorized",
      facebookNeeded: "Page authorization needed",
      identityLabel: "AI identity",
      identityDetail: "tone",
      languageDetail: "language",
      knowledgeLabel: "Knowledge",
      totalSources: "total sources",
      active: "active",
      activeSingular: "active",
      activePlural: "active",
      privacyLabel: "Privacy controls",
      retention: "day image memory retention",
      analyticsOn: "Analytics on",
      analyticsOff: "Analytics off",
    },
  },
  identity: {
    eyebrow: "AI identity",
    title: "Owned assistant profile",
    body: "This profile is the customer-facing voice across connected channels.",
    assistantName: "Assistant name",
    instructions: "Instructions",
    tone: "Tone",
    language: "Language",
    modelDefault: "Model default",
    save: "Save identity",
  },
  channels: {
    eyebrow: "Channels",
    title: "Facebook Messenger",
    body:
      "Page tokens stay encrypted on the portal backend. The browser receives Page status and display metadata only.",
    lastCheck: "Last check",
    connect: "Connect Facebook Page",
  },
  knowledge: {
    eyebrow: "Knowledge",
    title: "Workspace knowledge sources",
    body:
      "Registered sources belong to this customer workspace and are not shared across tenants.",
    metrics: {
      totalSources: "Total sources",
      active: "Active",
      lastUpdate: "Last update",
    },
    indexing: "Indexing",
    indexingEnabled: "Knowledge indexing enabled",
    indexingPaused: "Knowledge indexing paused",
    indexingEnabledBody:
      "Active sources can be prepared for assistant retrieval inside the workspace boundary.",
    indexingPausedBody:
      "Sources remain registered, but indexing is disabled for this workspace.",
    emptyTitle: "No knowledge sources registered",
    emptyBody: "The assistant currently relies on its identity and instructions.",
  },
  usage: {
    eyebrow: "Usage and limits",
    body:
      "Usage is counted at workspace level so quota and billing signals stay tied to the owning tenant.",
    metrics: {
      imagesLeft: "Images left",
      imagesUsed: "Images used",
      messages: "Messages",
      blocked: "Blocked",
    },
    upgrade: "Upgrade",
    upgradeRecommended: "Upgrade recommended",
    planHealthy: "Plan healthy",
    imageLimit: "Image limit",
    perDay: "per day",
    request: "request",
    emptyTitle: "No upgrade requests",
    emptyBody: "Manual upgrade handling is ready when usage needs it.",
  },
  privacy: {
    eyebrow: "Privacy",
    title: "Customer data controls",
    body:
      "Customer content remains private by default, with export and deletion request paths attached to this workspace.",
    knowledgeIndexing: "Knowledge indexing",
    usageAnalytics: "Usage analytics",
    imageMemoryRetention: "Image memory retention",
    days: "days",
    links: {
      privacy: "Privacy policy",
      terms: "Terms",
      dataDeletion: "Data deletion",
      exportRequest: "Request data export",
      deletionRequest: "Request workspace deletion",
    },
  },
};

export type LocaleCopy = typeof enCopy;

const nlBeCopy: LocaleCopy = {
  brand: {
    subtitle: "Klantenportaal",
  },
  locale: {
    label: "Taal",
    nl: "NL",
    fr: "FR",
    en: "EN",
  },
  navAria: "Hoofdnavigatie",
  nav: {
    dashboard: "Dashboard",
    identity: "AI-identiteit",
    channels: "Kanalen",
    knowledge: "Kennis",
    usage: "Gebruik",
    privacy: "Privacy",
  },
  sidebar: {
    dataScoped: "Klantdata blijft binnen deze werkruimte.",
  },
  account: {
    signedIn: "Aangemeld",
  },
  notices: {
    previewData: "Portaaldata konden niet geladen worden. We tonen voorbeelddata.",
    loading: "Portaaldata laden...",
    identitySaved: "AI-identiteit opgeslagen.",
    identitySaveError: "AI-identiteit kon niet opgeslagen worden.",
    facebookAppMissing: "Facebook app-id is niet ingesteld op de portal-backend.",
    facebookAuthorizationOpened:
      "Facebook-autorisatie geopend. Kom hier terug nadat je de pagina hebt goedgekeurd.",
    facebookConnectError: "Facebook-koppeling kon niet gestart worden.",
  },
  date: {
    notAvailable: "Niet beschikbaar",
    notUpdated: "Nog niet bijgewerkt",
  },
  common: {
    workspace: "Werkruimte",
    today: "Vandaag",
    saving: "Opslaan",
    opening: "Openen",
    enabled: "Ingeschakeld",
    disabled: "Uitgeschakeld",
    freePlan: "Gratis plan",
    items: "items",
    page: "Pagina",
    transport: "Transport",
    messenger: "Messenger",
    noPageConnected: "Geen pagina verbonden",
    customerPageRequired: "Klantpagina vereist",
  },
  status: {
    connected: "Verbonden",
    missing_permissions: "Rechten ontbreken",
    token_expired: "Token verlopen",
    webhook_unhealthy: "Webhook ongezond",
    disconnected: "Niet verbonden",
  },
  sourceTypes: {
    upload: "Upload",
    website: "Website",
    manual_text: "Handmatige tekst",
    integration: "Integratie",
  },
  sourceStatus: {
    active: "Actief",
    queued: "In wachtrij",
    indexing: "Indexeren",
    error: "Fout",
    disabled: "Uitgeschakeld",
  },
  upgradeStatus: {
    requested: "Aangevraagd",
    contacted: "Gecontacteerd",
    completed: "Afgerond",
    rejected: "Geweigerd",
  },
  upgradeReasons: {
    image_limit_reached: "Beeldlimiet bereikt",
    blocked_usage: "Gebruik vandaag geblokkeerd",
    none: "Geen upgrade-trigger",
  },
  plan: {
    free: "Gratis plan",
  },
  dashboard: {
    title: "Werkruimteoverzicht",
    body:
      "Beheer AI-instellingen, kanaalstatus, gebruik en privacy-instellingen binnen deze werkruimte.",
    metrics: {
      imagesLeft: "Beelden over",
      messages: "Berichten",
      activeSources: "Actieve bronnen",
      blocked: "Geblokkeerd",
    },
    nextAction: "Volgende stap",
    connectedChannel: "verbonden kanaal",
    connectedChannels: "verbonden kanalen",
    actions: {
      upgradeTitle: "Upgrade bekijken",
      connectTitle: "Facebook-pagina verbinden",
      connectBody: "Messenger blijft inactief tot een klantpagina is goedgekeurd.",
      knowledgeTitle: "Kennis toevoegen",
      knowledgeBody:
        "De assistent kan antwoorden vanuit het werkruimteprofiel, maar er zijn nog geen actieve kennisbronnen.",
      identityTitle: "AI-identiteit nakijken",
      identityBody:
        "Hou naam, toon en instructies actueel voordat er meer klantverkeer komt.",
    },
    setup: {
      facebookLabel: "Facebook Messenger",
      facebookAuthorized: "Pagina goedgekeurd",
      facebookNeeded: "Pagina-autorisatie nodig",
      identityLabel: "AI-identiteit",
      identityDetail: "toon",
      languageDetail: "taal",
      knowledgeLabel: "Kennis",
      totalSources: "bronnen totaal",
      active: "actief",
      activeSingular: "actief",
      activePlural: "actief",
      privacyLabel: "Privacy-instellingen",
      retention: "dagen beeldgeheugen",
      analyticsOn: "Analytics aan",
      analyticsOff: "Analytics uit",
    },
  },
  identity: {
    eyebrow: "AI-identiteit",
    title: "Eigen assistentprofiel",
    body: "Dit profiel is de klantgerichte stem voor alle gekoppelde kanalen.",
    assistantName: "Naam van assistent",
    instructions: "Instructies",
    tone: "Toon",
    language: "Taal",
    modelDefault: "Standaardmodel",
    save: "Identiteit opslaan",
  },
  channels: {
    eyebrow: "Kanalen",
    title: "Facebook Messenger",
    body:
      "Paginatokens blijven versleuteld op de portal-backend. De browser krijgt alleen paginastatus en weergavemetadata.",
    lastCheck: "Laatste check",
    connect: "Facebook-pagina verbinden",
  },
  knowledge: {
    eyebrow: "Kennis",
    title: "Kennisbronnen van deze werkruimte",
    body:
      "Geregistreerde bronnen horen bij deze klantwerkruimte en worden niet gedeeld tussen tenants.",
    metrics: {
      totalSources: "Bronnen totaal",
      active: "Actief",
      lastUpdate: "Laatste update",
    },
    indexing: "Indexering",
    indexingEnabled: "Kennisindexering ingeschakeld",
    indexingPaused: "Kennisindexering gepauzeerd",
    indexingEnabledBody:
      "Actieve bronnen kunnen binnen de werkruimtegrens klaargemaakt worden voor assistent-retrieval.",
    indexingPausedBody:
      "Bronnen blijven geregistreerd, maar indexering staat uit voor deze werkruimte.",
    emptyTitle: "Geen kennisbronnen geregistreerd",
    emptyBody: "De assistent gebruikt voorlopig alleen identiteit en instructies.",
  },
  usage: {
    eyebrow: "Gebruik en limieten",
    body:
      "Gebruik wordt op werkruimteniveau geteld, zodat quota en billing-signalen bij de juiste tenant blijven.",
    metrics: {
      imagesLeft: "Beelden over",
      imagesUsed: "Beelden gebruikt",
      messages: "Berichten",
      blocked: "Geblokkeerd",
    },
    upgrade: "Upgrade",
    upgradeRecommended: "Upgrade aanbevolen",
    planHealthy: "Plan in orde",
    imageLimit: "Beeldlimiet",
    perDay: "per dag",
    request: "aanvraag",
    emptyTitle: "Geen upgrade-aanvragen",
    emptyBody: "Handmatige upgradeflow staat klaar wanneer gebruik dat vraagt.",
  },
  privacy: {
    eyebrow: "Privacy",
    title: "Klantdata beheren",
    body:
      "Klantcontent is standaard privé, met export- en verwijderpaden gekoppeld aan deze werkruimte.",
    knowledgeIndexing: "Kennisindexering",
    usageAnalytics: "Gebruiksanalytics",
    imageMemoryRetention: "Beeldgeheugen bewaren",
    days: "dagen",
    links: {
      privacy: "Privacybeleid",
      terms: "Voorwaarden",
      dataDeletion: "Data verwijderen",
      exportRequest: "Data-export aanvragen",
      deletionRequest: "Werkruimte verwijderen aanvragen",
    },
  },
};

const frBeCopy: LocaleCopy = {
  brand: {
    subtitle: "Portail client",
  },
  locale: {
    label: "Langue",
    nl: "NL",
    fr: "FR",
    en: "EN",
  },
  navAria: "Navigation principale",
  nav: {
    dashboard: "Tableau de bord",
    identity: "Identité IA",
    channels: "Canaux",
    knowledge: "Connaissances",
    usage: "Utilisation",
    privacy: "Confidentialité",
  },
  sidebar: {
    dataScoped: "Les données client restent liées à cet espace de travail.",
  },
  account: {
    signedIn: "Connecté",
  },
  notices: {
    previewData:
      "Les données du portail n'ont pas pu être chargées. Données de prévisualisation affichées.",
    loading: "Chargement des données du portail...",
    identitySaved: "Identité IA enregistrée.",
    identitySaveError: "Impossible d'enregistrer l'identité IA.",
    facebookAppMissing:
      "L'app-id Facebook n'est pas configuré sur le backend du portail.",
    facebookAuthorizationOpened:
      "Autorisation Facebook ouverte. Revenez ici après avoir approuvé la Page.",
    facebookConnectError: "Impossible de démarrer la connexion Facebook.",
  },
  date: {
    notAvailable: "Non disponible",
    notUpdated: "Pas encore mis à jour",
  },
  common: {
    workspace: "Espace de travail",
    today: "Aujourd'hui",
    saving: "Enregistrement",
    opening: "Ouverture",
    enabled: "Activé",
    disabled: "Désactivé",
    freePlan: "Plan gratuit",
    items: "éléments",
    page: "Page",
    transport: "Transport",
    messenger: "Messenger",
    noPageConnected: "Aucune Page connectée",
    customerPageRequired: "Page client requise",
  },
  status: {
    connected: "Connecté",
    missing_permissions: "Autorisations manquantes",
    token_expired: "Jeton expiré",
    webhook_unhealthy: "Webhook dégradé",
    disconnected: "Déconnecté",
  },
  sourceTypes: {
    upload: "Import",
    website: "Site web",
    manual_text: "Texte manuel",
    integration: "Intégration",
  },
  sourceStatus: {
    active: "Actif",
    queued: "En attente",
    indexing: "Indexation",
    error: "Erreur",
    disabled: "Désactivé",
  },
  upgradeStatus: {
    requested: "Demandé",
    contacted: "Contacté",
    completed: "Terminé",
    rejected: "Refusé",
  },
  upgradeReasons: {
    image_limit_reached: "Limite d'images atteinte",
    blocked_usage: "Utilisation bloquée aujourd'hui",
    none: "Aucun déclencheur d'upgrade",
  },
  plan: {
    free: "Plan gratuit",
  },
  dashboard: {
    title: "Vue d'ensemble de l'espace de travail",
    body:
      "Gérez les réglages IA, l'état des canaux, l'utilisation et la confidentialité dans cet espace de travail.",
    metrics: {
      imagesLeft: "Images restantes",
      messages: "Messages",
      activeSources: "Sources actives",
      blocked: "Bloqués",
    },
    nextAction: "Prochaine étape",
    connectedChannel: "canal connecté",
    connectedChannels: "canaux connectés",
    actions: {
      upgradeTitle: "Examiner l'upgrade",
      connectTitle: "Connecter la Page Facebook",
      connectBody: "Messenger reste inactif tant qu'une Page client n'est pas approuvée.",
      knowledgeTitle: "Ajouter des connaissances",
      knowledgeBody:
        "L'assistant peut répondre depuis le profil de l'espace de travail, mais aucune source de connaissances active n'est enregistrée.",
      identityTitle: "Vérifier l'identité IA",
      identityBody:
        "Gardez le nom, le ton et les instructions à jour avant d'ouvrir davantage de trafic client.",
    },
    setup: {
      facebookLabel: "Facebook Messenger",
      facebookAuthorized: "Page approuvée",
      facebookNeeded: "Autorisation de Page requise",
      identityLabel: "Identité IA",
      identityDetail: "ton",
      languageDetail: "langue",
      knowledgeLabel: "Connaissances",
      totalSources: "sources au total",
      active: "actives",
      activeSingular: "active",
      activePlural: "actives",
      privacyLabel: "Confidentialité",
      retention: "jours de mémoire d'image",
      analyticsOn: "Analytics activés",
      analyticsOff: "Analytics désactivés",
    },
  },
  identity: {
    eyebrow: "Identité IA",
    title: "Profil d'assistant propre",
    body: "Ce profil est la voix client sur tous les canaux connectés.",
    assistantName: "Nom de l'assistant",
    instructions: "Instructions",
    tone: "Ton",
    language: "Langue",
    modelDefault: "Modèle par défaut",
    save: "Enregistrer l'identité",
  },
  channels: {
    eyebrow: "Canaux",
    title: "Facebook Messenger",
    body:
      "Les jetons de Page restent chiffrés sur le backend du portail. Le navigateur reçoit uniquement le statut de la Page et les métadonnées d'affichage.",
    lastCheck: "Dernière vérification",
    connect: "Connecter la Page Facebook",
  },
  knowledge: {
    eyebrow: "Connaissances",
    title: "Sources de connaissances de cet espace",
    body:
      "Les sources enregistrées appartiennent à cet espace client et ne sont pas partagées entre tenants.",
    metrics: {
      totalSources: "Sources au total",
      active: "Actives",
      lastUpdate: "Dernière mise à jour",
    },
    indexing: "Indexation",
    indexingEnabled: "Indexation des connaissances activée",
    indexingPaused: "Indexation des connaissances suspendue",
    indexingEnabledBody:
      "Les sources actives peuvent être préparées pour la recherche assistant dans la limite de l'espace de travail.",
    indexingPausedBody:
      "Les sources restent enregistrées, mais l'indexation est désactivée pour cet espace.",
    emptyTitle: "Aucune source de connaissances enregistrée",
    emptyBody: "L'assistant utilise pour l'instant uniquement son identité et ses instructions.",
  },
  usage: {
    eyebrow: "Utilisation et limites",
    body:
      "L'utilisation est comptée au niveau de l'espace de travail afin que les quotas et la facturation restent liés au bon tenant.",
    metrics: {
      imagesLeft: "Images restantes",
      imagesUsed: "Images utilisées",
      messages: "Messages",
      blocked: "Bloqués",
    },
    upgrade: "Upgrade",
    upgradeRecommended: "Upgrade recommandé",
    planHealthy: "Plan en ordre",
    imageLimit: "Limite d'images",
    perDay: "par jour",
    request: "demande",
    emptyTitle: "Aucune demande d'upgrade",
    emptyBody: "Le flux d'upgrade manuel est prêt quand l'utilisation le demande.",
  },
  privacy: {
    eyebrow: "Confidentialité",
    title: "Contrôles des données client",
    body:
      "Le contenu client est privé par défaut, avec des chemins d'export et de suppression liés à cet espace de travail.",
    knowledgeIndexing: "Indexation des connaissances",
    usageAnalytics: "Analytics d'utilisation",
    imageMemoryRetention: "Conservation de la mémoire d'image",
    days: "jours",
    links: {
      privacy: "Politique de confidentialité",
      terms: "Conditions",
      dataDeletion: "Suppression des données",
      exportRequest: "Demander un export des données",
      deletionRequest: "Demander la suppression de l'espace",
    },
  },
};

export const localeCopies: Record<AppLocale, LocaleCopy> = {
  "nl-BE": nlBeCopy,
  "fr-BE": frBeCopy,
  en: enCopy,
};

export function resolveLocale(value: string | null | undefined): AppLocale {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return DEFAULT_LOCALE;
  if (normalized === "nl-be" || normalized.startsWith("nl")) return "nl-BE";
  if (normalized === "fr-be" || normalized.startsWith("fr")) return "fr-BE";
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  return FALLBACK_LOCALE;
}
