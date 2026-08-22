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
  resolveWhatsAppGenerationScopeMock,
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
  resolveWhatsAppGenerationScopeMock: vi.fn(),
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

vi.mock("./_core/whatsappGenerationScope", () => {
  class WhatsAppGenerationScopeError extends Error {}
  return {
    resolveWhatsAppGenerationScope: resolveWhatsAppGenerationScopeMock,
    WhatsAppGenerationScopeError,
  };
});

vi.mock("./_core/logger", async () => {
  const actual =
    await vi.importActual<typeof import("./_core/logger")>("./_core/logger");

  return {
    ...actual,
    safeLog: safeLogMock,
  };
});

vi.mock("./_core/i18n", () => ({
  t: vi.fn(() => "localized message"),
  normalizeLang: vi.fn(() => "nl"),
}));

import {
  getMessengerRequestOwnership,
  getMessengerRequestPageId,
  getMessengerRequestPrivacySubject,
} from "./_core/messengerRequestContext";

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
  resolveWhatsAppGenerationScopeMock.mockReset();
  safeLogMock.mockReset();
  vi.restoreAllMocks();
});

describe("whatsappWebhook", () => {
  beforeEach(() => {
    process.env.PRIVACY_PEPPER = TEST_PRIVACY_PEPPER;
    resolveWhatsAppGenerationScopeMock.mockResolvedValue({
      workspaceId: 42,
      channelConnectionId: 8,
      bindingEpoch: 3,
      privacyEpoch: 2,
    });
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
        endpoint: {
          channel: "whatsapp",
          wabaId: "303030303030303",
          phoneNumberId: "404040404040404",
        },
        senderId: "+32123456",
        userId: "u1",
        messageType: "audio",
        rawMessageType: "audio",
        audioId: "audio-id",
      },
    ]);
    claimWebhookReplayKeyMock.mockResolvedValue(true);
    getOrCreateStateMock.mockResolvedValue({
      consentGiven: true,
      userKey: "u1",
    });
    handleWhatsAppConsentGateMock.mockResolvedValue(false);
    const { processWhatsAppWebhookPayload } =
      await import("./_core/whatsappWebhook");
    await processWhatsAppWebhookPayload({
      object: "whatsapp_business_account",
    });

    expect(handleWhatsAppAudioEventMock).toHaveBeenCalledTimes(1);
    expect(handleWhatsAppImageEventMock).not.toHaveBeenCalled();
    expect(handleWhatsAppTextEventMock).not.toHaveBeenCalled();
    expect(handleWhatsAppInteractiveEventMock).not.toHaveBeenCalled();
  });

  it("routes unknown message types that contain audioId to the audio handler", async () => {
    extractWhatsAppEventsMock.mockReturnValue([
      {
        channel: "whatsapp",
        endpoint: {
          channel: "whatsapp",
          wabaId: "303030303030303",
          phoneNumberId: "404040404040404",
        },
        senderId: "+32999999",
        userId: "u2",
        messageType: "unknown",
        rawMessageType: "ptt",
        audioId: "ptt-id",
      },
    ]);
    claimWebhookReplayKeyMock.mockResolvedValue(true);
    getOrCreateStateMock.mockResolvedValue({
      consentGiven: true,
      userKey: "u2",
    });
    handleWhatsAppConsentGateMock.mockResolvedValue(false);
    const { processWhatsAppWebhookPayload } =
      await import("./_core/whatsappWebhook");
    await processWhatsAppWebhookPayload({
      object: "whatsapp_business_account",
    });

    expect(handleWhatsAppAudioEventMock).toHaveBeenCalledTimes(1);
  });

  it("carries exact immutable tenant scope into channel handlers", async () => {
    extractWhatsAppEventsMock.mockReturnValue([
      {
        channel: "whatsapp",
        endpoint: {
          channel: "whatsapp",
          wabaId: "303030303030303",
          phoneNumberId: "404040404040404",
        },
        senderId: "32999999",
        userId: "u2",
        messageType: "text",
        rawMessageType: "text",
        textBody: "maak een beeld",
      },
    ]);
    claimWebhookReplayKeyMock.mockResolvedValue(true);
    getOrCreateStateMock.mockResolvedValue({
      consentGiven: true,
      userKey: "u2",
    });
    handleWhatsAppConsentGateMock.mockResolvedValue(false);
    handleWhatsAppTextEventMock.mockImplementation(async () => {
      expect(getMessengerRequestPageId()).toBe("404040404040404");
      expect(getMessengerRequestOwnership()).toEqual({
        workspaceId: 42,
        channelConnectionId: 8,
        bindingEpoch: 3,
      });
      expect(getMessengerRequestPrivacySubject()).toEqual({
        userKey: "u2",
        privacyEpoch: 2,
      });
    });

    const { processWhatsAppWebhookPayload } =
      await import("./_core/whatsappWebhook");
    await processWhatsAppWebhookPayload({
      object: "whatsapp_business_account",
    });

    expect(resolveWhatsAppGenerationScopeMock).toHaveBeenCalledWith({
      endpoint: {
        channel: "whatsapp",
        wabaId: "303030303030303",
        phoneNumberId: "404040404040404",
      },
      senderId: "32999999",
      userKey: "u2",
    });
    expect(handleWhatsAppTextEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        costLedgerScope: {
          workspaceId: 42,
          channelConnectionId: 8,
          bindingEpoch: 3,
          privacyEpoch: 2,
        },
      })
    );
    const replayKey = claimWebhookReplayKeyMock.mock.calls[0]?.[0];
    expect(replayKey).toMatch(/^whatsapp:v2:[a-f0-9]{64}:[a-f0-9]{64}$/);
    expect(replayKey).not.toContain("u2");
    expect(replayKey).not.toContain("maak een beeld");
  });

  it("routes privacy controls inside the exact tenant and subject fence", async () => {
    extractWhatsAppEventsMock.mockReturnValue([
      {
        channel: "whatsapp",
        endpoint: {
          channel: "whatsapp",
          wabaId: "303030303030303",
          phoneNumberId: "404040404040404",
        },
        senderId: "32999999",
        userId: "u2",
        messageType: "interactive",
        rawMessageType: "interactive",
        rawEventMeta: { interactiveReplyId: "GDPR_DELETE_CONFIRM" },
      },
    ]);
    claimWebhookReplayKeyMock.mockResolvedValue(true);
    getOrCreateStateMock.mockResolvedValue({
      consentGiven: true,
      userKey: "u2",
      pendingDeleteConfirm: true,
    });
    handleWhatsAppConsentGateMock.mockImplementation(async () => {
      expect(getMessengerRequestPageId()).toBe("404040404040404");
      expect(getMessengerRequestOwnership()).toEqual({
        workspaceId: 42,
        channelConnectionId: 8,
        bindingEpoch: 3,
      });
      expect(getMessengerRequestPrivacySubject()).toEqual({
        userKey: "u2",
        privacyEpoch: 2,
      });
      return true;
    });

    const { processWhatsAppWebhookPayload } =
      await import("./_core/whatsappWebhook");
    await processWhatsAppWebhookPayload({
      object: "whatsapp_business_account",
    });

    expect(handleWhatsAppConsentGateMock).toHaveBeenCalledTimes(1);
    expect(handleWhatsAppTextEventMock).not.toHaveBeenCalled();
    expect(handleWhatsAppInteractiveEventMock).not.toHaveBeenCalled();
  });

  it("does not deduplicate the same provider message id across tenant endpoints", async () => {
    const event = {
      channel: "whatsapp",
      endpoint: {
        channel: "whatsapp",
        wabaId: "303030303030303",
        phoneNumberId: "404040404040404",
      },
      senderId: "32999999",
      userId: "u2",
      messageId: "same-provider-message",
      messageType: "text",
      rawMessageType: "text",
      textBody: "maak een beeld",
    };
    extractWhatsAppEventsMock.mockReturnValue([event]);
    claimWebhookReplayKeyMock.mockResolvedValue(true);
    getOrCreateStateMock.mockResolvedValue({
      consentGiven: true,
      userKey: "u2",
    });
    handleWhatsAppConsentGateMock.mockResolvedValue(false);

    const { processWhatsAppWebhookPayload } =
      await import("./_core/whatsappWebhook");
    await processWhatsAppWebhookPayload({
      object: "whatsapp_business_account",
    });
    const firstKey = claimWebhookReplayKeyMock.mock.calls[0]?.[0];

    extractWhatsAppEventsMock.mockReturnValue([
      {
        ...event,
        endpoint: {
          channel: "whatsapp",
          wabaId: "606060606060606",
          phoneNumberId: "707070707070707",
        },
      },
    ]);
    resolveWhatsAppGenerationScopeMock.mockResolvedValueOnce({
      workspaceId: 99,
      channelConnectionId: 18,
      bindingEpoch: 7,
      privacyEpoch: 2,
    });
    await processWhatsAppWebhookPayload({
      object: "whatsapp_business_account",
    });
    const secondKey = claimWebhookReplayKeyMock.mock.calls[1]?.[0];

    expect(firstKey).not.toBe(secondKey);
    expect(handleWhatsAppTextEventMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed before replay, state, or handlers when ownership is unavailable", async () => {
    const { WhatsAppGenerationScopeError } =
      await import("./_core/whatsappGenerationScope");
    extractWhatsAppEventsMock.mockReturnValue([
      {
        channel: "whatsapp",
        endpoint: {
          channel: "whatsapp",
          wabaId: "303030303030303",
          phoneNumberId: "404040404040404",
        },
        senderId: "32999999",
        userId: "u2",
        messageType: "text",
        rawMessageType: "text",
        textBody: "maak een beeld",
      },
    ]);
    resolveWhatsAppGenerationScopeMock.mockRejectedValue(
      new WhatsAppGenerationScopeError()
    );

    const { processWhatsAppWebhookPayload } =
      await import("./_core/whatsappWebhook");
    await processWhatsAppWebhookPayload({
      object: "whatsapp_business_account",
    });

    expect(claimWebhookReplayKeyMock).not.toHaveBeenCalled();
    expect(getOrCreateStateMock).not.toHaveBeenCalled();
    expect(handleWhatsAppTextEventMock).not.toHaveBeenCalled();
    expect(sendWhatsAppTextReplyMock).not.toHaveBeenCalled();
  });
});
