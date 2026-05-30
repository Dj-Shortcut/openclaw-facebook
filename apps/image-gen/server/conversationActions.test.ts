import { describe, expect, it } from "vitest";
import {
  buildQuickStartResponse,
  buildGenerationFailureResponse,
  buildGenerationSuccessResponse,
} from "./_core/conversationActions";
import { renderMessengerQuickReplies } from "./_core/messengerActionRenderer";

describe("conversation actions", () => {
  it("builds quick-start choices as channel-neutral conversation actions", () => {
    expect(buildQuickStartResponse("nl")).toEqual({
      text: "Beschrijf wat je wilt maken, of stuur een foto als je die wilt bewerken.",
      actions: [
        { id: "WHAT_IS_THIS", label: "Wat doe ik?" },
        { id: "PRIVACY_INFO", label: "Privacy" },
      ],
    });
  });

  it("builds image-generation success follow-up actions without Messenger payload shape", () => {
    expect(buildGenerationSuccessResponse("en")).toEqual({
      text: "Done ✅",
      actions: [{ id: "PRIVACY_INFO", label: "Privacy" }],
    });
  });

  it("renders neutral actions as Messenger quick replies at the channel edge", () => {
    expect(
      renderMessengerQuickReplies([{ id: "PRIVACY_INFO", label: "Privacy" }])
    ).toEqual([
      {
        content_type: "text",
        title: "Privacy",
        payload: "PRIVACY_INFO",
      },
    ]);
  });

  it("builds generation failure actions before Messenger rendering", () => {
    expect(buildGenerationFailureResponse("en", "Try again?", "RETRY_STYLE_gold")).toEqual({
      text: "Try again?",
      actions: [
        { id: "RETRY_STYLE_gold", label: "Retry" },
        { id: "CHOOSE_STYLE", label: "Another" },
      ],
    });
  });
});
