import http from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildRuntimeReadinessChecks,
  createReadinessHandler,
  type ReadinessCheck,
} from "./_core/readiness";
import { bindTestHttpServer } from "./testHttpServer";

async function startServer(checks: ReadinessCheck[]) {
  const app = express();
  app.get("/readyz", createReadinessHandler(checks));

  const server = http.createServer(app);
  const boundServer = await bindTestHttpServer(server);

  return {
    baseUrl: boundServer.baseUrl,
    close: boundServer.close,
  };
}

describe("readiness", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("does not require Mollie configuration while billing is disabled", () => {
    delete process.env.MOLLIE_BILLING_ENABLED;
    const mollieCheck = buildRuntimeReadinessChecks().find(
      check => check.name === "mollie_billing_config"
    );

    expect(mollieCheck).toBeDefined();
    expect(() => mollieCheck?.check()).not.toThrow();
  });

  it("fails the Mollie readiness check when billing is enabled but unconfigured", () => {
    process.env.MOLLIE_BILLING_ENABLED = "true";
    delete process.env.MOLLIE_API_KEY;
    const mollieCheck = buildRuntimeReadinessChecks().find(
      check => check.name === "mollie_billing_config"
    );

    expect(() => mollieCheck?.check()).toThrow("MOLLIE_API_KEY is missing");
  });

  it("fails readiness when billing is enabled without its tenant worker", () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: "test",
      MOLLIE_BILLING_ENABLED: "true",
      MOLLIE_API_KEY: "test_example123",
      MOLLIE_MODE: "test",
      MOLLIE_PAYMENT_WEBHOOK_URL:
        "http://billing.test/api/webhooks/mollie/payments",
      APP_BASE_URL: "http://leaderbot.test",
      BILLING_SUPPORT_EMAIL: "billing@leaderbot.test",
    };
    delete process.env.MOLLIE_BILLING_WORKER_WORKSPACE_ID;
    const mollieCheck = buildRuntimeReadinessChecks().find(
      check => check.name === "mollie_billing_config"
    );

    expect(() => mollieCheck?.check()).toThrow(
      "MOLLIE_BILLING_WORKER_WORKSPACE_ID is required"
    );
  });

  it("returns ok when all dependency checks pass", async () => {
    const server = await startServer([
      { name: "redis", check: vi.fn() },
      { name: "storage", check: vi.fn(async () => undefined) },
    ]);

    try {
      const response = await fetch(`${server.baseUrl}/readyz`);
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload).toEqual({
        ok: true,
        checks: [
          { name: "redis", ok: true },
          { name: "storage", ok: true },
        ],
      });
    } finally {
      await server.close();
    }
  });

  it("returns 503 with redacted error codes when a dependency check fails", async () => {
    class StorageConfigError extends Error {}
    const server = await startServer([
      { name: "redis", check: vi.fn() },
      {
        name: "image_storage_config",
        check: vi.fn(() => {
          throw new StorageConfigError("secret storage URL missing");
        }),
      },
    ]);

    try {
      const response = await fetch(`${server.baseUrl}/readyz`);
      const payload = await response.json();

      expect(response.status).toBe(503);
      expect(payload).toEqual({
        ok: false,
        checks: [
          { name: "redis", ok: true },
          {
            name: "image_storage_config",
            ok: false,
            error: "StorageConfigError",
          },
        ],
      });
      expect(JSON.stringify(payload)).not.toContain("secret storage URL");
    } finally {
      await server.close();
    }
  });
});
