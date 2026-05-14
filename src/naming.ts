import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import type { MessengerConfig } from "./types.js";

export const FACEBOOK_CHANNEL_ID = "facebook";
export const LEGACY_MESSENGER_CHANNEL_ID = "messenger";
export const DEFAULT_FACEBOOK_WEBHOOK_PATH = "/facebook/webhook";
export const LEGACY_MESSENGER_WEBHOOK_PATH = "/messenger/webhook";

export const FACEBOOK_ENV_KEYS = {
  pageId: "FACEBOOK_PAGE_ID",
  pageAccessToken: "FACEBOOK_PAGE_ACCESS_TOKEN",
  appSecret: "FACEBOOK_APP_SECRET",
  verifyToken: "FACEBOOK_VERIFY_TOKEN",
} as const;

export const LEGACY_MESSENGER_ENV_KEYS = {
  pageId: "MESSENGER_PAGE_ID",
  pageAccessToken: "MESSENGER_PAGE_ACCESS_TOKEN",
  appSecret: "MESSENGER_APP_SECRET",
  verifyToken: "MESSENGER_VERIFY_TOKEN",
} as const;

export function readFacebookEnv(
  key: keyof typeof FACEBOOK_ENV_KEYS,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env[FACEBOOK_ENV_KEYS[key]]?.trim() ?? env[LEGACY_MESSENGER_ENV_KEYS[key]]?.trim() ?? "";
}

export function hasFacebookConfiguredEnv(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(
    (env.FACEBOOK_PAGE_ID?.trim() || env.MESSENGER_PAGE_ID?.trim()) &&
    (env.FACEBOOK_PAGE_ACCESS_TOKEN?.trim() || env.MESSENGER_PAGE_ACCESS_TOKEN?.trim()) &&
    (env.FACEBOOK_APP_SECRET?.trim() || env.MESSENGER_APP_SECRET?.trim()) &&
    (env.FACEBOOK_VERIFY_TOKEN?.trim() || env.MESSENGER_VERIFY_TOKEN?.trim()),
  );
}

export function resolveFacebookConfig(cfg: OpenClawConfig): {
  config?: MessengerConfig;
  key: typeof FACEBOOK_CHANNEL_ID | typeof LEGACY_MESSENGER_CHANNEL_ID;
} {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  if (channels?.[FACEBOOK_CHANNEL_ID]) {
    return { config: channels[FACEBOOK_CHANNEL_ID] as MessengerConfig, key: FACEBOOK_CHANNEL_ID };
  }
  return {
    config: channels?.[LEGACY_MESSENGER_CHANNEL_ID] as MessengerConfig | undefined,
    key: LEGACY_MESSENGER_CHANNEL_ID,
  };
}

export function stripFacebookTargetPrefix(value: string): string {
  return value
    .trim()
    .replace(/^facebook:(?:user:)?/i, "")
    .replace(/^fb:/i, "")
    .replace(/^messenger:(?:user:)?/i, "")
    .replace(/^fbm:/i, "");
}
