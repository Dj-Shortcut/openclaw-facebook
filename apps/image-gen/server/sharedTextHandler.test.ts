import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { safeLogMock } = vi.hoisted(() => ({
  safeLogMock: vi.fn(),
}));

vi.mock("./_core/messengerApi", () => ({
  safeLog: safeLogMock,
}));

import { t } from "./_core/i18n";
import { handleSharedTextMessage } from "./_core/sharedTextHandler";
import type { MessengerUserState } from "./_core/messengerState";

function createState(
  overrides: Partial<MessengerUserState> = {}
): MessengerUserState {
  return {
    psid: "psid-1",
    userKey: "user-key-1",
    stage: "IDLE",
    state: "IDLE",
    lastPhotoUrl: null,
    lastPhoto: null,
    preferredLang: "nl",
    hasSeenIntro: false,
    lastGeneratedUrl: null,
    quota: {
      dayKey: "2026-03-20",
      count: 0,
    },
    imageGenerationQuotaReservation: null,
    videoGenerationQuota: {
      dayKey: "2026-03-20",
      count: 0,
    },
    videoGenerationQuotaReservation: null,
    transcriptionQuota: {
      dayKey: "2026-03-20",
      count: 0,
    },
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("sharedTextHandler", () => {
  beforeEach(() => {
    safeLogMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns intro response metadata for a new greeting", async () => {
    const result = await handleSharedTextMessage({
      message: {
        channel: "messenger",
        senderId: "psid-1",
        userId: "user-key-1",
        messageType: "text",
        textBody: "Hi",
      },
      reqId: "req-1",
      lang: "nl",
      getState: async () => createState(),
      setFlowState: async () => {},
    });

    expect(result).toEqual({
      response: {
        text: t("nl", "flowExplanation"),
        actions: [
          { id: "new_image", label: "Nieuwe afbeelding", inputText: "new_image" },
          { id: "edit_photo", label: "Pas foto aan", inputText: "Pas foto aan" },
          { id: "privacy", label: "Privacy", inputText: "Privacy" },
        ],
      },
      afterSend: "markIntroSeen",
    });
  });

  it("keeps intro guidance prompt-first instead of style-catalog-first", () => {
    expect(t("nl", "flowExplanation")).toContain("Beschrijf wat je wilt maken");
    expect(t("nl", "flowExplanation")).not.toContain("andere stijl");
    expect(t("en", "textWithoutPhoto")).toContain("Describe the image you want");
    expect(t("en", "textWithoutPhoto")).not.toContain("make a style");
  });

  it("returns prompt-first quick start actions for repeat IDLE greetings", async () => {
    const result = await handleSharedTextMessage({
      message: {
        channel: "messenger",
        senderId: "psid-repeat",
        userId: "user-key-repeat",
        messageType: "text",
        textBody: "Hi",
      },
      reqId: "req-repeat",
      lang: "nl",
      getState: async () =>
        createState({
          psid: "psid-repeat",
          userKey: "user-key-repeat",
          hasSeenIntro: true,
        }),
      setFlowState: async () => {},
    });

    expect(result).toEqual({
      response: {
        text: t("nl", "flowExplanation"),
        actions: [
          { id: "new_image", label: "Nieuwe afbeelding", inputText: "new_image" },
          { id: "edit_photo", label: "Pas foto aan", inputText: "Pas foto aan" },
          { id: "privacy", label: "Privacy", inputText: "Privacy" },
        ],
      },
    });
  });

  it("does not offer image-edit actions for stale result state without an image", async () => {
    const result = await handleSharedTextMessage({
      message: {
        channel: "messenger",
        senderId: "psid-result",
        userId: "user-key-result",
        messageType: "text",
        textBody: "Hey",
      },
      reqId: "req-result",
      lang: "nl",
      getState: async () =>
        createState({
          psid: "psid-result",
          userKey: "user-key-result",
          stage: "RESULT_READY",
          state: "RESULT_READY",
          hasSeenIntro: true,
        }),
      setFlowState: async () => {},
    });

    expect(result).toEqual({
      response: {
        text: t("nl", "flowExplanation"),
        actions: [
          { id: "new_image", label: "Nieuwe afbeelding", inputText: "new_image" },
          { id: "edit_photo", label: "Pas foto aan", inputText: "Pas foto aan" },
          { id: "privacy", label: "Privacy", inputText: "Privacy" },
        ],
      },
    });
  });

  it("returns result follow-up edit choices only when a current image exists", async () => {
    const result = await handleSharedTextMessage({
      message: {
        channel: "messenger",
        senderId: "psid-result-image",
        userId: "user-key-result-image",
        messageType: "text",
        textBody: "Hey",
      },
      reqId: "req-result-image",
      lang: "nl",
      getState: async () =>
        createState({
          psid: "psid-result-image",
          userKey: "user-key-result-image",
          stage: "RESULT_READY",
          state: "RESULT_READY",
          hasSeenIntro: true,
          lastGeneratedUrl: "https://img.example/result.jpg",
        }),
      setFlowState: async () => {},
    });

    expect(result).toEqual({
      response: {
        text: t("nl", "success"),
        actions: [
          { id: "new_image", label: "Nieuwe afbeelding", inputText: "new_image" },
          { id: "edit_photo", label: "Pas aan", inputText: "Pas aan" },
          {
            id: "change_background",
            label: "Andere achtergrond",
            inputText: "change_background",
          },
          { id: "privacy", label: "Privacy", inputText: "Privacy" },
        ],
      },
    });
  });

  it("treats a generated image as editable context for help commands", async () => {
    const runTextFeatures = vi.fn(async () => true);

    const result = await handleSharedTextMessage({
      message: {
        channel: "messenger",
        senderId: "psid-generated-help",
        userId: "user-key-generated-help",
        messageType: "text",
        textBody: "help",
      },
      reqId: "req-generated-help",
      lang: "nl",
      getState: async () =>
        createState({
          psid: "psid-generated-help",
          userKey: "user-key-generated-help",
          lastGeneratedUrl: "https://img.example/generated.jpg",
          hasSeenIntro: true,
        }),
      setFlowState: async () => {},
      runTextFeatures,
    });

    expect(result).toEqual({ response: null });
    expect(runTextFeatures).toHaveBeenCalledWith({
      state: expect.objectContaining({
        lastGeneratedUrl: "https://img.example/generated.jpg",
      }),
      messageText: "help",
      normalizedText: "help",
      hasPhoto: true,
    });
  });

  it("returns in-progress greeting copy as a channel-neutral response", async () => {
    const result = await handleSharedTextMessage({
      message: {
        channel: "messenger",
        senderId: "psid-processing",
        userId: "user-key-processing",
        messageType: "text",
        textBody: "Hello",
      },
      reqId: "req-processing",
      lang: "nl",
      getState: async () =>
        createState({
          psid: "psid-processing",
          userKey: "user-key-processing",
          stage: "PROCESSING",
          state: "PROCESSING",
          hasSeenIntro: true,
        }),
      setFlowState: async () => {},
    });

    expect(result).toEqual({
      response: { text: t("nl", "processingBlocked") },
      replyState: "PROCESSING",
    });
  });

  it("returns failure follow-up choices as conversation actions", async () => {
    const result = await handleSharedTextMessage({
      message: {
        channel: "messenger",
        senderId: "psid-failure",
        userId: "user-key-failure",
        messageType: "text",
        textBody: "Hey",
      },
      reqId: "req-failure",
      lang: "nl",
      getState: async () =>
        createState({
          psid: "psid-failure",
          userKey: "user-key-failure",
          stage: "FAILURE",
          state: "FAILURE",
          hasSeenIntro: true,
        }),
      setFlowState: async () => {},
    });

    expect(result).toEqual({
      response: {
        text: t("nl", "failure"),
        actions: [
          {
            id: "new_image",
            label: "Nieuwe afbeelding",
            inputText: "new_image",
          },
        ],
      },
    });
  });

  it("returns no response for acknowledgement text and logs the ignored ack", async () => {
    const logAckIgnored = vi.fn();

    const result = await handleSharedTextMessage({
      message: {
        channel: "messenger",
        senderId: "psid-1",
        userId: "user-key-1",
        messageType: "text",
        textBody: "ok",
      },
      reqId: "req-ack",
      lang: "nl",
      getState: async () => createState(),
      setFlowState: async () => {},
      logAckIgnored,
    });

    expect(result).toEqual({ response: null });
    expect(logAckIgnored).toHaveBeenCalledWith("ok");
  });

  it("treats old English style shortcut text as ordinary text", async () => {
    const setFlowState = vi.fn(async () => {});

    const result = await handleSharedTextMessage({
      message: {
        channel: "whatsapp",
        senderId: "wa-user",
        userId: "wa-user-key",
        messageType: "text",
        textBody: "new style",
      },
      reqId: "req-style",
      lang: "en",
      getState: async () =>
        createState({
          psid: "wa-user",
          userKey: "wa-user-key",
          lastPhotoUrl: "https://img.example/photo.jpg",
          lastPhoto: "https://img.example/photo.jpg",
        }),
      setFlowState,
    });

    expect(setFlowState).not.toHaveBeenCalled();
    expect(result).toEqual({
      response: {
        text: t("en", "assistantQuickActions"),
        actions: [
          { id: "edit_photo", label: "Edit image", inputText: "Edit image" },
          {
            id: "change_background",
            label: "Different background",
            inputText: "change_background",
          },
          { id: "new_image", label: "New image", inputText: "new_image" },
          { id: "privacy", label: "Privacy", inputText: "Privacy" },
        ],
      },
    });
  });

  it("treats old Dutch style shortcut text as ordinary text", async () => {
    const setFlowState = vi.fn(async () => {});

    const result = await handleSharedTextMessage({
      message: {
        channel: "whatsapp",
        senderId: "wa-user-nl",
        userId: "wa-user-key-nl",
        messageType: "text",
        textBody: "nieuwe stijl",
      },
      reqId: "req-style-nl",
      lang: "nl",
      getState: async () =>
        createState({
          psid: "wa-user-nl",
          userKey: "wa-user-key-nl",
          lastPhotoUrl: "https://img.example/input.jpg",
          lastPhoto: "https://img.example/input.jpg",
        }),
      setFlowState,
    });

    expect(setFlowState).not.toHaveBeenCalled();
    expect(result).toEqual({
      response: {
        text: t("nl", "assistantQuickActions"),
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
      },
    });
  });

  it("keeps free text deterministic without calling OpenAI text APIs", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const setFlowState = vi.fn(async () => {});

    const result = await handleSharedTextMessage({
      message: {
        channel: "messenger",
        senderId: "psid-2",
        userId: "user-key-2",
        messageType: "text",
        textBody: "Can you help me?",
      },
      reqId: "req-deterministic",
      lang: "en",
      getState: async () =>
        createState({
          psid: "psid-2",
          userKey: "user-key-2",
          hasSeenIntro: true,
        }),
      setFlowState,
    });

    expect(setFlowState).not.toHaveBeenCalled();
    expect(result).toEqual({
      response: {
        text: t("en", "flowExplanation"),
        actions: [
          { id: "new_image", label: "New image", inputText: "new_image" },
          { id: "edit_photo", label: "Edit photo", inputText: "Edit photo" },
          { id: "privacy", label: "Privacy", inputText: "Privacy" },
        ],
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  const videoAnimationRecoveryCases: Array<{ text: string; expected: string }> = [
    {
      text: "laat hem dansen",
      expected: t("nl", "unsupportedVideoOrAnimation"),
    },
    {
      text: "laat hem zingen",
      expected: t("nl", "unsupportedVideoOrAnimation"),
    },
    {
      text: "laat hem bewegen",
      expected: t("nl", "unsupportedVideoOrAnimation"),
    },
    {
      text: "bewegen zoals Bruno",
      expected: t("nl", "unsupportedVideoOrAnimation"),
    },
    {
      text: "let him dance",
      expected: t("nl", "unsupportedVideoOrAnimation"),
    },
    {
      text: "let him sing",
      expected: t("nl", "unsupportedVideoOrAnimation"),
    },
    {
      text: "move like Bruno",
      expected: t("nl", "unsupportedVideoOrAnimation"),
    },
  ];

  it.each(videoAnimationRecoveryCases)(
    "returns video-animation intent guidance for \"$text\"",
    async ({ text, expected }) => {
      const result = await handleSharedTextMessage({
        message: {
          channel: "messenger",
          senderId: "psid-video-anim",
          userId: "user-key-video-anim",
          messageType: "text",
          textBody: text,
        },
        reqId: "req-video-anim",
        lang: "nl",
        getState: async () =>
          createState({
            psid: "psid-video-anim",
            userKey: "user-key-video-anim",
          }),
        setFlowState: async () => {},
      });

      expect(result).toEqual({ response: { text: expected } });
    }
  );

  it("returns contextual actions for free text with an existing image", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await handleSharedTextMessage({
      message: {
        channel: "messenger",
        senderId: "psid-3",
        userId: "user-key-3",
        messageType: "text",
        textBody: "Wat kan ik nu doen?",
      },
      reqId: "req-has-photo",
      lang: "nl",
      getState: async () =>
        createState({
          psid: "psid-3",
          userKey: "user-key-3",
          stage: "AWAITING_EDIT_PROMPT",
          state: "AWAITING_EDIT_PROMPT",
          hasSeenIntro: true,
          lastPhotoUrl: "https://img.example/input.jpg",
          lastPhoto: "https://img.example/input.jpg",
        }),
      setFlowState: async () => {},
    });

    expect(result).toEqual({
      response: {
        text: t("nl", "assistantQuickActions"),
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
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats emoji-only messages as normal text", async () => {
    const result = await handleSharedTextMessage({
      message: {
        channel: "messenger",
        senderId: "psid-emoji-only",
        userId: "user-key-emoji-only",
        messageType: "text",
        textBody: "\u2764\uFE0F",
      },
      reqId: "req-emoji-only",
      lang: "nl",
      getState: async () =>
        createState({
          psid: "psid-emoji-only",
          userKey: "user-key-emoji-only",
          hasSeenIntro: true,
        }),
      setFlowState: async () => {},
    });

    expect(result).toEqual({
      response: {
        text: t("nl", "flowExplanation"),
        actions: [
          { id: "new_image", label: "Nieuwe afbeelding", inputText: "new_image" },
          { id: "edit_photo", label: "Pas foto aan", inputText: "Pas foto aan" },
          { id: "privacy", label: "Privacy", inputText: "Privacy" },
        ],
      },
    });
  });

  it("treats text with emoji as normal text", async () => {
    const result = await handleSharedTextMessage({
      message: {
        channel: "messenger",
        senderId: "psid-text-emoji",
        userId: "user-key-text-emoji",
        messageType: "text",
        textBody: "maak deze cyberpunk \ud83d\udca1",
      },
      reqId: "req-text-emoji",
      lang: "nl",
      getState: async () =>
        createState({
          psid: "psid-text-emoji",
          userKey: "user-key-text-emoji",
          hasSeenIntro: true,
        }),
      setFlowState: async () => {},
    });

    expect(result).toEqual({
      response: {
        text: t("nl", "flowExplanation"),
        actions: [
          { id: "new_image", label: "Nieuwe afbeelding", inputText: "new_image" },
          { id: "edit_photo", label: "Pas foto aan", inputText: "Pas foto aan" },
          { id: "privacy", label: "Privacy", inputText: "Privacy" },
        ],
      },
    });
  });

  it("treats multi-codepoint emoji as normal text", async () => {
    const multiCodepointEmoji = "\ud83d\udc69\u200d\ud83d\udc68\u200d\ud83d\udc67\ud83c\udffb";
    const result = await handleSharedTextMessage({
      message: {
        channel: "messenger",
        senderId: "psid-multi-emoji",
        userId: "user-key-multi-emoji",
        messageType: "text",
        textBody: multiCodepointEmoji,
      },
      reqId: "req-multi-emoji",
      lang: "nl",
      getState: async () =>
        createState({
          psid: "psid-multi-emoji",
          userKey: "user-key-multi-emoji",
          hasSeenIntro: true,
        }),
      setFlowState: async () => {},
    });

    expect(result).toEqual({
      response: {
        text: t("nl", "flowExplanation"),
        actions: [
          { id: "new_image", label: "Nieuwe afbeelding", inputText: "new_image" },
          { id: "edit_photo", label: "Pas foto aan", inputText: "Pas foto aan" },
          { id: "privacy", label: "Privacy", inputText: "Privacy" },
        ],
      },
    });
  });
  it("treats flag emoji as normal text", async () => {
    const result = await handleSharedTextMessage({
      message: {
        channel: "messenger",
        senderId: "psid-flag-emoji",
        userId: "user-key-flag-emoji",
        messageType: "text",
        textBody: "\ud83c\uddfa\ud83c\uddf8",
      },
      reqId: "req-flag-emoji",
      lang: "nl",
      getState: async () =>
        createState({
          psid: "psid-flag-emoji",
          userKey: "user-key-flag-emoji",
          hasSeenIntro: true,
        }),
      setFlowState: async () => {},
    });

    expect(result).toEqual({
      response: {
        text: t("nl", "flowExplanation"),
        actions: [
          { id: "new_image", label: "Nieuwe afbeelding", inputText: "new_image" },
          { id: "edit_photo", label: "Pas foto aan", inputText: "Pas foto aan" },
          { id: "privacy", label: "Privacy", inputText: "Privacy" },
        ],
      },
    });
  });
});
