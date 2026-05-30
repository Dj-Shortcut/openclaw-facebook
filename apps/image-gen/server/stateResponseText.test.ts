import { describe, expect, it } from "vitest";
import {
  buildStateResponseText,
  resolveStateReplyPayload,
} from "./_core/stateResponseText";

describe("stateResponseText", () => {
  it("does not offer state quick replies for migrated failure responses", () => {
    expect(buildStateResponseText("FAILURE", "Probeer opnieuw?", "nl")).toBe(
      "Probeer opnieuw?"
    );
  });

  it("does not resolve legacy failure selections after migration to actions", () => {
    expect(resolveStateReplyPayload("FAILURE", "1", "nl")).toBe(undefined);
    expect(resolveStateReplyPayload("FAILURE", "Privacybeleid", "nl")).toBe(
      undefined
    );
    expect(resolveStateReplyPayload("FAILURE", "Nieuwe stijl", "nl")).toBe(
      undefined
    );
  });
});
