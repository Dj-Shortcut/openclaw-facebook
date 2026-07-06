import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  buildTokenChannelStatusSummary,
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
  createDependentCredentialStatusIssueCollector,
} from "openclaw/plugin-sdk/status-helpers";
import { DEFAULT_ACCOUNT_ID } from "./accounts.js";
import { type ChannelPlugin, type ResolvedMessengerAccount } from "./channel-api.js";
import { hasMessengerCredentials } from "./utils.js";
import { FACEBOOK_CHANNEL_ID } from "./naming.js";
import { getMessengerRuntime } from "./runtime.js";
import type { MessengerProbeResult } from "./types.js";

const loadMessengerProbeRuntime = createLazyRuntimeModule(() => import("./probe.js"));

export const messengerStatusAdapter: NonNullable<
  ChannelPlugin<ResolvedMessengerAccount>["status"]
> = createComputedAccountStatusAdapter<ResolvedMessengerAccount>({
  defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
  collectStatusIssues: createDependentCredentialStatusIssueCollector({
    channel: FACEBOOK_CHANNEL_ID,
    dependencySourceKey: "tokenSource",
    missingPrimaryMessage: "Messenger Page access token not configured",
    missingDependentMessage: "Messenger app secret or verify token not configured",
  }),
  buildChannelSummary: ({ snapshot }) => buildTokenChannelStatusSummary(snapshot),
  probeAccount: async ({ account, timeoutMs }) => {
    const probe =
      getMessengerRuntime().channel.facebook?.probeMessengerPage ??
      (await loadMessengerProbeRuntime()).probeMessengerPage;
    return await probe({
      pageId: account.pageId,
      pageAccessToken: account.pageAccessToken,
      graphApiVersion: account.config.graphApiVersion,
      timeoutMs,
    });
  },
  resolveAccountSnapshot: ({ account, runtime }) => ({
    accountId: account.accountId,
    name: account.name,
    enabled: account.enabled,
    configured: hasMessengerCredentials(account),
    extra: {
      tokenSource: account.tokenSource === "none" ? undefined : account.tokenSource,
      pageId: account.pageId || undefined,
      lastError: runtime?.lastError,
      mode: "webhook",
    },
  }),
});
