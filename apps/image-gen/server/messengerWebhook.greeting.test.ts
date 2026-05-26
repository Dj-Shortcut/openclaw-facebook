import { describe, expect, it } from "vitest";
import { getGreetingResponse } from "./_core/webhookHelpers";

describe("greeting handling by conversation state", () => {
  it("returns processing text while PROCESSING", () => {
    expect(getGreetingResponse("PROCESSING")).toEqual({
      mode: "text",
      text: "Even geduld — je vorige afbeelding is bijna klaar.",
    });
  });

  it("returns plain photo prompt while AWAITING_PHOTO", () => {
    expect(getGreetingResponse("AWAITING_PHOTO")).toEqual({
      mode: "text",
      text: "Stuur gerust een foto, dan kan ik een stijl voor je maken.",
    });
  });

  it("returns style picker prompt while AWAITING_STYLE", () => {
    expect(getGreetingResponse("AWAITING_STYLE")).toEqual({
      mode: "quick_replies",
      state: "AWAITING_STYLE",
      text: "Kies eerst een stijlgroep 👇",
    });
  });

  it("returns follow-up options while RESULT_READY", () => {
    expect(getGreetingResponse("RESULT_READY")).toEqual({
      mode: "quick_replies",
      state: "RESULT_READY",
      text: "Klaar ✅",
    });
  });

  it("returns recovery options while FAILURE", () => {
    expect(getGreetingResponse("FAILURE")).toEqual({
      mode: "quick_replies",
      state: "FAILURE",
      text: "Oeps. Probeer nog een stijl.",
    });
  });

  it("returns quick start welcome only in IDLE", () => {
    expect(getGreetingResponse("IDLE")).toEqual({
      mode: "quick_replies",
      state: "IDLE",
      text: "Stuur een foto en ik maak er een speciale versie van in een andere stijl — het is gratis.",
    });
  });
});
