import type { ChannelSetupAdapter, OpenClawConfig } from "openclaw/plugin-sdk/setup";
import { createSetupInputPresenceValidator } from "openclaw/plugin-sdk/setup";
import {
  DEFAULT_ACCOUNT_ID,
  listMessengerAccountIds,
  normalizeAccountId,
  resolveMessengerAccount,
  type MessengerConfig,
} from "./channel-api.js";
import { hasMessengerCredentials } from "./channel-shared.js";
import { FACEBOOK_CHANNEL_ID, resolveFacebookConfig, stripFacebookTargetPrefix } from "./naming.js";

export function patchMessengerAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  patch: Record<string, unknown>;
  clearFields?: string[];
  enabled?: boolean;
}): OpenClawConfig {
  const accountId = normalizeAccountId(params.accountId);
  const { config: messengerConfig = {} as MessengerConfig } = resolveFacebookConfig(params.cfg);
  const clearFields = params.clearFields ?? [];
  if (accountId === DEFAULT_ACCOUNT_ID) {
    const nextMessenger = { ...messengerConfig } as Record<string, unknown>;
    for (const field of clearFields) {
      delete nextMessenger[field];
    }
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        [FACEBOOK_CHANNEL_ID]: {
          ...nextMessenger,
          ...(params.enabled ? { enabled: true } : {}),
          ...params.patch,
        },
      },
    };
  }
  const nextAccount = { ...messengerConfig.accounts?.[accountId] } as Record<string, unknown>;
  for (const field of clearFields) {
    delete nextAccount[field];
  }
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      [FACEBOOK_CHANNEL_ID]: {
        ...messengerConfig,
        ...(params.enabled ? { enabled: true } : {}),
        accounts: {
          ...messengerConfig.accounts,
          [accountId]: {
            ...nextAccount,
            ...(params.enabled ? { enabled: true } : {}),
            ...params.patch,
          },
        },
      },
    },
  };
}

export function isMessengerConfigured(cfg: OpenClawConfig, accountId: string): boolean {
  return hasMessengerCredentials(resolveMessengerAccount({ cfg, accountId }));
}

export function parseMessengerAllowFromId(value: string): string | null {
  const normalized = stripFacebookTargetPrefix(value);
  return normalized || null;
}

export const messengerSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  applyAccountName: ({ cfg, accountId, name }) =>
    patchMessengerAccountConfig({
      cfg,
      accountId,
      patch: name?.trim() ? { name: name.trim() } : {},
    }),
  validateInput: createSetupInputPresenceValidator({
    defaultAccountOnlyEnvError:
      "FACEBOOK_* env vars can only be used for the default Facebook account.",
    whenNotUseEnv: [
      {
        someOf: ["pageId"],
        message: "Facebook requires pageId (or --use-env).",
      },
      {
        someOf: ["pageAccessToken", "tokenFile"],
        message: "Facebook requires pageAccessToken or --token-file (or --use-env).",
      },
      {
        someOf: ["appSecret", "appSecretFile"],
        message: "Facebook requires appSecret or --app-secret-file (or --use-env).",
      },
      {
        someOf: ["verifyToken", "verifyTokenFile"],
        message: "Facebook requires verifyToken or --verify-token-file (or --use-env).",
      },
    ],
  }),
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const typedInput = input as {
      useEnv?: boolean;
      pageId?: string;
      pageAccessToken?: string;
      tokenFile?: string;
      appSecret?: string;
      appSecretFile?: string;
      verifyToken?: string;
      verifyTokenFile?: string;
    };
    return patchMessengerAccountConfig({
      cfg,
      accountId,
      enabled: true,
      clearFields: typedInput.useEnv
        ? [
            "pageId",
            "pageAccessToken",
            "tokenFile",
            "appSecret",
            "appSecretFile",
            "verifyToken",
            "verifyTokenFile",
          ]
        : undefined,
      patch: typedInput.useEnv
        ? {}
        : {
            ...(typedInput.pageId ? { pageId: typedInput.pageId } : {}),
            ...(typedInput.tokenFile
              ? { tokenFile: typedInput.tokenFile }
              : typedInput.pageAccessToken
                ? { pageAccessToken: typedInput.pageAccessToken }
                : {}),
            ...(typedInput.appSecretFile
              ? { appSecretFile: typedInput.appSecretFile }
              : typedInput.appSecret
                ? { appSecret: typedInput.appSecret }
                : {}),
            ...(typedInput.verifyTokenFile
              ? { verifyTokenFile: typedInput.verifyTokenFile }
              : typedInput.verifyToken
                ? { verifyToken: typedInput.verifyToken }
                : {}),
          },
    });
  },
};

export { listMessengerAccountIds };
