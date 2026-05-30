import { describe, expect, it } from "vitest";
import { buildGenerationSuccessResponse } from "./_core/conversationActions";
import { renderMessengerQuickReplies } from "./_core/messengerActionRenderer";

describe("conversation actions", () => {
  it("builds image-generation success follow-up actions without Messenger payload shape", () => {
    expect(buildGenerationSuccessResponse("en")).toEqual({
      text: "Done ✅",
      actions: [
        { id: "CHOOSE_STYLE", label: "New style" },
        { id: "PRIVACY_INFO", label: "Privacy Policy" },
      ],
    });
  });

  it("renders neutral actions as Messenger quick replies at the channel edge", () => {
    expect(
      renderMessengerQuickReplies([
        { id: "CHOOSE_STYLE", label: "New style" },
        { id: "PRIVACY_INFO", label: "Privacy Policy" },
      ])
    ).toEqual([
      {
        content_type: "text",
        title: "New style",
        payload: "CHOOSE_STYLE",
      },
      {
        content_type: "text",
        title: "Privacy Policy",
        payload: "PRIVACY_INFO",
      },
    ]);
  });
});
