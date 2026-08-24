import { describe, expect, it } from "vitest";

import { assertMollieBillingDrainLifecycleState } from "./billingDrainLifecycle";

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
