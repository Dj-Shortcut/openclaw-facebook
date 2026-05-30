import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type {
  MessagePresentation,
  MessagePresentationBlock,
  MessagePresentationButton,
  MessagePresentationOption,
} from "openclaw/plugin-sdk/interactive-runtime";

export const MESSENGER_OPENCLAW_ACTION_PREFIX = "OPENCLAW_ACTION:";
export const MESSENGER_QUICK_REPLY_MIN_COUNT = 2;
export const MESSENGER_QUICK_REPLY_MAX_COUNT = 4;
export const MESSENGER_QUICK_REPLY_TITLE_MAX_LENGTH = 20;
export const MESSENGER_QUICK_REPLY_PAYLOAD_MAX_BYTES = 1000;
export const MESSENGER_QUICK_REPLY_CONTENT_TYPE = "text";

export type ConversationAction = {
  id: string;
  label: string;
};

export type MessengerQuickReply = {
  content_type: typeof MESSENGER_QUICK_REPLY_CONTENT_TYPE;
  title: string;
  payload: string;
};

export type MessengerNativePresentation = {
  quickReplies?: MessengerQuickReply[];
};

export type MessengerPresentationPayload = ReplyPayload & {
  actions?: ConversationAction[];
  channelData?: Record<string, unknown> & {
    facebook?: MessengerNativePresentation;
  };
};

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function trimToCodePoints(value: string, maxLength: number): string {
  return Array.from(value.trim()).slice(0, maxLength).join("");
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function normalizeQuickReplyLabel(value: unknown): string | null {
  if (!hasText(value)) {
    return null;
  }
  const label = trimToCodePoints(value, MESSENGER_QUICK_REPLY_TITLE_MAX_LENGTH);
  return label || null;
}

function normalizeQuickReplyPayload(value: unknown, fallback: string): string | null {
  const payload = hasText(value) ? value.trim() : fallback.trim();
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
  const payload = normalizeQuickReplyPayload(action.id, action.label);
  if (!payload) {
    return null;
  }
  const encodedPayload = encodeOpenClawActionPayload(payload);
  if (!encodedPayload) {
    return null;
  }
  return { content_type: MESSENGER_QUICK_REPLY_CONTENT_TYPE, title, payload: encodedPayload };
}

function extractQuickReplies(blocks: readonly MessagePresentationBlock[]): MessengerQuickReply[] {
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

function extractActionQuickReplies(actions: readonly ConversationAction[] | undefined): MessengerQuickReply[] {
  return (actions ?? [])
    .map(actionToQuickReply)
    .filter((quickReply): quickReply is MessengerQuickReply => quickReply !== null);
}

function shouldRenderQuickReplies(quickReplies: readonly MessengerQuickReply[]): boolean {
  return (
    quickReplies.length >= MESSENGER_QUICK_REPLY_MIN_COUNT &&
    quickReplies.length <= MESSENGER_QUICK_REPLY_MAX_COUNT
  );
}

function presentationText(presentation: MessagePresentation, fallbackText: string | undefined): string | null {
  const parts: string[] = [];
  if (hasText(fallbackText)) {
    parts.push(fallbackText.trim());
  }
  if (hasText(presentation.title) && !parts.includes(presentation.title.trim())) {
    parts.push(presentation.title.trim());
  }
  for (const block of presentation.blocks) {
    if ((block.type === "text" || block.type === "context") && hasText(block.text)) {
      const text = block.text.trim();
      if (!parts.includes(text)) {
        parts.push(text);
      }
    }
    if (block.type === "select" && hasText(block.placeholder)) {
      const text = block.placeholder.trim();
      if (!parts.includes(text)) {
        parts.push(text);
      }
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

export function renderMessengerPresentationPayload(params: {
  payload: ReplyPayload;
  presentation: MessagePresentation;
}): MessengerPresentationPayload | null {
  const quickReplies = extractQuickReplies(params.presentation.blocks);
  const text = presentationText(params.presentation, params.payload.text);
  if (!text || !shouldRenderQuickReplies(quickReplies)) {
    return null;
  }
  return {
    ...params.payload,
    text,
    channelData: {
      ...(params.payload.channelData ?? {}),
      facebook: {
        ...((params.payload.channelData?.facebook as MessengerNativePresentation | undefined) ?? {}),
        quickReplies,
      },
    },
  };
}

export function renderMessengerActionPayload(payload: MessengerPresentationPayload): MessengerPresentationPayload | null {
  const quickReplies = extractActionQuickReplies(payload.actions);
  const text = hasText(payload.text) ? payload.text.trim() : null;
  if (!text || !shouldRenderQuickReplies(quickReplies)) {
    return null;
  }
  return {
    ...payload,
    text,
    channelData: {
      ...(payload.channelData ?? {}),
      facebook: {
        ...((payload.channelData?.facebook as MessengerNativePresentation | undefined) ?? {}),
        quickReplies,
      },
    },
  };
}

export function renderMessengerReplyPayload(payload: ReplyPayload): MessengerPresentationPayload {
  const actionPayload = renderMessengerActionPayload(payload as MessengerPresentationPayload);
  if (actionPayload) {
    return actionPayload;
  }

  if (payload.presentation) {
    return renderMessengerPresentationPayload({
      payload,
      presentation: payload.presentation,
    }) ?? payload;
  }

  return payload;
}

export function getMessengerQuickReplies(payload: ReplyPayload): MessengerQuickReply[] | undefined {
  const quickReplies = (payload.channelData?.facebook as MessengerNativePresentation | undefined)
    ?.quickReplies;
  return quickReplies && shouldRenderQuickReplies(quickReplies) ? quickReplies : undefined;
}
