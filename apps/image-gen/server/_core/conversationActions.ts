import { type Lang, t } from "./i18n";
import type { ConversationResponse } from "./botResponse";

export const CONVERSATION_ACTION_CHOOSE_STYLE = "CHOOSE_STYLE";
export const CONVERSATION_ACTION_PRIVACY_INFO = "PRIVACY_INFO";

export function buildGenerationSuccessResponse(
  lang: Lang
): ConversationResponse {
  return {
    text: t(lang, "success"),
    actions: [
      {
        id: CONVERSATION_ACTION_CHOOSE_STYLE,
        label: t(lang, "newStyle"),
      },
      {
        id: CONVERSATION_ACTION_PRIVACY_INFO,
        label: t(lang, "privacyButtonLabel"),
      },
    ],
  };
}
