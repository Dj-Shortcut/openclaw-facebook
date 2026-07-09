import type {
  MessagePresentationBlock,
  MessagePresentationButton,
  MessagePresentationOption,
} from "openclaw/plugin-sdk/interactive-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import {
  MESSENGER_OPENCLAW_ACTION_PREFIX,
  MESSENGER_QUICK_REPLY_CONTENT_TYPE,
  MESSENGER_QUICK_REPLY_MAX_COUNT,
  MESSENGER_QUICK_REPLY_MIN_COUNT,
  MESSENGER_QUICK_REPLY_PAYLOAD_MAX_BYTES,
  MESSENGER_QUICK_REPLY_TITLE_MAX_LENGTH,
  type ConversationAction,
  type MessengerNativePresentation,
  type MessengerQuickReply,
} from "./messengerPresentationTypes.js";
import {
  hasText,
  stripMessengerMarkdown,
  trimToCodePoints,
  utf8ByteLength,
} from "./messengerPresentationText.js";

function normalizeQuickReplyLabel(value: unknown): string | null {
  if (!hasText(value)) {
    return null;
  }
  const label = trimToCodePoints(
    stripMessengerMarkdown(value),
    MESSENGER_QUICK_REPLY_TITLE_MAX_LENGTH,
  );
  return label || null;
}

function normalizeQuickReplyPayload(value: unknown, fallback: string): string | null {
  const payload = hasText(value)
    ? stripMessengerMarkdown(value)
    : stripMessengerMarkdown(fallback);
  if (!payload || utf8ByteLength(payload) > MESSENGER_QUICK_REPLY_PAYLOAD_MAX_BYTES) {
    return null;
  }
  return payload;
}

function encodeOpenClawActionPayload(value: string): string | null {
  const encoded = `${MESSENGER_OPENCLAW_ACTION_PREFIX}${value}`;
  return utf8ByteLength(encoded) > MESSENGER_QUICK_REPLY_PAYLOAD_MAX_BYTES ? null : encoded;
}

export function decodeOpenClawActionPayload(payload: string | undefined): string | null {
  const trimmed = payload?.trim();
  if (!trimmed?.startsWith(MESSENGER_OPENCLAW_ACTION_PREFIX)) {
    return null;
  }
  const value = trimmed.slice(MESSENGER_OPENCLAW_ACTION_PREFIX.length).trim();
  return value || null;
}

function buttonToQuickReply(button: MessagePresentationButton): MessengerQuickReply | null {
  if (button.disabled || button.url || button.webApp || button.web_app) {
    return null;
  }
  const title = normalizeQuickReplyLabel(button.label);
  if (!title) {
    return null;
  }
  const payload = normalizeQuickReplyPayload(button.value, button.label);
  if (!payload) {
    return null;
  }
  const encodedPayload = encodeOpenClawActionPayload(payload);
  if (!encodedPayload) {
    return null;
  }
  return { content_type: MESSENGER_QUICK_REPLY_CONTENT_TYPE, title, payload: encodedPayload };
}

function optionToQuickReply(option: MessagePresentationOption): MessengerQuickReply | null {
  const title = normalizeQuickReplyLabel(option.label);
  if (!title) {
    return null;
  }
  const payload = normalizeQuickReplyPayload(option.value, option.label);
  if (!payload) {
    return null;
  }
  const encodedPayload = encodeOpenClawActionPayload(payload);
  if (!encodedPayload) {
    return null;
  }
  return { content_type: MESSENGER_QUICK_REPLY_CONTENT_TYPE, title, payload: encodedPayload };
}

function actionToQuickReply(action: ConversationAction): MessengerQuickReply | null {
  const title = normalizeQuickReplyLabel(action.label);
  if (!title) {
    return null;
  }
  const payload = normalizeQuickReplyPayload(
    action.inputText ?? action.value ?? action.id,
    action.label,
  );
  if (!payload) {
    return null;
  }
  const encodedPayload = encodeOpenClawActionPayload(payload);
  if (!encodedPayload) {
    return null;
  }
  return { content_type: MESSENGER_QUICK_REPLY_CONTENT_TYPE, title, payload: encodedPayload };
}

export function extractQuickReplies(
  blocks: readonly MessagePresentationBlock[],
): MessengerQuickReply[] {
  const quickReplies: MessengerQuickReply[] = [];
  for (const block of blocks) {
    if (block.type === "buttons") {
      for (const button of block.buttons) {
        const quickReply = buttonToQuickReply(button);
        if (quickReply) {
          quickReplies.push(quickReply);
        }
      }
      continue;
    }
    if (block.type === "select") {
      for (const option of block.options) {
        const quickReply = optionToQuickReply(option);
        if (quickReply) {
          quickReplies.push(quickReply);
        }
      }
    }
  }
  return quickReplies;
}

export function extractActionQuickReplies(
  actions: readonly ConversationAction[] | undefined,
): MessengerQuickReply[] {
  return (actions ?? [])
    .map(actionToQuickReply)
    .filter((quickReply): quickReply is MessengerQuickReply => quickReply !== null);
}

export function shouldRenderQuickReplies(
  quickReplies: readonly MessengerQuickReply[],
): boolean {
  return (
    quickReplies.length >= MESSENGER_QUICK_REPLY_MIN_COUNT &&
    quickReplies.length <= MESSENGER_QUICK_REPLY_MAX_COUNT
  );
}

export function getMessengerQuickReplies(payload: ReplyPayload): MessengerQuickReply[] | undefined {
  const quickReplies = (payload.channelData?.facebook as MessengerNativePresentation | undefined)
    ?.quickReplies;
  return quickReplies && shouldRenderQuickReplies(quickReplies) ? quickReplies : undefined;
}
