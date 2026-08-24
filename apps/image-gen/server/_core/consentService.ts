import {
  deleteUserData,
  type UserDataDeletionOutcome,
} from "./dataDeletionService";
import {
  GDPR_CONSENT_AGREE,
  GDPR_CONSENT_DECLINE,
  GDPR_DELETE_CANCEL,
  GDPR_DELETE_CONFIRM,
} from "./consentActionIds";
import type { Lang } from "./i18n";
import type { ConversationAction } from "./botResponse";
import { buildQuickStartResponse } from "./conversationActions";
import {
  getState,
  setConsentPromptedAt,
  setConsentState,
  setPendingDeleteConfirm,
  type MessengerUserState,
} from "./messengerState";
import type { NormalizedWhatsAppEvent } from "./whatsappTypes";

const DELETE_COMMAND_BY_LANG: Record<Lang, string> = {
  en: "delete my data",
  nl: "verwijder mijn data",
};
const DELETE_COMMANDS = new Set(Object.values(DELETE_COMMAND_BY_LANG));
const DELETE_CONFIRM_TEXTS = new Set(["ja", "ja verwijder", "yes", "confirm"]);
const DELETE_CANCEL_TEXTS = new Set(["nee", "no", "cancel", "stop"]);
const DELETE_CONFIRMATION_WINDOW_MS = 15 * 60 * 1000;
const DIRECT_CONSENT_AGREE_TEXTS = new Set([
  "ja",
  "yes",
  "ok",
  "oke",
  "oké",
  "okay",
  "is ok",
  "is oke",
  "is oké",
  "is goed",
  "dat is ok",
  "dat is oke",
  "dat is oké",
  "dat is goed",
  "goed",
  "helemaal goed",
  "voor mij goed",
  "dat mag",
  "mag",
  "doe maar",
  "ga maar door",
  "prima",
  "sure",
  "thats fine",
  "fine by me",
  "go ahead",
  "you may",
]);
const DIRECT_CONSENT_DECLINE_TEXTS = new Set([
  "nee",
  "no",
  "nee bedankt",
  "no thanks",
  "decline",
]);

const CONSENT_ACKNOWLEDGEMENT_WINDOW_MS = 15 * 60 * 1000;
const AGREEMENT_TERM_VARIANTS = new Set([
  "akkoord",
  "akoord",
  "akord",
  "akkoort",
  "accoort",
  "agree",
  "aggre",
  "agre",
]);
const PERMISSION_TERM_VARIANTS = new Set([
  "toestemming",
  "toesteming",
  "toestmming",
  "toestemmng",
  "consent",
  "consnt",
  "consnet",
  "permission",
  "permision",
  "permisson",
]);
const CONSENT_REFUSAL_BEFORE_TARGET_PATTERN =
  /\b(?:niet|geen|nee|nooit|weiger|weigeren|not|no|never|wont|dont|cannot|cant|decline|refuse)(?: [\p{L}\p{N}]+){0,4} (?:agreement|permission|ok|oke|oké|okay|goed)\b/u;
const CONSENT_REFUSAL_AFTER_TARGET_PATTERN =
  /\b(?:agreement|permission|ok|oke|oké|okay|goed)(?: [\p{L}\p{N}]+){0,4} (?:niet|geen|nee|nooit|weiger|weigeren|not|no|never|wont|dont|cannot|cant|decline|refuse)\b/u;
const CONSENT_TARGET_PATTERN =
  /\b(?:agreement|permission|ok|oke|oké|okay|goed)\b/u;
const CONSENT_CONTRAST_SEPARATOR_PATTERN = /\b(?:maar|but)\b/u;
const CONSENT_CONTRAST_REFUSAL_PATTERN =
  /^(?:(?:toch|still|liever|rather|eigenlijk|actually) )?(?:(?:ik|i) (?:ga|do|will|wil|want) )?(?:niet|not)\b/u;

