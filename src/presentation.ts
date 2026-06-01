import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type {
  MessagePresentation,
  MessagePresentationBlock,
  MessagePresentationButton,
  MessagePresentationOption,
} from "openclaw/plugin-sdk/interactive-runtime";

export const MESSENGER_OPENCLAW_ACTION_PREFIX = "OPENCLAW_ACTION:";
export const MESSENGER_QUICK_REPLY_MIN_COUNT = 1;
const MESSENGER_INFERRED_CHOICE_MIN_COUNT = 2;
export const MESSENGER_QUICK_REPLY_MAX_COUNT = 13;
export const MESSENGER_QUICK_REPLY_TITLE_MAX_LENGTH = 20;
export const MESSENGER_QUICK_REPLY_PAYLOAD_MAX_BYTES = 1000;
export const MESSENGER_QUICK_REPLY_CONTENT_TYPE = "text";

export type ConversationAction = {
  id?: string;
  label: string;
  inputText?: string;
  value?: string;
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
  return Array.from(value.trim()).slice(0, maxLength).join("").trim();
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

function extractNumberedChoicesFromText(text: string | undefined): ConversationAction[] {
  if (!hasText(text) || text.includes("```")) {
    return [];
  }

  const choices: string[] = [];
  let currentChoice: string | null = null;
  let expectedNumber = 1;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const match = /^(\d{1,2})[\.)]\s+(.+)$/u.exec(line);
    if (match) {
      const number = Number(match[1]);
      if (!Number.isInteger(number) || number !== expectedNumber) {
        currentChoice = null;
        continue;
      }
      currentChoice = match[2]?.trim() ?? "";
      if (currentChoice) {
        choices.push(currentChoice);
        expectedNumber += 1;
      }
      continue;
    }

    if (!line) {
      currentChoice = null;
      continue;
    }

    if (currentChoice && choices.length > 0 && !/[.!?]$/u.test(currentChoice)) {
      const continued = `${currentChoice} ${line}`.trim();
      choices[choices.length - 1] = continued;
      currentChoice = continued;
    }
  }

  if (
    choices.length < MESSENGER_INFERRED_CHOICE_MIN_COUNT ||
    choices.length > MESSENGER_QUICK_REPLY_MAX_COUNT
  ) {
    return [];
  }

  return choices.map((choice) => {
    const label = normalizeInferredChoiceLabel(choice);
    return {
      label,
      inputText: normalizeInferredChoiceInput(label),
    };
  });
}

function normalizeInferredChoiceLabel(choice: string): string {
  const cleaned = choice
    .replace(/[,:;?!.]+$/u, "")
    .replace(/^(?:of\s+)?(?:een|a|an)\s+/iu, "")
    .replace(/\s+(?:schrijf|schrijven|write)(?:\s+(?:waarmee|which|that)\b.*)?$/iu, "")
    .replace(/\s+(?:maak|maken|schrijf|schrijven)$/iu, "")
    .trim();

  const label = /\b(?:tekstprompt|image prompt|prompt)\b/iu.test(cleaned)
    ? cleaned.match(/\b(?:tekstprompt|image prompt|prompt)\b/iu)?.[0] ?? cleaned
    : cleaned;

  return label || choice.trim();
}

function normalizeInferredChoiceInput(label: string): string {
  const normalizedLabel = label.trim().replace(/[,:;?!.]+$/u, "");
  if (/^(?:tekstprompt|prompt|image prompt)$/iu.test(normalizedLabel)) {
    return normalizedLabel === "image prompt"
      ? "Write an image prompt"
      : "Schrijf een tekstprompt";
  }
  if (/^(?:maak|genereer|create|generate|schrijf|write)\b/iu.test(normalizedLabel)) {
    return normalizedLabel;
  }
  return `Maak een ${normalizedLabel}`;
}

function stripNumberedChoicesFromText(text: string): string {
  const keptLines: string[] = [];
  let currentChoice: string | null = null;
  let expectedNumber = 1;

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const match = /^(\d{1,2})[\.)]\s+(.+)$/u.exec(line);
    if (match) {
      const number = Number(match[1]);
      if (Number.isInteger(number) && number === expectedNumber) {
        currentChoice = match[2]?.trim() ?? "";
        expectedNumber += 1;
        continue;
      }
    }

    if (currentChoice && line && !/[.!?]$/u.test(currentChoice)) {
      currentChoice = `${currentChoice} ${line}`.trim();
      continue;
    }

    currentChoice = null;
    keptLines.push(rawLine);
  }

  const compacted = keptLines
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();

  return compacted || text.trim();
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
  const text = hasText(payload.text) ? payload.text.trim() : null;
  const inferredActions = extractNumberedChoicesFromText(text ?? undefined);
  const quickReplies = extractActionQuickReplies([
    ...inferredActions,
    ...(payload.actions ?? []),
  ]);
  if (!text || !shouldRenderQuickReplies(quickReplies)) {
    return null;
  }
  return {
    ...payload,
    text: inferredActions.length ? stripNumberedChoicesFromText(text) : text,
    channelData: {
      ...(payload.channelData ?? {}),
      facebook: {
        ...((payload.channelData?.facebook as MessengerNativePresentation | undefined) ?? {}),
        quickReplies,
      },
    },
  };
}

export function renderMessengerInferredChoicePayload(
  payload: MessengerPresentationPayload,
): MessengerPresentationPayload | null {
  if (payload.actions?.length || payload.presentation) {
    return null;
  }
  const nativeQuickReplies = (payload.channelData?.facebook as MessengerNativePresentation | undefined)
    ?.quickReplies;
  if (nativeQuickReplies?.length) {
    return null;
  }
  const text = hasText(payload.text) ? payload.text.trim() : null;
  if (!text) {
    return null;
  }

  const quickReplies = extractActionQuickReplies(extractNumberedChoicesFromText(text));
  if (!shouldRenderQuickReplies(quickReplies)) {
    return null;
  }
  return {
    ...payload,
    text: stripNumberedChoicesFromText(text),
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

  return renderMessengerInferredChoicePayload(payload as MessengerPresentationPayload) ?? payload;
}

export function getMessengerQuickReplies(payload: ReplyPayload): MessengerQuickReply[] | undefined {
  const quickReplies = (payload.channelData?.facebook as MessengerNativePresentation | undefined)
    ?.quickReplies;
  return quickReplies && shouldRenderQuickReplies(quickReplies) ? quickReplies : undefined;
}
