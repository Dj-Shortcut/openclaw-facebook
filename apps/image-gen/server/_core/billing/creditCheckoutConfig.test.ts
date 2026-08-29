import { describe, expect, it } from "vitest";

import {
  CreditCheckoutConfigError,
  deriveCreditCheckoutTestUserKeyHash,
  getCreditCheckoutPilotConfig,
  isCreditCheckoutMessengerScopeAllowed,
  withCreditCheckoutHmacKeyring,
  withCreditCheckoutHmacSecret,
} from "./creditCheckoutConfig";

const TEST_USER_KEY = `u2.k1.${"7".repeat(64)}`;
const TEST_USER_KEY_HASH = deriveCreditCheckoutTestUserKeyHash(TEST_USER_KEY);

function enabledEnv(override: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    MOLLIE_MODE: "test",
    MOLLIE_CREDIT_CHECKOUT_ENABLED: "true",
    MESSENGER_PAID_CREDITS_ENABLED: "true",
    MESSENGER_PAID_IMAGE_PROVIDER_MAX_COST_USD: "1.00",
    MOLLIE_CREDIT_WORKSPACE_ID: "42",
    MOLLIE_CREDIT_TEST_CHANNEL_CONNECTION_ID: "8",
    MOLLIE_CREDIT_TEST_BINDING_EPOCH: "3",
    MOLLIE_CREDIT_TEST_PRIVACY_EPOCH: "5",
    MOLLIE_CREDIT_TEST_USER_KEY_HASH: TEST_USER_KEY_HASH,
    MOLLIE_BILLING_DRAIN_ENABLED: "true",
    BILLING_NOTIFICATION_PLANE_ENABLED: "true",
    MOLLIE_BILLING_ENABLED: "false",
    MOLLIE_LIVE_BILLING_ENABLED: "false",
    CREDIT_CHECKOUT_HMAC_ACTIVE_KEY_ID: "k1",
    CREDIT_CHECKOUT_HMAC_SECRET: "ab".repeat(32),
    ...override,
  };
}

