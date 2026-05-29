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
    selectedStyle: null,
    chosenStyle: null,
    selectedStyleCategory: null,
    preselectedStyle: null,
    preferredLang: "nl",
    hasSeenIntro: false,
    lastGeneratedUrl: null,
    quota: {
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
        kind: "text",
        text: t("nl", "flowExplanation"),
      },
      replyState: "IDLE",
      afterSend: "markIntroSeen",
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

  it("returns the style picker response metadata when a photo is already present", async () => {
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

    expect(setFlowState).toHaveBeenCalledWith("AWAITING_STYLE");
    expect(result).toEqual({
      response: { kind: "text", text: t("en", "styleCategoryPicker") },
      replyState: "AWAITING_STYLE",
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

    expect(setFlowState).toHaveBeenCalledWith("AWAITING_PHOTO");
    expect(result).toEqual({
      response: {
        kind: "text",
        text: t("en", "textWithoutPhoto"),
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps free text with an existing photo on fixed style guidance", async () => {
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
          stage: "AWAITING_STYLE",
          state: "AWAITING_STYLE",
          hasSeenIntro: true,
          lastPhotoUrl: "https://img.example/input.jpg",
          lastPhoto: "https://img.example/input.jpg",
        }),
      setFlowState: async () => {},
    });

    expect(result).toEqual({
      response: {
        kind: "text",
        text: t("nl", "flowExplanation"),
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
