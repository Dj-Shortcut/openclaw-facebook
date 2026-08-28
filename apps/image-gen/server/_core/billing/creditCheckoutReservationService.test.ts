import { describe, expect, it, vi } from "vitest";

import {
  CreditCheckoutReservationError,
  readCreditCheckoutAppBaseUrl,
  reserveMessengerCreditCheckout,
} from "./creditCheckoutReservationService";
import { deriveCreditWalletIdentity } from "./creditCheckoutIdentity";
import { deriveCreditCheckoutTestUserKeyHash } from "./creditCheckoutConfig";

const NOW = new Date("2026-08-28T12:00:00.000Z");
const INPUT = Object.freeze({
  workspaceId: 42,
  channelConnectionId: 8,
  bindingEpoch: 3,
  privacyEpoch: 5,
  userKey: "a".repeat(64),
  requestId: "messenger-generation-request-1",
});

function dependencies(
  override: Partial<Parameters<typeof reserveMessengerCreditCheckout>[1]> = {}
) {
  return {
    config: () => ({
      checkoutEnabled: true,
      paidCreditsEnabled: true,
      workspaceId: 42,
      mode: "test" as const,
      testPilotScope: {
        channelConnectionId: INPUT.channelConnectionId,
        bindingEpoch: INPUT.bindingEpoch,
        privacyEpoch: INPUT.privacyEpoch,
        userKeyHash: deriveCreditCheckoutTestUserKeyHash(INPUT.userKey),
      },
    }),
    readAuthorization: vi.fn(async () => ({ authorizationEpoch: 7 })),
    readWalletIdentity: vi.fn(async () => null),
    reserve: vi.fn(async input => ({
      result: "applied" as const,
      intentId: input.intentId,
      walletId: input.walletId,
    })),
    withKeyring: <T>(
      callback: (
        keys: readonly Readonly<{ keyId: string; secret: Uint8Array }>[]
      ) => T
    ) => callback([{ keyId: "k1", secret: Buffer.alloc(32, 9) }]),
    now: () => NOW,
    appBaseUrl: () => new URL("https://app.leaderbot.live"),
    ...override,
  };
}

