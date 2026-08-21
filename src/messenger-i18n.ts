export type MessengerLanguage = "nl" | "en";

export const DEFAULT_MESSENGER_CUSTOMER_PORTAL_URL =
  "https://leaderbot.live/";

type MessengerTranslationKey =
  | "missingReferencedPrompt"
  | "gatewayImageBudgetReached"
  | "gatewayAudioBudgetReached"
  | "gatewayEventBudgetReached"
  | "planQuotaReached"
  | "planQuotaUnavailable"
  | "internalActionFailed"
  | "deleteRequestFallback"
  | "imageGeneratorUnavailable"
  | "interactiveActionUnavailable"
  | "audioTranscriptionUnavailable"
  | "fastLaneGreeting"
  | "fastLaneHelp"
  | "fastLaneStatus"
  | "fastLaneDeleteData"
  | "attachmentAudioInstruction"
  | "attachmentImageInstruction"
  | "attachmentVideoInstruction"
  | "attachmentFileInstruction"
  | "attachmentUnknownInstruction"
  | "attachmentTranscriptLabel";

const translations: Record<
  MessengerLanguage,
  Record<MessengerTranslationKey, string>
> = {
  nl: {
    missingReferencedPrompt:
      "Ik vind die prompt niet meer terug. Plak hem even opnieuw, dan maak ik de afbeelding.",
    gatewayImageBudgetReached:
      "Even pauze, ons dagbudget voor afbeeldingen is bereikt. Probeer later opnieuw.",
    gatewayAudioBudgetReached:
      "Even pauze, ons dagbudget voor voiceberichten is bereikt. Typ je bericht even uit, dan help ik meteen verder.",
    gatewayEventBudgetReached:
      "Even pauze, ons dagbudget is bereikt. Probeer later opnieuw.",
    planQuotaReached:
      "Je tegoed voor je huidige plan is opgebruikt. Open je klantenportaal om je gebruik te bekijken.",
    planQuotaUnavailable:
      "Ik kan je tegoed nu niet veilig controleren. Probeer zo meteen opnieuw.",
    internalActionFailed:
      "Ik kon een interne actie niet uitvoeren. Probeer het zo meteen opnieuw.",
    deleteRequestFallback:
      "Ik kon je verwijderverzoek nu niet automatisch verwerken. Mail privacy@leaderbot.live met je verzoek, dan behandelen we het via de privacyflow.",
    imageGeneratorUnavailable:
      "Ik kon de image generator nu niet bereiken. Probeer zo meteen opnieuw.",
    interactiveActionUnavailable:
      "Ik kon deze knopactie nu niet verwerken. Probeer zo meteen opnieuw.",
    audioTranscriptionUnavailable:
      "Ik heb je voicebericht ontvangen, maar ik kan audio nu niet betrouwbaar omzetten naar tekst. Typ je bericht even uit, dan help ik meteen verder.",
    fastLaneGreeting: "Hey! Ik ben er. Stuur je vraag gerust door.",
    fastLaneHelp:
      "Ik kan korte vragen beantwoorden, meedenken met taken en herkennen wanneer je een afbeelding wilt maken. Stuur gewoon wat je nodig hebt.",
    fastLaneStatus:
      "Online. Messenger is verbonden en ik kan je berichten ontvangen.",
    fastLaneDeleteData:
      "Ik kan je data niet vanuit deze Messenger-gateway verwijderen. Gebruik de privacy- of data-verwijdering link van Leaderbot, of mail privacy@leaderbot.live met je verzoek. Berichten die al in Messenger staan, blijven door Meta beheerd.",
    attachmentAudioInstruction:
      "De gebruiker stuurde een voice/audio-bericht. Luister of transcribeer de bijlage als dat beschikbaar is en reageer inhoudelijk.",
    attachmentImageInstruction:
      "De gebruiker stuurde een afbeelding zonder duidelijke image-generation opdracht. Bekijk de bijgevoegde afbeelding en antwoord op basis daarvan. Als de gebruiker lijkt te willen bewerken, vraag eerst wat er aangepast moet worden.",
    attachmentVideoInstruction:
      "De gebruiker stuurde een video. Bekijk of analyseer de bijgevoegde video als dat beschikbaar is en reageer inhoudelijk.",
    attachmentFileInstruction:
      "De gebruiker stuurde een bestand. Gebruik de bijlage als context als dat beschikbaar is en reageer inhoudelijk.",
    attachmentUnknownInstruction:
      "De gebruiker stuurde een bijlage. Gebruik de bijlage als context als dat beschikbaar is en reageer inhoudelijk.",
    attachmentTranscriptLabel: "Transcriptie voicebericht",
  },
  en: {
    missingReferencedPrompt:
      "I can no longer find that prompt. Paste it again and I will create the image.",
    gatewayImageBudgetReached:
      "Quick pause: our daily image budget has been reached. Please try again later.",
    gatewayAudioBudgetReached:
      "Quick pause: our daily voice-message budget has been reached. Type your message and I will help right away.",
    gatewayEventBudgetReached:
      "Quick pause: our daily budget has been reached. Please try again later.",
    planQuotaReached:
      "The credit for your current plan has been used up. Open your customer portal to review your usage.",
    planQuotaUnavailable:
      "I cannot safely check your credit right now. Please try again shortly.",
    internalActionFailed:
      "I could not complete an internal action. Please try again shortly.",
    deleteRequestFallback:
      "I could not process your deletion request automatically. Email privacy@leaderbot.live and we will handle it through the privacy process.",
    imageGeneratorUnavailable:
      "I could not reach the image generator. Please try again shortly.",
    interactiveActionUnavailable:
      "I could not process this button action. Please try again shortly.",
    audioTranscriptionUnavailable:
      "I received your voice message, but I cannot reliably convert audio to text right now. Type your message and I will help right away.",
    fastLaneGreeting: "Hi! I am here. Send me your question whenever you are ready.",
    fastLaneHelp:
      "I can answer short questions, help with tasks, and recognize when you want to create an image. Just send what you need.",
    fastLaneStatus:
      "Online. Messenger is connected and I can receive your messages.",
    fastLaneDeleteData:
      "I cannot delete your data from this Messenger gateway. Use Leaderbot's privacy or data-deletion link, or email privacy@leaderbot.live. Messages already stored in Messenger remain managed by Meta.",
    attachmentAudioInstruction:
      "The user sent a voice/audio message. Listen to or transcribe the attachment when available and respond to its content.",
    attachmentImageInstruction:
      "The user sent an image without a clear image-generation request. Review the attached image and respond based on it. If the user appears to want an edit, first ask what should be changed.",
    attachmentVideoInstruction:
      "The user sent a video. Review or analyze the attached video when available and respond to its content.",
    attachmentFileInstruction:
      "The user sent a file. Use the attachment as context when available and respond to its content.",
    attachmentUnknownInstruction:
      "The user sent an attachment. Use it as context when available and respond to its content.",
    attachmentTranscriptLabel: "Voice-message transcript",
  },
};

export function normalizeMessengerLanguage(
  value: string | null | undefined,
): MessengerLanguage {
  return value?.trim().toLowerCase() === "en" ? "en" : "nl";
}

export function tMessenger(
  lang: MessengerLanguage,
  key: MessengerTranslationKey,
): string {
  return translations[lang][key];
}

export function normalizeMessengerCustomerPortalUrl(
  value: string | null | undefined,
): string {
  try {
    const portalUrl = new URL(
      value?.trim() || DEFAULT_MESSENGER_CUSTOMER_PORTAL_URL,
    );
    if (
      portalUrl.protocol !== "https:" ||
      portalUrl.username ||
      portalUrl.password
    ) {
      return DEFAULT_MESSENGER_CUSTOMER_PORTAL_URL;
    }
    return portalUrl.toString();
  } catch {
    return DEFAULT_MESSENGER_CUSTOMER_PORTAL_URL;
  }
}

export function buildMessengerPlanQuotaReachedReply(
  lang: MessengerLanguage,
  customerPortalUrl: string | null | undefined,
): string {
  return `${tMessenger(lang, "planQuotaReached")} ${normalizeMessengerCustomerPortalUrl(customerPortalUrl)}`;
}
