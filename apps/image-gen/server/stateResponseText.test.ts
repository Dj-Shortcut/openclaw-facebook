import { describe, expect, it } from "vitest";
import {
  buildStateResponseText,
  resolveStateReplyPayload,
} from "./_core/stateResponseText";
import { classifyInboundEvent } from "./_core/messengerInboundClassification";

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

  it("still treats stale legacy quick-reply payload taps as known inbound payloads", () => {
    for (const payload of [
      "CHOOSE_STYLE",
      "WHAT_IS_THIS",
      "PRIVACY_INFO",
      "RETRY_STYLE",
      "RETRY_STYLE_gold",
    ]) {
      expect(
        classifyInboundEvent({
          sender: { id: "psid-1" },
          message: { quick_reply: { payload } },
        })
      ).toMatchObject({
        eventPayload: payload,
        isIntentionalSilentUnknownPayload: false,
      });
    }
  });
});
