import { describe, expect, it, vi, afterEach } from "vitest";
import { t } from "./_core/i18n";

const {
  assertAudioBudgetAvailableMock,
  releaseAudioBudgetReservationMock,
  reserveTranscriptionForAttemptMock,
  releaseTranscriptionReservationMock,
  commitTranscriptionSuccessMock,
  prepareAudioForTranscriptionFromBufferMock,
  transcribePreparedAudioMessageMock,
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
  MessengerQuotaReservationCommitError: MessengerQuotaReservationCommitErrorMock,
}));

vi.mock("./_core/webhookAudioMessageRouter", () => ({
  prepareAudioForTranscriptionFromBuffer:
    prepareAudioForTranscriptionFromBufferMock,
  transcribePreparedAudioMessage: transcribePreparedAudioMessageMock,
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

afterEach(() => {
  assertAudioBudgetAvailableMock.mockReset();
  releaseAudioBudgetReservationMock.mockReset();
  reserveTranscriptionForAttemptMock.mockReset();
  releaseTranscriptionReservationMock.mockReset();
  commitTranscriptionSuccessMock.mockReset();
  prepareAudioForTranscriptionFromBufferMock.mockReset();
  transcribePreparedAudioMessageMock.mockReset();
  downloadWhatsAppMediaMock.mockReset();
  sendWhatsAppTextReplyMock.mockReset();
  handleWhatsAppTextEventMock.mockReset();
});

describe("WhatsApp audio handler", () => {
  it("does not release the daily audio budget when reservation acquisition fails", async () => {
    assertAudioBudgetAvailableMock.mockRejectedValue(
      new MessengerDailyAudioTranscriptionBudgetExceededErrorMock()
    );

    await handleWhatsAppAudioEvent(
      {
        channel: "whatsapp",
        messageType: "audio",
        rawMessageType: "audio",
        audioId: "wa-audio-over-cap",
        senderId: "whatsapp-sender",
        userId: "whatsapp-user",
        messageId: "wa-message-over-cap",
        textBody: "",
      },
      { reqId: "req-wa-audio-over-cap", lang: "en" }
    );

    expect(sendWhatsAppTextReplyMock).toHaveBeenCalledWith(
      "whatsapp-sender",
      t("en", "outOfFreeCredits")
    );
    expect(releaseAudioBudgetReservationMock).not.toHaveBeenCalled();
    expect(reserveTranscriptionForAttemptMock).not.toHaveBeenCalled();
    expect(downloadWhatsAppMediaMock).not.toHaveBeenCalled();
  });
});
