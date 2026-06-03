import { describe, expect, it } from "vitest";
import { t } from "./_core/i18n";
import { getGreetingResponse } from "./_core/webhookHelpers";

describe("greeting handling by conversation state", () => {
  it("returns processing text while PROCESSING", () => {
    expect(getGreetingResponse("PROCESSING")).toEqual({
      mode: "text",
      text: t("nl", "processingBlocked"),
    });
  });

  it("returns plain photo prompt while AWAITING_PHOTO", () => {
    expect(getGreetingResponse("AWAITING_PHOTO")).toEqual({
      mode: "text",
      text: t("nl", "textWithoutPhoto"),
    });
  });

  it("returns photo edit prompt while AWAITING_EDIT_PROMPT", () => {
    expect(getGreetingResponse("AWAITING_EDIT_PROMPT")).toEqual({
      mode: "text",
      text: t("nl", "editImagePrompt"),
    });
  });

  it("returns follow-up options while RESULT_READY", () => {
    expect(getGreetingResponse("RESULT_READY")).toEqual({
      mode: "text",
      text: t("nl", "success"),
    });
  });

  it("returns recovery options while FAILURE", () => {
    expect(getGreetingResponse("FAILURE")).toEqual({
      mode: "text",
      text: t("nl", "failure"),
    });
  });

  it("returns quick start welcome only in IDLE", () => {
    expect(getGreetingResponse("IDLE")).toEqual({
      mode: "text",
      text: t("nl", "flowExplanation"),
    });
  });
});
