import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";

export const MESSENGER_OPENCLAW_ACTION_PREFIX = "OPENCLAW_ACTION:";
export const MESSENGER_QUICK_REPLY_MIN_COUNT = 1;
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
