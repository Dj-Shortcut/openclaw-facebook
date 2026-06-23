export type Lang = "nl" | "en";
export type SupportedUiLang = Lang;

type TranslationParams = {
  link?: string;
};

type TranslationKey =
  | "flowExplanation"
  | "photoEditPrompt"
  | "editImagePrompt"
  | "newImagePrompt"
  | "changeBackground"
  | "changeBackgroundPrompt"
  | "changeBackgroundRequiresPhoto"
  | "screenshotClarifyPrompt"
  | "screenshotIntentContinuation"
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
  | "missingInputImageWithEditableImage"
  | "messengerMissingInputImage"
  | "messengerMissingInputImageWithEditableImage"
  | "unsupportedMediaWithEditableImage"
  | "unsupportedVideo"
  | "unsupportedVideoWithEditableImage"
  | "unsupportedFile"
  | "unsupportedFileWithEditableImage"
  | "unsupportedShare"
  | "unsupportedShareWithEditableImage"
  | "unsupportedSticker"
  | "unsupportedStickerWithEditableImage"
  | "unsupportedUnknown"
  | "unsupportedUnknownWithEditableImage"
  | "unsupportedVideoOrAnimation"
  | "videoGenerationDisabled"
  | "videoGenerationRequiresPhoto"
  | "generatingVideoPrompt"
  | "videoGenerationQueued"
  | "videoGenerationTimeout"
  | "videoGenerationUnavailable"
  | "videoGenerationGenericFailure"
  | "outOfVideoCredits"
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
  | "unsupportedMedia"
  | "unsupportedGif"
  | "unsupportedAudio";

type TranslationValue = string | ((params: TranslationParams) => string);

