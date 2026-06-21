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
  reserveTranscriptionForAttemptMock,
  commitTranscriptionSuccessMock,
  releaseTranscriptionReservationMock,
  fetchExternalSourceImageForIngressMock,
} = vi.hoisted(() => ({
  safeLogMock: vi.fn(),
  handleTextMessageMock: vi.fn(async () => undefined),
  reserveTranscriptionForAttemptMock: vi.fn(async () => ({ token: "quota-lock" })),
  commitTranscriptionSuccessMock: vi.fn(async () => true),
  releaseTranscriptionReservationMock: vi.fn(async () => undefined),
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
  reserveTranscriptionForAttempt: reserveTranscriptionForAttemptMock,
  commitTranscriptionSuccess: commitTranscriptionSuccessMock,
  releaseTranscriptionReservation: releaseTranscriptionReservationMock,
  MessengerQuotaReservationCommitError: class MessengerQuotaReservationCommitError extends Error {},
}));

import type { HandlerContext } from "./_core/webhookHandlerTypes";
import { tryHandleAudioMessage } from "./_core/webhookAudioMessageRouter";

const FIXED_LEDGER_NOW = new Date("2026-06-21T12:00:00.000Z");
const FIXED_LEDGER_PERIOD = "2026-06-21";
import { type FacebookWebhookEvent } from "./_core/webhookHelpers";
import { t } from "./_core/i18n";
import { appendCostLedgerEntry, readCostLedgerPeriod } from "./_core/costLedger";
import { clearStateStore } from "./_core/stateStore";

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
  const originalAudioEstimateUsd = process.env.OPENAI_AUDIO_TRANSCRIPTION_ESTIMATED_COST_USD;
  const originalSpendCapUsd = process.env.MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD;
  const originalMonthlySpendCapUsd = process.env.MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD;

  beforeEach(() => {
    safeLogMock.mockClear();
    handleTextMessageMock.mockClear();
    reserveTranscriptionForAttemptMock.mockClear();
    reserveTranscriptionForAttemptMock.mockResolvedValue({ token: "quota-lock" });
    commitTranscriptionSuccessMock.mockClear();
    commitTranscriptionSuccessMock.mockResolvedValue(true);
    releaseTranscriptionReservationMock.mockClear();
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
    delete process.env.OPENAI_AUDIO_TRANSCRIPTION_ESTIMATED_COST_USD;
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
    if (originalAudioEstimateUsd === undefined) {
      delete process.env.OPENAI_AUDIO_TRANSCRIPTION_ESTIMATED_COST_USD;
    } else {
      process.env.OPENAI_AUDIO_TRANSCRIPTION_ESTIMATED_COST_USD = originalAudioEstimateUsd;
    }
    if (originalSpendCapUsd === undefined) {
      delete process.env.MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD;
    } else {
      process.env.MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD = originalSpendCapUsd;
    }
    if (originalMonthlySpendCapUsd === undefined) {
      delete process.env.MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD;
    } else {
      process.env.MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD = originalMonthlySpendCapUsd;
    }
    vi.unstubAllGlobals();
    clearStateStore();
    vi.useRealTimers();
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
    expect(reserveTranscriptionForAttemptMock).not.toHaveBeenCalled();
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
    expect(reserveTranscriptionForAttemptMock).toHaveBeenCalledTimes(1);
    expect(commitTranscriptionSuccessMock).toHaveBeenCalledWith(
      "psid-2",
      { token: "quota-lock" },
      { releaseReservation: false }
    );
    expect(releaseTranscriptionReservationMock).toHaveBeenCalledTimes(1);
    expect(releaseTranscriptionReservationMock).toHaveBeenCalledWith(
      "psid-2",
      { token: "quota-lock" }
    );
    expect(
      releaseTranscriptionReservationMock.mock.invocationCallOrder[0]
    ).toBeGreaterThan(fetchMock.mock.invocationCallOrder[0]);
    expect(handleTextMessageMock).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        psid: "psid-2",
        userId: "user-2",
        text: "maak een foto van een cyberpunk stadslandschap",
      })
    );
  });

  it("records priced audio transcription attempts with final cost when configured", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_LEDGER_NOW);
    const ctx = makeContext();
    process.env.OPENAI_AUDIO_TRANSCRIPTION_ESTIMATED_COST_USD = "0.0042";
    const fetchMock = vi.fn(async (url: string | URL) => {
      const target = typeof url === "string" ? url : url.toString();
      if (target === "https://api.openai.com/v1/audio/transcriptions") {
        return {
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ text: "maak een foto van een astronaut" }),
        } as Response;
      }
      throw new Error(`Unexpected fetch URL: ${target}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await tryHandleAudioMessage(ctx, {
      psid: "psid-audio-priced",
      userId: "user-audio-priced",
      reqId: "req-audio-priced",
      lang: "nl",
      attachments: [
        { type: "audio", payload: { url: "https://audio.example/message-priced.mp3" } },
      ],
      text: "",
    });

    expect(result).toBe(true);
    const ledgerEntries = await readCostLedgerPeriod(FIXED_LEDGER_PERIOD);
    expect(ledgerEntries).toEqual([
      expect.objectContaining({
        id: "req-audio-priced:openai-audio:1",
        operation: "audio_transcription",
        provider: "openai-audio",
        model: "whisper-1",
        userKey: "user-audio-priced",
        status: "provider_attempt_succeeded",
        estimatedCostUsd: 0.0042,
        estimatedOutputCostUsd: null,
        finalCostUsd: 0.0042,
        costEstimateComplete: true,
        estimateSource: "env_override",
        unpricedCostComponents: [],
      }),
    ]);
    expect(JSON.stringify(ledgerEntries)).not.toContain("maak een foto");
    expect(JSON.stringify(ledgerEntries)).not.toContain("message-priced.mp3");
    expect(JSON.stringify(ledgerEntries)).not.toContain("psid-audio-priced");
  });

  it("counts the provider attempt when transcript is empty", async () => {
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
    expect(reserveTranscriptionForAttemptMock).toHaveBeenCalledTimes(1);
    expect(commitTranscriptionSuccessMock).toHaveBeenCalledTimes(1);
    expect(releaseTranscriptionReservationMock).toHaveBeenCalledTimes(1);
  });

  it("counts each retried audio transcription provider attempt", async () => {
    const ctx = makeContext();
    const fetchMock = vi.fn(async (url: string | URL) => {
      const target = typeof url === "string" ? url : url.toString();
      if (
        target ===
        "https://api.openai.com/v1/audio/transcriptions"
      ) {
        if (fetchMock.mock.calls.length === 1) {
          return {
            ok: false,
            status: 500,
            headers: new Headers({ "content-type": "application/json" }),
            text: async () => "temporary provider failure",
          } as Response;
        }
        return {
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ text: "maak een foto van een robot" }),
        } as Response;
      }
      throw new Error(`Unexpected fetch URL: ${target}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await tryHandleAudioMessage(ctx, {
      psid: "psid-audio-retry",
      userId: "user-audio-retry",
      reqId: "req-audio-retry",
      lang: "nl",
      attachments: [
        { type: "audio", payload: { url: "https://audio.example/message-retry.mp3" } },
      ],
      text: "",
    });

    expect(result).toBe(true);
    const ledgerEntries = await readCostLedgerPeriod(new Date().toISOString().slice(0, 10));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(commitTranscriptionSuccessMock).toHaveBeenCalledTimes(2);
    expect(handleTextMessageMock).toHaveBeenCalledTimes(1);
    expect(ledgerEntries).toEqual([
      expect.objectContaining({
        id: "req-audio-retry:openai-audio:1",
        channel: "facebook_messenger",
        operation: "audio_transcription",
        provider: "openai-audio",
        model: "whisper-1",
        userKey: "user-audio-retry",
        reqId: "req-audio-retry",
        status: "provider_attempt_failed",
        costEstimateComplete: false,
        estimateSource: "unpriced",
        unpricedCostComponents: ["audio_seconds"],
      }),
      expect.objectContaining({
        id: "req-audio-retry:openai-audio:2",
        userKey: "user-audio-retry",
        status: "provider_attempt_succeeded",
      }),
    ]);
    expect(JSON.stringify(ledgerEntries)).not.toContain("maak een foto");
    expect(JSON.stringify(ledgerEntries)).not.toContain("message-retry.mp3");
    expect(JSON.stringify(ledgerEntries)).not.toContain("psid-audio-retry");
  });

  it("stops audio transcription retries when quota is exhausted", async () => {
    const ctx = makeContext();
    commitTranscriptionSuccessMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => "temporary provider failure",
    }) as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await tryHandleAudioMessage(ctx, {
      psid: "psid-audio-retry-exhausted",
      userId: "user-audio-retry-exhausted",
      reqId: "req-audio-retry-exhausted",
      lang: "nl",
      attachments: [
        { type: "audio", payload: { url: "https://audio.example/message-retry-exhausted.mp3" } },
      ],
      text: "",
    });

    expect(result).toBe(true);
    const ledgerEntries = await readCostLedgerPeriod(new Date().toISOString().slice(0, 10));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(commitTranscriptionSuccessMock).toHaveBeenCalledTimes(2);
    expect(ctx.sendLoggedText).toHaveBeenCalledWith(
      "psid-audio-retry-exhausted",
      t("nl", "outOfFreeCredits"),
      "req-audio-retry-exhausted"
    );
    expect(handleTextMessageMock).not.toHaveBeenCalled();
    expect(ledgerEntries).toHaveLength(1);
    expect(ledgerEntries[0]).toMatchObject({
      id: "req-audio-retry-exhausted:openai-audio:1",
      operation: "audio_transcription",
      userKey: "user-audio-retry-exhausted",
      status: "provider_attempt_failed",
    });
  });

  it("blocks misconfigured audio transcription cost overrides when spend caps are enabled", async () => {
    const ctx = makeContext();
    process.env.OPENAI_AUDIO_TRANSCRIPTION_ESTIMATED_COST_USD = "0";
    process.env.MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD = "1";
    const fetchMock = vi.fn(async () => {
      throw new Error("transcription provider should not be called");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await tryHandleAudioMessage(ctx, {
      psid: "psid-audio-spend-cap",
      userId: "user-audio-spend-cap",
      reqId: "req-audio-spend-cap",
      lang: "nl",
      attachments: [
        { type: "audio", payload: { url: "https://audio.example/message-spend-cap.mp3" } },
      ],
      text: "",
    });

    expect(result).toBe(true);
    expect(commitTranscriptionSuccessMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(releaseTranscriptionReservationMock).toHaveBeenCalledWith(
      "psid-audio-spend-cap",
      { token: "quota-lock" }
    );
    expect(ctx.sendLoggedText).toHaveBeenCalledWith(
      "psid-audio-spend-cap",
      t("nl", "outOfFreeCredits"),
      "req-audio-spend-cap"
    );
    expect(await readCostLedgerPeriod(new Date().toISOString().slice(0, 10))).toEqual([]);
  });

  it("uses configured audio transcription estimates for spend cap checks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_LEDGER_NOW);
    const ctx = makeContext();
    process.env.OPENAI_AUDIO_TRANSCRIPTION_ESTIMATED_COST_USD = "0.025";
    process.env.MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD = "0.03";
    await appendCostLedgerEntry(
      {
        id: "req-existing-audio-spend:attempt-1",
        channel: "facebook_messenger",
        operation: "audio_transcription",
        provider: "openai-audio",
        model: "whisper-1",
        userKey: "other-user",
        reqId: "req-existing-audio-spend",
        status: "provider_attempt_started",
        estimatedCostUsd: 0.02,
        estimatedOutputCostUsd: null,
        finalCostUsd: null,
        costEstimateComplete: true,
        estimateSource: "env_override",
        unpricedCostComponents: [],
      },
      FIXED_LEDGER_NOW
    );
    const fetchMock = vi.fn(async () => {
      throw new Error("transcription provider should not be called");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await tryHandleAudioMessage(ctx, {
      psid: "psid-audio-priced-spend-cap",
      userId: "user-audio-priced-spend-cap",
      reqId: "req-audio-priced-spend-cap",
      lang: "nl",
      attachments: [
        { type: "audio", payload: { url: "https://audio.example/message-priced-cap.mp3" } },
      ],
      text: "",
    });

    expect(result).toBe(true);
    expect(commitTranscriptionSuccessMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.sendLoggedText).toHaveBeenCalledWith(
      "psid-audio-priced-spend-cap",
      t("nl", "outOfFreeCredits"),
      "req-audio-priced-spend-cap"
    );
    const ledgerEntries = await readCostLedgerPeriod(FIXED_LEDGER_PERIOD);
    expect(ledgerEntries).toHaveLength(1);
    expect(ledgerEntries[0]?.id).toBe("req-existing-audio-spend:attempt-1");
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
    expect(reserveTranscriptionForAttemptMock).not.toHaveBeenCalled();
    expect(commitTranscriptionSuccessMock).not.toHaveBeenCalled();
    expect(releaseTranscriptionReservationMock).not.toHaveBeenCalled();
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
    expect(reserveTranscriptionForAttemptMock).toHaveBeenCalledTimes(1);
    expect(commitTranscriptionSuccessMock).toHaveBeenCalledTimes(1);
    expect(releaseTranscriptionReservationMock).toHaveBeenCalledTimes(1);
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
    reserveTranscriptionForAttemptMock.mockResolvedValue(null);

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
    expect(reserveTranscriptionForAttemptMock).toHaveBeenCalledTimes(1);
    expect(commitTranscriptionSuccessMock).not.toHaveBeenCalled();
    expect(releaseTranscriptionReservationMock).not.toHaveBeenCalled();
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
    expect(reserveTranscriptionForAttemptMock).not.toHaveBeenCalled();
    expect(safeLogMock).toHaveBeenCalledWith(
      "messenger_audio_transcription_skipped",
      expect.objectContaining({
        reason: "missing_openai_api_key",
        route: "audio",
      })
    );
  });
});
