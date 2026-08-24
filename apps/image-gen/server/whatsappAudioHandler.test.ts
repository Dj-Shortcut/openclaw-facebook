import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "./_core/i18n";

const {
  assertAudioBudgetAvailableMock,
  releaseAudioBudgetReservationMock,
  reserveTranscriptionForAttemptMock,
  releaseTranscriptionReservationMock,
  commitTranscriptionSuccessMock,
  prepareAudioForTranscriptionFromBufferMock,
  transcribePreparedAudioMessageMock,
  assertAudioProviderFenceMock,
  reserveProviderFenceMock,
  markProviderFenceStartedMock,
  finalizeProviderFenceMock,
  downloadWhatsAppMediaMock,
  sendWhatsAppTextReplyMock,
  handleWhatsAppTextEventMock,
  MessengerDailyAudioTranscriptionBudgetExceededErrorMock,
  MessengerSpendBudgetExceededErrorMock,
  MessengerQuotaReservationCommitErrorMock,
} = vi.hoisted(() => {
  class MessengerDailyAudioTranscriptionBudgetExceededError extends Error {}
  class MessengerSpendBudgetExceededError extends Error {}
  class MessengerQuotaReservationCommitError extends Error {}

  return {
    assertAudioBudgetAvailableMock: vi.fn(),
    releaseAudioBudgetReservationMock: vi.fn(),
    reserveTranscriptionForAttemptMock: vi.fn(),
    releaseTranscriptionReservationMock: vi.fn(),
    commitTranscriptionSuccessMock: vi.fn(),
    prepareAudioForTranscriptionFromBufferMock: vi.fn(),
    transcribePreparedAudioMessageMock: vi.fn(),
    assertAudioProviderFenceMock: vi.fn(),
    reserveProviderFenceMock: vi.fn(),
    markProviderFenceStartedMock: vi.fn(),
    finalizeProviderFenceMock: vi.fn(),
    downloadWhatsAppMediaMock: vi.fn(),
    sendWhatsAppTextReplyMock: vi.fn(),
    handleWhatsAppTextEventMock: vi.fn(),
    MessengerDailyAudioTranscriptionBudgetExceededErrorMock:
      MessengerDailyAudioTranscriptionBudgetExceededError,
    MessengerSpendBudgetExceededErrorMock: MessengerSpendBudgetExceededError,
    MessengerQuotaReservationCommitErrorMock:
      MessengerQuotaReservationCommitError,
  };
});

vi.mock("./_core/generationGuard", () => ({
  assertMessengerDailyAudioTranscriptionBudgetAvailable:
    assertAudioBudgetAvailableMock,
  releaseMessengerDailyAudioTranscriptionBudgetReservation:
    releaseAudioBudgetReservationMock,
  MessengerDailyAudioTranscriptionBudgetExceededError:
    MessengerDailyAudioTranscriptionBudgetExceededErrorMock,
  MessengerSpendBudgetExceededError: MessengerSpendBudgetExceededErrorMock,
}));

vi.mock("./_core/messengerQuota", () => ({
  reserveTranscriptionForAttempt: reserveTranscriptionForAttemptMock,
  releaseTranscriptionReservation: releaseTranscriptionReservationMock,
  commitTranscriptionSuccess: commitTranscriptionSuccessMock,
  MessengerQuotaReservationCommitError:
    MessengerQuotaReservationCommitErrorMock,
}));

vi.mock("./_core/webhookAudioMessageRouter", () => ({
  assertAudioProviderFence: assertAudioProviderFenceMock,
  prepareAudioForTranscriptionFromBuffer:
    prepareAudioForTranscriptionFromBufferMock,
  transcribePreparedAudioMessage: transcribePreparedAudioMessageMock,
}));

vi.mock("./_core/messengerProviderAttemptFence", () => ({
  reserveMessengerProviderAttemptFence: reserveProviderFenceMock,
  markMessengerProviderAttemptStarted: markProviderFenceStartedMock,
  finalizeMessengerProviderAttemptFence: finalizeProviderFenceMock,
}));

