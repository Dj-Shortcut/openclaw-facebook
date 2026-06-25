import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  extractWhatsAppEventsMock,
  logWhatsAppWebhookPayloadMock,
  claimWebhookReplayKeyMock,
  handleWhatsAppConsentGateMock,
  getOrCreateStateMock,
  setLastUserMessageAtMock,
  sendWhatsAppButtonsReplyMock,
  sendWhatsAppTextReplyMock,
  handleWhatsAppImageEventMock,
  handleWhatsAppAudioEventMock,
  handleWhatsAppInteractiveEventMock,
  handleWhatsAppTextEventMock,
  safeLogMock,
} = vi.hoisted(() => ({
  extractWhatsAppEventsMock: vi.fn(),
  logWhatsAppWebhookPayloadMock: vi.fn(),
  claimWebhookReplayKeyMock: vi.fn(),
  handleWhatsAppConsentGateMock: vi.fn(),
  getOrCreateStateMock: vi.fn(),
  setLastUserMessageAtMock: vi.fn(),
  sendWhatsAppButtonsReplyMock: vi.fn(),
  sendWhatsAppTextReplyMock: vi.fn(),
  handleWhatsAppImageEventMock: vi.fn(),
  handleWhatsAppAudioEventMock: vi.fn(),
  handleWhatsAppInteractiveEventMock: vi.fn(),
  handleWhatsAppTextEventMock: vi.fn(),
  safeLogMock: vi.fn(),
}));

const TEST_PRIVACY_PEPPER = "ci-whatsapp-pepper";
const originalPrivacyPepper = process.env.PRIVACY_PEPPER;

vi.mock("./_core/inbound/whatsappInbound", () => ({
  extractWhatsAppEvents: extractWhatsAppEventsMock,
  logWhatsAppWebhookPayload: logWhatsAppWebhookPayloadMock,
}));

vi.mock("./_core/webhookReplayProtection", () => ({
  claimWebhookReplayKey: claimWebhookReplayKeyMock,
}));

vi.mock("./_core/consentService", () => ({
  handleWhatsAppConsentGate: handleWhatsAppConsentGateMock,
}));

vi.mock("./_core/messengerState", () => ({
  getOrCreateState: getOrCreateStateMock,
  setLastUserMessageAt: setLastUserMessageAtMock,
}));

vi.mock("./_core/whatsappResponseService", () => ({
  sendWhatsAppButtonsReply: sendWhatsAppButtonsReplyMock,
  sendWhatsAppTextReply: sendWhatsAppTextReplyMock,
}));

vi.mock("./_core/whatsappHandlers/imageHandler", () => ({
  handleWhatsAppImageEvent: handleWhatsAppImageEventMock,
}));

vi.mock("./_core/whatsappHandlers/audioHandler", () => ({
  handleWhatsAppAudioEvent: handleWhatsAppAudioEventMock,
}));

vi.mock("./_core/whatsappHandlers/interactiveHandler", () => ({
  handleWhatsAppInteractiveEvent: handleWhatsAppInteractiveEventMock,
}));

vi.mock("./_core/whatsappHandlers/textHandler", () => ({
  handleWhatsAppTextEvent: handleWhatsAppTextEventMock,
}));

vi.mock("./_core/logger", async () => {
  const actual = await vi.importActual<typeof import("./_core/logger")>(
    "./_core/logger"
  );

  return {
    ...actual,
    safeLog: safeLogMock,
  };
});

vi.mock("./_core/i18n", () => ({
  t: vi.fn(() => "localized message"),
  normalizeLang: vi.fn(() => "nl"),
}));

afterEach(() => {
  extractWhatsAppEventsMock.mockReset();
  logWhatsAppWebhookPayloadMock.mockReset();
  claimWebhookReplayKeyMock.mockReset();
  handleWhatsAppConsentGateMock.mockReset();
  getOrCreateStateMock.mockReset();
  setLastUserMessageAtMock.mockReset();
  sendWhatsAppButtonsReplyMock.mockReset();
  sendWhatsAppTextReplyMock.mockReset();
  handleWhatsAppImageEventMock.mockReset();
  handleWhatsAppAudioEventMock.mockReset();
  handleWhatsAppInteractiveEventMock.mockReset();
  handleWhatsAppTextEventMock.mockReset();
  safeLogMock.mockReset();
  vi.restoreAllMocks();
});

describe("whatsappWebhook", () => {
  beforeEach(() => {
    process.env.PRIVACY_PEPPER = TEST_PRIVACY_PEPPER;
  });

  afterEach(() => {
    if (originalPrivacyPepper === undefined) {
      delete process.env.PRIVACY_PEPPER;
    } else {
      process.env.PRIVACY_PEPPER = originalPrivacyPepper;
    }
  });

  it("routes explicit audio message types to the audio handler", async () => {
    extractWhatsAppEventsMock.mockReturnValue([
      {
        channel: "whatsapp",
        senderId: "+32123456",
        userId: "u1",
        messageType: "audio",
        rawMessageType: "audio",
        audioId: "audio-id",
      },
    ]);
    claimWebhookReplayKeyMock.mockResolvedValue(true);
    getOrCreateStateMock.mockResolvedValue({ consentGiven: true, userKey: "u1" });
    handleWhatsAppConsentGateMock.mockResolvedValue(false);

    const { processWhatsAppWebhookPayload } = await import("./_core/whatsappWebhook");
    await processWhatsAppWebhookPayload({ object: "whatsapp_business_account" });

    expect(handleWhatsAppAudioEventMock).toHaveBeenCalledTimes(1);
    expect(handleWhatsAppImageEventMock).not.toHaveBeenCalled();
    expect(handleWhatsAppTextEventMock).not.toHaveBeenCalled();
    expect(handleWhatsAppInteractiveEventMock).not.toHaveBeenCalled();
  });

  it("routes unknown message types that contain audioId to the audio handler", async () => {
    extractWhatsAppEventsMock.mockReturnValue([
      {
        channel: "whatsapp",
        senderId: "+32999999",
        userId: "u2",
        messageType: "unknown",
        rawMessageType: "ptt",
        audioId: "ptt-id",
      },
    ]);
    claimWebhookReplayKeyMock.mockResolvedValue(true);
    getOrCreateStateMock.mockResolvedValue({ consentGiven: true, userKey: "u2" });
    handleWhatsAppConsentGateMock.mockResolvedValue(false);

    const { processWhatsAppWebhookPayload } = await import("./_core/whatsappWebhook");
    await processWhatsAppWebhookPayload({ object: "whatsapp_business_account" });

    expect(handleWhatsAppAudioEventMock).toHaveBeenCalledTimes(1);
  });
});
