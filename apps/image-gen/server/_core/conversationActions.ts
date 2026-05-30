import { type Lang, t } from "./i18n";
import type { ConversationResponse } from "./botResponse";

export const CONVERSATION_ACTION_CHOOSE_STYLE = "CHOOSE_STYLE";
export const CONVERSATION_ACTION_PRIVACY_INFO = "PRIVACY_INFO";
export const CONVERSATION_ACTION_RETRY_STYLE = "RETRY_STYLE";

export function buildGenerationSuccessResponse(
  lang: Lang
): ConversationResponse {
  return {
    text: t(lang, "success"),
    actions: [
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
  retryActionId = CONVERSATION_ACTION_RETRY_STYLE
): ConversationResponse {
  return {
    text,
    actions: [
      {
        id: retryActionId,
        label: t(lang, "retryThisStyle"),
      },
      {
        id: CONVERSATION_ACTION_CHOOSE_STYLE,
        label: t(lang, "otherStyle"),
      },
    ],
  };
}