vi.mock("./_core/whatsappApi", () => ({
  downloadWhatsAppMedia: downloadWhatsAppMediaMock,
}));

vi.mock("./_core/whatsappResponseService", () => ({
  sendWhatsAppTextReply: sendWhatsAppTextReplyMock,
}));

vi.mock("./_core/whatsappHandlers/textHandler", () => ({
  handleWhatsAppTextEvent: handleWhatsAppTextEventMock,
}));

vi.mock("./_core/logger", () => ({
  safeLog: vi.fn(),
}));

import { handleWhatsAppAudioEvent } from "./_core/whatsappHandlers/audioHandler";

beforeEach(() => {
  assertAudioProviderFenceMock.mockResolvedValue(undefined);
  reserveProviderFenceMock.mockResolvedValue({
    leaseToken: "download-lease",
    attemptKeyHash: "d".repeat(64),
  });
  markProviderFenceStartedMock.mockResolvedValue(undefined);
  finalizeProviderFenceMock.mockResolvedValue(undefined);
});

afterEach(() => {
  assertAudioBudgetAvailableMock.mockReset();
  releaseAudioBudgetReservationMock.mockReset();
  reserveTranscriptionForAttemptMock.mockReset();
  releaseTranscriptionReservationMock.mockReset();
  commitTranscriptionSuccessMock.mockReset();
  prepareAudioForTranscriptionFromBufferMock.mockReset();
  transcribePreparedAudioMessageMock.mockReset();
  assertAudioProviderFenceMock.mockReset();
  reserveProviderFenceMock.mockReset();
  markProviderFenceStartedMock.mockReset();
  finalizeProviderFenceMock.mockReset();
  downloadWhatsAppMediaMock.mockReset();
  sendWhatsAppTextReplyMock.mockReset();
  handleWhatsAppTextEventMock.mockReset();
  delete process.env.OPENAI_API_KEY;
});

