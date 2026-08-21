import http from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildRuntimeReadinessChecks,
  createReadinessHandler,
  type ReadinessCheck,
} from "./_core/readiness";
import { resetConversationIdentityConfigForTests } from "./_core/conversationIdentityConfig";
import { bindTestHttpServer } from "./testHttpServer";

const READINESS_ENV_KEYS = [
  "NODE_ENV",
  "MOLLIE_BILLING_ENABLED",
  "MOLLIE_ENTITLEMENT_ENFORCEMENT_ENABLED",
  "AI_ANSWER_FINALIZATION_DRAIN_ENABLED",
  "AI_ANSWER_QUOTA_PREFLIGHT_ENABLED",
  "MOLLIE_API_KEY",
  "MOLLIE_MODE",
  "MOLLIE_PAYMENT_WEBHOOK_URL",
  "APP_BASE_URL",
  "BILLING_SUPPORT_EMAIL",
  "MOLLIE_BILLING_WORKER_WORKSPACE_ID",
  "MOLLIE_BILLING_SCHEDULER_MODE",
  "PORTAL_HANDOFF_TOKEN_SECRET",
  "REDIS_URL",
  "CONVERSATION_SCOPE_HMAC_KEY_ID",
  "CONVERSATION_SCOPE_HMAC_SECRET",
] as const;
const originalReadinessEnv = Object.fromEntries(
  READINESS_ENV_KEYS.map(key => [key, process.env[key]])
) as Record<(typeof READINESS_ENV_KEYS)[number], string | undefined>;

function restoreReadinessEnv(): void {
  for (const key of READINESS_ENV_KEYS) {
    const originalValue = originalReadinessEnv[key];
    if (originalValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalValue;
    }
  }
}

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
  afterEach(() => {
    vi.unstubAllEnvs();
    restoreReadinessEnv();
    resetConversationIdentityConfigForTests();
  });

  it("fails the conversation identity readiness check when its key is missing", () => {
    delete process.env.CONVERSATION_SCOPE_HMAC_KEY_ID;
    delete process.env.CONVERSATION_SCOPE_HMAC_SECRET;
    resetConversationIdentityConfigForTests();
    const identityCheck = buildRuntimeReadinessChecks().find(
      check => check.name === "conversation_identity_config"
    );

    expect(identityCheck).toBeDefined();
    expect(() => identityCheck?.check()).toThrow(
      "Conversation identity configuration is invalid"
    );
  });

  it("passes the conversation identity readiness check with a valid key", () => {
    vi.stubEnv("CONVERSATION_SCOPE_HMAC_KEY_ID", "k1");
    vi.stubEnv("CONVERSATION_SCOPE_HMAC_SECRET", "a".repeat(64));
    resetConversationIdentityConfigForTests();
    const identityCheck = buildRuntimeReadinessChecks().find(
      check => check.name === "conversation_identity_config"
    );

    expect(identityCheck).toBeDefined();
    expect(() => identityCheck?.check()).not.toThrow();
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
    vi.stubEnv("MOLLIE_BILLING_ENABLED", "true");
    vi.stubEnv("MOLLIE_ENTITLEMENT_ENFORCEMENT_ENABLED", "true");
    vi.stubEnv("PORTAL_HANDOFF_TOKEN_SECRET", "x".repeat(32));
    delete process.env.MOLLIE_API_KEY;
    const mollieCheck = buildRuntimeReadinessChecks().find(
      check => check.name === "mollie_billing_config"
    );

    expect(() => mollieCheck?.check()).toThrow("MOLLIE_API_KEY is missing");
  });

  it("allows database-driven multi-tenant workers without a pilot workspace", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("MOLLIE_BILLING_ENABLED", "true");
    vi.stubEnv("MOLLIE_ENTITLEMENT_ENFORCEMENT_ENABLED", "true");
    vi.stubEnv("PORTAL_HANDOFF_TOKEN_SECRET", "x".repeat(32));
    vi.stubEnv("MOLLIE_API_KEY", "test_example123");
    vi.stubEnv("MOLLIE_MODE", "test");
    vi.stubEnv(
      "MOLLIE_PAYMENT_WEBHOOK_URL",
      "http://billing.test/api/webhooks/mollie/payments"
    );
    vi.stubEnv("APP_BASE_URL", "http://leaderbot.test");
    vi.stubEnv("BILLING_SUPPORT_EMAIL", "billing@leaderbot.test");
    vi.stubEnv("MOLLIE_BILLING_SCHEDULER_MODE", "multi_tenant");
    delete process.env.MOLLIE_BILLING_WORKER_WORKSPACE_ID;
    const mollieCheck = buildRuntimeReadinessChecks().find(
      check => check.name === "mollie_billing_config"
    );

    expect(() => mollieCheck?.check()).not.toThrow();
  });

  it("fails rate-limiter readiness when Mollie billing has no shared Redis", async () => {
    vi.stubEnv("MOLLIE_BILLING_ENABLED", "true");
    delete process.env.REDIS_URL;
    const rateLimiterCheck = buildRuntimeReadinessChecks().find(
      check => check.name === "http_rate_limiter"
    );

    await expect(rateLimiterCheck?.check()).rejects.toThrow(
      "Mollie webhook rate limiting requires Redis"
    );
  });

  it("does not report paid AI quota ready when admission lacks the durable drain", async () => {
    vi.stubEnv("MOLLIE_ENTITLEMENT_ENFORCEMENT_ENABLED", "true");
    vi.stubEnv("AI_ANSWER_FINALIZATION_DRAIN_ENABLED", "false");
    const check = buildRuntimeReadinessChecks().find(
      item => item.name === "ai_answer_finalization"
    );

    await expect(check?.check()).rejects.toThrow(
      "requires the durable finalization drain"
    );
  });

  it("keeps exposure-off quota preflight fail-closed without the durable drain", async () => {
    vi.stubEnv("MOLLIE_ENTITLEMENT_ENFORCEMENT_ENABLED", "false");
    vi.stubEnv("AI_ANSWER_QUOTA_PREFLIGHT_ENABLED", "true");
    vi.stubEnv("AI_ANSWER_FINALIZATION_DRAIN_ENABLED", "false");
    const check = buildRuntimeReadinessChecks().find(
      item => item.name === "ai_answer_finalization"
    );

    await expect(check?.check()).rejects.toThrow(
      "requires the durable finalization drain"
    );
  });

  it("includes the privacy-erasure worker liveness gate", () => {
    expect(
      buildRuntimeReadinessChecks().some(
        check => check.name === "messenger_privacy_erasure_worker"
      )
    ).toBe(true);
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
