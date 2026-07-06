import { describeWebhookAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { type ChannelPlugin, type ResolvedMessengerAccount } from "./channel-api.js";
import { messengerConfigAdapter } from "./config-adapter.js";
import { MessengerChannelConfigSchema } from "./config-schema.js";
import { FACEBOOK_CHANNEL_ID, hasFacebookConfiguredEnv } from "./naming.js";
import { hasMessengerCredentials, hasText } from "./utils.js";

export const messengerChannelPluginCommon: Pick<
  ChannelPlugin<ResolvedMessengerAccount>,
  "meta" | "capabilities" | "reload" | "configSchema" | "config"
> = {
  meta: {
    id: FACEBOOK_CHANNEL_ID,
    label: "Facebook",
    selectionLabel: "Facebook (Page Messenger)",
    detailLabel: "Facebook Page",
    docsPath: "/channels/facebook",
    docsLabel: "facebook",
    blurb: "Facebook Page Messenger DMs via Meta webhooks.",
    systemImage: "message.fill",
    quickstartAllowFrom: true,
  },
  capabilities: {
    chatTypes: ["direct"],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.facebook", "channels.messenger"] },
  configSchema: MessengerChannelConfigSchema,
  config: {
    ...messengerConfigAdapter,
    hasConfiguredState: ({ env }: { env?: Record<string, string | undefined> }) =>
      hasFacebookConfiguredEnv(env),
    isConfigured: (account: ResolvedMessengerAccount) => hasMessengerCredentials(account),
    unconfiguredReason: (account: ResolvedMessengerAccount) => {
      const missing = [];
      if (!hasText(account.pageId)) {
        missing.push("pageId");
      }
      if (!hasText(account.pageAccessToken)) {
        missing.push("pageAccessToken");
      }
      if (!hasText(account.appSecret)) {
        missing.push("appSecret");
      }
      if (!hasText(account.verifyToken)) {
        missing.push("verifyToken");
      }
      return missing.length ? `not configured: missing ${missing.join(", ")}` : "not configured";
    },
    describeAccount: (account: ResolvedMessengerAccount) =>
      describeWebhookAccountSnapshot({
        account,
        configured: hasMessengerCredentials(account),
        extra: {
          pageId: account.pageId || undefined,
          tokenSource: account.tokenSource === "none" ? undefined : account.tokenSource,
        },
      }),
  },
};
