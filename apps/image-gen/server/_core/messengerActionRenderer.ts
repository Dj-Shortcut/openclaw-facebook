import type { ConversationAction } from "./botResponse";
import type { QuickReply } from "./messengerApi";
import { encodeMessengerActionInput } from "./messengerActionPayload";
import { CONVERSATION_ACTION_RETRY_GENERATION } from "./conversationActions";

function normalizeActionValue(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function renderMessengerQuickReplies(
  actions: readonly ConversationAction[] | undefined
): QuickReply[] {
  if (!actions?.length) {
    return [];
  }

  return actions.flatMap(action => {
    const title = normalizeActionValue(action.label);
    const payload = normalizeActionValue(renderMessengerActionPayload(action));
    if (!title || !payload) {
      return [];
    }

    return [
      {
        content_type: "text" as const,
        title,
        payload,
      },
    ];
  });
}

function renderMessengerActionPayload(action: ConversationAction): string {
  if (action.inputText) {
    return encodeMessengerActionInput(action.inputText);
  }

  if (action.id === CONVERSATION_ACTION_RETRY_GENERATION) {
    return action.data?.retryStyle
      ? `RETRY_STYLE_${action.data.retryStyle}`
      : "RETRY_STYLE";
  }

  return action.id;
}
