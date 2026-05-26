import { type Lang, t } from "./i18n";
import {
  getQuickRepliesForState,
  type ConversationState,
  type StateQuickReply,
} from "./messengerState";

function localizeReplyTitle(reply: StateQuickReply, lang: Lang): string {
  switch (reply.payload) {
    case "WHAT_IS_THIS":
      return t(lang, "whatIsThis");
    case "PRIVACY_INFO":
      return t(lang, "privacyButtonLabel");
    case "CHOOSE_STYLE":
      return t(lang, "newStyle");
    case "RETRY_STYLE":
      return t(lang, "retry");
    default:
      return reply.title;
  }
}

function normalizeSelectionText(value: string): string {
  return value.trim().toLowerCase();
}

export function resolveStateReplyPayload(
  state: ConversationState,
  rawSelection: string,
  lang: Lang
): string | undefined {
  const replies = getQuickRepliesForState(state);
  if (replies.length === 0) {
    return undefined;
  }

  const normalizedSelection = normalizeSelectionText(rawSelection);
  const selectedIndex = Number.parseInt(normalizedSelection, 10);
  if (Number.isFinite(selectedIndex) && selectedIndex > 0) {
    return replies[selectedIndex - 1]?.payload;
  }

  const matchedReply = replies.find(reply => {
    const localizedTitle = normalizeSelectionText(localizeReplyTitle(reply, lang));
    const rawTitle = normalizeSelectionText(reply.title);
    return (
      normalizedSelection === localizedTitle ||
      normalizedSelection === rawTitle
    );
  });

  return matchedReply?.payload;
}

export function buildStateResponseText(
  state: ConversationState,
  leadText: string,
  lang: Lang
): string {
  const replies = getQuickRepliesForState(state);
  if (replies.length === 0) {
    return leadText;
  }

  return [
    leadText,
    "",
    ...replies.map(
      (reply, index) => `${index + 1}. ${localizeReplyTitle(reply, lang)}`
    ),
  ].join("\n");
}
