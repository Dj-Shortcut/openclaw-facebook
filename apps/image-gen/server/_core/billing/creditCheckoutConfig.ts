import { createHash, timingSafeEqual } from "node:crypto";

import type { MollieMode } from "./config";

const ENABLED = "true";
const MAX_DATABASE_ID = 2_147_483_647;
const SHA256_KEY_PATTERN = /^[0-9a-f]{64}$/;
const HMAC_KEY_ID_PATTERN = /^k[1-9][0-9]{0,5}$/;
const MAX_HMAC_KEYRING_SIZE = 4;
const MAX_PREVIOUS_KEYS_LENGTH = 320;
const PRIVACY_USER_KEY_PATTERN =
  /^(?:[0-9a-f]{64}|u2[.]k[1-9][0-9]{0,5}[.][0-9a-f]{64})$/;

export type CreditCheckoutTestPilotScope = Readonly<{
  channelConnectionId: number;
  bindingEpoch: number;
  privacyEpoch: number;
  userKeyHash: string;
}>;

export type CreditCheckoutMessengerScopePinInput = Readonly<{
  workspaceId: number;
  channelConnectionId: number;
  bindingEpoch: number;
  privacyEpoch: number;
  userKey: string;
}>;

export type CreditCheckoutHmacKey = Readonly<{
  keyId: string;
  secret: Uint8Array;
}>;

export type CreditCheckoutPilotConfig = Readonly<{
  checkoutEnabled: boolean;
  paidCreditsEnabled: boolean;
  workspaceId: number | null;
  mode: MollieMode;
  testPilotScope: CreditCheckoutTestPilotScope | null;
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

function readDatabaseId(
  env: NodeJS.ProcessEnv,
  name:
    | "MOLLIE_CREDIT_WORKSPACE_ID"
    | "MOLLIE_CREDIT_TEST_CHANNEL_CONNECTION_ID"
    | "MOLLIE_CREDIT_TEST_BINDING_EPOCH"
    | "MOLLIE_CREDIT_TEST_PRIVACY_EPOCH"
): number | null {
  const value = env[name]?.trim();
  if (!value) return null;
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new CreditCheckoutConfigError(`${name} must be a positive integer`);
  }
  const databaseId = Number(value);
  if (
    !Number.isSafeInteger(databaseId) ||
    databaseId < 1 ||
    databaseId > MAX_DATABASE_ID
  ) {
    throw new CreditCheckoutConfigError(`${name} must be a positive integer`);
  }
  return databaseId;
}

function readTestPilotScope(
  env: NodeJS.ProcessEnv
): CreditCheckoutTestPilotScope | null {
  const channelConnectionId = readDatabaseId(
    env,
    "MOLLIE_CREDIT_TEST_CHANNEL_CONNECTION_ID"
  );
  const bindingEpoch = readDatabaseId(env, "MOLLIE_CREDIT_TEST_BINDING_EPOCH");
  const privacyEpoch = readDatabaseId(env, "MOLLIE_CREDIT_TEST_PRIVACY_EPOCH");
  const userKeyHash = env.MOLLIE_CREDIT_TEST_USER_KEY_HASH?.trim() ?? "";
  const hasAny =
    channelConnectionId !== null ||
    bindingEpoch !== null ||
    privacyEpoch !== null ||
    userKeyHash.length > 0;
  if (!hasAny) return null;
  if (
    channelConnectionId === null ||
    bindingEpoch === null ||
    privacyEpoch === null ||
    !SHA256_KEY_PATTERN.test(userKeyHash)
  ) {
    throw new CreditCheckoutConfigError(
      "The Test Mode credit pilot scope must be complete and canonical"
    );
  }
  return Object.freeze({
    channelConnectionId,
    bindingEpoch,
    privacyEpoch,
    userKeyHash,
  });
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
    config.mode === "test" &&
    (config.checkoutEnabled || config.paidCreditsEnabled) &&
    config.testPilotScope === null
  ) {
    throw new CreditCheckoutConfigError(
      "Test Mode paid credits require one exact Messenger tester scope"
    );
  }
  if (config.mode === "live" && config.testPilotScope !== null) {
    throw new CreditCheckoutConfigError(
      "Test Mode tester scope must be unset in live mode"
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
    workspaceId: readDatabaseId(env, "MOLLIE_CREDIT_WORKSPACE_ID"),
    mode: readMode(env),
    testPilotScope: readTestPilotScope(env),
  });
  assertDedicatedCreditCheckoutShape(env, config);
  return config;
}

/**
 * Produces the only tester identifier accepted by Test Mode rollout config.
 * Callers must persist/configure only this domain-separated digest, never the
 * underlying pseudonymous user key.
 */
export function deriveCreditCheckoutTestUserKeyHash(userKey: string): string {
  if (!PRIVACY_USER_KEY_PATTERN.test(userKey)) {
    throw new CreditCheckoutConfigError(
      "Credit checkout tester identity is invalid"
    );
  }
  return createHash("sha256")
    .update("leaderbot.credit-checkout-test-user.v1\0", "utf8")
    .update(userKey, "utf8")
    .digest("hex");
}

