import { describe, expect, it } from "vitest";
import {
  buildStateResponseText,
  resolveStateReplyPayload,
} from "./_core/stateResponseText";

describe("stateResponseText", () => {
  it("labels CHOOSE_STYLE as another style instead of the old new-style CTA", () => {
    expect(buildStateResponseText("FAILURE", "Probeer opnieuw?", "nl")).toBe(
      "Probeer opnieuw?\n\n1. Probeer opnieuw\n2. Andere"
    );
  });

  it("keeps legacy new-style text as a compatibility alias", () => {
    expect(resolveStateReplyPayload("FAILURE", "Nieuwe stijl", "nl")).toBe(
      "CHOOSE_STYLE"
    );
    expect(resolveStateReplyPayload("FAILURE", "Andere", "nl")).toBe(
      "CHOOSE_STYLE"
    );
  });
});
