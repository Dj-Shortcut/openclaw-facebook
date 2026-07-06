import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { resolveMessengerAccount } from "./accounts.js";
import { hasMessengerCredentials } from "./utils.js";

export function inspectMessengerAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}) {
  const account = resolveMessengerAccount(params);
  return {
    accountId: account.accountId,
    name: account.name,
    enabled: account.enabled,
    configured: hasMessengerCredentials(account),
    tokenStatus: account.tokenSource === "none" ? ("missing" as const) : ("available" as const),
    tokenSource: account.tokenSource,
  };
}
