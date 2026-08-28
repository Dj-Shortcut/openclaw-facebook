import type { MollieMode } from "./config";

const ENABLED = "true";
const MAX_DATABASE_ID = 2_147_483_647;
const SHA256_KEY_PATTERN = /^[0-9a-f]{64}$/;

export type CreditCheckoutPilotConfig = Readonly<{
  checkoutEnabled: boolean;
  paidCreditsEnabled: boolean;
  workspaceId: number | null;
  mode: MollieMode;
}>;

export class CreditCheckoutConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreditCheckoutConfigError";
  }
}

function readMode(env: NodeJS.ProcessEnv): MollieMode {
  const mode = env.MOLLIE_MODE?.trim();
  if (mode !== "test" && mode !== "live") {
    throw new CreditCheckoutConfigError("MOLLIE_MODE must be test or live");
  }
  return mode;
}

function readWorkspaceId(env: NodeJS.ProcessEnv): number | null {
  const value = env.MOLLIE_CREDIT_WORKSPACE_ID?.trim();
  if (!value) return null;
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new CreditCheckoutConfigError(
      "MOLLIE_CREDIT_WORKSPACE_ID must be a positive integer"
    );
  }
  const workspaceId = Number(value);
  if (
    !Number.isSafeInteger(workspaceId) ||
    workspaceId < 1 ||
    workspaceId > MAX_DATABASE_ID
  ) {
    throw new CreditCheckoutConfigError(
      "MOLLIE_CREDIT_WORKSPACE_ID must be a positive integer"
    );
  }
  return workspaceId;
}

function assertDedicatedCreditCheckoutShape(
  env: NodeJS.ProcessEnv,
  config: CreditCheckoutPilotConfig
): void {
  if (config.checkoutEnabled && !config.paidCreditsEnabled) {
    throw new CreditCheckoutConfigError(
      "MESSENGER_PAID_CREDITS_ENABLED must be true before credit checkout"
    );
  }
  if (config.paidCreditsEnabled && config.workspaceId === null) {
    throw new CreditCheckoutConfigError(
      "MOLLIE_CREDIT_WORKSPACE_ID is required before paid credits"
    );
  }
  if (
    config.paidCreditsEnabled &&
    env.MOLLIE_BILLING_DRAIN_ENABLED !== ENABLED
  ) {
    throw new CreditCheckoutConfigError(
      "MOLLIE_BILLING_DRAIN_ENABLED must be true before paid credits"
    );
  }
  if (!config.checkoutEnabled) return;
  if (env.BILLING_NOTIFICATION_PLANE_ENABLED !== ENABLED) {
    throw new CreditCheckoutConfigError(
      "BILLING_NOTIFICATION_PLANE_ENABLED must be true before credit checkout"
    );
  }
  if (env.MOLLIE_BILLING_ENABLED === ENABLED) {
    throw new CreditCheckoutConfigError(
      "Legacy Mollie billing must remain disabled for credit checkout"
    );
  }
  if (config.mode === "test") {
    if (env.MOLLIE_LIVE_BILLING_ENABLED === ENABLED) {
      throw new CreditCheckoutConfigError(
        "MOLLIE_LIVE_BILLING_ENABLED must remain false in test mode"
      );
    }
    return;
  }
  if (env.MOLLIE_LIVE_BILLING_ENABLED !== ENABLED) {
    throw new CreditCheckoutConfigError(
      "Live credit checkout requires explicit live billing approval"
    );
  }
}

/**
 * Reads only non-secret rollout state. A disabled credit checkout may coexist
 * with an unconfigured pilot so deploys can land dark before the first test.
 */
export function getCreditCheckoutPilotConfig(
  env: NodeJS.ProcessEnv = process.env
): CreditCheckoutPilotConfig {
  const config = Object.freeze({
    checkoutEnabled: env.MOLLIE_CREDIT_CHECKOUT_ENABLED === ENABLED,
    paidCreditsEnabled: env.MESSENGER_PAID_CREDITS_ENABLED === ENABLED,
    workspaceId: readWorkspaceId(env),
    mode: readMode(env),
  });
  assertDedicatedCreditCheckoutShape(env, config);
  return config;
}

export function isCreditCheckoutEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.MOLLIE_CREDIT_CHECKOUT_ENABLED === ENABLED;
}

export function isPaidMessengerCreditsEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.MESSENGER_PAID_CREDITS_ENABLED === ENABLED;
}

/**
 * Keeps decoded secret bytes scoped to one synchronous derivation. The value
 * is never returned, logged, serialized, or retained after the callback.
 */
export function withCreditCheckoutHmacSecret<T>(
  callback: (secret: Uint8Array) => T,
  env: NodeJS.ProcessEnv = process.env
): T {
  const encoded = env.CREDIT_CHECKOUT_HMAC_SECRET?.trim() ?? "";
  if (!SHA256_KEY_PATTERN.test(encoded)) {
    throw new CreditCheckoutConfigError(
      "CREDIT_CHECKOUT_HMAC_SECRET must be a 32-byte lowercase hexadecimal key"
    );
  }
  const secret = Buffer.from(encoded, "hex");
  try {
    return callback(secret);
  } finally {
    secret.fill(0);
  }
}