type MessengerConsentGateInput = {
  psid: string;
  lang: Lang;
  text?: string | null;
  payload?: string | null;
  state: MessengerUserState;
  sendText: (text: string) => Promise<boolean | void>;
  sendDeletionOutcome?: (text: string) => Promise<boolean | void>;
  sendActions: (
    text: string,
    actions: ConversationAction[]
  ) => Promise<boolean | void>;
  onConsentControlsError?: (error: unknown) => void;
};

type WhatsAppConsentGateInput = {
  event: NormalizedWhatsAppEvent;
  lang: Lang;
  state: MessengerUserState;
  sendText: (text: string) => Promise<void>;
  sendDeletionOutcome?: (text: string) => Promise<void>;
  sendButtons: (
    text: string,
    options: Array<{ id: string; title: string }>
  ) => Promise<void>;
};

export function isWhatsAppPrivacyOrConsentControl(
  event: NormalizedWhatsAppEvent
): boolean {
  const payload =
    typeof event.rawEventMeta?.interactiveReplyId === "string"
      ? event.rawEventMeta.interactiveReplyId
      : null;
  if (
    payload === GDPR_CONSENT_AGREE ||
    payload === GDPR_CONSENT_DECLINE ||
    payload === GDPR_DELETE_CANCEL ||
    payload === GDPR_DELETE_CONFIRM
  ) {
    return true;
  }

  const text = event.textBody;
  return Boolean(
    isDeleteCommand(text) ||
    isDeleteConfirmText(text) ||
    isDeleteCancelText(text) ||
    isConsentAgreeText(text, false) ||
    isConsentDeclineText(text)
  );
}

function normalizeControlText(text: string | null | undefined): string {
  return (
    text
      ?.trim()
      .toLocaleLowerCase("nl-BE")
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .replace(/\s+/g, " ") ?? ""
  );
}

export function isDeleteCommand(text: string | null | undefined): boolean {
  const normalized = normalizeControlText(text);
  return (
    DELETE_COMMANDS.has(normalized) ||
    /^(?:delete|remove|erase)\s+(?:my\s+)?data(?:\s+(?:aub|a\s+u\s+b|please|pls))?$/.test(
      normalized
    ) ||
    /^(?:verwijder|wis)\s+(?:mijn\s+)?(?:data|gegevens)(?:\s+(?:aub|a\s+u\s+b|alsjeblieft))?$/.test(
      normalized
    )
  );
}

function isDeleteConfirmText(text: string | null | undefined): boolean {
  return DELETE_CONFIRM_TEXTS.has(normalizeControlText(text));
}

function isDeleteCancelText(text: string | null | undefined): boolean {
  return DELETE_CANCEL_TEXTS.has(normalizeControlText(text));
}

function hasActiveDeleteConfirmation(
  state: MessengerUserState,
  now = Date.now()
): boolean {
  const requestedAt = state.pendingDeleteConfirmAt;
  return (
    state.pendingDeleteConfirm === true &&
    typeof requestedAt === "number" &&
    Number.isFinite(requestedAt) &&
    requestedAt <= now &&
    now - requestedAt <= DELETE_CONFIRMATION_WINDOW_MS
  );
}

async function clearPendingDeleteConfirmation(psid: string): Promise<void> {
  if (await Promise.resolve(getState(psid))) {
    await Promise.resolve(setPendingDeleteConfirm(psid, false));
  }
}

function canonicalizeConsentTerms(normalized: string): string {
  return normalized
    .split(" ")
    .map(token => {
      if (AGREEMENT_TERM_VARIANTS.has(token)) {
        return "agreement";
      }

      if (PERMISSION_TERM_VARIANTS.has(token)) {
        return "permission";
      }

      return token;
    })
    .join(" ");
}

