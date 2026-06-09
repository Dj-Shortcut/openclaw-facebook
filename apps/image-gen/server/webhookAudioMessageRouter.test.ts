import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { safeLogMock, handleTextMessageMock, canGenerateMock } = vi.hoisted(() => ({
  safeLogMock: vi.fn(),
  handleTextMessageMock: vi.fn(async () => undefined),
  canGenerateMock: vi.fn(async () => true),
}));

vi.mock("./_core/messengerApi", () => ({
  safeLog: safeLogMock,
}));

vi.mock("./_core/webhookTextMessageRouter", () => ({
  handleTextMessage: handleTextMessageMock,
}));

vi.mock("./_core/image-generation/sourceImageFetcher", () => ({
  fetchExternalSourceImageForIngress: vi
    .fn()
    .mockResolvedValue({
      buffer: Buffer.from([1, 2, 3, 4]),
      contentType: "audio/mpeg",
      incomingLen: 4,
      incomingSha256: "stubhash",
      fbImageFetchMs: 12,
    }),
}));

vi.mock("./_core/messengerQuota", () => ({
  canGenerate: canGenerateMock,
}));

import type { HandlerContext } from "./_core/webhookHandlerTypes";
import { tryHandleAudioMessage } from "./_core/webhookAudioMessageRouter";
import { type FacebookWebhookEvent } from "./_core/webhookHelpers";
import { t } from "./_core/i18n";

type TestAttachment = Exclude<
  NonNullable<FacebookWebhookEvent["message"]>["attachments"],
  undefined
>[number];

function makeContext(): HandlerContext {
  return {
    defaultLang: "nl",
    claimEventReplayOrLog: vi.fn(async () => false),
    createFeatureImageContext: vi.fn(),
    createFeaturePayloadContext: vi.fn(),
    createFeatureTextContext: vi.fn(),
    debugWebhookLog: vi.fn(),
    getAttachmentHostname: vi.fn(() => "example.com"),
    logImageFlowDecision: vi.fn(),
    logIncomingMessage: vi.fn(),
    logUserState: vi.fn(),
    maybeSendInFlightMessage: vi.fn(async () => ({ handled: false })),
    runImageGeneration: vi.fn(async () => ({ sent: true, messageId: "msg-image" })),
    sendFaceMemoryConsentPrompt: vi.fn(async () => ({ sent: true, messageId: "msg-face" })),
    sendFlowExplanation: vi.fn(async () => ({ sent: true, messageId: "msg-flow" })),
    sendLoggedImage: vi.fn(async () => ({ sent: true, messageId: "msg-image-output" })),
    sendLoggedActions: vi.fn(async () => ({ sent: true, messageId: "msg-actions" })),
    sendLoggedText: vi.fn(async () => ({ sent: true, messageId: "msg-text" })),
    sendPhotoReceivedPrompt: vi.fn(async () => ({ sent: true, messageId: "msg-photo-prompt" })),
  };
}

describe("webhook audio message router", () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalPrivacyPepper = process.env.PRIVACY_PEPPER;

  beforeEach(() => {
    safeLogMock.mockClear();
    handleTextMessageMock.mockClear();
    process.env.PRIVACY_PEPPER = "test-pepper";
    process.env.OPENAI_API_KEY = "dummy-key";
    canGenerateMock.mockClear();
    canGenerateMock.mockResolvedValue(true);
  });

  afterEach(() => {
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
    if (originalPrivacyPepper === undefined) {
      delete process.env.PRIVACY_PEPPER;
    } else {
      process.env.PRIVACY_PEPPER = originalPrivacyPepper;
    }
    vi.unstubAllGlobals();
  });

  it("returns false for captioned audio and does not invoke transcription", async () => {
    const ctx = makeContext();

    const result = await tryHandleAudioMessage(ctx, {
      psid: "psid-1",
      userId: "user-1",
      reqId: "req-captioned-audio",
      lang: "nl",
      attachments: [
        { type: "audio", payload: { url: "https://audio.example/message.mp3" } },
      ],
      text: "maak deze cyberpunk",
    });

    expect(result).toBe(false);
    expect(handleTextMessageMock).not.toHaveBeenCalled();
  });

  it("transcribes audio and routes to text handler when text is absent", async () => {
    const ctx = makeContext();
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = typeof url === "string" ? url : url.toString();
      if (
        target ===
        "https://api.openai.com/v1/audio/transcriptions"
      ) {
        return {
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ text: "maak een foto van een cyberpunk stadslandschap" }),
        } as Response;
      }
      return {
        ok: true,
        headers: new Headers({ "content-type": "audio/mpeg" }),
        arrayBuffer: async () => Buffer.from([1, 2, 3, 4]),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await tryHandleAudioMessage(ctx, {
      psid: "psid-2",
      userId: "user-2",
      reqId: "req-audio-ok",
      lang: "nl",
      attachments: [
        { type: "audio", payload: { url: "https://audio.example/message.mp3" } },
      ],
      text: "",
    });

    expect(result).toBe(true);
    expect(handleTextMessageMock).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        psid: "psid-2",
        userId: "user-2",
        text: "maak een foto van een cyberpunk stadslandschap",
      })
    );
  });

  it("returns false when user is out of generation quota and sends out-of-credits message", async () => {
    const ctx = makeContext();
    canGenerateMock.mockResolvedValue(false);

    const result = await tryHandleAudioMessage(ctx, {
      psid: "psid-4",
      userId: "user-4",
      reqId: "req-audio-quota",
      lang: "nl",
      attachments: [
        { type: "audio", payload: { url: "https://audio.example/message.mp3" } },
      ],
      text: "",
    });

    expect(result).toBe(true);
    expect(ctx.sendLoggedText).toHaveBeenCalledWith(
      "psid-4",
      t("nl", "outOfFreeCredits"),
      "req-audio-quota"
    );
    expect(handleTextMessageMock).not.toHaveBeenCalled();
  });

  it("returns false when OPENAI API key is missing", async () => {
    const ctx = makeContext();
    delete process.env.OPENAI_API_KEY;

    const result = await tryHandleAudioMessage(ctx, {
      psid: "psid-3",
      userId: "user-3",
      reqId: "req-audio-missing-key",
      lang: "nl",
      attachments: [
        { type: "audio", payload: { url: "https://audio.example/message.mp3" } },
      ],
      text: "",
    });

    expect(result).toBe(false);
    expect(safeLogMock).toHaveBeenCalledWith(
      "messenger_audio_transcription_skipped",
      expect.objectContaining({
        reason: "missing_openai_api_key",
        route: "audio",
      })
    );
  });
});
