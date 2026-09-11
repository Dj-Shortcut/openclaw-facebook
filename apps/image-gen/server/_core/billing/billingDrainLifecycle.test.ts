import { describe, expect, it } from "vitest";

import {
  assertMollieBillingDrainLifecycleState,
  assertOwnerMessengerLegacyWorkState,
  OwnerMessengerLegacyBillingWorkError,
  type OwnerMessengerLegacyWorkState,
} from "./billingDrainLifecycle";

const NO_LEGACY_WORK: OwnerMessengerLegacyWorkState = {
  unresolvedProviderIntent: false,
  unresolvedProviderOperation: false,
  activeSubscription: false,
  retiredOutboxDelivery: false,
};

describe("Mollie provider-drain lifecycle", () => {
  it("refuses a restart that drops the drain after provider activity", () => {
    expect(() => assertMollieBillingDrainLifecycleState(true, false)).toThrow(
      "must remain true after provider transport or checkout exposure"
    );
  });

  it("allows commercial checkout to remain disabled while the drain stays on", () => {
    expect(() =>
      assertMollieBillingDrainLifecycleState(true, true)
    ).not.toThrow();
  });

  it("keeps a genuinely unused billing plane credential-free", () => {
    expect(() =>
      assertMollieBillingDrainLifecycleState(false, false)
    ).not.toThrow();
  });
});

describe("owner-operated Messenger billing runtime", () => {
  it.each([
    "unresolvedProviderIntent",
    "unresolvedProviderOperation",
    "activeSubscription",
    "retiredOutboxDelivery",
  ] as const)("fails closed while %s remains executable", workKind => {
    expect(() =>
      assertOwnerMessengerLegacyWorkState({
        ...NO_LEGACY_WORK,
        [workKind]: true,
      })
    ).toThrow(
      expect.objectContaining<Partial<OwnerMessengerLegacyBillingWorkError>>({
        name: "OwnerMessengerLegacyBillingWorkError",
        workKind,
      })
    );
  });

  it("allows retained terminal financial history after executable work is drained", () => {
    expect(() =>
      assertOwnerMessengerLegacyWorkState(NO_LEGACY_WORK)
    ).not.toThrow();
  });
});
