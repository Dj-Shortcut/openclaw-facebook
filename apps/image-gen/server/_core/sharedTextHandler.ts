import { t, type Lang } from "./i18n";
import type { ConversationState, MessengerUserState } from "./messengerState";
import { safeLog } from "./messengerApi";
import { detectAck, getGreetingResponse } from "./webhookHelpers";
import { toLogUser } from "./privacy";
import type { NormalizedInboundMessage } from "./normalizedInboundMessage";
import type { BotResponse } from "./botResponse";

const GREETINGS = new Set(["hi", "hello", "hey", "yo", "hola"]);
const SMALLTALK = new Set([
  "how are you",
  "how are you?",
  "sup",
  "what's up",
  "whats up",
  "thanks",
  "thank you",
]);

type SharedTextHandlerInput = {
  message: NormalizedInboundMessage;
  reqId: string;
  lang: Lang;
  getState: () => Promise<MessengerUserState>;
  setFlowState: (state: ConversationState) => Promise<void>;
  runTextFeatures?: (args: {
    state: MessengerUserState;
    messageText: string;
    normalizedText: string;
    hasPhoto: boolean;
  }) => Promise<boolean>;
  logState?: (state: MessengerUserState, context: string) => void;
  logAckIgnored?: (ack: string) => void;
};

/**
 * Shared text handling currently only covers normalized text messages.
 * Channel adapters remain responsible for media-specific flows and any
 * post-send side effects returned via this result contract.
 */
type SharedTextHandlerResult = {
  response: BotResponse | null;
  replyState?: ConversationState;
  afterSend?: "markIntroSeen";
};

type PreparedSharedTextMessage = {
  trimmedText: string;
  normalizedText: string;
};

function prepareSharedTextMessage(
  message: NormalizedInboundMessage
): PreparedSharedTextMessage | null {
  if (message.messageType !== "text") {
    return null;
  }

  const trimmedText = message.textBody?.trim();
  const normalizedText = trimmedText?.toLowerCase();
  if (!trimmedText || !normalizedText) {
    return null;
  }

  return { trimmedText, normalizedText };
}

function logSharedTextExecution(input: SharedTextHandlerInput): void {
  safeLog("shared_text_executing", {
    channel: input.message.channel,
    reqId: input.reqId,
    user: toLogUser(input.message.userId),
    messageType: input.message.messageType,
  });
}

function tryHandleAck(
  input: SharedTextHandlerInput,
  trimmedText: string
): SharedTextHandlerResult | null {
  const ack = detectAck(trimmedText);
  if (!ack) {
    return null;
  }

  if (input.logAckIgnored) {
    input.logAckIgnored(ack);
  } else {
    safeLog("ack_ignored", { ack, channel: input.message.channel });
  }

  return { response: null };
}

async function tryHandleGreetingOrSmalltalk(
  input: SharedTextHandlerInput,
  normalizedText: string
): Promise<SharedTextHandlerResult | null> {
  if (!GREETINGS.has(normalizedText) && !SMALLTALK.has(normalizedText)) {
    return null;
  }

  const state = await input.getState();
  input.logState?.(state, "greeting");
  if (!state.hasSeenIntro && state.stage === "IDLE") {
    return {
      response: { kind: "text", text: t(input.lang, "flowExplanation") },
      replyState: "IDLE",
      afterSend: "markIntroSeen",
    };
  }

  const response = getGreetingResponse(state.stage, input.lang);
  if (response.mode === "text") {
    return { response: { kind: "text", text: response.text } };
  }

  return {
    response: { kind: "text", text: response.text },
    replyState: response.state,
  };
}

async function tryHandleNewStyleShortcut(
  input: SharedTextHandlerInput,
  normalizedText: string
): Promise<SharedTextHandlerResult | null> {
  if (normalizedText !== "nieuwe stijl" && normalizedText !== "new style") {
    return null;
  }

  const state = await input.getState();
  if (!state.lastPhotoUrl) {
    return null;
  }

  await input.setFlowState("AWAITING_STYLE");
  return {
    response: { kind: "text", text: t(input.lang, "styleCategoryPicker") },
    replyState: "AWAITING_STYLE",
  };
}

function buildDefaultTextResponse(
  lang: Lang,
  hasPhoto: boolean
): SharedTextHandlerResult {
  return {
    response: {
      kind: "text",
      text: hasPhoto ? t(lang, "flowExplanation") : t(lang, "textWithoutPhoto"),
    },
  };
}

export async function handleSharedTextMessage(
  input: SharedTextHandlerInput
): Promise<SharedTextHandlerResult> {
  const preparedMessage = prepareSharedTextMessage(input.message);
  if (!preparedMessage) {
    return { response: null };
  }

  const { trimmedText, normalizedText } = preparedMessage;
  logSharedTextExecution(input);

  const ackResult = tryHandleAck(input, trimmedText);
  if (ackResult) {
    return ackResult;
  }

  const greetingResult = await tryHandleGreetingOrSmalltalk(
    input,
    normalizedText
  );
  if (greetingResult) {
    return greetingResult;
  }

  const newStyleResult = await tryHandleNewStyleShortcut(input, normalizedText);
  if (newStyleResult) {
    return newStyleResult;
  }

  const state = await input.getState();
  const hasPhoto = Boolean(state.lastPhotoUrl);
  if (
    input.runTextFeatures &&
    (await input.runTextFeatures({
      state,
      messageText: trimmedText,
      normalizedText,
      hasPhoto,
    }))
  ) {
    return { response: null };
  }

  input.logState?.(state, "text_message");
  if (!hasPhoto) {
    await input.setFlowState("AWAITING_PHOTO");
  }

  return buildDefaultTextResponse(input.lang, hasPhoto);
}