const translations: Record<Lang, Record<TranslationKey, TranslationValue>> = {
  nl: {
    flowExplanation:
      "Beschrijf wat je wilt maken, of stuur een foto als je die wilt bewerken.",
  photoEditPrompt:
    "Foto ontvangen. Beschrijf wat je aan de foto wilt aanpassen.",
  editImagePrompt: "Beschrijf wat je aan de afbeelding wilt aanpassen.",
  newImagePrompt: "Beschrijf de nieuwe afbeelding die je wilt maken.",
  changeBackground: "Andere achtergrond",
  changeBackgroundPrompt:
    "Beschrijf de nieuwe achtergrond. Ik gebruik de huidige afbeelding.",
  changeBackgroundRequiresPhoto:
    "Stuur eerst een bruikbare bronfoto via de fotoknop of camera, niet als bestand of bijlage. Daarna vraag ik welke achtergrond je wilt.",
  screenshotClarifyPrompt: "Ik zag een screenshot — wat wil je daar precies mee doen?",
  screenshotIntentContinuation: "Top, dit is een screenshot. Ik werk dit meteen volgens je eerdere bedoeling af.",
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
    editRequiresPhoto:
      "Stuur eerst een bruikbare foto via de fotoknop of camera, niet als bestand of bijlage.",
    textWithoutPhoto:
      "Beschrijf welke afbeelding je wilt maken, of stuur een foto als je die wilt bewerken.",
    privacy: ({ link }) =>
      [
        "Je berichten, prompts en eventuele foto's worden alleen gebruikt om Leaderbot te laten antwoorden of afbeeldingen te maken.",
        "Je kan je data verwijderen door 'verwijder mijn data' te sturen.",
        ...(link ? [`Privacybeleid: ${link}`] : []),
      ].join("\n"),
    aboutLeaderbot:
      "Leaderbot is gemaakt door Andy. Je mag hem gerust contacteren via Facebook.\nVolledige naam op vraag: Andy Arijs.",
    failure: "Oeps. Probeer opnieuw of beschrijf een nieuwe afbeelding.",
    missingInputImage:
      "Ik kon je foto niet goed lezen. Stuur opnieuw een gewone foto als afbeelding. Daarna vraag ik wat je wilt aanpassen.",
    missingInputImageWithEditableImage:
      "Ik kon die foto niet goed lezen. Beschrijf wat je aan de huidige afbeelding wilt aanpassen, of stuur opnieuw een gewone foto als je een andere bronfoto wilt gebruiken.",
    messengerMissingInputImage:
      "Ik kon deze upload niet lezen. Gebruik de fotoknop of camera in Messenger en stuur de foto als foto, niet als bestand of bijlage. Wil je zonder foto verder, kies Nieuwe afbeelding.",
    messengerMissingInputImageWithEditableImage:
      "Ik kon deze upload niet lezen. Ik kan nog verder met je huidige afbeelding: beschrijf de aanpassing, of gebruik de fotoknop/camera in Messenger als je een andere bronfoto wilt sturen.",
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
    unsupportedMediaWithEditableImage:
      "Ik kan deze bijlage niet verwerken. Je kunt nu nog met je huidige foto verder: beschrijf de aanpassing of stuur een nieuwe foto.",
    unsupportedVideo:
      "Ik kan momenteel alleen foto’s bewerken. Video’s worden nog niet ondersteund. Stuur een foto om verder te gaan.",
    unsupportedVideoWithEditableImage:
      "Ik kan momenteel nog geen video maken. Je kunt wel nog doorgaan met de vorige foto: beschrijf een wijziging of stuur een nieuwe foto.",
    unsupportedFile:
      "Ik kan geen documenten of andere bestanden verwerken. Stuur een foto als je verder wilt gaan.",
    unsupportedFileWithEditableImage:
      "Ik kan geen documenten of andere bestanden verwerken. Je kunt wel nog met je vorige foto verder: beschrijf een wijziging of stuur een nieuwe foto.",
    unsupportedShare:
      "Ik kan gedeelde links nog niet als invoer gebruiken. Stuur een foto voor bewerking.",
    unsupportedShareWithEditableImage:
      "Ik kan gedeelde links nog niet als invoer gebruiken. Je kunt wel nog met je vorige foto verder.",
    unsupportedSticker:
      "Ik kan geen stickers verwerken. Stuur een foto als je wilt bewerken.",
    unsupportedStickerWithEditableImage:
      "Ik kan geen stickers verwerken. Je kunt wel nog met je vorige foto verder.",
    unsupportedUnknown:
      "Deze bijlage kan ik niet verwerken. Stuur een foto om te beginnen.",
    unsupportedUnknownWithEditableImage:
      "Deze bijlage kan ik niet verwerken. Je kunt wel nog met je vorige foto verder.",
    unsupportedVideoOrAnimation:
      "Ik kan nog geen video maken, maar ik kan wel een foto aanpassen. Wil je bijvoorbeeld een podium, disco-achtergrond of danspose?",
    videoGenerationDisabled:
      "Ik kan nog geen video maken, maar ik kan wel een foto aanpassen. Wil je bijvoorbeeld een podium, disco-achtergrond of danspose?",
    videoGenerationRequiresPhoto:
      "Ik kan hier een korte video van maken zodra je eerst een foto stuurt. Stuur een foto en zeg daarna wat er moet bewegen.",
    generatingVideoPrompt:
      "Ik maak nu een korte video van je foto. Dit kan wat langer duren.",
    videoGenerationQueued:
      "Ik zet je video in de wachtrij en stuur hem zodra hij klaar is.",
    videoGenerationTimeout:
      "De videomaker deed er te lang over. Probeer straks opnieuw met dezelfde foto.",
    videoGenerationUnavailable:
      "Video maken staat nog niet aan.",
    videoGenerationGenericFailure:
      "Ik kon die video nu niet maken. Je foto blijft bewaard, dus je kunt een andere aanpassing vragen.",
    outOfVideoCredits:
      "Je hebt je gratis videocredits voor vandaag opgebruikt. Probeer morgen opnieuw.",
    unsupportedGif:
      "GIF ontvangen, stuur best een gewone foto voor bewerking.",
    unsupportedAudio:
      "Ik heb je voice ontvangen, maar kan die nog niet verwerken. Stuur tekst of een foto.",
  },
  en: {
    flowExplanation:
      "Describe the image you want to make, or send a photo if you want me to edit it.",
    photoEditPrompt:
      "Photo received. Describe what you want me to change in the photo.",
    editImagePrompt: "Describe what you want me to change in the image.",
    newImagePrompt: "Describe the new image you want me to create.",
    changeBackground: "Different background",
    changeBackgroundPrompt:
      "Describe the new background. I will use the current image.",
    changeBackgroundRequiresPhoto:
      "Send a usable source photo with the photo button or camera first, not as a file attachment. Then I will ask what background you want.",
    screenshotClarifyPrompt: "I see a screenshot — what do you want to do with it?",
    screenshotIntentContinuation: "Got it, this is a screenshot. I’ll apply your previous request now.",
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
    editRequiresPhoto:
      "Send a usable photo with the photo button or camera first, not as a file attachment.",
    textWithoutPhoto:
      "Describe the image you want to make, or send a photo if you want me to edit it.",
    privacy: ({ link }) =>
      [
        "Your messages, prompts, and any photos are only used so Leaderbot can reply or create images.",
        "You can delete your data by sending 'delete my data'.",
        ...(link ? [`Privacy policy: ${link}`] : []),
      ].join("\n"),
    aboutLeaderbot:
      "Leaderbot was made by Andy. Feel free to contact him via Facebook.\nFull name on request: Andy Arijs.",
    failure: "Oops. Try again or describe a new image.",
    missingInputImage:
      "I could not read your photo properly. Please send a normal photo image again. Then I will ask what you want to change.",
    missingInputImageWithEditableImage:
      "I could not read that photo properly. Describe what you want to change in the current image, or send a normal photo image again if you want to use a different source photo.",
    messengerMissingInputImage:
      "I could not read this upload. Use the photo button or camera in Messenger and send it as a photo, not as a file attachment. To continue without a photo, choose New image.",
    messengerMissingInputImageWithEditableImage:
      "I could not read this upload. I can still use your current image: describe the change, or use the photo button/camera in Messenger if you want to send a different source photo.",
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
    unsupportedMediaWithEditableImage:
      "I can't process this attachment. You can keep working with your current photo: describe the edit or send a new photo.",
    unsupportedVideo:
      "I currently only work with photos. Videos are not supported yet. Send a photo to continue.",
    unsupportedVideoWithEditableImage:
      "I can't create videos yet. You can continue with your previous photo: describe an edit or send a new photo.",
    unsupportedFile:
      "I can't process documents or other files. Send a photo to continue.",
    unsupportedFileWithEditableImage:
      "I can't process documents or other files. You can still continue with your previous photo: describe an edit or send a new photo.",
    unsupportedShare:
      "I still can't use shared links as input. Send a photo for editing.",
    unsupportedShareWithEditableImage:
      "I still can't use shared links as input. You can still continue with your previous photo.",
    unsupportedSticker:
      "I can't process stickers. Send a photo for editing.",
    unsupportedStickerWithEditableImage:
      "I can't process stickers. You can still continue with your previous photo.",
    unsupportedUnknown:
      "I can't process this attachment. Send a photo to continue.",
    unsupportedUnknownWithEditableImage:
      "I can't process this attachment. You can still continue with your previous photo.",
    unsupportedVideoOrAnimation:
      "I can’t create a video yet, but I can edit a photo. For example, send a disco stage, dance pose, or nightclub background request.",
    videoGenerationDisabled:
      "I can't create video yet, but I can edit a photo. For example, ask for a stage, disco background, or dance pose.",
    videoGenerationRequiresPhoto:
      "I can make a short video from this once you send a photo first. Send a photo, then tell me what should move.",
    generatingVideoPrompt:
      "I am making a short video from your photo now. This can take a bit longer.",
    videoGenerationQueued:
      "I queued your video and will send it as soon as it is ready.",
    videoGenerationTimeout:
      "The video provider took too long. Please try again later with the same photo.",
    videoGenerationUnavailable:
      "Video generation is not enabled yet.",
    videoGenerationGenericFailure:
      "I could not create that video right now. Your photo is still available, so you can ask for a different edit.",
    outOfVideoCredits:
      "You used your free video credits for today. Try again tomorrow.",
    unsupportedGif:
      "I got your GIF, send a regular photo instead.",
    unsupportedAudio:
      "I got your voice message, but I can't process it yet. Send text or a photo.",
  },
};

export function normalizeLang(lang: string | null | undefined): Lang {
  return typeof lang === "string" && lang.toLowerCase().startsWith("en")
    ? "en"
    : "nl";
}

export function normalizeSupportedUiLang(
  value: unknown
): SupportedUiLang | null {
  return value === "nl" || value === "en" ? value : null;
}

export function t(
  lang: Lang,
  key: TranslationKey,
  params: TranslationParams = {}
): string {
  const entry = translations[lang][key];
  return typeof entry === "function" ? entry(params) : entry;
}
