import { afterEach, describe, expect, it, vi } from "vitest";
import { assertAuthConfig } from "./_core/env";

describe.sequential("OAuth SDK configuration guard", () => {
  const originalOAuthUrl = process.env.OAUTH_SERVER_URL;
  const originalJwtSecret = process.env.JWT_SECRET;

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
    vi.restoreAllMocks();
  });

  it("does not log an OAuth error when OAUTH_SERVER_URL is missing", { timeout: 180_000 }, async () => {
    delete process.env.OAUTH_SERVER_URL;
    process.env.JWT_SECRET = "x".repeat(32);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    vi.resetModules();
    await import("./_core/sdk");

    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("OAUTH_SERVER_URL is not configured")
    );
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual({
      level: "info",
      event: "oauth_client_disabled",
      reason: "missing_oauth_server_url",
    });
  });

  it("logs OAuth initialization when OAUTH_SERVER_URL is provided", { timeout: 180_000 }, async () => {
    process.env.OAUTH_SERVER_URL = "https://oauth.example.com";
    process.env.JWT_SECRET = "x".repeat(32);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    vi.resetModules();
    await import("./_core/sdk");

    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual({
      level: "info",
      event: "oauth_client_initialized",
      configured: true,
    });
  });

  it("fails auth config validation when JWT_SECRET is missing or too short", () => {
    delete process.env.JWT_SECRET;
    expect(() => assertAuthConfig()).toThrow("JWT_SECRET must be set");

    process.env.JWT_SECRET = "short-secret";
    expect(() => assertAuthConfig()).toThrow("JWT_SECRET must be set");
  });
});
