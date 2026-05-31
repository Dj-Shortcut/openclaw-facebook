import { describe, expect, it } from "vitest";
import {
  buildAssistantPhotoHelpResponse,
  buildPhotoReceivedResponse,
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
        { id: "new_image", label: "Nieuwe afbeelding", inputText: "Nieuwe afbeelding" },
        { id: "edit_photo", label: "Pas foto aan", inputText: "Pas foto aan" },
        { id: "privacy", label: "Privacy", inputText: "Privacy" },
      ],
    });
  });

  it("builds image-generation success follow-up actions without Messenger payload shape", () => {
    expect(buildGenerationSuccessResponse("en")).toEqual({
      text: "Done.",
      actions: [
        { id: "new_image", label: "New image", inputText: "New image" },
        { id: "edit_photo", label: "Edit image", inputText: "Edit image" },
        { id: "privacy", label: "Privacy", inputText: "Privacy" },
      ],
    });
  });

  it("renders neutral actions as Messenger quick replies at the channel edge", () => {
    expect(
      renderMessengerQuickReplies([
        { id: "privacy", label: "Privacy", inputText: "Privacy" },
      ])
    ).toEqual([
      {
        content_type: "text",
        title: "Privacy",
        payload: "OPENCLAW_ACTION:Privacy",
      },
    ]);
  });

  it("builds photo-context help choices as concrete conversation actions", () => {
    expect(buildAssistantPhotoHelpResponse("nl")).toEqual({
      text: "Je afbeelding staat klaar. Wat wil je doen?",
      actions: [
        { id: "edit_photo", label: "Pas aan", inputText: "Pas aan" },
        { id: "new_image", label: "Nieuwe afbeelding", inputText: "Nieuwe afbeelding" },
        { id: "privacy", label: "Privacy", inputText: "Privacy" },
      ],
    });
  });

  it("builds photo-received choices without legacy style picker actions", () => {
    expect(buildPhotoReceivedResponse("nl")).toEqual({
      text: "Foto ontvangen. Wat wil je aanpassen?",
      actions: [
        { id: "edit_photo", label: "Pas aan", inputText: "Pas aan" },
        { id: "privacy", label: "Privacy", inputText: "Privacy" },
      ],
    });
  });

  it("renders action input as a Messenger payload that can become normal text again", () => {
    const [reply] = renderMessengerQuickReplies([
      { id: "new_image", label: "New image", inputText: "New image" },
    ]);

    expect(reply).toEqual({
      content_type: "text",
      title: "New image",
      payload: "OPENCLAW_ACTION:New%20image",
    });
    expect(decodeMessengerActionInput(reply?.payload)).toBe("New image");
  });

  it("renders id-only actions as normal text input using the action label", () => {
    const [reply] = renderMessengerQuickReplies([
      { id: "retry", label: "Try again" },
    ]);

    expect(reply).toEqual({
      content_type: "text",
      title: "Try again",
      payload: "OPENCLAW_ACTION:Try%20again",
    });
    expect(decodeMessengerActionInput(reply?.payload)).toBe("Try again");
  });

  it("preserves platform consent and deletion payload actions", () => {
    expect(
      renderMessengerQuickReplies([
        { id: "CONSENT_FACE_YES", label: "Yes" },
        { id: "GDPR_DELETE_CONFIRM", label: "Delete" },
      ])
    ).toEqual([
      {
        content_type: "text",
        title: "Yes",
        payload: "CONSENT_FACE_YES",
      },
      {
        content_type: "text",
        title: "Delete",
        payload: "GDPR_DELETE_CONFIRM",
      },
    ]);
  });

  it("builds generation failure actions before Messenger rendering", () => {
    expect(buildGenerationFailureResponse("en", "Try again?")).toEqual({
      text: "Try again?",
      actions: [
        { id: "new_image", label: "New image", inputText: "New image" },
      ],
    });
  });

  it("does not render legacy retry payloads from migrated failure actions", () => {
    expect(
      renderMessengerQuickReplies(
        buildGenerationFailureResponse("en", "Try again?").actions
      )
    ).toEqual([
      {
        content_type: "text",
        title: "New image",
        payload: "OPENCLAW_ACTION:New%20image",
      },
    ]);
  });
});