describe("WhatsApp audio handler", () => {
  it("does not release the daily audio budget when reservation acquisition fails", async () => {
    assertAudioBudgetAvailableMock.mockRejectedValue(
      new MessengerDailyAudioTranscriptionBudgetExceededErrorMock()
    );

    await handleWhatsAppAudioEvent(
      {
        channel: "whatsapp",
        endpoint: {
          channel: "whatsapp",
          wabaId: "303030303030303",
          phoneNumberId: "404040404040404",
        },
        messageType: "audio",
        rawMessageType: "audio",
        audioId: "wa-audio-over-cap",
        senderId: "whatsapp-sender",
        userId: "whatsapp-user",
        messageId: "wa-message-over-cap",
        textBody: "",
      },
      {
        reqId: "req-wa-audio-over-cap",
        lang: "en",
        costLedgerScope: {
          workspaceId: 42,
          channelConnectionId: 8,
          bindingEpoch: 3,
          privacyEpoch: 2,
        },
      }
    );

    expect(sendWhatsAppTextReplyMock).toHaveBeenCalledWith(
      "whatsapp-sender",
      t("en", "outOfFreeCredits"),
      "req-wa-audio-over-cap",
      "audio-daily-budget-exhausted"
    );
    expect(releaseAudioBudgetReservationMock).not.toHaveBeenCalled();
    expect(reserveTranscriptionForAttemptMock).not.toHaveBeenCalled();
    expect(downloadWhatsAppMediaMock).not.toHaveBeenCalled();
  });

  it("passes the immutable WhatsApp tenant scope into the audio provider job", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const scope = {
      workspaceId: 42,
      channelConnectionId: 8,
      bindingEpoch: 3,
      privacyEpoch: 2,
    } as const;
    assertAudioBudgetAvailableMock.mockResolvedValue(undefined);
    reserveTranscriptionForAttemptMock.mockResolvedValue({ token: "quota" });
    commitTranscriptionSuccessMock.mockResolvedValue(true);
    downloadWhatsAppMediaMock.mockResolvedValue({
      buffer: Buffer.from("audio"),
      contentType: "audio/ogg",
    });
    prepareAudioForTranscriptionFromBufferMock.mockReturnValue({
      apiKey: "test-key",
      sourceAudio: {
        buffer: Buffer.from("audio"),
        contentType: "audio/ogg",
        incomingLen: 5,
      },
    });
    transcribePreparedAudioMessageMock.mockImplementation(
      async (...args: unknown[]) => {
        await (args[5] as () => Promise<void>)();
        return "transcript with words";
      }
    );

    await handleWhatsAppAudioEvent(
      {
        channel: "whatsapp",
        endpoint: {
          channel: "whatsapp",
          wabaId: "303030303030303",
          phoneNumberId: "404040404040404",
        },
        messageType: "audio",
        rawMessageType: "audio",
        audioId: "wa-audio",
        senderId: "32470000001",
        userId: "user-key",
        messageId: "wa-message",
        textBody: "",
      },
      { reqId: "req-wa-audio", lang: "en", costLedgerScope: scope }
    );

    expect(transcribePreparedAudioMessageMock).toHaveBeenCalledWith(
      "req-wa-audio",
      "32470000001",
      "user-key",
      "wa-audio",
      expect.any(Object),
      expect.any(Function),
      "whatsapp",
      {
        psid: "32470000001",
        userId: "user-key",
        reqId: "req-wa-audio",
        lang: "en",
        pageId: "404040404040404",
        ...scope,
        providerChannel: "whatsapp",
      }
    );
    expect(reserveProviderFenceMock).toHaveBeenCalledWith(
      expect.objectContaining({ providerChannel: "whatsapp", ...scope }),
      "meta-audio-download",
      1,
      expect.any(Date),
      "whatsapp"
    );
    expect(markProviderFenceStartedMock).toHaveBeenCalledBefore(
      downloadWhatsAppMediaMock
    );
    expect(finalizeProviderFenceMock).toHaveBeenCalledWith(
      expect.any(Object),
      "succeeded"
    );
    expect(handleWhatsAppTextEventMock).toHaveBeenCalledOnce();
  });

  it("suppresses downloaded audio when deletion wins during the Meta request", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    assertAudioBudgetAvailableMock.mockResolvedValue(undefined);
    reserveTranscriptionForAttemptMock.mockResolvedValue({ token: "quota" });
    let finishDownload:
      ((value: { buffer: Buffer; contentType: string }) => void) | null = null;
    downloadWhatsAppMediaMock.mockImplementation(
      async () =>
        await new Promise<{ buffer: Buffer; contentType: string }>(resolve => {
          finishDownload = resolve;
        })
    );

    const handling = handleWhatsAppAudioEvent(
      {
        channel: "whatsapp",
        endpoint: {
          channel: "whatsapp",
          wabaId: "303030303030303",
          phoneNumberId: "404040404040404",
        },
        messageType: "audio",
        rawMessageType: "audio",
        audioId: "wa-audio-delete-race",
        senderId: "32470000001",
        userId: "user-key",
        messageId: "wa-message-delete-race",
        textBody: "",
      },
      {
        reqId: "req-wa-audio-delete-race",
        lang: "en",
        costLedgerScope: {
          workspaceId: 42,
          channelConnectionId: 8,
          bindingEpoch: 3,
          privacyEpoch: 2,
        },
      }
    );

    await vi.waitFor(() => {
      expect(downloadWhatsAppMediaMock).toHaveBeenCalledOnce();
    });
    assertAudioProviderFenceMock.mockRejectedValueOnce(
      new Error("privacy subject erased")
    );
    (finishDownload as NonNullable<typeof finishDownload>)({
      buffer: Buffer.from("private"),
      contentType: "audio/ogg",
    });
    await handling;

    expect(finalizeProviderFenceMock).toHaveBeenCalledWith(
      expect.any(Object),
      "succeeded"
    );
    expect(prepareAudioForTranscriptionFromBufferMock).not.toHaveBeenCalled();
    expect(transcribePreparedAudioMessageMock).not.toHaveBeenCalled();
    expect(sendWhatsAppTextReplyMock).toHaveBeenCalledWith(
      "32470000001",
      t("en", "unsupportedAudio"),
      "req-wa-audio-delete-race",
      "audio-download-failed"
    );
  });
});
