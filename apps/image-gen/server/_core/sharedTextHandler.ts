import { t, type Lang } from "./i18n";
import type { ConversationState, MessengerUserState } from "./messengerState";
import { safeLog } from "./messengerApi";
import { detectAck, getGreetingResponse } from "./webhookHelpers";
import { toLogUser } from "./privacy";
import type { NormalizedInboundMessage } from "./normalizedInboundMessage";
import type { BotResponse } from "./botResponse";
import {
  buildAssistantPhotoHelpResponse,
  buildGenerationFailureResponse,
  buildGenerationSuccessResponse,
  buildQuickStartResponse,
} from "./conversationActions";

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
      response: buildQuickStartResponse(input.lang),
      afterSend: "markIntroSeen",
    };
  }

  const response = getGreetingResponse(state.stage, input.lang);
  if (state.stage === "IDLE") {
    return { response: buildQuickStartResponse(input.lang) };
  }

  if (state.stage === "RESULT_READY") {
    return {
      response: hasEditableImage(state)
        ? buildGenerationSuccessResponse(input.lang)
        : buildQuickStartResponse(input.lang),
    };
  }

  if (state.stage === "FAILURE") {
    return {
      response: buildGenerationFailureResponse(input.lang, response.text),
    };
  }

  return {
    response: { kind: "text", text: response.text },
    replyState: state.stage,
  };
}

function buildDefaultTextResponse(
  lang: Lang,
  hasPhoto: boolean
): SharedTextHandlerResult {
  if (hasPhoto) {
    return { response: buildAssistantPhotoHelpResponse(lang) };
  }

  return { response: buildQuickStartResponse(lang) };
}

function hasEditableImage(state: MessengerUserState): boolean {
  return Boolean(
    state.lastPhotoUrl ??
      state.lastPhoto ??
      state.lastGeneratedUrl ??
      state.lastImageUrl
  );
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

  const state = await input.getState();
  const hasPhoto = hasEditableImage(state);
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
  return buildDefaultTextResponse(input.lang, hasPhoto);
}
