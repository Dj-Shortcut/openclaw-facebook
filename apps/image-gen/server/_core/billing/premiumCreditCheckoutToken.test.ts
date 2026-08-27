import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createPremiumCreditCheckoutUrl,
  readPremiumCreditCheckoutToken,
} from "./premiumCreditCheckoutToken";

const originalEnv = { ...process.env };
const identity = {
  workspaceId: 7,
  channelConnectionId: 11,
  bindingEpoch: 3,
  privacyEpoch: 5,
  userKey: "a".repeat(64),
  pageId: "page-123",
};

beforeEach(() => {
  process.env.NODE_ENV = "test";
  process.env.APP_BASE_URL = "https://bot.example";
  process.env.PREMIUM_CREDIT_CHECKOUT_ENABLED = "true";
  process.env.PREMIUM_CREDIT_ENFORCEMENT_ENABLED = "true";
  process.env.PREMIUM_CREDIT_CHECKOUT_TOKEN_SECRET = "s".repeat(48);
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("premium credit checkout token", () => {
  it("round-trips an opaque ten-minute subject-bound capability", () => {
    const url = new URL(createPremiumCreditCheckoutUrl(identity, 1_000_000)!);
    expect(url.origin).toBe("https://bot.example");
    expect(url.pathname).toBe("/credits");
    expect(url.toString()).not.toContain(identity.userKey);

    const decoded = readPremiumCreditCheckoutToken(
      url.searchParams.get("token")!,
      1_001_000
    );
    expect(decoded).toMatchObject({
      ...identity,
      offer: "premium_image_credits_5_v1",
      issuedAt: 1_000_000,
      expiresAt: 1_600_000,
    });
    expect(decoded.checkoutScopeKey).toMatch(/^premium:[a-f0-9]{64}$/);
  });

  it("fails closed for tampering, expiry, disabled exposure and unsafe origins", () => {
    const url = new URL(createPremiumCreditCheckoutUrl(identity, 2_000_000)!);
    const token = url.searchParams.get("token")!;
    expect(() =>
      readPremiumCreditCheckoutToken(`${token.slice(0, -1)}x`, 2_001_000)
    ).toThrow("token is invalid");
    expect(() => readPremiumCreditCheckoutToken(token, 2_600_000)).toThrow(
      "invalid or expired"
    );

    process.env.PREMIUM_CREDIT_CHECKOUT_ENABLED = "false";
    expect(createPremiumCreditCheckoutUrl(identity)).toBeUndefined();
    process.env.PREMIUM_CREDIT_CHECKOUT_ENABLED = "true";
    process.env.NODE_ENV = "production";
    process.env.APP_BASE_URL = "http://bot.example";
    expect(createPremiumCreditCheckoutUrl(identity)).toBeUndefined();
  });
});
