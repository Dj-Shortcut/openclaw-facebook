import type { ConversationAction } from "./botResponse";
import type { QuickReply } from "./messengerApi";
import { encodeMessengerActionInput } from "./messengerActionPayload";

const MESSENGER_QUICK_REPLY_TITLE_MAX_LENGTH = 20;

function normalizeActionValue(value: string): string | undefined {
  const trimmed = Array.from(value.trim())
    .slice(0, MESSENGER_QUICK_REPLY_TITLE_MAX_LENGTH)
    .join("")
    .trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizePayloadValue(value: string): string | undefined {
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
    const payload = normalizePayloadValue(renderMessengerActionPayload(action));
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
  return encodeMessengerActionInput(action.inputText ?? action.label ?? action.id);
}
