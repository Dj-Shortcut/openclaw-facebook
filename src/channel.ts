import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import { createRestrictSendersChannelSecurity } from "openclaw/plugin-sdk/channel-policy";
import { createEmptyChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveMessengerAccount } from "./accounts.js";
import { type ChannelPlugin, type ResolvedMessengerAccount } from "./channel-api.js";
import { messengerChannelPluginCommon } from "./channel-shared.js";
import { messengerGatewayAdapter } from "./gateway.js";
import { FACEBOOK_CHANNEL_ID, stripFacebookTargetPrefix } from "./naming.js";
import { messengerMessageAdapter, messengerOutboundAdapter } from "./outbound.js";
import { getMessengerRuntime } from "./runtime.js";
import { messengerSetupAdapter } from "./setup-core.js";
import { messengerSetupWizard } from "./setup-surface.js";
import { messengerStatusAdapter } from "./status.js";

const loadMessengerSendRuntime = createLazyRuntimeModule(() => import("./send.js"));

const messengerSecurityAdapter = createRestrictSendersChannelSecurity<ResolvedMessengerAccount>({
  channelKey: FACEBOOK_CHANNEL_ID,
  resolveDmPolicy: (account) => account.config.dmPolicy,
  resolveDmAllowFrom: (account) => account.config.allowFrom,
  resolveGroupPolicy: () => "disabled",
  surface: "Facebook Page Messenger DMs",
  openScope: "any Facebook user who messages the Page",
  groupPolicyPath: "channels.facebook.groupPolicy",
  groupAllowFromPath: "channels.facebook.groupAllowFrom",
  policyPathSuffix: "dmPolicy",
  approveHint: "openclaw pairing approve facebook <code>",
  normalizeDmEntry: stripFacebookTargetPrefix,
});

export const messengerPlugin: ChannelPlugin<ResolvedMessengerAccount> = createChatChannelPlugin({
  base: {
    id: FACEBOOK_CHANNEL_ID,
    ...messengerChannelPluginCommon,
    messaging: {
      targetPrefixes: ["facebook", "fb", "messenger", "fbm"],
      normalizeTarget: (target) => stripFacebookTargetPrefix(target) || undefined,
      targetResolver: {
        looksLikeId: (id) => {
          const trimmed = id?.trim();
          return Boolean(
            trimmed &&
            (/^\d{6,}$/.test(trimmed) || /^(?:facebook|fb|messenger|fbm):/i.test(trimmed)),
          );
        },
        hint: "<page-scoped-id>",
      },
    },
    directory: createEmptyChannelDirectoryAdapter(),
    setup: messengerSetupAdapter,
    setupWizard: messengerSetupWizard,
    status: messengerStatusAdapter,
    gateway: messengerGatewayAdapter,
    message: messengerMessageAdapter,
  },
  pairing: {
    text: {
      idLabel: "messengerPsid",
      message: "OpenClaw: your access has been approved.",
      normalizeAllowEntry: createPairingPrefixStripper(
        /^(?:facebook|fb|messenger|fbm):(?:user:)?/i,
      ),
      notify: async ({ cfg, id, message, accountId }) => {
        const account =
          getMessengerRuntime().channel.facebook?.resolveMessengerAccount?.({
            cfg,
            accountId: accountId ?? undefined,
          }) ?? resolveMessengerAccount({ cfg, accountId: accountId ?? undefined });
        if (!account.pageAccessToken) {
          throw new Error("Messenger Page access token not configured");
        }
        const sendText =
          getMessengerRuntime().channel.facebook?.sendMessengerText ??
          (await loadMessengerSendRuntime()).sendMessengerText;
        await sendText(id, message, { cfg, accountId: account.accountId });
      },
    },
  },
  security: messengerSecurityAdapter,
  outbound: messengerOutboundAdapter,
});
