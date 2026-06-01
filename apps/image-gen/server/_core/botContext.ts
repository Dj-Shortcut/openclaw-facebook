import type { Lang } from "./i18n";
import type {
  BotChannel,
  BotChannelCapabilities,
} from "./normalizedInboundMessage";
import type {
  ConversationState,
  MessengerUserState,
} from "./messengerState";
import type { ConversationAction } from "./botResponse";
import type { GenerationStatsSnapshot } from "./botRuntimeStats";
import type { GenerationKind } from "./image-generation/generationTypes";

export type FeatureResult = { handled: true } | { handled: false };

export type BotLogger = {
  info(event: string, details?: Record<string, unknown>): void;
  warn(event: string, details?: Record<string, unknown>): void;
  error(event: string, details?: Record<string, unknown>): void;
};

type BotContextBase = {
  channel: BotChannel;
  capabilities: BotChannelCapabilities;
  senderId: string;
  userId: string;
  reqId: string;
  lang: Lang;
  state: MessengerUserState;
  sendText(text: string): Promise<void>;
  sendImage(url: string): Promise<void>;
  sendActions(text: string, actions: ConversationAction[]): Promise<void>;
  setFlowState(state: ConversationState): Promise<void>;
  clearImageContext?(): Promise<void>;
  runImageGeneration(
    sourceImageUrl?: string,
    promptHint?: string,
    generationKind?: GenerationKind
  ): Promise<void>;
  getRuntimeStats(): GenerationStatsSnapshot;
  logger: BotLogger;
};

export type BotTextContext = BotContextBase & {
  messageText: string;
  normalizedText: string;
  hasPhoto: boolean;
};

export type BotPayloadContext = BotContextBase & {
  payload: string;
};

export type BotImageContext = BotContextBase & {
  imageUrl: string;
};

export type BotErrorContext = BotContextBase & {
  error: unknown;
};
