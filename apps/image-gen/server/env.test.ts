import { afterEach, describe, expect, it } from "vitest";
import { assertPortalDatabaseConfig } from "./_core/env";

const originalNodeEnv = process.env.NODE_ENV;
const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }

  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

describe("portal database config", () => {
  it("does not require DATABASE_URL outside production", () => {
    process.env.NODE_ENV = "test";
    delete process.env.DATABASE_URL;

    expect(() => assertPortalDatabaseConfig()).not.toThrow();
  });

  it("requires DATABASE_URL in production", () => {
    process.env.NODE_ENV = "production";
    delete process.env.DATABASE_URL;

    expect(() => assertPortalDatabaseConfig()).toThrow(
      "DATABASE_URL is required for the production customer portal"
    );
  });

  it("requires a MySQL-compatible production DATABASE_URL", () => {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgres://example.invalid/leaderbot";

    expect(() => assertPortalDatabaseConfig()).toThrow(
      "DATABASE_URL must use a MySQL-compatible URL"
    );
  });

  it("accepts a MySQL-compatible production DATABASE_URL", () => {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "mysql://user:pass@example.invalid:3306/leaderbot";

    expect(() => assertPortalDatabaseConfig()).not.toThrow();
  });
});
