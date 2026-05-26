export type Lang = "nl" | "en";

type TranslationParams = {
  link?: string;
  styleLabel?: string;
};

type TranslationKey =
  | "flowExplanation"
  | "identityGameConfirmFirstPrompt"
  | "identityGameConfirmStart"
  | "identityGameConfirmLater"
  | "identityGameEntryRecognized"
  | "identityGameUnavailable"
  | "identityGameSessionPending"
  | "identityGameStartConfirmed"
  | "identityGameDeferred"
  | "stylePicker"
  | "styleCategoryPicker"
  | "styleCategoryCarouselIntro"
  | "whatIsThis"
  | "newStyle"
  | "retry"
  | "assistantQuickActions"
  | "assistantPhotoTip"
  | "assistantPhotoTipExtra"
  | "assistantRandomStyle"
  | "success"
  | "processingBlocked"
  | "styleWithoutPhoto"
  | "textWithoutPhoto"
  | "privacy"
  | "privacyButtonLabel"
  | "aboutLeaderbot"
  | "failure"
  | "missingInputImage"
  | "generatingPrompt"
  | "retryThisStyle"
  | "otherStyle"
  | "backToCategories"
  | "hdUnavailable"
  | "generationUnavailable"
  | "generationTimeout"
  | "generationBudgetReached"
  | "generationGenericFailure"
  | "errorFallback"
  | "unsupportedMedia";

type TranslationValue = string | ((params: TranslationParams) => string);

