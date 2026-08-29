import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { listCreditOffers, type CreditOffer } from "./creditCatalog";
import {
  CreditCheckoutIdentityError,
  deriveCreditCheckoutIdentity,
  deriveCreditWalletIdentity,
  type CreditCheckoutIdentityInput,
} from "./creditCheckoutIdentity";

const USER_KEY = "a".repeat(64);
const VERSIONED_USER_KEY = `u2.k2.${"b".repeat(64)}`;
const REQUEST_KEY_HASH = createHash("sha256")
  .update("stable-messenger-request", "utf8")
  .digest("hex");
const OTHER_REQUEST_KEY_HASH = createHash("sha256")
  .update("different-messenger-request", "utf8")
  .digest("hex");
const OFFER = listCreditOffers()[0]!;

function input(
  overrides: Partial<CreditCheckoutIdentityInput> = {}
): CreditCheckoutIdentityInput {
  return {
    dedicatedSecret: Buffer.from("s".repeat(32), "ascii"),
    scope: {
      workspaceId: 42,
      mode: "test",
      channel: "facebook_messenger",
      channelConnectionId: 12,
      bindingEpoch: 3,
      privacyEpoch: 5,
      userKey: USER_KEY,
    },
    expectedAuthorizationEpoch: 7,
    requestKeyHash: REQUEST_KEY_HASH,
    offer: OFFER,
    ...overrides,
  };
}

