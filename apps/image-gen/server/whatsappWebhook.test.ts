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
    const [audioHandler, imageHandler, interactiveHandler, textHandler] = await Promise.all([
      import("./_core/whatsappHandlers/audioHandler"),
      import("./_core/whatsappHandlers/imageHandler"),
      import("./_core/whatsappHandlers/interactiveHandler"),
      import("./_core/whatsappHandlers/textHandler"),
    ]);
    const imageSpy = vi.spyOn(imageHandler, "handleWhatsAppImageEvent");
    const interactiveSpy = vi.spyOn(interactiveHandler, "handleWhatsAppInteractiveEvent");
    const textSpy = vi.spyOn(textHandler, "handleWhatsAppTextEvent");
    const audioSpy = vi
      .spyOn(audioHandler, "handleWhatsAppAudioEvent")
      .mockResolvedValue(undefined);
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

    expect(audioSpy).toHaveBeenCalledTimes(1);
    expect(imageSpy).not.toHaveBeenCalled();
    expect(textSpy).not.toHaveBeenCalled();
    expect(interactiveSpy).not.toHaveBeenCalled();
  });

  it("routes unknown message types that contain audioId to the audio handler", async () => {
    const audioHandler = await import("./_core/whatsappHandlers/audioHandler");
    const audioSpy = vi
      .spyOn(audioHandler, "handleWhatsAppAudioEvent")
      .mockResolvedValue(undefined);
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

    expect(audioSpy).toHaveBeenCalledTimes(1);
  });
});
