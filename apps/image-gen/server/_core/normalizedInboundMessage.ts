export type BotChannel = "messenger" | "whatsapp";

export type BotChannelCapabilities = {
  quickReplies: boolean;
  richTemplates: boolean;
};

export type NormalizedInboundMessage = {
  channel: BotChannel;
  senderId: string;
  userId: string;
  channelCapabilities?: BotChannelCapabilities;
  messageType: "text" | "image" | "audio" | "unknown";
  rawMessageType?: string;
  messageId?: string;
  textBody?: string;
  audioId?: string;
  imageUrl?: string;
  imageId?: string;
  timestamp?: number;
  rawEventMeta?: Record<string, unknown>;
};
