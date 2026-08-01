import { describe, expect, it } from "vitest";
import { mandateMatchesCurrentSubscription } from "./outboxWorker";

describe("billing outbox containment safeguards", () => {
  it("preserves a unique provisioning remote when the valid mandate was not stored yet", () => {
    expect(
      mandateMatchesCurrentSubscription("mdt_valid123", null, true)
    ).toBe(true);
    expect(mandateMatchesCurrentSubscription(undefined, null, true)).toBe(
      false
    );
  });

  it("requires the exact stored mandate after provisioning", () => {
    expect(
      mandateMatchesCurrentSubscription("mdt_valid123", "mdt_valid123", false)
    ).toBe(true);
    expect(
      mandateMatchesCurrentSubscription("mdt_other123", "mdt_valid123", false)
    ).toBe(false);
  });
});