function stripBenignNegativePhrases(normalized: string): string {
  return normalized
    .replace(
      /\b(?:geen(?: enkel)? probleem|geen bezwaar|no problem|not a problem|no objection)\b/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

function semanticConsentText(normalized: string): string {
  return canonicalizeConsentTerms(stripBenignNegativePhrases(normalized));
}

function hasConsentCue(semantic: string): boolean {
  return /\b(?:agreement|permission|ja|yes|ok|oke|oké|okay|goed|prima)\b/.test(
    semantic
  );
}

function hasDeferredOrUncertainConsent(semantic: string): boolean {
  return (
    hasConsentCue(semantic) &&
    /\b(?:misschien|wellicht|mogelijk|eventueel|later|ooit|zou|zouden|maybe|perhaps|possibly|might|eventually|would|unsure)\b/.test(
      semantic
    )
  );
}

function hasExplicitConsentRefusal(semantic: string): boolean {
  const clauses = semantic
    .split(CONSENT_CONTRAST_SEPARATOR_PATTERN)
    .map(clause => clause.trim());

  if (
    clauses.some(
      clause =>
        CONSENT_REFUSAL_BEFORE_TARGET_PATTERN.test(clause) ||
        CONSENT_REFUSAL_AFTER_TARGET_PATTERN.test(clause)
    )
  ) {
    return true;
  }

  return clauses.some(
    (clause, index) =>
      index > 0 &&
      CONSENT_TARGET_PATTERN.test(clauses[index - 1] ?? "") &&
      CONSENT_CONTRAST_REFUSAL_PATTERN.test(clause)
  );
}

function looksLikeConsentQuestion(
  text: string | null | undefined,
  normalized: string
): boolean {
  if (text?.includes("?")) {
    return true;
  }

  return /^(?:waarom|wat|welke|hoe|kan|kun|mag|moet|wil|ben|heb|hebt|ga|is (?:dit|dat|het)|why|what|which|how|can|could|may|must|do|does|did|are|have|has|is (?:this|that|it))\b/.test(
    normalized
  );
}

function isExplicitConsentGrantClause(normalizedClause: string): boolean {
  const semantic = semanticConsentText(normalizedClause);
  if (!semantic) {
    return false;
  }

  return [
    /^(?:ja|yes)(?: (?:ik|i|wij|we)(?: (?:ga|gaan|ben|zijn|am|are|do))?)? agreement$/,
    /^(?:ik|i|wij|we) (?:(?:ga|gaan|ben|zijn|am|are|do) )?(?:(?:helemaal|volledig|fully) )?agreement(?: (?:met|with|to|voor) .+)?$/,
    /^(?:(?:helemaal|volledig|fully) )?agreement$/,
    /^(?:die|deze|mijn|mijnt|my|the)? ?(?:permission|agreement) (?:heb|hebt|heeft|hebben|have|has|got) (?:je|jij|u|jullie|you)(?: (?:van mij|van ons|from me|from us))?$/,
    /^(?:je|jij|u|jullie|you) (?:hebt|heeft|hebben|have|has|got) (?:mijn|ons|onze|my|our)? ?(?:permission|agreement)(?: (?:van mij|van ons|from me|from us))?$/,
    /^(?:ik|i|wij|we) (?:hierbij |hereby )?(?:geef|geven|verleen|verlenen|give|grant) (?:je|jij|u|jullie|you)? ?(?:mijn|ons|onze|my|our)? ?permission(?: (?:voor|to|for) .+)?$/,
    /^(?:hierbij|bij deze|hereby) (?:geef|geven|verleen|verlenen|give|grant) (?:ik|wij|i|we) (?:je|jij|u|jullie|you)? ?(?:mijn|ons|onze|my|our)? ?permission(?: (?:voor|to|for) .+)?$/,
    /^(?:ik|i|wij|we)(?: hereby)? permission$/,
    /^(?:ik|wij) stem(?:men)? (?:hiermee |ermee )?in$/,
    /^permission (?:is )?(?:gegeven|verleend|granted|given)$/,
  ].some(pattern => pattern.test(semantic));
}

function hasExplicitConsentGrant(text: string | null | undefined): boolean {
  return isExplicitConsentGrantClause(normalizeControlText(text));
}

function wasConsentPromptedRecently(
  consentPromptedAt: number | undefined,
  now = Date.now()
): boolean {
  return (
    typeof consentPromptedAt === "number" &&
    Number.isFinite(consentPromptedAt) &&
    consentPromptedAt <= now &&
    now - consentPromptedAt <= CONSENT_ACKNOWLEDGEMENT_WINDOW_MS
  );
}

function isConsentAgreeText(
  text: string | null | undefined,
  allowContextualAcknowledgement: boolean
): boolean {
  const normalized = normalizeControlText(text);
  const semantic = semanticConsentText(normalized);
  if (!normalized || text?.includes("?")) {
    return false;
  }

  if (
    allowContextualAcknowledgement &&
    DIRECT_CONSENT_AGREE_TEXTS.has(normalized)
  ) {
    return true;
  }

  if (
    looksLikeConsentQuestion(text, normalized) ||
    hasDeferredOrUncertainConsent(semantic) ||
    hasExplicitConsentRefusal(semantic)
  ) {
    return false;
  }

  return hasExplicitConsentGrant(text);
}

function isConsentDeclineText(text: string | null | undefined): boolean {
  const normalized = normalizeControlText(text);
  return (
    DIRECT_CONSENT_DECLINE_TEXTS.has(normalized) ||
    hasExplicitConsentRefusal(semanticConsentText(normalized))
  );
}

function deleteCommand(lang: Lang): string {
  return DELETE_COMMAND_BY_LANG[lang] ?? DELETE_COMMAND_BY_LANG.nl;
}

function consentText(lang: Lang): string {
  return lang === "en"
    ? "Hey! Before we continue, I need your permission to process your images and data. Use a button below, or reply 'I AGREE' if the buttons are not visible."
    : "Hey! Voor we verdergaan heb ik je toestemming nodig om je beelden en data te verwerken. Gebruik een knop hieronder, of antwoord 'IK GA AKKOORD' als de knoppen niet zichtbaar zijn.";
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

function deletionPendingText(lang: Lang): string {
  return lang === "en"
    ? "We couldn't finish deleting all your data yet. Please try 'delete my data' again later. If this keeps happening, contact privacy@leaderbot.live."
    : "We konden nog niet al je data verwijderen. Probeer later opnieuw met 'verwijder mijn data'. Blijft dit gebeuren, mail dan privacy@leaderbot.live.";
}

function deletionFailedText(lang: Lang): string {
  return lang === "en"
    ? "We couldn't complete your data deletion request. Please try again later or contact privacy@leaderbot.live."
    : "We konden je verzoek om je data te verwijderen niet afronden. Probeer het later opnieuw of mail privacy@leaderbot.live.";
}

function deletionConfirmationExpiredText(lang: Lang): string {
  return lang === "en"
    ? "This deletion confirmation has expired. Type 'delete my data' to start again."
    : "Deze verwijderbevestiging is verlopen. Typ 'verwijder mijn data' om opnieuw te beginnen.";
}

function deletionOutcomeText(
  lang: Lang,
  outcome: UserDataDeletionOutcome
): string {
  if (outcome.status === "completed") {
    return deletionDoneText(lang);
  }

  return outcome.status === "pending"
    ? deletionPendingText(lang)
    : deletionFailedText(lang);
}

export async function deleteUserDataAndSendResult(
  psid: string,
  lang: Lang,
  sendText: (text: string) => Promise<boolean | void>
): Promise<void> {
  const outcome = await deleteUserData(psid);
  if (outcome.status !== "completed") {
    try {
      if (await Promise.resolve(getState(psid))) {
        await Promise.resolve(setPendingDeleteConfirm(psid, false));
      }
    } catch {
      // The deletion service already reports storage failures. Still send the
      // user the pending/failed outcome when the state store is unavailable.
    }
  }
  await sendText(deletionOutcomeText(lang, outcome));
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
    ? `Your consent is registered ✅\nYou can delete your data anytime by typing '${command}'.`
    : `Je toestemming is geregistreerd ✅\nJe kan je data altijd verwijderen door '${command}' te typen.`;
}

function consentActions(lang: Lang): ConversationAction[] {
  return [
    {
      id: GDPR_CONSENT_AGREE,
      label: lang === "en" ? "I Agree" : "Ik ga akkoord",
    },
    {
      id: GDPR_CONSENT_DECLINE,
      label: lang === "en" ? "No thanks" : "Nee bedankt",
    },
  ];
}

function deleteActions(lang: Lang): ConversationAction[] {
  return [
    {
      id: GDPR_DELETE_CONFIRM,
      label: lang === "en" ? "Yes, delete" : "Ja, verwijder",
    },
    {
      id: GDPR_DELETE_CANCEL,
      label: lang === "en" ? "Cancel" : "Annuleer",
    },
  ];
}

function whatsAppConsentButtons(
  lang: Lang
): Array<{ id: string; title: string }> {
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

function whatsAppDeleteButtons(
  lang: Lang
): Array<{ id: string; title: string }> {
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

function whatsAppDeleteNoticeButtons(
  lang: Lang
): Array<{ id: string; title: string }> {
  const command = deleteCommand(lang);
  return [
    {
      id: command,
      title: lang === "en" ? "🗑 Delete my data" : "🗑 Verwijder data",
    },
  ];
}

async function acceptMessengerConsent(
  input: MessengerConsentGateInput
): Promise<void> {
  await Promise.resolve(setConsentState(input.psid, true));
  await input.sendText(messengerConsentAcceptedText(input.lang));
  const response = buildQuickStartResponse(input.lang);
  await input.sendActions(response.text ?? "", response.actions ?? []);
}

async function declineMessengerConsent(
  input: MessengerConsentGateInput
): Promise<void> {
  await Promise.resolve(setConsentState(input.psid, false));
  await input.sendText(consentDeclinedText(input.lang));
}

export async function handleMessengerConsentGate(
  input: MessengerConsentGateInput
): Promise<boolean> {
  const hasActiveDeleteRequest = hasActiveDeleteConfirmation(input.state);

  if (input.payload === GDPR_CONSENT_AGREE) {
    await acceptMessengerConsent(input);
    return true;
  }

  if (input.payload === GDPR_CONSENT_DECLINE) {
    await declineMessengerConsent(input);
    return true;
  }

  if (input.payload === GDPR_DELETE_CANCEL) {
    if (!hasActiveDeleteRequest) {
      if (input.state.pendingDeleteConfirm) {
        await clearPendingDeleteConfirmation(input.psid);
      }
      await input.sendText(deletionConfirmationExpiredText(input.lang));
      return true;
    }
    await clearPendingDeleteConfirmation(input.psid);
    await input.sendText(deleteCancelledText(input.lang));
    return true;
  }

  if (input.payload === GDPR_DELETE_CONFIRM) {
    if (!hasActiveDeleteRequest) {
      if (input.state.pendingDeleteConfirm) {
        await clearPendingDeleteConfirmation(input.psid);
      }
      await input.sendText(deletionConfirmationExpiredText(input.lang));
      return true;
    }
    await clearPendingDeleteConfirmation(input.psid);
    await deleteUserDataAndSendResult(
      input.psid,
      input.lang,
      input.sendDeletionOutcome ?? input.sendText
    );
    return true;
  }

  if (hasActiveDeleteRequest && isDeleteConfirmText(input.text)) {
    await clearPendingDeleteConfirmation(input.psid);
    await deleteUserDataAndSendResult(
      input.psid,
      input.lang,
      input.sendDeletionOutcome ?? input.sendText
    );
    return true;
  }

  if (hasActiveDeleteRequest && isDeleteCancelText(input.text)) {
    await clearPendingDeleteConfirmation(input.psid);
    await input.sendText(deleteCancelledText(input.lang));
    return true;
  }

  if (isDeleteCommand(input.text) || isDeleteCommand(input.payload)) {
    const controlsDelivered = await input.sendActions(
      deletionConfirmText(input.lang),
      deleteActions(input.lang)
    );
    if (controlsDelivered !== false) {
      await Promise.resolve(setPendingDeleteConfirm(input.psid, true));
    }
    return true;
  }

  if (input.state.pendingDeleteConfirm) {
    if (!hasActiveDeleteRequest) {
      await clearPendingDeleteConfirmation(input.psid);
      await input.sendText(deletionConfirmationExpiredText(input.lang));
      return true;
    }
    await input.sendActions(
      deletionConfirmText(input.lang),
      deleteActions(input.lang)
    );
    return true;
  }

  if (input.state.consentGiven !== true) {
    if (
      isConsentAgreeText(
        input.text,
        wasConsentPromptedRecently(input.state.consentPromptedAt)
      )
    ) {
      await acceptMessengerConsent(input);
      return true;
    }

    if (isConsentDeclineText(input.text)) {
      await declineMessengerConsent(input);
      return true;
    }

    if (input.state.consentDeclinedAt !== undefined) {
      await input.sendText(consentDeclinedText(input.lang));
      return true;
    }

    const notice = consentText(input.lang);
    let controlsDelivered: boolean | void;
    try {
      controlsDelivered = await input.sendActions(
        notice,
        consentActions(input.lang)
      );
    } catch (error) {
      input.onConsentControlsError?.(error);
      controlsDelivered = false;
    }
    const promptDelivered =
      controlsDelivered === false ? await input.sendText(notice) : true;
    if (promptDelivered !== false) {
      await Promise.resolve(setConsentPromptedAt(input.psid));
    }
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
  const hasActiveDeleteRequest = hasActiveDeleteConfirmation(input.state);

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
    if (!hasActiveDeleteRequest) {
      if (input.state.pendingDeleteConfirm) {
        await clearPendingDeleteConfirmation(input.event.senderId);
      }
      await input.sendText(deletionConfirmationExpiredText(input.lang));
      return true;
    }
    await clearPendingDeleteConfirmation(input.event.senderId);
    await input.sendText(deleteCancelledText(input.lang));
    return true;
  }

  if (payload === GDPR_DELETE_CONFIRM) {
    if (!hasActiveDeleteRequest) {
      if (input.state.pendingDeleteConfirm) {
        await clearPendingDeleteConfirmation(input.event.senderId);
      }
      await input.sendText(deletionConfirmationExpiredText(input.lang));
      return true;
    }
    await clearPendingDeleteConfirmation(input.event.senderId);
    await deleteUserDataAndSendResult(
      input.event.senderId,
      input.lang,
      input.sendDeletionOutcome ?? input.sendText
    );
    return true;
  }

  if (hasActiveDeleteRequest && isDeleteConfirmText(text)) {
    await clearPendingDeleteConfirmation(input.event.senderId);
    await deleteUserDataAndSendResult(
      input.event.senderId,
      input.lang,
      input.sendDeletionOutcome ?? input.sendText
    );
    return true;
  }

  if (hasActiveDeleteRequest && isDeleteCancelText(text)) {
    await clearPendingDeleteConfirmation(input.event.senderId);
    await input.sendText(deleteCancelledText(input.lang));
    return true;
  }

  if (isDeleteCommand(text) || isDeleteCommand(payload)) {
    await input.sendButtons(
      deletionConfirmText(input.lang),
      whatsAppDeleteButtons(input.lang)
    );
    await Promise.resolve(setPendingDeleteConfirm(input.event.senderId, true));
    return true;
  }

  if (input.state.pendingDeleteConfirm) {
    if (!hasActiveDeleteRequest) {
      await clearPendingDeleteConfirmation(input.event.senderId);
      await input.sendText(deletionConfirmationExpiredText(input.lang));
      return true;
    }
    await input.sendButtons(
      deletionConfirmText(input.lang),
      whatsAppDeleteButtons(input.lang)
    );
    return true;
  }

  if (input.state.consentGiven !== true) {
    if (isConsentAgreeText(text, false)) {
      await Promise.resolve(setConsentState(input.event.senderId, true));
      await input.sendButtons(
        consentAcceptedText(input.lang),
        whatsAppDeleteNoticeButtons(input.lang)
      );
      return true;
    }

    if (isConsentDeclineText(text)) {
      await Promise.resolve(setConsentState(input.event.senderId, false));
      await input.sendText(consentDeclinedText(input.lang));
      return true;
    }

    if (input.state.consentDeclinedAt !== undefined) {
      await input.sendText(consentDeclinedText(input.lang));
      return true;
    }

    await input.sendButtons(
      consentText(input.lang),
      whatsAppConsentButtons(input.lang)
    );
    return true;
  }

  return false;
}