describe("credit checkout rollout configuration", () => {
  it("accepts only an explicitly pinned Test Mode credit checkout", () => {
    expect(getCreditCheckoutPilotConfig(enabledEnv())).toEqual({
      checkoutEnabled: true,
      paidCreditsEnabled: true,
      workspaceId: 42,
      mode: "test",
      paidImageProviderMaxCostUsd: 1,
      testPilotScope: {
        channelConnectionId: 8,
        bindingEpoch: 3,
        privacyEpoch: 5,
        userKeyHash: TEST_USER_KEY_HASH,
      },
    });
  });

  it.each([
    ["paid credits", { MESSENGER_PAID_CREDITS_ENABLED: "false" }],
    ["pilot workspace", { MOLLIE_CREDIT_WORKSPACE_ID: "" }],
    ["provider drain", { MOLLIE_BILLING_DRAIN_ENABLED: "false" }],
    ["notification plane", { BILLING_NOTIFICATION_PLANE_ENABLED: "false" }],
    ["legacy billing", { MOLLIE_BILLING_ENABLED: "true" }],
    ["live flag", { MOLLIE_LIVE_BILLING_ENABLED: "true" }],
  ])("fails closed when the %s boundary is invalid", (_label, override) => {
    expect(() => getCreditCheckoutPilotConfig(enabledEnv(override))).toThrow(
      CreditCheckoutConfigError
    );
  });

  it("allows a dark deploy without pilot or operational credit flags", () => {
    expect(
      getCreditCheckoutPilotConfig({
        MOLLIE_MODE: "test",
        MOLLIE_CREDIT_CHECKOUT_ENABLED: "false",
        MESSENGER_PAID_CREDITS_ENABLED: "false",
      })
    ).toEqual({
      checkoutEnabled: false,
      paidCreditsEnabled: false,
      workspaceId: null,
      mode: "test",
      paidImageProviderMaxCostUsd: null,
      testPilotScope: null,
    });
  });

  it.each(["", "0", "-1", "NaN", "Infinity"])(
    "fails closed for an invalid paid-image provider maximum %j",
    value => {
      expect(() =>
        getCreditCheckoutPilotConfig(
          enabledEnv({ MESSENGER_PAID_IMAGE_PROVIDER_MAX_COST_USD: value })
        )
      ).toThrow(CreditCheckoutConfigError);
    }
  );

  it("allows only the exact pseudonymous tester on the pinned Page binding", () => {
    const config = getCreditCheckoutPilotConfig(enabledEnv());
    const exactScope = {
      workspaceId: 42,
      channelConnectionId: 8,
      bindingEpoch: 3,
      privacyEpoch: 5,
      userKey: TEST_USER_KEY,
    };

    expect(isCreditCheckoutMessengerScopeAllowed(config, exactScope)).toBe(
      true
    );
    expect(
      isCreditCheckoutMessengerScopeAllowed(config, {
        ...exactScope,
        userKey: `u2.k1.${"8".repeat(64)}`,
      })
    ).toBe(false);
    expect(
      isCreditCheckoutMessengerScopeAllowed(config, {
        ...exactScope,
        bindingEpoch: 4,
      })
    ).toBe(false);
  });

  it.each([
    ["missing tester hash", { MOLLIE_CREDIT_TEST_USER_KEY_HASH: "" }],
    ["partial tester scope", { MOLLIE_CREDIT_TEST_CHANNEL_CONNECTION_ID: "" }],
    ["malformed tester hash", { MOLLIE_CREDIT_TEST_USER_KEY_HASH: "a" }],
  ])("fails closed for a %s", (_label, override) => {
    expect(() => getCreditCheckoutPilotConfig(enabledEnv(override))).toThrow(
      CreditCheckoutConfigError
    );
  });

  it("rejects a Test Mode tester pin in live mode", () => {
    expect(() =>
      getCreditCheckoutPilotConfig(
        enabledEnv({
          MOLLIE_MODE: "live",
          MOLLIE_LIVE_BILLING_ENABLED: "true",
        })
      )
    ).toThrow("Test Mode tester scope must be unset in live mode");
  });

  it.each([
    ["pilot workspace", { MOLLIE_CREDIT_WORKSPACE_ID: "" }],
    ["provider drain", { MOLLIE_BILLING_DRAIN_ENABLED: "false" }],
    [
      "provider attempt maximum",
      { MESSENGER_PAID_IMAGE_PROVIDER_MAX_COST_USD: "" },
    ],
  ])(
    "keeps the %s boundary mandatory while paid-credit consumption remains enabled",
    (_label, override) => {
      expect(() =>
        getCreditCheckoutPilotConfig(
          enabledEnv({ MOLLIE_CREDIT_CHECKOUT_ENABLED: "false", ...override })
        )
      ).toThrow(CreditCheckoutConfigError);
    }
  );

  it("reveals decoded secret bytes only inside the callback and wipes them", () => {
    let observed: Uint8Array | undefined;
    const result = withCreditCheckoutHmacSecret(secret => {
      observed = secret;
      expect(Buffer.from(secret).toString("hex")).toBe("ab".repeat(32));
      return "derived";
    }, enabledEnv());

    expect(result).toBe("derived");
    expect(observed).toBeDefined();
    expect(Buffer.from(observed ?? []).equals(Buffer.alloc(32))).toBe(true);
  });

  it.each(["", "AB".repeat(32), "a".repeat(63), "not-a-secret"])(
    "rejects malformed dedicated secret material",
    value => {
      expect(() =>
        withCreditCheckoutHmacSecret(() => undefined, {
          CREDIT_CHECKOUT_HMAC_ACTIVE_KEY_ID: "k1",
          CREDIT_CHECKOUT_HMAC_SECRET: value,
        })
      ).toThrow(CreditCheckoutConfigError);
    }
  );

  it("orders the active key before retained predecessors and wipes all bytes", () => {
    let observed:
      readonly Readonly<{ keyId: string; secret: Uint8Array }>[] | undefined;
    const ids = withCreditCheckoutHmacKeyring(
      keys => {
        observed = keys;
        return keys.map(key => key.keyId);
      },
      enabledEnv({
        CREDIT_CHECKOUT_HMAC_ACTIVE_KEY_ID: "k3",
        CREDIT_CHECKOUT_HMAC_SECRET: "cd".repeat(32),
        CREDIT_CHECKOUT_HMAC_PREVIOUS_KEYS: `k2=${"bc".repeat(32)},k1=${"ab".repeat(32)}`,
      })
    );

    expect(ids).toEqual(["k3", "k2", "k1"]);
    expect(observed).toHaveLength(3);
    expect(
      observed?.every(key => Buffer.from(key.secret).equals(Buffer.alloc(32)))
    ).toBe(true);
  });

  it("retains wallets across more than four HMAC key generations", () => {
    const retainedKeys = [5, 4, 3, 2, 1].map(index => ({
      keyId: `k${index}`,
      secret: index.toString(16).padStart(2, "0").repeat(32),
    }));
    let observed:
      readonly Readonly<{ keyId: string; secret: Uint8Array }>[] | undefined;

    const ids = withCreditCheckoutHmacKeyring(
      keys => {
        observed = keys;
        return keys.map(key => key.keyId);
      },
      enabledEnv({
        CREDIT_CHECKOUT_HMAC_ACTIVE_KEY_ID: "k6",
        CREDIT_CHECKOUT_HMAC_SECRET: "06".repeat(32),
        CREDIT_CHECKOUT_HMAC_PREVIOUS_KEYS: retainedKeys
          .map(key => `${key.keyId}=${key.secret}`)
          .join(","),
      })
    );

    expect(ids).toEqual(["k6", "k5", "k4", "k3", "k2", "k1"]);
    expect(
      observed?.every(key => Buffer.from(key.secret).equals(Buffer.alloc(32)))
    ).toBe(true);
  });

  it.each([
    ["missing active ID", { CREDIT_CHECKOUT_HMAC_ACTIVE_KEY_ID: "" }],
    ["malformed active ID", { CREDIT_CHECKOUT_HMAC_ACTIVE_KEY_ID: "current" }],
    [
      "duplicate key ID",
      {
        CREDIT_CHECKOUT_HMAC_PREVIOUS_KEYS: `k1=${"bc".repeat(32)}`,
      },
    ],
    [
      "duplicate secret",
      {
        CREDIT_CHECKOUT_HMAC_PREVIOUS_KEYS: `k2=${"ab".repeat(32)}`,
      },
    ],
  ])("rejects a %s", (_label, override) => {
    expect(() =>
      withCreditCheckoutHmacKeyring(() => undefined, enabledEnv(override))
    ).toThrow(CreditCheckoutConfigError);
  });
});
