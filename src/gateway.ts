import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveMessengerAccount } from "./accounts.js";
import {
  clearAccountEntryFields,
  DEFAULT_ACCOUNT_ID,
  type ChannelPlugin,
  type MessengerConfig,
  type OpenClawConfig,
  type ResolvedMessengerAccount,
} from "./channel-api.js";
import { readFacebookEnv, resolveFacebookConfig } from "./naming.js";
import { getMessengerRuntime } from "./runtime.js";

const loadMessengerMonitorRuntime = createLazyRuntimeModule(() => import("./monitor.js"));

export const messengerGatewayAdapter: NonNullable<
  ChannelPlugin<ResolvedMessengerAccount>["gateway"]
> = {
  startAccount: async (ctx) => {
    const account = ctx.account;
    for (const [label, value] of [
      ["pageId", account.pageId],
      ["Page access token", account.pageAccessToken],
      ["appSecret", account.appSecret],
      ["verifyToken", account.verifyToken],
    ] as const) {
      if (!value.trim()) {
        throw new Error(
          `Messenger webhook mode requires ${label} for account "${account.accountId}".`,
        );
      }
    }
    ctx.log?.info(`[${account.accountId}] starting Messenger provider (${account.pageId})`);
    const monitorMessengerProvider =
      getMessengerRuntime().channel.facebook?.monitorMessengerProvider ??
      (await loadMessengerMonitorRuntime()).monitorMessengerProvider;
    return await monitorMessengerProvider({
      account,
      config: ctx.cfg,
      runtime: ctx.runtime,
      abortSignal: ctx.abortSignal,
      webhookPath: account.config.webhookPath,
    });
  },
  logoutAccount: async ({ accountId, cfg }) => {
    const envToken = readFacebookEnv("pageAccessToken");
    const nextCfg = { ...cfg } as OpenClawConfig;
    const { config: messengerConfig = {}, key: channelConfigKey } = resolveFacebookConfig(cfg);
    const nextMessenger = { ...messengerConfig };
    let cleared = false;
    let changed = false;
    const fields = [
      "pageId",
      "pageAccessToken",
      "tokenFile",
      "appSecret",
      "appSecretFile",
      "verifyToken",
      "verifyTokenFile",
    ];
    if (accountId === DEFAULT_ACCOUNT_ID) {
      for (const field of fields) {
        if (field in nextMessenger) {
          delete (nextMessenger as Record<string, unknown>)[field];
          cleared = true;
          changed = true;
        }
      }
    }
    const accountCleanup = clearAccountEntryFields({
      accounts: nextMessenger.accounts,
      accountId,
      fields,
      markClearedOnFieldPresence: true,
    });
    if (accountCleanup.changed) {
      changed = true;
      cleared ||= accountCleanup.cleared;
      if (accountCleanup.nextAccounts) {
        nextMessenger.accounts = accountCleanup.nextAccounts;
      } else {
        delete nextMessenger.accounts;
      }
    }
    if (changed) {
      nextCfg.channels = { ...nextCfg.channels, [channelConfigKey]: nextMessenger };
      await getMessengerRuntime().config.replaceConfigFile({
        nextConfig: nextCfg,
        afterWrite: { mode: "auto" },
      });
    }
    const resolved = resolveMessengerAccount({ cfg: changed ? nextCfg : cfg, accountId });
    return { cleared, envToken: Boolean(envToken), loggedOut: resolved.tokenSource === "none" };
  },
};
