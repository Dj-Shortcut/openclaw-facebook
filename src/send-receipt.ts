import type { MessageReceipt } from "openclaw/plugin-sdk/channel-message";

export function createMessengerSendReceipt(params: {
  messageId: string;
  recipientId: string;
}): MessageReceipt {
  return {
    primaryPlatformMessageId: params.messageId,
    platformMessageIds: [params.messageId],
    parts: [
      {
        kind: "text",
        platformMessageId: params.messageId,
        index: 0,
      },
    ],
    sentAt: Date.now(),
  };
}
