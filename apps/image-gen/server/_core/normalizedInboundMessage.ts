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
  messageType: "text" | "image" | "unknown";
  rawMessageType?: string;
  textBody?: string;
  imageUrl?: string;
  imageId?: string;
  timestamp?: number;
  rawEventMeta?: Record<string, unknown>;
  entryIntent?: import("./entryIntent").EntryIntent | null;
};
