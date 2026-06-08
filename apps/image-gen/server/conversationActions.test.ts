import { afterEach, describe, expect, it } from "vitest";
import {
  buildAssistantPhotoHelpResponse,
  buildFaceMemoryConsentResponse,
  buildPhotoReceivedResponse,
  buildQuickStartResponse,
  buildGenerationFailureResponse,
  buildGenerationSuccessResponse,
  buildImageUploadFailureResponse,
} from "./_core/conversationActions";
import { renderMessengerQuickReplies } from "./_core/messengerActionRenderer";
import { decodeMessengerActionInput } from "./_core/messengerActionPayload";

describe("conversation actions", () => {
  const originalFaceMemoryRetentionDays = process.env.FACE_MEMORY_RETENTION_DAYS;

  afterEach(() => {
    if (originalFaceMemoryRetentionDays === undefined) {
      delete process.env.FACE_MEMORY_RETENTION_DAYS;
    } else {
      process.env.FACE_MEMORY_RETENTION_DAYS = originalFaceMemoryRetentionDays;
    }
  });

  it("builds quick-start choices as channel-neutral conversation actions", () => {
    expect(buildQuickStartResponse("nl")).toEqual({
      text: "Beschrijf wat je wilt maken, of stuur een foto als je die wilt bewerken.",
      actions: [
        { id: "new_image", label: "Nieuwe afbeelding", inputText: "new_image" },
        { id: "edit_photo", label: "Pas foto aan", inputText: "Pas foto aan" },
        { id: "privacy", label: "Privacy", inputText: "Privacy" },
      ],
    });
  });

  it("builds image-generation success follow-up actions without Messenger payload shape", () => {
    expect(buildGenerationSuccessResponse("en")).toEqual({
      text: "Done.",
      actions: [
        { id: "new_image", label: "New image", inputText: "new_image" },
        { id: "edit_photo", label: "Edit image", inputText: "Edit image" },
        {
          id: "change_background",
          label: "Different background",
          inputText: "change_background",
        },
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
        {
          id: "change_background",
          label: "Andere achtergrond",
          inputText: "change_background",
        },
        { id: "new_image", label: "Nieuwe afbeelding", inputText: "new_image" },
        { id: "privacy", label: "Privacy", inputText: "Privacy" },
      ],
    });
  });

  it("builds photo-received choices without legacy style picker actions", () => {
    expect(buildPhotoReceivedResponse("nl")).toEqual({
      text: "Foto ontvangen. Beschrijf wat je aan de foto wilt aanpassen.",
      actions: [
        { id: "edit_photo", label: "Pas aan", inputText: "Pas aan" },
        {
          id: "change_background",
          label: "Andere achtergrond",
          inputText: "change_background",
        },
        { id: "privacy", label: "Privacy", inputText: "Privacy" },
      ],
    });
  });

  it("renders action input as a Messenger payload that can become normal text again", () => {
    const [reply] = renderMessengerQuickReplies([
      { id: "new_image", label: "New image", inputText: "new_image" },
    ]);

    expect(reply).toEqual({
      content_type: "text",
      title: "New image",
      payload: "OPENCLAW_ACTION:new_image",
    });
    expect(decodeMessengerActionInput(reply?.payload)).toBe("new_image");
  });

  it("renders background UI intent with a stable Messenger payload", () => {
    const [reply] = renderMessengerQuickReplies([
      {
        id: "change_background",
        label: "Andere achtergrond",
        inputText: "change_background",
      },
    ]);

    expect(reply).toEqual({
      content_type: "text",
      title: "Andere achtergrond",
      payload: "OPENCLAW_ACTION:change_background",
    });
    expect(decodeMessengerActionInput(reply?.payload)).toBe("change_background");
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
        { id: "new_image", label: "New image", inputText: "new_image" },
      ],
    });
  });

  it("builds unreadable-photo recovery with only valid next actions", () => {
    expect(buildImageUploadFailureResponse("nl", false)).toEqual({
      text: expect.stringContaining("fotoknop of camera in Messenger"),
      actions: [
        { id: "new_image", label: "Nieuwe afbeelding", inputText: "new_image" },
      ],
    });

    expect(buildImageUploadFailureResponse("nl", true)).toEqual({
      text: expect.stringContaining("huidige afbeelding"),
      actions: [
        {
          id: "change_background",
          label: "Andere achtergrond",
          inputText: "change_background",
        },
        { id: "new_image", label: "Nieuwe afbeelding", inputText: "new_image" },
      ],
    });
  });

  it("uses the configured face-memory retention window in consent actions", () => {
    process.env.FACE_MEMORY_RETENTION_DAYS = "7";

    expect(buildFaceMemoryConsentResponse("en")).toMatchObject({
      text: expect.stringContaining("for 7 days"),
      actions: [
        { id: "CONSENT_FACE_YES", label: "Yes, 7 days" },
        { id: "CONSENT_FACE_NO", label: "No" },
      ],
    });
    expect(buildFaceMemoryConsentResponse("nl")).toMatchObject({
      text: expect.stringContaining("7 dagen bewaren"),
      actions: [
        { id: "CONSENT_FACE_YES", label: "Ja, 7 dagen" },
        { id: "CONSENT_FACE_NO", label: "Nee" },
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
        payload: "OPENCLAW_ACTION:new_image",
      },
    ]);
  });
});
