import type { MessengerSendOutcome } from "./messengerApi";
import type {
  BotImageContext,
  BotPayloadContext,
  BotTextContext,
} from "./botContext";
import type { ConversationAction } from "./botResponse";
import type { GenerationKind } from "./image-generation/generationTypes";
import type { Lang } from "./i18n";
import { getOrCreateState } from "./messengerState";
import type { FacebookWebhookEvent } from "./webhookHelpers";
import type { MaybeInFlightMessageResult } from "./webhookFallback";

export type HandlerDeps = {
  defaultLang: Lang;
};

export type InternalMessengerImageRequestInput = {
  psid: string;
  prompt: string;
  reqId: string;
  lang?: Lang;
  timestamp?: number;
  sourceImageUrl?: string;
};

export type MessengerState = Awaited<ReturnType<typeof getOrCreateState>>;

export type HandlerContext = {
  defaultLang: Lang;
  claimEventReplayOrLog: (
    event: FacebookWebhookEvent,
    entryId: string | undefined,
    userId: string
  ) => Promise<boolean>;
  createFeatureImageContext: (
    psid: string,
    userId: string,
    reqId: string,
    lang: Lang,
    state: MessengerState,
    imageUrl: string
  ) => BotImageContext;
  createFeaturePayloadContext: (
    psid: string,
    userId: string,
    reqId: string,
    lang: Lang,
    state: MessengerState,
    payload: string
  ) => BotPayloadContext;
  createFeatureTextContext: (
    psid: string,
    userId: string,
    reqId: string,
    lang: Lang,
    state: MessengerState,
    messageText: string,
    normalizedText: string,
    hasPhoto: boolean
  ) => BotTextContext;
  debugWebhookLog: (message: Record<string, unknown>) => void;
  getAttachmentHostname: (url: string) => string | null;
  logImageFlowDecision: (input: {
    psid: string;
    userId: string;
    reqId: string;
    stage: string;
    hadPreviousPhoto: boolean;
    incomingImageUrl: string;
    action: "request_edit_prompt";
  }) => void;
  logIncomingMessage: (
    psid: string,
    userId: string,
    event: FacebookWebhookEvent,
    reqId: string
  ) => void;
  logUserState: (
    psid: string,
    userId: string,
    state: MessengerState,
    reqId: string,
    context: string
  ) => void;
  maybeSendInFlightMessage: (
    psid: string,
    reqId: string,
    lang: Lang
  ) => Promise<MaybeInFlightMessageResult>;
  runImageGeneration: (
    psid: string,
    userId: string,
    reqId: string,
    lang: Lang,
    sourceImageUrl?: string,
    promptHint?: string,
    generationKind?: GenerationKind
  ) => Promise<MessengerSendOutcome>;
  sendFaceMemoryConsentPrompt: (
    psid: string,
    lang: Lang,
    reqId: string
  ) => Promise<MessengerSendOutcome>;
  sendFlowExplanation: (
    psid: string,
    lang: Lang,
    reqId: string
  ) => Promise<MessengerSendOutcome>;
  sendLoggedImage: (
    psid: string,
    imageUrl: string,
    reqId: string
  ) => Promise<MessengerSendOutcome>;
  sendLoggedActions: (
    psid: string,
    text: string,
    actions: ConversationAction[],
    reqId: string
  ) => Promise<MessengerSendOutcome>;
  sendLoggedText: (
    psid: string,
    text: string,
    reqId: string
  ) => Promise<MessengerSendOutcome>;
  sendPhotoReceivedPrompt: (
    psid: string,
    lang: Lang,
    reqId: string
  ) => Promise<MessengerSendOutcome>;
};
