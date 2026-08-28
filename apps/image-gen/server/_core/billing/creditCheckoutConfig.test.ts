import { describe, expect, it } from "vitest";

import {
  CreditCheckoutConfigError,
  getCreditCheckoutPilotConfig,
  withCreditCheckoutHmacSecret,
} from "./creditCheckoutConfig";

function enabledEnv(override: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    MOLLIE_MODE: "test",
    MOLLIE_CREDIT_CHECKOUT_ENABLED: "true",
    MESSENGER_PAID_CREDITS_ENABLED: "true",
    MOLLIE_CREDIT_WORKSPACE_ID: "42",
    MOLLIE_BILLING_DRAIN_ENABLED: "true",
    BILLING_NOTIFICATION_PLANE_ENABLED: "true",
    MOLLIE_BILLING_ENABLED: "false",
    MOLLIE_LIVE_BILLING_ENABLED: "false",
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
    });
  });

  it.each([
    ["pilot workspace", { MOLLIE_CREDIT_WORKSPACE_ID: "" }],
    ["provider drain", { MOLLIE_BILLING_DRAIN_ENABLED: "false" }],
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
          CREDIT_CHECKOUT_HMAC_SECRET: value,
        })
      ).toThrow(CreditCheckoutConfigError);
    }
  );
});
