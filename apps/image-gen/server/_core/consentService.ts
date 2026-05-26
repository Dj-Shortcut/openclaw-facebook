import { deleteUserData } from "./dataDeletionService";
import type { Lang } from "./i18n";
import type { QuickReply } from "./messengerApi";
import {
  setConsentState,
  setPendingDeleteConfirm,
  type MessengerUserState,
} from "./messengerState";
import type { NormalizedWhatsAppEvent } from "./whatsappTypes";

const GDPR_CONSENT_AGREE = "GDPR_CONSENT_AGREE";
const GDPR_CONSENT_DECLINE = "GDPR_CONSENT_DECLINE";
const GDPR_DELETE_CONFIRM = "GDPR_DELETE_CONFIRM";
const GDPR_DELETE_CANCEL = "GDPR_DELETE_CANCEL";

const DELETE_COMMAND_BY_LANG: Record<Lang, string> = {
  en: "delete my data",
  nl: "verwijder mijn data",
};
const DELETE_COMMANDS = new Set(Object.values(DELETE_COMMAND_BY_LANG));
const DELETE_CONFIRM_TEXTS = new Set([
  "ja",
  "ja verwijder",
  "yes",
  "confirm",
]);
const DELETE_CANCEL_TEXTS = new Set(["nee", "no", "cancel", "stop"]);

type MessengerConsentGateInput = {
  psid: string;
  lang: Lang;
  text?: string | null;
  payload?: string | null;
  state: MessengerUserState;
  sendText: (text: string) => Promise<void>;
  sendQuickReplies: (text: string, replies: QuickReply[]) => Promise<void>;
  sendRestyleStarterPills: () => Promise<void>;
};

type WhatsAppConsentGateInput = {
  event: NormalizedWhatsAppEvent;
  lang: Lang;
  state: MessengerUserState;
  sendText: (text: string) => Promise<void>;
  sendButtons: (
    text: string,
    options: Array<{ id: string; title: string }>
  ) => Promise<void>;
};

function normalizeControlText(text: string | null | undefined): string {
  return (
    text
      ?.trim()
      .toLocaleLowerCase("nl-BE")
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .replace(/\s+/g, " ") ?? ""
  );
}

function isDeleteCommand(text: string | null | undefined): boolean {
  return DELETE_COMMANDS.has(normalizeControlText(text));
}

function isDeleteConfirmText(text: string | null | undefined): boolean {
  return DELETE_CONFIRM_TEXTS.has(normalizeControlText(text));
}

function isDeleteCancelText(text: string | null | undefined): boolean {
  return DELETE_CANCEL_TEXTS.has(normalizeControlText(text));
}

function deleteCommand(lang: Lang): string {
  return DELETE_COMMAND_BY_LANG[lang] ?? DELETE_COMMAND_BY_LANG.nl;
}

function consentText(lang: Lang): string {
  return lang === "en"
    ? "Hey! Before we continue, I need your permission to process your images and data."
    : "Hey! Voor we verdergaan heb ik je toestemming nodig om je beelden en data te verwerken.";
}

function deletionConfirmText(lang: Lang): string {
  return lang === "en"
    ? "This will delete all data we store about you: your images, generated results, preferences, and chat history.\n\nMessages in this chat may still be visible in Messenger/WhatsApp."
    : "Dit verwijdert alle data die wij over jou bewaren: je beelden, gegenereerde resultaten, voorkeuren en chatgeschiedenis.\n\nBerichten in deze chat kunnen nog zichtbaar blijven in Messenger/WhatsApp.";
}

function deletionDoneText(lang: Lang): string {
  return lang === "en"
    ? "Your data has been deleted ✅\nIf you continue, we'll treat you as a new user."
    : "Je data is verwijderd ✅\nAls je verdergaat, behandelen we je als een nieuwe gebruiker.";
}

function consentDeclinedText(lang: Lang): string {
  return lang === "en"
    ? "No problem. I cannot continue without your consent."
    : "Geen probleem. Zonder je toestemming kan ik niet verdergaan.";
}

function consentAcceptedText(lang: Lang): string {
  const command = deleteCommand(lang);
  return lang === "en"
    ? `You're all set ✅\nYou can delete your data anytime.\nType '${command}' or use the button below 👇`
    : `Je bent klaar ✅\nJe kan je data altijd verwijderen.\nTyp '${command}' of gebruik de knop hieronder 👇`;
}

function deleteCancelledText(lang: Lang): string {
  return lang === "en" ? "Deletion cancelled." : "Verwijderen geannuleerd.";
}

function messengerConsentAcceptedText(lang: Lang): string {
  const command = deleteCommand(lang);
  return lang === "en"
    ? `You're all set ✅\nYou can delete your data anytime by typing '${command}'.`
    : `Je bent klaar ✅\nJe kan je data altijd verwijderen door '${command}' te typen.`;
}

function consentReplies(lang: Lang): QuickReply[] {
  return [
    {
      content_type: "text",
      title: lang === "en" ? "I Agree" : "Ik ga akkoord",
      payload: GDPR_CONSENT_AGREE,
    },
    {
      content_type: "text",
      title: lang === "en" ? "No thanks" : "Nee bedankt",
      payload: GDPR_CONSENT_DECLINE,
    },
  ];
}

function deleteNoticeReplies(lang: Lang): QuickReply[] {
  const command = deleteCommand(lang);
  return [
    {
      content_type: "text",
      title: lang === "en" ? "🗑 Delete my data" : "🗑 Verwijder mijn data",
      payload: command,
    },
  ];
}

