export type Lang = "nl" | "en";

type TranslationParams = {
  link?: string;
};

type TranslationKey =
  | "flowExplanation"
  | "photoEditPrompt"
  | "editImagePrompt"
  | "whatIsThis"
  | "newImage"
  | "editImage"
  | "editPhoto"
  | "assistantQuickActions"
  | "assistantPhotoTip"
  | "assistantPhotoTipExtra"
  | "success"
  | "processingBlocked"
  | "inFlightMessage"
  | "editRequiresPhoto"
  | "textWithoutPhoto"
  | "privacy"
  | "aboutLeaderbot"
  | "failure"
  | "missingInputImage"
  | "generatingImagePrompt"
  | "generationQueued"
  | "whatsappGenerationFollowup"
  | "backToCategories"
  | "hdUnavailable"
  | "generationUnavailable"
  | "generationTimeout"
  | "generationBudgetReached"
  | "outOfFreeCredits"
  | "generationGenericFailure"
  | "errorFallback"
  | "unsupportedMedia";

type TranslationValue = string | ((params: TranslationParams) => string);

const translations: Record<Lang, Record<TranslationKey, TranslationValue>> = {
  nl: {
    flowExplanation:
      "Beschrijf wat je wilt maken, of stuur een foto als je die wilt bewerken.",
    photoEditPrompt: "Foto ontvangen. Wat wil je aanpassen?",
    editImagePrompt: "Wat wil je aanpassen?",
    whatIsThis: "Wat doe ik?",
    newImage: "Nieuwe afbeelding",
    editImage: "Pas aan",
    editPhoto: "Pas foto aan",
    assistantQuickActions: "Je afbeelding staat klaar. Wat wil je doen?",
    assistantPhotoTip:
      "Typ gewoon wat je wilt maken, bijvoorbeeld: maak een futuristische stad bij zonsondergang.",
    assistantPhotoTipExtra:
      "Bij een foto kan je meteen zeggen wat er anders moet.",
    success: "Klaar.",
    processingBlocked: "Even geduld, je vorige afbeelding is bijna klaar.",
    inFlightMessage: "Even geduld, ik ben nog bezig met je afbeelding.",
    editRequiresPhoto: "Stuur eerst de foto die je wilt bewerken.",
    textWithoutPhoto:
      "Beschrijf welke afbeelding je wilt maken, of stuur een foto als je die wilt bewerken.",
    privacy: ({ link }) =>
      [
        "Je foto wordt enkel gebruikt om de afbeelding te maken.",
        "Ze wordt daarna niet bewaard.",
        ...(link ? [`Privacybeleid: ${link}`] : []),
      ].join("\n"),
    aboutLeaderbot:
      "Leaderbot is gemaakt door Andy. Je mag hem gerust contacteren via Facebook.\nVolledige naam op vraag: Andy Arijs.",
    failure: "Oeps. Probeer opnieuw of beschrijf een nieuwe afbeelding.",
    missingInputImage:
      "Ik kon je foto niet goed lezen. Stuur ze nog eens door aub.",
    generatingImagePrompt: "Ik maak nu je afbeelding.",
    generationQueued:
      "Ik zet je afbeelding in de wachtrij en stuur ze zodra ze klaar is.",
    whatsappGenerationFollowup:
      "Beschrijf je volgende afbeelding of aanpassing.",
    backToCategories: "Categorieen",
    hdUnavailable:
      "Ik kan HD-downloads delen nadat ik een afbeelding heb gemaakt.",
    generationUnavailable: "Beeldgeneratie staat nog niet aan.",
    generationTimeout:
      "Dit duurde te lang bij de beeldprovider. Probeer nog eens.",
    generationBudgetReached:
      "Even pauze, ons maandbudget is bereikt. Probeer later opnieuw.",
    outOfFreeCredits:
      "Je hebt je gratis credits voor vandaag opgebruikt. Kom morgen terug.",
    generationGenericFailure: "Ik kon die afbeelding nu niet maken.",
    errorFallback: "Er liep iets mis aan mijn kant. Probeer gerust opnieuw.",
    unsupportedMedia:
      "Ik werk voorlopig alleen met foto's. Stuur een foto in plaats van een video of ander bestand.",
  },
  en: {
    flowExplanation:
      "Describe the image you want to make, or send a photo if you want me to edit it.",
    photoEditPrompt: "Photo received. What should I change?",
    editImagePrompt: "What should I change?",
    whatIsThis: "What is this?",
    newImage: "New image",
    editImage: "Edit image",
    editPhoto: "Edit photo",
    assistantQuickActions: "Your image is ready. What would you like to do?",
    assistantPhotoTip:
      "Just type what you want to make, for example: make a futuristic city at sunset.",
    assistantPhotoTipExtra: "With a photo, tell me what should change.",
    success: "Done.",
    processingBlocked: "One sec, your previous image is almost done.",
    inFlightMessage: "One sec, I am still working on your image.",
    editRequiresPhoto: "Send the photo you want me to edit first.",
    textWithoutPhoto:
      "Describe the image you want to make, or send a photo if you want me to edit it.",
    privacy: ({ link }) =>
      [
        "Your photo is only used to make the image.",
        "It is not stored afterwards.",
        ...(link ? [`Privacy policy: ${link}`] : []),
      ].join("\n"),
    aboutLeaderbot:
      "Leaderbot was made by Andy. Feel free to contact him via Facebook.\nFull name on request: Andy Arijs.",
    failure: "Oops. Try again or describe a new image.",
    missingInputImage:
      "I could not read your photo properly. Please send it again.",
    generatingImagePrompt: "I am making your image now.",
    generationQueued:
      "I queued your image and will send it as soon as it is ready.",
    whatsappGenerationFollowup: "Describe your next image or change.",
    backToCategories: "Categories",
    hdUnavailable: "I can share HD downloads after I generate an image.",
    generationUnavailable: "Image generation is not enabled yet.",
    generationTimeout:
      "This took too long at the image provider. Please try again.",
    generationBudgetReached:
      "Quick pause, our monthly budget has been reached. Please try again later.",
    outOfFreeCredits:
      "You used your free credits for today. Come back tomorrow.",
    generationGenericFailure: "I could not generate that image right now.",
    errorFallback: "Something went wrong on my side. Please try again.",
    unsupportedMedia:
      "I currently only work with photos. Please send a photo instead of a video or other file.",
  },
};

export function normalizeLang(lang: string | null | undefined): Lang {
  return typeof lang === "string" && lang.toLowerCase().startsWith("en")
    ? "en"
    : "nl";
}

export function t(
  lang: Lang,
  key: TranslationKey,
  params: TranslationParams = {}
): string {
  const entry = translations[lang][key];
  return typeof entry === "function" ? entry(params) : entry;
}
