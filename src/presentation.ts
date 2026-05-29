import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type {
  MessagePresentation,
  MessagePresentationBlock,
  MessagePresentationButton,
  MessagePresentationOption,
} from "openclaw/plugin-sdk/interactive-runtime";

export const MESSENGER_QUICK_REPLY_MIN_COUNT = 2;
export const MESSENGER_QUICK_REPLY_MAX_COUNT = 4;
export const MESSENGER_QUICK_REPLY_TITLE_MAX_LENGTH = 20;
export const MESSENGER_QUICK_REPLY_PAYLOAD_MAX_BYTES = 1000;
export const MESSENGER_QUICK_REPLY_CONTENT_TYPE = "text";

export type MessengerQuickReply = {
  content_type: typeof MESSENGER_QUICK_REPLY_CONTENT_TYPE;
  title: string;
  payload: string;
};

export type MessengerNativePresentation = {
  quickReplies?: MessengerQuickReply[];
};

export type MessengerPresentationPayload = ReplyPayload & {
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
  return { content_type: MESSENGER_QUICK_REPLY_CONTENT_TYPE, title, payload };
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
  return { content_type: MESSENGER_QUICK_REPLY_CONTENT_TYPE, title, payload };
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
  return quickReplies.slice(0, MESSENGER_QUICK_REPLY_MAX_COUNT);
}

function shouldRenderQuickReplies(quickReplies: readonly MessengerQuickReply[]): boolean {
  return (
    quickReplies.length >= MESSENGER_QUICK_REPLY_MIN_COUNT &&
    quickReplies.length <= MESSENGER_QUICK_REPLY_MAX_COUNT
  );
}

function presentationText(presentation: MessagePresentation, fallbackText: string | undefined): string {
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
  return parts.join("\n\n") || "Kies een optie.";
}

export function renderMessengerPresentationPayload(params: {
  payload: ReplyPayload;
  presentation: MessagePresentation;
}): MessengerPresentationPayload | null {
  const quickReplies = extractQuickReplies(params.presentation.blocks);
  if (!shouldRenderQuickReplies(quickReplies)) {
    return null;
  }
  return {
    ...params.payload,
    text: presentationText(params.presentation, params.payload.text),
    channelData: {
      ...(params.payload.channelData ?? {}),
      facebook: {
        ...((params.payload.channelData?.facebook as MessengerNativePresentation | undefined) ?? {}),
        quickReplies,
      },
    },
  };
}

export function getMessengerQuickReplies(payload: ReplyPayload): MessengerQuickReply[] | undefined {
  const quickReplies = (payload.channelData?.facebook as MessengerNativePresentation | undefined)
    ?.quickReplies;
  return quickReplies && shouldRenderQuickReplies(quickReplies) ? quickReplies : undefined;
}
