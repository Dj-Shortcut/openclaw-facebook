import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertMollieBillingEnabled,
  assertTenantBillingWorkerConfigured,
  assertTenantBillingWorkerWorkspace,
  getMollieConfig,
  getTenantBillingWorkerWorkspaceId,
  isMollieBillingEnabled,
} from "./config";

const originalEnv = { ...process.env };

function useValidTestConfig(): void {
  process.env = {
    ...originalEnv,
    NODE_ENV: "test",
    MOLLIE_API_KEY: "test_example123",
    MOLLIE_MODE: "test",
    MOLLIE_PAYMENT_WEBHOOK_URL:
      "http://billing.test/api/webhooks/mollie/payments",
    APP_BASE_URL: "http://leaderbot.test/",
    BILLING_SUPPORT_EMAIL: "billing@leaderbot.test",
    MOLLIE_ENTITLEMENT_ENFORCEMENT_ENABLED: "true",
    MOLLIE_BILLING_SCHEDULER_MODE: "multi_tenant",
    PORTAL_HANDOFF_TOKEN_SECRET: "test-portal-handoff-secret-at-least-32",
  };
  delete process.env.PORTAL_BASE_URL;
  delete process.env.MOLLIE_LIVE_BILLING_ENABLED;
  delete process.env.MOLLIE_BILLING_ENABLED;
  delete process.env.MOLLIE_BILLING_WORKER_WORKSPACE_ID;
}

