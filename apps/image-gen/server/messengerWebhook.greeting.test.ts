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

  it("returns style picker prompt while AWAITING_STYLE", () => {
    expect(getGreetingResponse("AWAITING_STYLE")).toEqual({
      mode: "quick_replies",
      state: "AWAITING_STYLE",
      text: t("nl", "styleCategoryPicker"),
    });
  });

  it("returns follow-up options while RESULT_READY", () => {
    expect(getGreetingResponse("RESULT_READY")).toEqual({
      mode: "quick_replies",
      state: "RESULT_READY",
      text: t("nl", "success"),
    });
  });

  it("returns recovery options while FAILURE", () => {
    expect(getGreetingResponse("FAILURE")).toEqual({
      mode: "quick_replies",
      state: "FAILURE",
      text: t("nl", "failure"),
    });
  });

  it("returns quick start welcome only in IDLE", () => {
    expect(getGreetingResponse("IDLE")).toEqual({
      mode: "quick_replies",
      state: "IDLE",
      text: t("nl", "flowExplanation"),
    });
  });
});
