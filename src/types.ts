import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import type { MessageReceipt } from "openclaw/plugin-sdk/channel-message";

export type MessengerTokenSource = "config" | "env" | "file" | "none";
export type MessengerUnknownSenderMode = "pairing" | "leaderbot_free_tier";

interface MessengerAccountBaseConfig {
  enabled?: boolean;
  pageId?: string;
  pageAccessToken?: string;
  tokenFile?: string;
  appSecret?: string;
  appSecretFile?: string;
  verifyToken?: string;
  verifyTokenFile?: string;
  name?: string;
  allowFrom?: Array<string | number>;
  dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
  unknownSenderMode?: MessengerUnknownSenderMode;
  leaderbotBridgeEnabled?: boolean;
  responsePrefix?: string;
  webhookPath?: string;
  defaultTo?: string;
  graphApiVersion?: string;
}

export interface MessengerConfig extends MessengerAccountBaseConfig {
  accounts?: Record<string, MessengerAccountConfig>;
  defaultAccount?: string;
}

export interface MessengerAccountConfig extends MessengerAccountBaseConfig {}

export interface ResolvedMessengerAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  pageId: string;
  pageAccessToken: string;
  appSecret: string;
  verifyToken: string;
  tokenSource: MessengerTokenSource;
  config: MessengerConfig & MessengerAccountConfig;
}

export interface MessengerSendResult {
  messageId: string;
  recipientId: string;
  receipt: MessageReceipt;
}

export type MessengerProbeResult = BaseProbeResult<string> & {
  page?: {
    id?: string;
    name?: string;
  };
};

export type MessengerWebhookMessaging = {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    reply_to?: {
      mid?: string;
    };
    quick_reply?: {
      payload?: string;
    };
    attachments?: Array<{
      type?: string;
      payload?: {
        url?: string;
      };
    }>;
  };
  postback?: {
    payload?: string;
    title?: string;
    referral?: {
      ref?: string;
    };
  };
  referral?: {
    ref?: string;
  };
};

export type MessengerWebhookBody = {
  object?: string;
  entry?: Array<{
    id?: string;
    time?: number;
    messaging?: MessengerWebhookMessaging[];
  }>;
};
