import { describe, expect, it } from "vitest";
import {
  buildQuickStartResponse,
  buildGenerationFailureResponse,
  buildGenerationSuccessResponse,
} from "./_core/conversationActions";
import { renderMessengerQuickReplies } from "./_core/messengerActionRenderer";
import { decodeMessengerActionInput } from "./_core/messengerActionPayload";

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
      actions: [
        { id: "NEW_IMAGE", label: "New image", inputText: "New image" },
        { id: "PRIVACY_INFO", label: "Privacy" },
      ],
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

  it("renders action input as a Messenger payload that can become normal text again", () => {
    const [reply] = renderMessengerQuickReplies([
      { id: "NEW_IMAGE", label: "New image", inputText: "New image" },
    ]);

    expect(reply).toEqual({
      content_type: "text",
      title: "New image",
      payload: "OPENCLAW_ACTION:New%20image",
    });
    expect(decodeMessengerActionInput(reply?.payload)).toBe("New image");
  });

  it("builds generation failure actions before Messenger rendering", () => {
    expect(buildGenerationFailureResponse("en", "Try again?", "gold")).toEqual({
      text: "Try again?",
      actions: [
        { id: "RETRY_GENERATION", label: "Retry", data: { retryStyle: "gold" } },
        { id: "NEW_IMAGE", label: "New image", inputText: "New image" },
      ],
    });
  });

  it("renders retry actions to legacy Messenger payloads at the channel edge", () => {
    expect(
      renderMessengerQuickReplies([
        { id: "RETRY_GENERATION", label: "Retry", data: { retryStyle: "gold" } },
      ])
    ).toEqual([
      {
        content_type: "text",
        title: "Retry",
        payload: "RETRY_STYLE_gold",
      },
    ]);
  });
});
