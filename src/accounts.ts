import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId as normalizeSharedAccountId,
  normalizeOptionalAccountId,
} from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { resolveAccountEntry } from "openclaw/plugin-sdk/account-resolution";
import { tryReadSecretFileSync } from "openclaw/plugin-sdk/core";
import { readFacebookEnv, resolveFacebookConfig } from "./naming.js";
import type {
  MessengerAccountConfig,
  MessengerConfig,
  MessengerTokenSource,
  ResolvedMessengerAccount,
} from "./types.js";

export { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";

function readFileIfExists(filePath: string | undefined, label: string): string | undefined {
  return tryReadSecretFileSync(filePath, label, { rejectSymlink: true });
}

function resolvePageAccessToken(params: {
  accountId: string;
  baseConfig?: MessengerConfig;
  accountConfig?: MessengerAccountConfig;
}): { token: string; tokenSource: MessengerTokenSource } {
  const { accountId, baseConfig, accountConfig } = params;
  if (accountConfig?.pageAccessToken?.trim()) {
    return { token: accountConfig.pageAccessToken.trim(), tokenSource: "config" };
  }
  const accountFileToken = readFileIfExists(
    accountConfig?.tokenFile,
    "Messenger Page access token file",
  );
  if (accountFileToken) {
    return { token: accountFileToken, tokenSource: "file" };
  }
  if (accountId === DEFAULT_ACCOUNT_ID) {
    if (baseConfig?.pageAccessToken?.trim()) {
      return { token: baseConfig.pageAccessToken.trim(), tokenSource: "config" };
    }
    const baseFileToken = readFileIfExists(
      baseConfig?.tokenFile,
      "Messenger Page access token file",
    );
    if (baseFileToken) {
      return { token: baseFileToken, tokenSource: "file" };
    }
    const envToken = readFacebookEnv("pageAccessToken");
    if (envToken) {
      return { token: envToken, tokenSource: "env" };
    }
  }
  return { token: "", tokenSource: "none" };
}

function resolveSecret(params: {
  accountId: string;
  baseConfig?: MessengerConfig;
  accountConfig?: MessengerAccountConfig;
  configKey: "appSecret" | "verifyToken";
  fileKey: "appSecretFile" | "verifyTokenFile";
  envKey: "appSecret" | "verifyToken";
  label: string;
}): string {
  const { accountId, baseConfig, accountConfig, configKey, fileKey, envKey, label } = params;
  if (accountConfig?.[configKey]?.trim()) {
    return accountConfig[configKey].trim();
  }
  const accountFileValue = readFileIfExists(accountConfig?.[fileKey], label);
  if (accountFileValue) {
    return accountFileValue;
  }
  if (accountId === DEFAULT_ACCOUNT_ID) {
    if (baseConfig?.[configKey]?.trim()) {
      return baseConfig[configKey].trim();
    }
    const baseFileValue = readFileIfExists(baseConfig?.[fileKey], label);
    if (baseFileValue) {
      return baseFileValue;
    }
    const envValue = readFacebookEnv(envKey);
    if (envValue) {
      return envValue;
    }
  }
  return "";
}

function resolvePageId(params: {
  accountId: string;
  baseConfig?: MessengerConfig;
  accountConfig?: MessengerAccountConfig;
}): string {
  if (params.accountConfig?.pageId?.trim()) {
    return params.accountConfig.pageId.trim();
  }
  if (params.accountId === DEFAULT_ACCOUNT_ID) {
    return params.baseConfig?.pageId?.trim() ?? readFacebookEnv("pageId");
  }
  return "";
}

export function resolveMessengerAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedMessengerAccount {
  const cfg = params.cfg;
  const accountId = normalizeSharedAccountId(
    params.accountId ?? resolveDefaultMessengerAccountId(cfg),
  );
  const messengerConfig = resolveFacebookConfig(cfg).config;
  const accountConfig =
    accountId !== DEFAULT_ACCOUNT_ID
      ? resolveAccountEntry(messengerConfig?.accounts, accountId)
      : undefined;

  const { token, tokenSource } = resolvePageAccessToken({
    accountId,
    baseConfig: messengerConfig,
    accountConfig,
  });
  const appSecret = resolveSecret({
    accountId,
    baseConfig: messengerConfig,
    accountConfig,
    configKey: "appSecret",
    fileKey: "appSecretFile",
    envKey: "appSecret",
    label: "Messenger app secret file",
  });
  const verifyToken = resolveSecret({
    accountId,
    baseConfig: messengerConfig,
    accountConfig,
    configKey: "verifyToken",
    fileKey: "verifyTokenFile",
    envKey: "verifyToken",
    label: "Messenger verify token file",
  });
  const pageId = resolvePageId({ accountId, baseConfig: messengerConfig, accountConfig });

  const baseConfig = { ...messengerConfig };
  delete baseConfig.accounts;
  delete baseConfig.defaultAccount;
  const mergedConfig: MessengerConfig & MessengerAccountConfig = {
    ...baseConfig,
    ...accountConfig,
  };

  return {
    accountId,
    name:
      accountConfig?.name ?? (accountId === DEFAULT_ACCOUNT_ID ? messengerConfig?.name : undefined),
    enabled:
      accountConfig?.enabled ??
      (accountId === DEFAULT_ACCOUNT_ID ? (messengerConfig?.enabled ?? true) : false),
    pageId,
    pageAccessToken: token,
    appSecret,
    verifyToken,
    tokenSource,
    config: mergedConfig,
  };
}

export function listMessengerAccountIds(cfg: OpenClawConfig): string[] {
  const messengerConfig = resolveFacebookConfig(cfg).config;
  const ids = new Set<string>();
  if (
    messengerConfig?.pageAccessToken?.trim() ||
    messengerConfig?.tokenFile ||
    readFacebookEnv("pageAccessToken")
  ) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }
  for (const id of Object.keys(messengerConfig?.accounts ?? {})) {
    ids.add(id);
  }
  return Array.from(ids);
}

export function resolveDefaultMessengerAccountId(cfg: OpenClawConfig): string {
  const preferred = normalizeOptionalAccountId(resolveFacebookConfig(cfg).config?.defaultAccount);
  if (
    preferred &&
    listMessengerAccountIds(cfg).some(
      (accountId) => normalizeSharedAccountId(accountId) === preferred,
    )
  ) {
    return preferred;
  }
  const ids = listMessengerAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function normalizeAccountId(accountId: string | undefined): string {
  return normalizeSharedAccountId(accountId);
}
