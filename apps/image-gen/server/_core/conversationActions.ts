import { type Lang, t } from "./i18n";
import type { ConversationResponse } from "./botResponse";

export const CONVERSATION_ACTION_NEW_IMAGE = "NEW_IMAGE";
export const CONVERSATION_ACTION_PRIVACY_INFO = "PRIVACY_INFO";
export const CONVERSATION_ACTION_RETRY_GENERATION = "RETRY_GENERATION";
export const CONVERSATION_ACTION_SURPRISE_ME = "SURPRISE_ME";
export const CONVERSATION_ACTION_WHAT_IS_THIS = "WHAT_IS_THIS";

export function buildQuickStartResponse(lang: Lang): ConversationResponse {
  return {
    text: t(lang, "flowExplanation"),
    actions: [
      {
        id: CONVERSATION_ACTION_WHAT_IS_THIS,
        label: t(lang, "whatIsThis"),
      },
      {
        id: CONVERSATION_ACTION_PRIVACY_INFO,
        label: "Privacy",
      },
    ],
  };
}

export function buildGenerationSuccessResponse(
  lang: Lang
): ConversationResponse {
  return {
    text: t(lang, "success"),
    actions: [
      {
        id: CONVERSATION_ACTION_NEW_IMAGE,
        label: t(lang, "newImage"),
        inputText: t(lang, "newImage"),
      },
      {
        id: CONVERSATION_ACTION_PRIVACY_INFO,
        label: "Privacy",
      },
    ],
  };
}

export function buildGenerationFailureResponse(
  lang: Lang,
  text: string,
  retryStyle?: string
): ConversationResponse {
  return {
    text,
    actions: [
      {
        id: CONVERSATION_ACTION_RETRY_GENERATION,
        label: t(lang, "retryThisStyle"),
        data: retryStyle ? { retryStyle } : undefined,
      },
      {
        id: CONVERSATION_ACTION_NEW_IMAGE,
        label: t(lang, "newImage"),
        inputText: t(lang, "newImage"),
      },
    ],
  };
}

export function buildAssistantPhotoHelpResponse(lang: Lang): ConversationResponse {
  return {
    text: t(lang, "assistantQuickActions"),
    actions: [
      {
        id: CONVERSATION_ACTION_NEW_IMAGE,
        label: t(lang, "newImage"),
        inputText: t(lang, "newImage"),
      },
      {
        id: CONVERSATION_ACTION_SURPRISE_ME,
        label: t(lang, "surpriseMe"),
        inputText: t(lang, "surpriseMe"),
      },
      {
        id: CONVERSATION_ACTION_PRIVACY_INFO,
        label: "Privacy",
      },
    ],
  };
}
