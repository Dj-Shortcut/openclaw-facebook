export type Lang = "nl" | "en";

type TranslationParams = {
  link?: string;
  styleLabel?: string;
};

type TranslationKey =
  | "flowExplanation"
  | "stylePicker"
  | "styleCategoryPicker"
  | "styleCategoryCarouselIntro"
  | "whatIsThis"
  | "newImage"
  | "retry"
  | "surpriseMe"
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
  | "generatingImagePrompt"
  | "generationQueued"
  | "whatsappGenerationFollowup"
  | "retryThisStyle"
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
    flowExplanation:
      "Beschrijf wat je wilt maken, of stuur een foto als je die wilt bewerken.",
    stylePicker: "Kies je stijl 👇",
    styleCategoryPicker: "Kies eerst een stijlgroep 👇",
    styleCategoryCarouselIntro: ({ styleLabel }) =>
      `Hier zijn je ${styleLabel ?? ""}-stijlen. Kies er eentje hieronder.`,
    whatIsThis: "Wat doe ik?",
    newImage: "Nieuwe afbeelding",
    retry: "Probeer opnieuw",
    surpriseMe: "Verras me",
    assistantQuickActions:
      "Snelle acties: beschrijf een nieuwe afbeelding, pas je laatste prompt aan, of vraag privacy-info.",
    assistantPhotoTip:
      "Tip: je kan gewoon typen wat je wilt zien, bijvoorbeeld 'maak een futuristische stad bij zonsondergang'.",
    assistantPhotoTipExtra:
      "Bij een foto kan je ook beschrijven wat ik moet aanpassen.",
    assistantRandomStyle: ({ styleLabel }) =>
      `🎲 Mooie keuze — ik ga voor ${styleLabel ?? "deze stijl"}.`,
    success: "Klaar ✅",
    processingBlocked: "Even geduld — je vorige afbeelding is bijna klaar.",
    styleWithoutPhoto: "Stuur eerst een foto, dan maak ik die stijl voor je.",
    textWithoutPhoto:
      "Beschrijf welke afbeelding je wilt maken, of stuur een foto als je die wilt bewerken.",
    privacy: ({ link }) => [
      "Je foto wordt enkel gebruikt om de afbeelding te maken.",
      "Ze wordt daarna niet bewaard.",
      ...(link ? [`Privacybeleid: ${link}`] : []),
    ].join("\n"),
    privacyButtonLabel: "Privacybeleid",
    aboutLeaderbot:
      "Leaderbot is gemaakt door Andy. Je mag hem gerust contacteren via Facebook.\nVolledige naam op vraag: Andy Arijs.",
    failure: "Oeps. Probeer opnieuw of beschrijf een nieuwe afbeelding.",
    missingInputImage: "Ik kon je foto niet goed lezen. Stuur ze nog eens door aub.",
    generatingPrompt: ({ styleLabel }) => `Ik maak nu je ${styleLabel ?? ""}-stijl.`,
    generatingImagePrompt: "Ik maak nu je afbeelding.",
    generationQueued: "Je afbeelding staat in de wachtrij. Ik stuur ze zodra ze klaar is.",
    whatsappGenerationFollowup:
      "Beschrijf wat je wilt maken of aanpassen voor een volgende afbeelding.",
    retryThisStyle: "Opnieuw",
    backToCategories: "Categorieen",
    hdUnavailable: "I can share HD downloads after I generate an image.",
    generationUnavailable: "AI generation isn’t enabled yet.",
    generationTimeout:
      "Dit duurde te lang bij de beeldprovider. Probeer nog eens.",
    generationBudgetReached:
      "⚠️ Even pauze — ons maandbudget is bereikt. Probeer later opnieuw.",
    generationGenericFailure: "I couldn’t generate that image right now.",
    errorFallback: "Er liep iets mis aan mijn kant. Probeer gerust opnieuw.",
    unsupportedMedia:
      "Ik werk voorlopig alleen met foto's. Stuur een foto in plaats van een video of ander bestand.",
  },
  en: {
    flowExplanation:
      "Describe the image you want to make, or send a photo if you want me to edit it.",
    stylePicker: "Pick a style 👇",
    styleCategoryPicker: "Pick a style group first 👇",
    styleCategoryCarouselIntro: ({ styleLabel }) =>
      `Here are your ${styleLabel ?? ""} styles. Pick one below.`,
    whatIsThis: "What is this?",
    newImage: "New image",
    retry: "Retry",
    surpriseMe: "Surprise me",
    assistantQuickActions:
      "Quick actions: describe a new image, adjust your last prompt, or ask for privacy info.",
    assistantPhotoTip:
      "Tip: you can simply type what you want to see, for example 'make a futuristic city at sunset'.",
    assistantPhotoTipExtra:
      "With a photo, you can also describe what I should change.",
    assistantRandomStyle: ({ styleLabel }) =>
      `🎲 Nice — going with ${styleLabel ?? "this style"}.`,
    success: "Done ✅",
    processingBlocked: "One sec — your previous image is almost done.",
    styleWithoutPhoto: "Send a photo first, then I can make that style for you.",
    textWithoutPhoto:
      "Describe the image you want to make, or send a photo if you want me to edit it.",
    privacy: ({ link }) => [
      "Your photo is only used to make the image.",
      "It is not stored afterwards.",
      ...(link ? [`Privacy policy: ${link}`] : []),
    ].join("\n"),
    privacyButtonLabel: "Privacy Policy",
    aboutLeaderbot:
      "Leaderbot was made by Andy. Feel free to contact him via Facebook.\nFull name on request: Andy Arijs.",
    failure: "Oops. Try again or describe a new image.",
    missingInputImage: "I could not read your photo properly. Please send it again.",
    generatingPrompt: ({ styleLabel }) => `I am now making your ${styleLabel ?? ""} style.`,
    generatingImagePrompt: "I am making your image now.",
    generationQueued: "Your image is queued. I’ll send it as soon as it’s ready.",
    whatsappGenerationFollowup:
      "Describe what you want to make or change for the next image.",
    retryThisStyle: "Retry",
    backToCategories: "Categories",
    hdUnavailable: "I can share HD downloads after I generate an image.",
    generationUnavailable: "AI generation isn’t enabled yet.",
    generationTimeout:
      "This took too long at the image provider. Please try again.",
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