describe("Messenger credit checkout reservation", () => {
  it("creates one exact, provider-silent €4.99 credit checkout action", async () => {
    const deps = dependencies();
    const result = await reserveMessengerCreditCheckout(INPUT, deps);

    expect(result.label).toBe("8 premiumcredits - € 4,99");
    expect(result.actionUrl).toMatch(
      /^https:\/\/app[.]leaderbot[.]live\/credits\/checkout\/[0-9a-f-]{36}#[A-Za-z0-9_-]{43}$/
    );
    expect(result.toJSON()).toEqual({
      intentId: result.intentId,
      capability: "redacted",
    });
    expect(JSON.stringify(result)).not.toContain("#");
    expect(JSON.stringify(result)).not.toContain(INPUT.userKey);
    expect(deps.readAuthorization).toHaveBeenCalledWith({
      workspaceId: 42,
      mode: "test",
    });
    expect(deps.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 42,
        mode: "test",
        channelConnectionId: 8,
        bindingEpoch: 3,
        privacyEpoch: 5,
        userKey: INPUT.userKey,
        authorizationEpoch: 7,
        offerSnapshotCode: "premium_images_8_medium_v1",
        expectedAmount: "4.99",
        creditCount: 8,
        description: "Leaderbot - 8 premium beeldcredits",
        capabilityHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        capabilityExpiresAt: new Date("2026-08-28T12:10:00.000Z"),
      })
    );
  });

  it("is deterministic for one durable Messenger request retry", async () => {
    const firstDeps = dependencies();
    const secondDeps = dependencies();
    const first = await reserveMessengerCreditCheckout(INPUT, firstDeps);
    const second = await reserveMessengerCreditCheckout(INPUT, secondDeps);
    expect(second.intentId).toBe(first.intentId);
    expect(second.actionUrl).toBe(first.actionUrl);
  });

  it("keeps an existing wallet on its retained key after rotation", async () => {
    const oldSecret = Buffer.alloc(32, 1);
    const newSecret = Buffer.alloc(32, 2);
    const scope = {
      workspaceId: INPUT.workspaceId,
      mode: "test" as const,
      channel: "facebook_messenger" as const,
      channelConnectionId: INPUT.channelConnectionId,
      bindingEpoch: INPUT.bindingEpoch,
      privacyEpoch: INPUT.privacyEpoch,
      userKey: INPUT.userKey,
    };
    const oldIdentity = deriveCreditWalletIdentity({
      dedicatedSecret: oldSecret,
      scope,
    });
    const newIdentity = deriveCreditWalletIdentity({
      dedicatedSecret: newSecret,
      scope,
    });
    const deps = dependencies({
      readWalletIdentity: vi.fn(async () => oldIdentity),
      withKeyring: callback =>
        callback([
          { keyId: "k2", secret: newSecret },
          { keyId: "k1", secret: oldSecret },
        ]),
    });

    await reserveMessengerCreditCheckout(INPUT, deps);

    expect(deps.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: oldIdentity.walletId,
        financialSubjectRef: oldIdentity.financialSubjectRef,
      })
    );
    expect(deps.reserve).not.toHaveBeenCalledWith(
      expect.objectContaining({ walletId: newIdentity.walletId })
    );
  });

  it("fails closed when an existing wallet key is no longer retained", async () => {
    const oldIdentity = deriveCreditWalletIdentity({
      dedicatedSecret: Buffer.alloc(32, 1),
      scope: {
        workspaceId: INPUT.workspaceId,
        mode: "test",
        channel: "facebook_messenger",
        channelConnectionId: INPUT.channelConnectionId,
        bindingEpoch: INPUT.bindingEpoch,
        privacyEpoch: INPUT.privacyEpoch,
        userKey: INPUT.userKey,
      },
    });
    const deps = dependencies({
      readWalletIdentity: vi.fn(async () => oldIdentity),
      withKeyring: callback =>
        callback([{ keyId: "k2", secret: Buffer.alloc(32, 2) }]),
    });

    await expect(reserveMessengerCreditCheckout(INPUT, deps)).rejects.toThrow(
      "Credit checkout keyring cannot resolve"
    );
    expect(deps.reserve).not.toHaveBeenCalled();
  });

  it("rejects another Messenger user in the same workspace before any database write", async () => {
    const deps = dependencies();

    await expect(
      reserveMessengerCreditCheckout(
        { ...INPUT, userKey: "b".repeat(64) },
        deps
      )
    ).rejects.toBeInstanceOf(CreditCheckoutReservationError);

    expect(deps.readAuthorization).not.toHaveBeenCalled();
    expect(deps.readWalletIdentity).not.toHaveBeenCalled();
    expect(deps.reserve).not.toHaveBeenCalled();
  });

  it.each([
    [
      "checkout disabled",
      { checkoutEnabled: false, paidCreditsEnabled: true, workspaceId: 42 },
    ],
    [
      "paid credits disabled",
      { checkoutEnabled: true, paidCreditsEnabled: false, workspaceId: 42 },
    ],
    [
      "wrong pilot workspace",
      { checkoutEnabled: true, paidCreditsEnabled: true, workspaceId: 99 },
    ],
  ])("fails closed when %s", async (_label, partial) => {
    const deps = dependencies({
      config: () => ({
        ...partial,
        mode: "test" as const,
        testPilotScope: {
          channelConnectionId: INPUT.channelConnectionId,
          bindingEpoch: INPUT.bindingEpoch,
          privacyEpoch: INPUT.privacyEpoch,
          userKeyHash: deriveCreditCheckoutTestUserKeyHash(INPUT.userKey),
        },
      }),
    });
    await expect(
      reserveMessengerCreditCheckout(INPUT, deps)
    ).rejects.toBeInstanceOf(CreditCheckoutReservationError);
    expect(deps.readAuthorization).not.toHaveBeenCalled();
    expect(deps.reserve).not.toHaveBeenCalled();
  });

  it("fails closed when the execution control is disabled", async () => {
    const deps = dependencies({
      readAuthorization: vi.fn(async () => null),
    });
    await expect(
      reserveMessengerCreditCheckout(INPUT, deps)
    ).rejects.toBeInstanceOf(CreditCheckoutReservationError);
    expect(deps.reserve).not.toHaveBeenCalled();
  });

  it.each([
    ["raw PSID", { userKey: "123456789" }],
    ["empty request", { requestId: "" }],
    ["invalid binding", { bindingEpoch: 0 }],
  ])("rejects %s before database access", async (_label, override) => {
    const deps = dependencies();
    await expect(
      reserveMessengerCreditCheckout({ ...INPUT, ...override }, deps)
    ).rejects.toBeInstanceOf(CreditCheckoutReservationError);
    expect(deps.readAuthorization).not.toHaveBeenCalled();
    expect(deps.reserve).not.toHaveBeenCalled();
  });
});

describe("credit checkout public base URL", () => {
  it("accepts an exact HTTPS origin", () => {
    expect(
      readCreditCheckoutAppBaseUrl({
        NODE_ENV: "production",
        APP_BASE_URL: "https://app.leaderbot.live/",
      }).toString()
    ).toBe("https://app.leaderbot.live/");
  });

  it.each([
    "http://app.leaderbot.live",
    "https://user@app.leaderbot.live",
    "https://app.leaderbot.live/path",
    "https://app.leaderbot.live/?token=x",
    "not-a-url",
  ])("rejects unsafe production URL %s", value => {
    expect(() =>
      readCreditCheckoutAppBaseUrl({
        NODE_ENV: "production",
        APP_BASE_URL: value,
      })
    ).toThrow(CreditCheckoutReservationError);
  });
});
