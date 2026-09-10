import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The runtime config must reach the shape a later bounded Test Mode activation
 * can roll back to: payment processing prepared, commercial exposure closed.
 *
 * `validateCreditTestActivation` already enforces this on every reviewed
 * rollback config at activation time. This test pins the same values on the
 * live runtime config now, so the deployment that becomes that rollback record
 * is prepared before the activation request exists.
 */

const rootDir = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const configPath = path.join(rootDir, "apps/image-gen/fly.toml");

/** Reads the `[env]` table of a Fly config as plain string assignments. */
function readEnvAssignments(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const assignments = {};
  let inEnv = false;
  for (const line of lines) {
    const table = /^\s*\[([^\]]+)\]\s*$/u.exec(line);
    if (table) {
      inEnv = table[1] === "env";
      continue;
    }
    if (!inEnv) continue;
    const entry = /^\s*([A-Z0-9_]+)\s*=\s*"([^"]*)"\s*$/u.exec(line);
    if (entry) assignments[entry[1]] = entry[2];
  }
  return assignments;
}

const env = readEnvAssignments(configPath);

describe("image-gen runtime payment processing preparation", () => {
  it("keeps the drain, notification plane and reconciliation prepared", () => {
    expect(env.MOLLIE_BILLING_DRAIN_ENABLED).toBe("true");
    expect(env.BILLING_NOTIFICATION_PLANE_ENABLED).toBe("true");
    expect(env.MOLLIE_RECONCILIATION_ENABLED).toBe("true");
  });

  it("keeps checkout and paid image use closed", () => {
    expect(env.MOLLIE_CREDIT_CHECKOUT_ENABLED).toBe("false");
    expect(env.MESSENGER_PAID_CREDITS_ENABLED).toBe("false");
    expect(env.MOLLIE_BILLING_ENABLED).toBe("false");
    expect(env.MOLLIE_LIVE_BILLING_ENABLED).toBe("false");
    expect(env.MOLLIE_MODE).toBe("test");
  });

  it("requires no manually registered tester", () => {
    for (const key of [
      "MOLLIE_CREDIT_TEST_CHANNEL_CONNECTION_ID",
      "MOLLIE_CREDIT_TEST_BINDING_EPOCH",
      "MOLLIE_CREDIT_TEST_PRIVACY_EPOCH",
      "MOLLIE_CREDIT_TEST_USER_KEY_HASH",
    ]) {
      expect((env[key] ?? "").trim()).toBe("");
    }
  });

  it("keeps the reviewed offer and spend caps unchanged", () => {
    expect(env.MOLLIE_CREDIT_WORKSPACE_ID).toBe("1");
    expect(env.MESSENGER_PAID_IMAGE_PROVIDER_MAX_COST_USD).toBe("1.00");
    expect(env.MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD).toBe("5.00");
    expect(env.MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD).toBe("25.00");
    expect(env.MESSENGER_USER_DAILY_SPEND_CAP_USD).toBe("2.00");
  });

  /**
   * The notification plane refuses to boot without these values, and the
   * sender and receiver halves must agree. The four signing secrets are Fly
   * secrets and are deliberately absent from this config.
   */
  it("carries the non-secret notification identity the plane needs", () => {
    expect(env.BILLING_NOTIFICATION_RECEIVER_PREFLIGHT_ACK).toBe("true");
    expect(env.BILLING_NOTIFICATION_SOURCE_ID).toBe(
      env.BILLING_NOTIFICATION_RECEIVER_SOURCE_ID,
    );
    expect(env.BILLING_CUSTOMER_NOTIFICATION_KEY_ID).toBe(
      env.BILLING_NOTIFICATION_RECEIVER_CUSTOMER_KEY_ID,
    );
    expect(env.BILLING_OPERATOR_NOTIFICATION_KEY_ID).toBe(
      env.BILLING_NOTIFICATION_RECEIVER_OPERATOR_KEY_ID,
    );
    expect(env.BILLING_CUSTOMER_NOTIFICATION_KEY_ID).not.toBe(
      env.BILLING_OPERATOR_NOTIFICATION_KEY_ID,
    );
    const origin = env.BILLING_NOTIFICATION_RECEIVER_PUBLIC_ORIGIN;
    expect(env.BILLING_CUSTOMER_NOTIFICATION_WEBHOOK_URL).toBe(
      `${origin}/api/internal/billing/notifications/customer`,
    );
    expect(env.BILLING_OPERATOR_NOTIFICATION_WEBHOOK_URL).toBe(
      `${origin}/api/internal/billing/notifications/operator`,
    );
    for (const secret of [
      "BILLING_CUSTOMER_NOTIFICATION_SIGNING_SECRET",
      "BILLING_OPERATOR_NOTIFICATION_SIGNING_SECRET",
      "BILLING_NOTIFICATION_RECEIVER_CUSTOMER_SIGNING_SECRET",
      "BILLING_NOTIFICATION_RECEIVER_OPERATOR_SIGNING_SECRET",
      "MOLLIE_API_KEY",
    ]) {
      expect(env[secret]).toBeUndefined();
    }
  });
});
