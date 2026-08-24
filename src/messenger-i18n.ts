import {
  DEFAULT_MESSENGER_CUSTOMER_PORTAL_URL,
  DEFAULT_MESSENGER_PRIVACY_CONTACT,
  MESSENGER_CUSTOMER_PORTAL_NAME,
} from "./leaderbot-bridge.js";

export type MessengerLanguage = "nl" | "en";

export { DEFAULT_MESSENGER_CUSTOMER_PORTAL_URL } from "./leaderbot-bridge.js";

type MessengerTranslationKey =
  | "missingReferencedPrompt"
  | "gatewayAudioBudgetReached"
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
  | "attachmentTranscriptLabel"
  | "pairingAccessRequired"
  | "pairingSenderIdLabel"
  | "pairingCodeLabel"
  | "pairingApprovalInstruction"
  | "sharedStateUnavailable";

const translations: Record<
  MessengerLanguage,
  Record<MessengerTranslationKey, string>
> = {
  nl: {
    missingReferencedPrompt:
      "Ik vind die prompt niet meer terug. Plak hem even opnieuw, dan maak ik de afbeelding.",
    gatewayAudioBudgetReached:
      "Even pauze, ons dagbudget voor voiceberichten is bereikt. Typ je bericht even uit, dan help ik meteen verder.",
    planQuotaReached:
      "Je tegoed voor je huidige plan is opgebruikt. Open je klantenportaal om je gebruik te bekijken.",
    planQuotaUnavailable:
      "Ik kan je tegoed nu niet veilig controleren. Probeer zo meteen opnieuw.",
    internalActionFailed:
      "Ik kon een interne actie niet uitvoeren. Probeer het zo meteen opnieuw.",
    deleteRequestFallback: `Ik kon je verwijderverzoek nu niet automatisch verwerken. Mail ${DEFAULT_MESSENGER_PRIVACY_CONTACT} met je verzoek, dan behandelen we het via de privacyflow.`,
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
    fastLaneDeleteData: `Ik kan je data niet vanuit deze Messenger-gateway verwijderen. Gebruik de privacy- of data-verwijdering link van ${MESSENGER_CUSTOMER_PORTAL_NAME}, of mail ${DEFAULT_MESSENGER_PRIVACY_CONTACT} met je verzoek. Berichten die al in Messenger staan, blijven door Meta beheerd.`,
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
    pairingAccessRequired: "OpenClaw: toegang is nog niet goedgekeurd.",
    pairingSenderIdLabel: "Je Messenger-PSID",
    pairingCodeLabel: "Koppelcode",
    pairingApprovalInstruction:
      "Vraag de beheerder om de toegang goed te keuren met:",
    sharedStateUnavailable:
      "Ik kan de veiligheidslimiet nu niet betrouwbaar controleren. Probeer zo meteen opnieuw.",
  },
  en: {
    missingReferencedPrompt:
      "I can no longer find that prompt. Paste it again and I will create the image.",
    gatewayAudioBudgetReached:
      "Quick pause: our daily voice-message budget has been reached. Type your message and I will help right away.",
    planQuotaReached:
      "The credit for your current plan has been used up. Open your customer portal to review your usage.",
    planQuotaUnavailable:
      "I cannot safely check your credit right now. Please try again shortly.",
    internalActionFailed:
      "I could not complete an internal action. Please try again shortly.",
    deleteRequestFallback: `I could not process your deletion request automatically. Email ${DEFAULT_MESSENGER_PRIVACY_CONTACT} and we will handle it through the privacy process.`,
    imageGeneratorUnavailable:
      "I could not reach the image generator. Please try again shortly.",
    interactiveActionUnavailable:
      "I could not process this button action. Please try again shortly.",
    audioTranscriptionUnavailable:
      "I received your voice message, but I cannot reliably convert audio to text right now. Type your message and I will help right away.",
    fastLaneGreeting:
      "Hi! I am here. Send me your question whenever you are ready.",
    fastLaneHelp:
      "I can answer short questions, help with tasks, and recognize when you want to create an image. Just send what you need.",
    fastLaneStatus:
      "Online. Messenger is connected and I can receive your messages.",
    fastLaneDeleteData: `I cannot delete your data from this Messenger gateway. Use ${MESSENGER_CUSTOMER_PORTAL_NAME}'s privacy or data-deletion link, or email ${DEFAULT_MESSENGER_PRIVACY_CONTACT}. Messages already stored in Messenger remain managed by Meta.`,
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
    pairingAccessRequired: "OpenClaw: access has not been approved yet.",
    pairingSenderIdLabel: "Your Messenger PSID",
    pairingCodeLabel: "Pairing code",
    pairingApprovalInstruction: "Ask the owner to approve access with:",
    sharedStateUnavailable:
      "I cannot reliably check the safety limit right now. Please try again shortly.",
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

export function buildMessengerPairingReply(
  lang: MessengerLanguage,
  params: { code: string; senderId: string },
): string {
  return [
    tMessenger(lang, "pairingAccessRequired"),
    `${tMessenger(lang, "pairingSenderIdLabel")}: ${params.senderId}`,
    `${tMessenger(lang, "pairingCodeLabel")}: ${params.code}`,
    `${tMessenger(lang, "pairingApprovalInstruction")}\nopenclaw pairing approve facebook ${params.code}`,
  ].join("\n\n");
}
