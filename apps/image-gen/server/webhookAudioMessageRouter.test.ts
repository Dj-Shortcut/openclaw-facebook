import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const {
  safeLogMock,
  handleTextMessageMock,
  checkAndIncrementTranscriptionMock,
  fetchExternalSourceImageForIngressMock,
} = vi.hoisted(() => ({
  safeLogMock: vi.fn(),
  handleTextMessageMock: vi.fn(async () => undefined),
  checkAndIncrementTranscriptionMock: vi.fn(async () => true),
  fetchExternalSourceImageForIngressMock: vi.fn().mockResolvedValue({
    buffer: Buffer.from([1, 2, 3, 4]),
    contentType: "audio/mpeg",
    incomingLen: 4,
    incomingSha256: "stubhash",
    fbImageFetchMs: 12,
  }),
}));

vi.mock("./_core/messengerApi", () => ({
  safeLog: safeLogMock,
}));

vi.mock("./_core/webhookTextMessageRouter", () => ({
  handleTextMessage: handleTextMessageMock,
}));

vi.mock("./_core/image-generation/sourceImageFetcher", () => ({
  fetchExternalSourceImageForIngress: fetchExternalSourceImageForIngressMock,
}));

vi.mock("./_core/messengerQuota", () => ({
  checkAndIncrementTranscription: checkAndIncrementTranscriptionMock,
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
  const originalAudioMaxBytes = process.env.MESSENGER_AUDIO_TRANSCRIPTION_MAX_BYTES;

  beforeEach(() => {
    safeLogMock.mockClear();
    handleTextMessageMock.mockClear();
    checkAndIncrementTranscriptionMock.mockClear();
    checkAndIncrementTranscriptionMock.mockResolvedValue(true);
    fetchExternalSourceImageForIngressMock.mockClear();
    fetchExternalSourceImageForIngressMock.mockResolvedValue({
      buffer: Buffer.from([1, 2, 3, 4]),
      contentType: "audio/mpeg",
      incomingLen: 4,
      incomingSha256: "stubhash",
      fbImageFetchMs: 12,
    });
    process.env.PRIVACY_PEPPER = "test-pepper";
    process.env.OPENAI_API_KEY = "dummy-key";
    delete process.env.MESSENGER_AUDIO_TRANSCRIPTION_MAX_BYTES;
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
    if (originalAudioMaxBytes === undefined) {
      delete process.env.MESSENGER_AUDIO_TRANSCRIPTION_MAX_BYTES;
    } else {
      process.env.MESSENGER_AUDIO_TRANSCRIPTION_MAX_BYTES = originalAudioMaxBytes;
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
    expect(checkAndIncrementTranscriptionMock).not.toHaveBeenCalled();
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
    expect(checkAndIncrementTranscriptionMock).toHaveBeenCalledTimes(1);
    expect(handleTextMessageMock).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        psid: "psid-2",
        userId: "user-2",
        text: "maak een foto van een cyberpunk stadslandschap",
      })
    );
  });

  it("reserves quota before transcription even when transcript is empty", async () => {
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
          json: async () => ({ text: "   " }),
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
      psid: "psid-empty",
      userId: "user-empty",
      reqId: "req-audio-empty",
      lang: "nl",
      attachments: [
        { type: "audio", payload: { url: "https://audio.example/message-empty.mp3" } },
      ],
      text: "",
    });

    expect(result).toBe(false);
    expect(checkAndIncrementTranscriptionMock).toHaveBeenCalledTimes(1);
  });

  it("skips OpenAI transcription when downloaded audio exceeds the configured size limit", async () => {
    const ctx = makeContext();
    process.env.MESSENGER_AUDIO_TRANSCRIPTION_MAX_BYTES = "3";
    fetchExternalSourceImageForIngressMock.mockResolvedValue({
      buffer: Buffer.from([1, 2, 3, 4]),
      contentType: "audio/mpeg",
      incomingLen: 4,
      incomingSha256: "stubhash",
      fbImageFetchMs: 12,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await tryHandleAudioMessage(ctx, {
      psid: "psid-large",
      userId: "user-large",
      reqId: "req-audio-large",
      lang: "nl",
      attachments: [
        { type: "audio", payload: { url: "https://audio.example/message-large.mp3" } },
      ],
      text: "",
    });

    expect(result).toBe(false);
    expect(checkAndIncrementTranscriptionMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(safeLogMock).toHaveBeenCalledWith(
      "messenger_audio_transcription_skipped",
      expect.objectContaining({
        reason: "audio_too_large",
        route: "audio",
        maxBytes: 3,
      })
    );
  });

  it("does not route one-word transcripts to the text handler", async () => {
    const ctx = makeContext();
    const fetchMock = vi.fn(async (url: string | URL) => {
      const target = typeof url === "string" ? url : url.toString();
      if (
        target ===
        "https://api.openai.com/v1/audio/transcriptions"
      ) {
        return {
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ text: "hallo" }),
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
      psid: "psid-short",
      userId: "user-short",
      reqId: "req-audio-short",
      lang: "nl",
      attachments: [
        { type: "audio", payload: { url: "https://audio.example/message-short.mp3" } },
      ],
      text: "",
    });

    expect(result).toBe(false);
    expect(checkAndIncrementTranscriptionMock).toHaveBeenCalledTimes(1);
    expect(handleTextMessageMock).not.toHaveBeenCalled();
    expect(safeLogMock).toHaveBeenCalledWith(
      "messenger_audio_transcription_no_text",
      expect.objectContaining({
        reason: "transcript_too_short",
        route: "audio",
        wordCount: 1,
      })
    );
  });

  it("returns true when transcription quota is exhausted and sends out-of-credits message", async () => {
    const ctx = makeContext();
    checkAndIncrementTranscriptionMock.mockResolvedValue(false);

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
    expect(checkAndIncrementTranscriptionMock).toHaveBeenCalledTimes(1);
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
    expect(checkAndIncrementTranscriptionMock).toHaveBeenCalledTimes(1);
    expect(safeLogMock).toHaveBeenCalledWith(
      "messenger_audio_transcription_skipped",
      expect.objectContaining({
        reason: "missing_openai_api_key",
        route: "audio",
      })
    );
  });
});
