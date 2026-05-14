export { clearAccountEntryFields } from "openclaw/plugin-sdk/core";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import {
  listMessengerAccountIds,
  normalizeAccountId,
  resolveDefaultMessengerAccountId,
  resolveMessengerAccount,
} from "./accounts.js";
import type { MessengerConfig, ResolvedMessengerAccount } from "./types.js";

export {
  DEFAULT_ACCOUNT_ID,
  listMessengerAccountIds,
  normalizeAccountId,
  resolveDefaultMessengerAccountId,
  resolveMessengerAccount,
};

export type { ChannelPlugin, MessengerConfig, OpenClawConfig, ResolvedMessengerAccount };