describe("credit checkout identity", () => {
  it("derives the same wallet without checkout authorization or request state", () => {
    const checkoutInput = input();
    const checkout = deriveCreditCheckoutIdentity(checkoutInput);
    const wallet = deriveCreditWalletIdentity({
      dedicatedSecret: checkoutInput.dedicatedSecret,
      scope: checkoutInput.scope,
    });

    expect(wallet).toEqual({
      financialSubjectRef: checkout.financialSubjectRef,
      walletId: checkout.walletId,
    });
    expect(Object.isFrozen(wallet)).toBe(true);
    expect(JSON.stringify(wallet)).not.toContain(checkoutInput.scope.userKey);
  });

  it("keeps wallet identity scoped to the exact Messenger privacy binding", () => {
    const checkoutInput = input();
    const base = deriveCreditWalletIdentity({
      dedicatedSecret: checkoutInput.dedicatedSecret,
      scope: checkoutInput.scope,
    });
    const changed = deriveCreditWalletIdentity({
      dedicatedSecret: checkoutInput.dedicatedSecret,
      scope: { ...checkoutInput.scope, privacyEpoch: 6 },
    });

    expect(changed.walletId).not.toBe(base.walletId);
    expect(changed.financialSubjectRef).not.toBe(base.financialSubjectRef);
  });

  it("derives identical opaque identity and capability material on retry", () => {
    const firstInput = input();
    const secretBefore = Buffer.from(firstInput.dedicatedSecret);
    const first = deriveCreditCheckoutIdentity(firstInput);
    const retry = deriveCreditCheckoutIdentity(input());

    expect(retry.toJSON()).toEqual(first.toJSON());
    expect(retry.checkoutCapability.toUrlFragment()).toBe(
      first.checkoutCapability.toUrlFragment()
    );
    expect(Buffer.from(firstInput.dedicatedSecret)).toEqual(secretBefore);
    expect(first.financialSubjectRef).toMatch(/^[0-9a-f]{64}$/);
    expect(first.checkoutScopeKey).toMatch(/^credit-checkout:v1:[0-9a-f]{64}$/);
    expect(first.checkoutScopeKey.length).toBeLessThanOrEqual(160);
    expect(first.idempotencyKey).toBe(`credit-payment:${first.intentId}`);
  });

  it("rotates financial identity on scope changes without following authorization", () => {
    const baseInput = input();
    const base = deriveCreditCheckoutIdentity(baseInput);
    const changedScopes = [
      { ...baseInput.scope, workspaceId: 43 },
      { ...baseInput.scope, mode: "live" as const },
      { ...baseInput.scope, channelConnectionId: 13 },
      { ...baseInput.scope, bindingEpoch: 4 },
      { ...baseInput.scope, privacyEpoch: 6 },
      { ...baseInput.scope, userKey: VERSIONED_USER_KEY },
    ];

    for (const scope of changedScopes) {
      const changed = deriveCreditCheckoutIdentity(input({ scope }));
      expect(changed.financialSubjectRef).not.toBe(base.financialSubjectRef);
      expect(changed.walletId).not.toBe(base.walletId);
      expect(changed.intentId).not.toBe(base.intentId);
      expect(changed.checkoutScopeKey).not.toBe(base.checkoutScopeKey);
    }

    const changedAuthorization = deriveCreditCheckoutIdentity(
      input({ expectedAuthorizationEpoch: 8 })
    );
    expect(changedAuthorization.financialSubjectRef).toBe(
      base.financialSubjectRef
    );
    expect(changedAuthorization.walletId).toBe(base.walletId);
    expect(changedAuthorization.intentId).not.toBe(base.intentId);
    expect(changedAuthorization.checkoutScopeKey).not.toBe(
      base.checkoutScopeKey
    );
  });

  it("binds each new request while preserving the same user wallet", () => {
    const base = deriveCreditCheckoutIdentity(input());
    const changed = deriveCreditCheckoutIdentity(
      input({ requestKeyHash: OTHER_REQUEST_KEY_HASH })
    );

    expect(changed.financialSubjectRef).toBe(base.financialSubjectRef);
    expect(changed.walletId).toBe(base.walletId);
    expect(changed.intentId).not.toBe(base.intentId);
    expect(changed.checkoutScopeKey).not.toBe(base.checkoutScopeKey);
    expect(changed.metadataHash).not.toBe(base.metadataHash);
  });

  it("emits canonical RFC 9562 UUIDv8 identifiers", () => {
    const result = deriveCreditCheckoutIdentity(input());

    for (const uuid of [result.walletId, result.intentId]) {
      expect(uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
      expect(uuid).toBe(uuid.toLowerCase());
    }
    expect(result.walletId).not.toBe(result.intentId);
  });

  it("builds one immutable, amount-consistent server metadata snapshot", () => {
    const result = deriveCreditCheckoutIdentity(input());

    expect(result.paymentMetadataSnapshot).toEqual({
      purpose: "premium_image_credits",
      version: 1,
      intentId: result.intentId,
      walletId: result.walletId,
      tenant: {
        workspaceId: 42,
        mode: "test",
        channel: "facebook_messenger",
        channelConnectionId: 12,
        bindingEpoch: 3,
        privacyEpoch: 5,
        financialSubjectRef: result.financialSubjectRef,
        authorizationEpoch: 7,
      },
      offer: {
        offerId: "premium_images_8_medium_v1",
        offerVersion: 1,
        amount: { currency: "EUR", value: "4.99", minor: 499 },
        creditCount: 8,
        creditUnit: "premium_image",
        imageQuality: "medium",
        validity: { expires: false, expiresAfterDays: null },
        paymentTerms: {
          kind: "one_time",
          automaticRenewal: false,
          mandateRequired: false,
          automaticTopUp: false,
          overageAllowed: false,
        },
        refundPolicyId: "premium_image_credit_refund",
        refundPolicyVersion: 1,
        description: "Leaderbot - 8 premium beeldcredits",
      },
    });
    expect(result.paymentMetadataSnapshot.offer.amount.minor).toBe(
      Number(result.paymentMetadataSnapshot.offer.amount.value) * 100
    );
    expect(result.metadataHash).toBe(
      createHash("sha256")
        .update(JSON.stringify(result.paymentMetadataSnapshot), "utf8")
        .digest("hex")
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.paymentMetadataSnapshot)).toBe(true);
    expect(Object.isFrozen(result.paymentMetadataSnapshot.tenant)).toBe(true);
    expect(Object.isFrozen(result.paymentMetadataSnapshot.offer)).toBe(true);
    expect(
      Object.isFrozen(result.paymentMetadataSnapshot.offer.paymentTerms)
    ).toBe(true);
    expect(result.paymentMetadataSnapshot.offer).toMatchObject({
      refundPolicyId: "premium_image_credit_refund",
      refundPolicyVersion: 1,
    });
  });

  it("keeps secret, user, request hash and raw capability out of JSON", () => {
    const checkoutInput = input();
    const result = deriveCreditCheckoutIdentity(checkoutInput);
    const rawCapability = result.checkoutCapability.toUrlFragment();
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("s".repeat(32));
    expect(serialized).not.toContain(USER_KEY);
    expect(serialized).not.toContain(REQUEST_KEY_HASH);
    expect(serialized).not.toContain(rawCapability);
    expect(serialized).toContain(result.metadataHash);
    expect(serialized).toContain(result.checkoutCapability.capabilityHash);
    expect(Object.keys(JSON.parse(serialized) as object)).not.toContain(
      "checkoutCapability"
    );
  });

  it("rejects cloned or altered offer objects instead of trusting browser fields", () => {
    const exactClone = {
      ...OFFER,
      amount: { ...OFFER.amount },
      providerPolicy: { ...OFFER.providerPolicy },
      validity: { ...OFFER.validity },
      paymentTerms: { ...OFFER.paymentTerms },
    } as CreditOffer;
    const alteredAmount = {
      ...exactClone,
      amountMinor: 1,
      amount: { currency: "EUR", value: "0.01" },
    } as unknown as CreditOffer;
    const alteredRefundPolicy = {
      ...exactClone,
      refundPolicyVersion: 2,
    } as unknown as CreditOffer;

    for (const offer of [exactClone, alteredAmount, alteredRefundPolicy]) {
      expect(() => deriveCreditCheckoutIdentity(input({ offer }))).toThrowError(
        expect.objectContaining({
          name: "CreditCheckoutIdentityError",
          code: "invalid_offer",
        })
      );
    }
  });

  it.each([
    {
      name: "null input",
      value: null,
      code: "invalid_input",
    },
    {
      name: "short secret",
      value: input({ dedicatedSecret: Buffer.alloc(31) }),
      code: "invalid_secret",
    },
    {
      name: "text secret",
      value: input({ dedicatedSecret: "x".repeat(32) as never }),
      code: "invalid_secret",
    },
    {
      name: "zero workspace",
      value: input({ scope: { ...input().scope, workspaceId: 0 } }),
      code: "invalid_scope",
    },
    {
      name: "fractional binding epoch",
      value: input({ scope: { ...input().scope, bindingEpoch: 1.5 } }),
      code: "invalid_scope",
    },
    {
      name: "wrong channel",
      value: input({
        scope: { ...input().scope, channel: "whatsapp" as never },
      }),
      code: "invalid_scope",
    },
    {
      name: "wrong mode",
      value: input({ scope: { ...input().scope, mode: "preview" as never } }),
      code: "invalid_scope",
    },
    {
      name: "noncanonical user key",
      value: input({
        scope: { ...input().scope, userKey: `u2.k0.${"A".repeat(64)}` },
      }),
      code: "invalid_scope",
    },
    {
      name: "uppercase legacy user key",
      value: input({
        scope: { ...input().scope, userKey: "A".repeat(64) },
      }),
      code: "invalid_scope",
    },
    {
      name: "raw Messenger identifier",
      value: input({
        scope: { ...input().scope, userKey: "1234567890123456" },
      }),
      code: "invalid_scope",
    },
    {
      name: "zero authorization epoch",
      value: input({ expectedAuthorizationEpoch: 0 }),
      code: "invalid_authorization_epoch",
    },
    {
      name: "uppercase request hash",
      value: input({ requestKeyHash: REQUEST_KEY_HASH.toUpperCase() }),
      code: "invalid_request_key_hash",
    },
    {
      name: "short request hash",
      value: input({ requestKeyHash: "0".repeat(63) }),
      code: "invalid_request_key_hash",
    },
  ])("rejects $name before deriving identity", ({ value, code }) => {
    let thrown: unknown;
    try {
      deriveCreditCheckoutIdentity(value as CreditCheckoutIdentityInput);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CreditCheckoutIdentityError);
    expect((thrown as CreditCheckoutIdentityError).code).toBe(code);
  });
});
