import { afterEach, describe, expect, it } from "vitest";
import { resolveMessengerAccount } from "./accounts.js";

describe("resolveMessengerAccount", () => {
  const originalEnv = { ...process.env };
  const credentialEnvKeys = [
    "FACEBOOK_PAGE_ID",
    "FACEBOOK_PAGE_ACCESS_TOKEN",
    "FACEBOOK_APP_SECRET",
    "FACEBOOK_VERIFY_TOKEN",
    "MESSENGER_PAGE_ID",
    "MESSENGER_PAGE_ACCESS_TOKEN",
    "MESSENGER_APP_SECRET",
    "MESSENGER_VERIFY_TOKEN",
  ];

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function clearCredentialEnv() {
    for (const key of credentialEnvKeys) {
      delete process.env[key];
    }
  }

  it("uses default account Facebook env credentials", () => {
    clearCredentialEnv();
    process.env.FACEBOOK_PAGE_ID = "page-1";
    process.env.FACEBOOK_PAGE_ACCESS_TOKEN = "token-1";
    process.env.FACEBOOK_APP_SECRET = "secret-1";
    process.env.FACEBOOK_VERIFY_TOKEN = "verify-1";

    const account = resolveMessengerAccount({ cfg: { channels: {} } as never });

    expect(account.accountId).toBe("default");
    expect(account.pageId).toBe("page-1");
    expect(account.pageAccessToken).toBe("token-1");
    expect(account.appSecret).toBe("secret-1");
    expect(account.verifyToken).toBe("verify-1");
    expect(account.tokenSource).toBe("env");
  });

  it("keeps legacy Messenger env credentials as a fallback", () => {
    clearCredentialEnv();
    process.env.MESSENGER_PAGE_ID = "legacy-page";
    process.env.MESSENGER_PAGE_ACCESS_TOKEN = "legacy-token";
    process.env.MESSENGER_APP_SECRET = "legacy-secret";
    process.env.MESSENGER_VERIFY_TOKEN = "legacy-verify";

    const account = resolveMessengerAccount({ cfg: { channels: {} } as never });

    expect(account.pageId).toBe("legacy-page");
    expect(account.pageAccessToken).toBe("legacy-token");
    expect(account.appSecret).toBe("legacy-secret");
    expect(account.verifyToken).toBe("legacy-verify");
    expect(account.tokenSource).toBe("env");
  });

  it("prefers canonical Facebook env credentials over legacy Messenger env credentials", () => {
    clearCredentialEnv();
    process.env.FACEBOOK_PAGE_ID = "page-1";
    process.env.FACEBOOK_PAGE_ACCESS_TOKEN = "token-1";
    process.env.FACEBOOK_APP_SECRET = "secret-1";
    process.env.FACEBOOK_VERIFY_TOKEN = "verify-1";
    process.env.MESSENGER_PAGE_ID = "legacy-page";
    process.env.MESSENGER_PAGE_ACCESS_TOKEN = "legacy-token";
    process.env.MESSENGER_APP_SECRET = "legacy-secret";
    process.env.MESSENGER_VERIFY_TOKEN = "legacy-verify";

    const account = resolveMessengerAccount({ cfg: { channels: {} } as never });

    expect(account.pageId).toBe("page-1");
    expect(account.pageAccessToken).toBe("token-1");
    expect(account.appSecret).toBe("secret-1");
    expect(account.verifyToken).toBe("verify-1");
    expect(account.tokenSource).toBe("env");
  });

  it("prefers named account config over defaults", () => {
    const account = resolveMessengerAccount({
      cfg: {
        channels: {
          facebook: {
            pageId: "base-page",
            pageAccessToken: "base-token",
            appSecret: "base-secret",
            verifyToken: "base-verify",
            accounts: {
              leaderbot: {
                pageId: "leader-page",
                pageAccessToken: "leader-token",
                appSecret: "leader-secret",
                verifyToken: "leader-verify",
              },
            },
          },
        },
      } as never,
      accountId: "leaderbot",
    });

    expect(account.pageId).toBe("leader-page");
    expect(account.pageAccessToken).toBe("leader-token");
    expect(account.appSecret).toBe("leader-secret");
    expect(account.verifyToken).toBe("leader-verify");
    expect(account.enabled).toBe(false);
  });

  it("keeps legacy channels.messenger config as a fallback", () => {
    const account = resolveMessengerAccount({
      cfg: {
        channels: {
          messenger: {
            pageId: "legacy-page",
            pageAccessToken: "legacy-token",
            appSecret: "legacy-secret",
            verifyToken: "legacy-verify",
          },
        },
      } as never,
    });

    expect(account.pageId).toBe("legacy-page");
    expect(account.pageAccessToken).toBe("legacy-token");
    expect(account.appSecret).toBe("legacy-secret");
    expect(account.verifyToken).toBe("legacy-verify");
  });

  it("prefers channels.facebook over legacy channels.messenger config", () => {
    const account = resolveMessengerAccount({
      cfg: {
        channels: {
          facebook: {
            pageId: "page-1",
            pageAccessToken: "token-1",
            appSecret: "secret-1",
            verifyToken: "verify-1",
          },
          messenger: {
            pageId: "legacy-page",
            pageAccessToken: "legacy-token",
            appSecret: "legacy-secret",
            verifyToken: "legacy-verify",
          },
        },
      } as never,
    });

    expect(account.pageId).toBe("page-1");
    expect(account.pageAccessToken).toBe("token-1");
    expect(account.appSecret).toBe("secret-1");
    expect(account.verifyToken).toBe("verify-1");
  });
});