/** Test Mode is one exact pseudonymous user on one immutable Page binding. */
export function isCreditCheckoutMessengerScopeAllowed(
  config: CreditCheckoutPilotConfig,
  scope: CreditCheckoutMessengerScopePinInput
): boolean {
  if (config.workspaceId === null || config.workspaceId !== scope.workspaceId) {
    return false;
  }
  if (config.mode === "live") return config.testPilotScope === null;
  const pilot = config.testPilotScope;
  if (
    !pilot ||
    pilot.channelConnectionId !== scope.channelConnectionId ||
    pilot.bindingEpoch !== scope.bindingEpoch ||
    pilot.privacyEpoch !== scope.privacyEpoch
  ) {
    return false;
  }
  let actual: Buffer;
  try {
    actual = Buffer.from(
      deriveCreditCheckoutTestUserKeyHash(scope.userKey),
      "hex"
    );
  } catch {
    return false;
  }
  const expected = Buffer.from(pilot.userKeyHash, "hex");
  try {
    return (
      actual.byteLength === expected.byteLength &&
      timingSafeEqual(actual, expected)
    );
  } finally {
    actual.fill(0);
    expected.fill(0);
  }
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

function readActiveHmacKeyId(env: NodeJS.ProcessEnv): string {
  const keyId = env.CREDIT_CHECKOUT_HMAC_ACTIVE_KEY_ID?.trim() ?? "";
  if (!HMAC_KEY_ID_PATTERN.test(keyId)) {
    throw new CreditCheckoutConfigError(
      "CREDIT_CHECKOUT_HMAC_ACTIVE_KEY_ID must be a canonical key ID"
    );
  }
  return keyId;
}

function readHmacKeyring(env: NodeJS.ProcessEnv): CreditCheckoutHmacKey[] {
  const activeKeyId = readActiveHmacKeyId(env);
  const activeSecret = env.CREDIT_CHECKOUT_HMAC_SECRET?.trim() ?? "";
  if (!SHA256_KEY_PATTERN.test(activeSecret)) {
    throw new CreditCheckoutConfigError(
      "CREDIT_CHECKOUT_HMAC_SECRET must be a 32-byte lowercase hexadecimal key"
    );
  }
  const previous = env.CREDIT_CHECKOUT_HMAC_PREVIOUS_KEYS?.trim() ?? "";
  if (previous.length > MAX_PREVIOUS_KEYS_LENGTH) {
    throw new CreditCheckoutConfigError(
      "CREDIT_CHECKOUT_HMAC_PREVIOUS_KEYS exceeds the bounded keyring"
    );
  }

  const encodedEntries = previous ? previous.split(",") : [];
  if (encodedEntries.length + 1 > MAX_HMAC_KEYRING_SIZE) {
    throw new CreditCheckoutConfigError(
      "CREDIT_CHECKOUT_HMAC_PREVIOUS_KEYS exceeds the bounded keyring"
    );
  }
  const seenKeyIds = new Set([activeKeyId]);
  const seenSecrets = new Set([activeSecret]);
  const entries: CreditCheckoutHmacKey[] = [
    Object.freeze({
      keyId: activeKeyId,
      secret: Buffer.from(activeSecret, "hex"),
    }),
  ];
  try {
    for (const entry of encodedEntries) {
      const separator = entry.indexOf("=");
      const keyId = separator > 0 ? entry.slice(0, separator) : "";
      const encodedSecret = separator > 0 ? entry.slice(separator + 1) : "";
      if (
        !HMAC_KEY_ID_PATTERN.test(keyId) ||
        !SHA256_KEY_PATTERN.test(encodedSecret) ||
        seenKeyIds.has(keyId) ||
        seenSecrets.has(encodedSecret)
      ) {
        throw new CreditCheckoutConfigError(
          "CREDIT_CHECKOUT_HMAC_PREVIOUS_KEYS is malformed"
        );
      }
      seenKeyIds.add(keyId);
      seenSecrets.add(encodedSecret);
      entries.push(
        Object.freeze({ keyId, secret: Buffer.from(encodedSecret, "hex") })
      );
    }
    return entries;
  } catch (error) {
    entries.forEach(entry => entry.secret.fill(0));
    throw error;
  }
}

/**
 * Exposes the active key followed by retained predecessors only inside one
 * synchronous callback. Previous keys must remain configured while any
 * non-erased wallet or provider-resolution proof was derived from them.
 */
export function withCreditCheckoutHmacKeyring<T>(
  callback: (keys: readonly CreditCheckoutHmacKey[]) => T,
  env: NodeJS.ProcessEnv = process.env
): T {
  const keys = readHmacKeyring(env);
  try {
    return callback(Object.freeze(keys));
  } finally {
    keys.forEach(entry => entry.secret.fill(0));
  }
}

/**
 * Keeps decoded secret bytes scoped to one synchronous derivation. The value
 * is never returned, logged, serialized, or retained after the callback.
 */
export function withCreditCheckoutHmacSecret<T>(
  callback: (secret: Uint8Array) => T,
  env: NodeJS.ProcessEnv = process.env
): T {
  return withCreditCheckoutHmacKeyring(keys => callback(keys[0].secret), env);
}