const translations: Record<Lang, Record<TranslationKey, TranslationValue>> = {
  nl: {
    flowExplanation: "Stuur een foto en ik maak er een speciale versie van in een andere stijl — het is gratis.",
    identityGameConfirmFirstPrompt:
      "Deze game-entry is herkend. Klaar om later te starten?",
    identityGameConfirmStart: "Start game",
    identityGameConfirmLater: "Later",
    identityGameEntryRecognized:
      "Deze identity game-entry is herkend. De game flow zelf volgt in de volgende fase.",
    identityGameUnavailable:
      "Deze game-link is herkend, maar deze game is momenteel niet beschikbaar.",
    identityGameSessionPending:
      "Je identity game-sessie is herkend, maar de game flow zelf is nog niet geactiveerd in deze fase.",
    identityGameStartConfirmed:
      "De game-start is bevestigd. De echte vraagflow volgt in de volgende fase.",
    identityGameDeferred:
      "Geen probleem. Deze game-link blijft herkenbaar voor later.",
    stylePicker: "Kies je stijl 👇",
    styleCategoryPicker: "Kies eerst een stijlgroep 👇",
    styleCategoryCarouselIntro: ({ styleLabel }) =>
      `Hier zijn je ${styleLabel ?? ""}-stijlen. Kies er eentje hieronder.`,
    whatIsThis: "Wat doe ik?",
    newStyle: "Nieuwe stijl",
    retry: "Probeer opnieuw",
    assistantQuickActions:
      "⚡ Snelle acties: kies een stijl, typ 'remix', of typ 'verras me' voor een willekeurige look.",
    assistantPhotoTip:
      "Tip: typ 'verras me' nadat je een foto hebt gestuurd voor meteen een willekeurige stijl.",
    assistantPhotoTipExtra:
      "Je kan ook gewoon een stijlnaam typen of op een genummerde optie antwoorden.",
    assistantRandomStyle: ({ styleLabel }) =>
      `🎲 Mooie keuze — ik ga voor ${styleLabel ?? "deze stijl"}.`,
    success: "Klaar ✅",
    processingBlocked: "Even geduld — je vorige afbeelding is bijna klaar.",
    styleWithoutPhoto: "Stuur eerst een foto, dan maak ik die stijl voor je.",
    textWithoutPhoto: "Stuur gerust een foto, dan kan ik een stijl voor je maken.",
    privacy: ({ link }) => [
      "Je foto wordt enkel gebruikt om de afbeelding te maken.",
      "Ze wordt daarna niet bewaard.",
      ...(link ? [`Privacybeleid: ${link}`] : []),
    ].join("\n"),
    privacyButtonLabel: "Privacybeleid",
    aboutLeaderbot: "Leaderbot is gemaakt door Andy. Je mag hem gerust contacteren via Facebook.\nVolledige naam op vraag: Andy Arijs.",
    failure: "Oeps. Probeer nog een stijl.",
    missingInputImage: "Ik kon je foto niet goed lezen. Stuur ze nog eens door aub.",
    generatingPrompt: ({ styleLabel }) => `Ik maak nu je ${styleLabel ?? ""}-stijl.`,
    retryThisStyle: "Opnieuw",
    otherStyle: "Andere",
    backToCategories: "Categorieen",
    hdUnavailable: "I can share HD downloads after I generate an image.",
    generationUnavailable: "AI generation isn’t enabled yet.",
    generationTimeout: "This took too long.",
    generationBudgetReached:
      "⚠️ Even pauze — ons maandbudget is bereikt. Probeer later opnieuw.",
    generationGenericFailure: "I couldn’t generate that image right now.",
    errorFallback: "Er liep iets mis aan mijn kant. Probeer gerust opnieuw.",
    unsupportedMedia:
      "Ik werk voorlopig alleen met foto's. Stuur een foto in plaats van een video of ander bestand.",
  },
  en: {
    flowExplanation: "Send a photo and I will make a special version of it in another style for free.",
    identityGameConfirmFirstPrompt:
      "This game entry was recognized. Ready to start later?",
    identityGameConfirmStart: "Start game",
    identityGameConfirmLater: "Later",
    identityGameEntryRecognized:
      "This identity game entry was recognized. The actual game flow will follow in the next phase.",
    identityGameUnavailable:
      "This game link was recognized, but this game is not available right now.",
    identityGameSessionPending:
      "Your identity game session was recognized, but the actual game flow is not enabled in this phase yet.",
    identityGameStartConfirmed:
      "The game start was confirmed. The actual question flow will follow in the next phase.",
    identityGameDeferred:
      "No problem. This game link will stay recognizable for later.",
    stylePicker: "Pick a style 👇",
    styleCategoryPicker: "Pick a style group first 👇",
    styleCategoryCarouselIntro: ({ styleLabel }) =>
      `Here are your ${styleLabel ?? ""} styles. Pick one below.`,
    whatIsThis: "What is this?",
    newStyle: "New style",
    retry: "Retry",
    assistantQuickActions:
      "⚡ Quick actions: choose a style, type 'remix', or type 'surprise me' for a random look.",
    assistantPhotoTip:
      "Tip: send 'surprise me' after uploading a photo for an instant random style.",
    assistantPhotoTipExtra:
      "You can also type a style name directly or reply with a numbered option.",
    assistantRandomStyle: ({ styleLabel }) =>
      `🎲 Nice — going with ${styleLabel ?? "this style"}.`,
    success: "Done ✅",
    processingBlocked: "One sec — your previous image is almost done.",
    styleWithoutPhoto: "Send a photo first, then I can make that style for you.",
    textWithoutPhoto: "Feel free to send a photo, then I can make a style for you.",
    privacy: ({ link }) => [
      "Your photo is only used to make the image.",
      "It is not stored afterwards.",
      ...(link ? [`Privacy policy: ${link}`] : []),
    ].join("\n"),
    privacyButtonLabel: "Privacy Policy",
    aboutLeaderbot: "Leaderbot was made by Andy. Feel free to contact him via Facebook.\nFull name on request: Andy Arijs.",
    failure: "Oops. Try another style.",
    missingInputImage: "I could not read your photo properly. Please send it again.",
    generatingPrompt: ({ styleLabel }) => `I am now making your ${styleLabel ?? ""} style.`,
    retryThisStyle: "Retry",
    otherStyle: "Another",
    backToCategories: "Categories",
    hdUnavailable: "I can share HD downloads after I generate an image.",
    generationUnavailable: "AI generation isn’t enabled yet.",
    generationTimeout: "This took too long.",
    generationBudgetReached:
      "⚠️ Quick pause — our monthly budget has been reached. Please try again later.",
    generationGenericFailure: "I couldn’t generate that image right now.",
    errorFallback: "Something went wrong on my side. Please try again.",
    unsupportedMedia:
      "I currently only work with photos. Please send a photo instead of a video or other file.",
  },
};

export function normalizeLang(lang: string | null | undefined): Lang {
  return typeof lang === "string" && lang.toLowerCase().startsWith("en") ? "en" : "nl";
}

export function t(lang: Lang, key: TranslationKey, params: TranslationParams = {}): string {
  const entry = translations[lang][key];
  return typeof entry === "function" ? entry(params) : entry;
}