describe("Mollie configuration", () => {
  beforeEach(() => {
    useValidTestConfig();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("documents every credential-free paid preflight setting", () => {
    const envExample = readFileSync(
      new URL("../../../.env.example", import.meta.url),
      "utf8"
    );
    for (const name of [
      "MOLLIE_BILLING_PREFLIGHT_ENABLED",
      "MOLLIE_BILLING_SCHEDULER_MODE",
      "BILLING_PROFILE_EVIDENCE_HMAC_SECRET",
      "MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD",
      "MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD",
      "MESSENGER_USER_DAILY_SPEND_CAP_USD",
      "MESSENGER_GLOBAL_DAILY_IMAGE_CAP",
      "OPENAI_IMAGE_ESTIMATED_COST_USD",
      "BILLING_NOTIFICATION_PLANE_ENABLED",
      "AI_ANSWER_FINALIZATION_DRAIN_ENABLED",
    ]) {
      expect(envExample).toContain(`${name}=`);
    }
  });

  it.each([
    "MOLLIE_API_KEY",
    "MOLLIE_MODE",
    "MOLLIE_PAYMENT_WEBHOOK_URL",
    "APP_BASE_URL",
    "BILLING_SUPPORT_EMAIL",
  ])("rejects a missing required setting: %s", setting => {
    delete process.env[setting];

    expect(() => getMollieConfig()).toThrow(`${setting} is missing`);
  });

  it("keeps all Mollie billing disabled until the launch switch is explicit", () => {
    expect(isMollieBillingEnabled()).toBe(false);
    expect(() => assertMollieBillingEnabled()).toThrow(
      "Mollie billing is disabled"
    );

    process.env.MOLLIE_BILLING_ENABLED = "true";
    expect(isMollieBillingEnabled()).toBe(true);
    expect(() => assertMollieBillingEnabled()).not.toThrow();
  });

  it("rejects checkout until paid entitlements are independently enforced", () => {
    process.env.MOLLIE_BILLING_ENABLED = "true";
    delete process.env.MOLLIE_ENTITLEMENT_ENFORCEMENT_ENABLED;

    expect(() => assertMollieBillingEnabled()).toThrow(
      "Mollie entitlement enforcement is disabled"
    );
  });

  it("rejects an unsupported mode", () => {
    process.env.MOLLIE_MODE = "production";

    expect(() => getMollieConfig()).toThrow("MOLLIE_MODE must be test or live");
  });

  it.each([
    ["test", "live_example123"],
    ["live", "test_example123"],
  ])("rejects a %s mode/key prefix mismatch", (mode, apiKey) => {
    process.env.MOLLIE_MODE = mode;
    process.env.MOLLIE_API_KEY = apiKey;
    process.env.APP_BASE_URL = "https://leaderbot.test";
    process.env.MOLLIE_PAYMENT_WEBHOOK_URL =
      "https://billing.test/api/webhooks/mollie/payments";

    expect(() => getMollieConfig()).toThrow(
      `MOLLIE_API_KEY does not match MOLLIE_MODE=${mode}`
    );
  });

  it("keeps live billing disabled unless it is explicitly enabled", () => {
    process.env.MOLLIE_MODE = "live";
    process.env.MOLLIE_API_KEY = "live_example123";
    process.env.APP_BASE_URL = "https://leaderbot.test";
    process.env.MOLLIE_PAYMENT_WEBHOOK_URL =
      "https://billing.test/api/webhooks/mollie/payments";

    expect(getMollieConfig()).toMatchObject({
      mode: "live",
      liveBillingEnabled: false,
    });
    process.env.MOLLIE_BILLING_ENABLED = "true";
    expect(() => assertMollieBillingEnabled()).toThrow(
      "Mollie live billing is disabled"
    );

    process.env.MOLLIE_LIVE_BILLING_ENABLED = "true";
    expect(() => assertMollieBillingEnabled()).not.toThrow();
    expect(getMollieConfig()).toMatchObject({
      mode: "live",
      liveBillingEnabled: true,
    });
  });

  it("rejects HTTP application and webhook URLs in production", () => {
    process.env.NODE_ENV = "production";

    expect(() => getMollieConfig()).toThrow(
      "APP_BASE_URL must use HTTPS for production or live billing"
    );

    process.env.APP_BASE_URL = "https://leaderbot.test";
    expect(() => getMollieConfig()).toThrow(
      "MOLLIE_PAYMENT_WEBHOOK_URL must use HTTPS for production or live billing"
    );
  });

  it("rejects a malformed portal origin before billing can be enabled", () => {
    process.env.PORTAL_BASE_URL = "https://leaderbot.test/handoff?unsafe=1";

    expect(() => getMollieConfig()).toThrow(
      "PORTAL_BASE_URL must be an origin without a path, query, or fragment"
    );
  });

  it("rejects an HTTP portal origin in production", () => {
    process.env.NODE_ENV = "production";
    process.env.APP_BASE_URL = "https://leaderbot.test";
    process.env.MOLLIE_PAYMENT_WEBHOOK_URL =
      "https://billing.test/api/webhooks/mollie/payments";
    process.env.PORTAL_BASE_URL = "http://leaderbot.test";

    expect(() => getMollieConfig()).toThrow(
      "PORTAL_BASE_URL must use HTTPS for production or live billing"
    );
  });

  it("accepts an HTTPS live configuration only with the explicit launch switch", () => {
    process.env.MOLLIE_MODE = "live";
    process.env.MOLLIE_API_KEY = "live_example123";
    process.env.MOLLIE_LIVE_BILLING_ENABLED = "true";
    process.env.APP_BASE_URL = "https://leaderbot.test/";
    process.env.MOLLIE_PAYMENT_WEBHOOK_URL =
      "https://billing.test/api/webhooks/mollie/payments";

    expect(getMollieConfig()).toEqual({
      apiKey: "live_example123",
      mode: "live",
      paymentWebhookUrl: "https://billing.test/api/webhooks/mollie/payments",
      appBaseUrl: "https://leaderbot.test",
      billingSupportEmail: "billing@leaderbot.test",
      liveBillingEnabled: true,
    });
  });

  it("requires an explicit scheduler mode and keeps an optional pilot allowlist", () => {
    expect(getTenantBillingWorkerWorkspaceId()).toBeNull();
    expect(assertTenantBillingWorkerConfigured()).toBeUndefined();
    expect(() => assertTenantBillingWorkerWorkspace(42)).not.toThrow();

    process.env.MOLLIE_BILLING_SCHEDULER_MODE = "pilot_pin";
    process.env.MOLLIE_BILLING_WORKER_WORKSPACE_ID = "42";
    expect(getTenantBillingWorkerWorkspaceId()).toBe(42);
    expect(assertTenantBillingWorkerConfigured()).toBeUndefined();
    expect(() => assertTenantBillingWorkerWorkspace(42)).not.toThrow();
    expect(() => assertTenantBillingWorkerWorkspace(43)).toThrow(
      "Mollie billing is unavailable for this workspace"
    );
  });

  it("never infers multi-tenant execution from a missing pilot pin", () => {
    delete process.env.MOLLIE_BILLING_SCHEDULER_MODE;
    expect(() => assertTenantBillingWorkerConfigured()).toThrow(
      "MOLLIE_BILLING_SCHEDULER_MODE must explicitly be pilot_pin or multi_tenant"
    );
  });

  it.each(["0", "-1", "1.5", "not-a-number"])(
    "rejects an invalid tenant worker workspace: %s",
    value => {
      process.env.MOLLIE_BILLING_WORKER_WORKSPACE_ID = value;
      expect(() => getTenantBillingWorkerWorkspaceId()).toThrow(
        "MOLLIE_BILLING_WORKER_WORKSPACE_ID must be a positive integer"
      );
    }
  );
});