function deleteReplies(lang: Lang): QuickReply[] {
  return [
    {
      content_type: "text",
      title: lang === "en" ? "Yes, delete" : "Ja, verwijder",
      payload: GDPR_DELETE_CONFIRM,
    },
    {
      content_type: "text",
      title: lang === "en" ? "Cancel" : "Annuleer",
      payload: GDPR_DELETE_CANCEL,
    },
  ];
}

function whatsAppConsentButtons(lang: Lang): Array<{ id: string; title: string }> {
  return [
    {
      id: GDPR_CONSENT_AGREE,
      title: lang === "en" ? "I Agree" : "Akkoord",
    },
    {
      id: GDPR_CONSENT_DECLINE,
      title: lang === "en" ? "No thanks" : "Nee",
    },
  ];
}

function whatsAppDeleteButtons(lang: Lang): Array<{ id: string; title: string }> {
  return [
    {
      id: GDPR_DELETE_CONFIRM,
      title: lang === "en" ? "Yes, delete" : "Verwijder",
    },
    {
      id: GDPR_DELETE_CANCEL,
      title: lang === "en" ? "Cancel" : "Annuleer",
    },
  ];
}

function whatsAppDeleteNoticeButtons(lang: Lang): Array<{ id: string; title: string }> {
  const command = deleteCommand(lang);
  return [
    {
      id: command,
      title: lang === "en" ? "🗑 Delete my data" : "🗑 Verwijder data",
    },
  ];
}

export async function handleMessengerConsentGate(
  input: MessengerConsentGateInput
): Promise<boolean> {
  if (input.payload === GDPR_CONSENT_AGREE) {
    await Promise.resolve(setConsentState(input.psid, true));
    await input.sendText(messengerConsentAcceptedText(input.lang));
    await input.sendRestyleStarterPills();
    return true;
  }

  if (input.payload === GDPR_CONSENT_DECLINE) {
    await Promise.resolve(setConsentState(input.psid, false));
    await input.sendText(consentDeclinedText(input.lang));
    return true;
  }

  if (input.payload === GDPR_DELETE_CANCEL) {
    await Promise.resolve(setPendingDeleteConfirm(input.psid, false));
    await input.sendText(deleteCancelledText(input.lang));
    return true;
  }

  if (input.payload === GDPR_DELETE_CONFIRM) {
    await deleteUserData(input.psid);
    await input.sendText(deletionDoneText(input.lang));
    return true;
  }

  if (input.state.pendingDeleteConfirm && isDeleteConfirmText(input.text)) {
    await deleteUserData(input.psid);
    await input.sendText(deletionDoneText(input.lang));
    return true;
  }

  if (input.state.pendingDeleteConfirm && isDeleteCancelText(input.text)) {
    await Promise.resolve(setPendingDeleteConfirm(input.psid, false));
    await input.sendText(deleteCancelledText(input.lang));
    return true;
  }

  if (isDeleteCommand(input.text) || isDeleteCommand(input.payload)) {
    await Promise.resolve(setPendingDeleteConfirm(input.psid, true));
    await input.sendQuickReplies(deletionConfirmText(input.lang), deleteReplies(input.lang));
    return true;
  }

  if (input.state.pendingDeleteConfirm) {
    await input.sendQuickReplies(deletionConfirmText(input.lang), deleteReplies(input.lang));
    return true;
  }

  if (input.state.consentGiven !== true) {
    await input.sendQuickReplies(consentText(input.lang), consentReplies(input.lang));
    return true;
  }

  return false;
}

export async function handleWhatsAppConsentGate(
  input: WhatsAppConsentGateInput
): Promise<boolean> {
  const payload =
    typeof input.event.rawEventMeta?.interactiveReplyId === "string"
      ? input.event.rawEventMeta.interactiveReplyId
      : null;
  const text = input.event.textBody;

  if (payload === GDPR_CONSENT_AGREE) {
    await Promise.resolve(setConsentState(input.event.senderId, true));
    await input.sendButtons(
      consentAcceptedText(input.lang),
      whatsAppDeleteNoticeButtons(input.lang)
    );
    return true;
  }

  if (payload === GDPR_CONSENT_DECLINE) {
    await Promise.resolve(setConsentState(input.event.senderId, false));
    await input.sendText(consentDeclinedText(input.lang));
    return true;
  }

  if (payload === GDPR_DELETE_CANCEL) {
    await Promise.resolve(setPendingDeleteConfirm(input.event.senderId, false));
    await input.sendText(deleteCancelledText(input.lang));
    return true;
  }

  if (payload === GDPR_DELETE_CONFIRM) {
    await deleteUserData(input.event.senderId);
    await input.sendText(deletionDoneText(input.lang));
    return true;
  }

  if (input.state.pendingDeleteConfirm && isDeleteConfirmText(text)) {
    await deleteUserData(input.event.senderId);
    await input.sendText(deletionDoneText(input.lang));
    return true;
  }

  if (input.state.pendingDeleteConfirm && isDeleteCancelText(text)) {
    await Promise.resolve(setPendingDeleteConfirm(input.event.senderId, false));
    await input.sendText(deleteCancelledText(input.lang));
    return true;
  }

  if (isDeleteCommand(text) || isDeleteCommand(payload)) {
    await Promise.resolve(setPendingDeleteConfirm(input.event.senderId, true));
    await input.sendButtons(
      deletionConfirmText(input.lang),
      whatsAppDeleteButtons(input.lang)
    );
    return true;
  }

  if (input.state.pendingDeleteConfirm) {
    await input.sendButtons(
      deletionConfirmText(input.lang),
      whatsAppDeleteButtons(input.lang)
    );
    return true;
  }

  if (input.state.consentGiven !== true) {
    await input.sendButtons(consentText(input.lang), whatsAppConsentButtons(input.lang));
    return true;
  }

  return false;
}
