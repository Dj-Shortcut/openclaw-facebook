import { afterEach, describe, expect, it, vi } from "vitest";
import { assertAuthConfig, getFacebookConnectStorageMode } from "./_core/env";

function parseConsoleLogCalls(logSpy: ReturnType<typeof vi.spyOn>) {
  return logSpy.mock.calls.map(call => JSON.parse(String(call[0])));
}

describe.sequential("OAuth SDK configuration guard", () => {
  const originalOAuthUrl = process.env.OAUTH_SERVER_URL;
  const originalJwtSecret = process.env.JWT_SECRET;
  const originalFacebookConnectStorageMode =
    process.env.FACEBOOK_CONNECT_STORAGE_MODE;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalOAuthUrl === undefined) {
      delete process.env.OAUTH_SERVER_URL;
    } else {
      process.env.OAUTH_SERVER_URL = originalOAuthUrl;
    }
    if (originalJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalJwtSecret;
    }
    if (originalFacebookConnectStorageMode === undefined) {
      delete process.env.FACEBOOK_CONNECT_STORAGE_MODE;
    } else {
      process.env.FACEBOOK_CONNECT_STORAGE_MODE =
        originalFacebookConnectStorageMode;
    }
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    vi.restoreAllMocks();
  });

  it(
    "does not log an OAuth error when OAUTH_SERVER_URL is missing",
    { timeout: 180_000 },
    async () => {
      delete process.env.OAUTH_SERVER_URL;
      process.env.JWT_SECRET = "x".repeat(32);
      const logSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);
      const infoSpy = vi
        .spyOn(console, "info")
        .mockImplementation(() => undefined);
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      vi.resetModules();
      await import("./_core/sdk");

      expect(errorSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("OAUTH_SERVER_URL is not configured")
      );
      expect(infoSpy).not.toHaveBeenCalled();
      expect(parseConsoleLogCalls(logSpy)).toContainEqual({
        level: "info",
        event: "oauth_client_disabled",
        reason: "missing_oauth_server_url",
      });
    }
  );

  it(
    "logs OAuth initialization when OAUTH_SERVER_URL is provided",
    { timeout: 180_000 },
    async () => {
      process.env.OAUTH_SERVER_URL = "https://oauth.example.com";
      process.env.JWT_SECRET = "x".repeat(32);
      const logSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);
      const infoSpy = vi
        .spyOn(console, "info")
        .mockImplementation(() => undefined);

      vi.resetModules();
      await import("./_core/sdk");

      expect(infoSpy).not.toHaveBeenCalled();
      expect(parseConsoleLogCalls(logSpy)).toContainEqual({
        level: "info",
        event: "oauth_client_initialized",
        configured: true,
      });
      expect(parseConsoleLogCalls(logSpy)).not.toContainEqual(
        expect.objectContaining({ baseUrl: "https://oauth.example.com" })
      );
    }
  );

  it("fails auth config validation when JWT_SECRET is missing or too short", () => {
    delete process.env.JWT_SECRET;
    expect(() => assertAuthConfig()).toThrow("JWT_SECRET must be set");

    process.env.JWT_SECRET = "short-secret";
    expect(() => assertAuthConfig()).toThrow("JWT_SECRET must be set");
  });

  it("defaults Facebook connect storage to the legacy-compatible bridge", () => {
    delete process.env.FACEBOOK_CONNECT_STORAGE_MODE;
    expect(getFacebookConnectStorageMode()).toBe("legacy_compat");
  });

  it("fails production startup for an invalid Facebook connect storage mode", () => {
    process.env.NODE_ENV = "production";
    process.env.JWT_SECRET = "x".repeat(32);
    process.env.FACEBOOK_CONNECT_STORAGE_MODE = "sealed_immediately";

    expect(() => assertAuthConfig()).toThrow(
      "FACEBOOK_CONNECT_STORAGE_MODE must be one of legacy_compat, sealed_compat, sealed_only"
    );
  });
});
