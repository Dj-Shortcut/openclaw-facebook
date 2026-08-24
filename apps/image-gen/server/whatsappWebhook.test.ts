import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  extractWhatsAppEventsMock,
  logWhatsAppWebhookPayloadMock,
  claimWebhookReplayKeyMock,
  deleteUserDataAndSendResultMock,
  handleWhatsAppConsentGateMock,
  isDeleteCommandMock,
  isWhatsAppPrivacyOrConsentControlMock,
  getErasingMessengerPrivacySubjectMock,
  getOrCreateStateMock,
  setLastUserMessageAtMock,
  sendWhatsAppButtonsReplyMock,
  sendWhatsAppErasureControlTextReplyMock,
  sendWhatsAppTextReplyMock,
  handleWhatsAppImageEventMock,
  handleWhatsAppAudioEventMock,
  handleWhatsAppInteractiveEventMock,
  handleWhatsAppTextEventMock,
  resolveWhatsAppGenerationOwnershipMock,
  admitWhatsAppGenerationScopeMock,
  safeLogMock,
} = vi.hoisted(() => ({
  extractWhatsAppEventsMock: vi.fn(),
  logWhatsAppWebhookPayloadMock: vi.fn(),
  claimWebhookReplayKeyMock: vi.fn(),
  deleteUserDataAndSendResultMock: vi.fn(),
  handleWhatsAppConsentGateMock: vi.fn(),
  isDeleteCommandMock: vi.fn(),
  isWhatsAppPrivacyOrConsentControlMock: vi.fn(),
  getErasingMessengerPrivacySubjectMock: vi.fn(),
  getOrCreateStateMock: vi.fn(),
  setLastUserMessageAtMock: vi.fn(),
  sendWhatsAppButtonsReplyMock: vi.fn(),
  sendWhatsAppErasureControlTextReplyMock: vi.fn(),
  sendWhatsAppTextReplyMock: vi.fn(),
  handleWhatsAppImageEventMock: vi.fn(),
  handleWhatsAppAudioEventMock: vi.fn(),
  handleWhatsAppInteractiveEventMock: vi.fn(),
  handleWhatsAppTextEventMock: vi.fn(),
  resolveWhatsAppGenerationOwnershipMock: vi.fn(),
  admitWhatsAppGenerationScopeMock: vi.fn(),
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
  deleteUserDataAndSendResult: deleteUserDataAndSendResultMock,
  handleWhatsAppConsentGate: handleWhatsAppConsentGateMock,
  isDeleteCommand: isDeleteCommandMock,
  isWhatsAppPrivacyOrConsentControl: isWhatsAppPrivacyOrConsentControlMock,
}));

vi.mock("./_core/messengerPrivacySubject", () => ({
  getErasingMessengerPrivacySubject: getErasingMessengerPrivacySubjectMock,
}));

vi.mock("./_core/messengerState", () => ({
  getOrCreateState: getOrCreateStateMock,
  setLastUserMessageAt: setLastUserMessageAtMock,
}));

vi.mock("./_core/whatsappResponseService", () => ({
  sendWhatsAppButtonsReply: sendWhatsAppButtonsReplyMock,
  sendWhatsAppErasureControlTextReply: sendWhatsAppErasureControlTextReplyMock,
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
  class WhatsAppGenerationScopeError extends Error {
    readonly retryable: boolean;

    constructor(options?: { retryable?: boolean }) {
      super("WhatsApp generation ownership is unavailable");
      this.name = "WhatsAppGenerationScopeError";
      this.retryable = options?.retryable === true;
    }
  }
  return {
    resolveWhatsAppGenerationOwnership: resolveWhatsAppGenerationOwnershipMock,
    admitWhatsAppGenerationScope: admitWhatsAppGenerationScopeMock,
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
  getMessengerRequestChannel,
  getMessengerRequestErasurePrivacySubject,
  isMessengerErasureControlDelivery,
} from "./_core/messengerRequestContext";

afterEach(() => {
  extractWhatsAppEventsMock.mockReset();
  logWhatsAppWebhookPayloadMock.mockReset();
  claimWebhookReplayKeyMock.mockReset();
  deleteUserDataAndSendResultMock.mockReset();
  handleWhatsAppConsentGateMock.mockReset();
  isDeleteCommandMock.mockReset();
  isWhatsAppPrivacyOrConsentControlMock.mockReset();
  getErasingMessengerPrivacySubjectMock.mockReset();
  getOrCreateStateMock.mockReset();
  setLastUserMessageAtMock.mockReset();
  sendWhatsAppButtonsReplyMock.mockReset();
  sendWhatsAppErasureControlTextReplyMock.mockReset();
  sendWhatsAppTextReplyMock.mockReset();
  handleWhatsAppImageEventMock.mockReset();
  handleWhatsAppAudioEventMock.mockReset();
  handleWhatsAppInteractiveEventMock.mockReset();
  handleWhatsAppTextEventMock.mockReset();
  resolveWhatsAppGenerationOwnershipMock.mockReset();
  admitWhatsAppGenerationScopeMock.mockReset();
  safeLogMock.mockReset();
  vi.restoreAllMocks();
});

describe("whatsappWebhook", () => {
  beforeEach(() => {
    process.env.PRIVACY_PEPPER = TEST_PRIVACY_PEPPER;
    isDeleteCommandMock.mockReturnValue(false);
    isWhatsAppPrivacyOrConsentControlMock.mockReturnValue(false);
    getErasingMessengerPrivacySubjectMock.mockResolvedValue(null);
    resolveWhatsAppGenerationOwnershipMock.mockResolvedValue({
      workspaceId: 42,
      channelConnectionId: 8,
      bindingEpoch: 3,
      userKey: "u2",
    });
    admitWhatsAppGenerationScopeMock.mockResolvedValue({
      workspaceId: 42,
      channelConnectionId: 8,
      bindingEpoch: 3,
      privacyEpoch: 2,
      userKey: "u2",
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
      expect(getMessengerRequestChannel()).toBe("whatsapp");
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

    expect(resolveWhatsAppGenerationOwnershipMock).toHaveBeenCalledWith({
      endpoint: {
        channel: "whatsapp",
        wabaId: "303030303030303",
        phoneNumberId: "404040404040404",
      },
      senderId: "32999999",
      userKey: "u2",
    });
    expect(admitWhatsAppGenerationScopeMock).toHaveBeenCalledWith({
      endpoint: {
        channel: "whatsapp",
        wabaId: "303030303030303",
        phoneNumberId: "404040404040404",
      },
      ownership: {
        workspaceId: 42,
        channelConnectionId: 8,
        bindingEpoch: 3,
        userKey: "u2",
      },
      eventOccurredAt: expect.any(Date),
      allowReactivation: true,
      allowCreation: true,
    });
    expect(handleWhatsAppTextEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        costLedgerScope: {
          workspaceId: 42,
          channelConnectionId: 8,
          bindingEpoch: 3,
          privacyEpoch: 2,
          userKey: "u2",
        },
      })
    );
    const replayKey = claimWebhookReplayKeyMock.mock.calls[0]?.[0];
    expect(replayKey).toMatch(/^whatsapp:v2:[a-f0-9]{64}:[a-f0-9]{64}$/);
    expect(replayKey).not.toContain("u2");
    expect(replayKey).not.toContain("maak een beeld");
  });

  it("routes privacy controls inside the exact tenant and subject fence", async () => {
    isWhatsAppPrivacyOrConsentControlMock.mockReturnValue(true);
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
    expect(admitWhatsAppGenerationScopeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowReactivation: false,
        allowCreation: true,
      })
    );
    expect(setLastUserMessageAtMock).not.toHaveBeenCalled();
    expect(handleWhatsAppTextEventMock).not.toHaveBeenCalled();
    expect(handleWhatsAppInteractiveEventMock).not.toHaveBeenCalled();
  });

  it("resumes an erasing WhatsApp subject only for a deletion control", async () => {
    isWhatsAppPrivacyOrConsentControlMock.mockReturnValue(true);
    isDeleteCommandMock.mockImplementation(value => value === "delete my data");
    getErasingMessengerPrivacySubjectMock.mockResolvedValue({
      privacyEpoch: 6,
      dataPrivacyEpoch: 5,
    });
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
        textBody: "delete my data",
      },
    ]);
    claimWebhookReplayKeyMock.mockResolvedValue(true);
    deleteUserDataAndSendResultMock.mockImplementation(
      async (_senderId, _lang, sendDeletionOutcome) => {
        expect(getMessengerRequestChannel()).toBe("whatsapp");
        expect(getMessengerRequestErasurePrivacySubject()).toEqual({
          userKey: "u2",
          privacyEpoch: 6,
          dataPrivacyEpoch: 5,
        });
        await sendDeletionOutcome("deletion outcome");
        expect(isMessengerErasureControlDelivery()).toBe(false);
      }
    );
    sendWhatsAppErasureControlTextReplyMock.mockImplementation(async () => {
      expect(isMessengerErasureControlDelivery()).toBe(true);
    });

    const { processWhatsAppWebhookPayload } =
      await import("./_core/whatsappWebhook");
    await processWhatsAppWebhookPayload({
      object: "whatsapp_business_account",
    });

    expect(getErasingMessengerPrivacySubjectMock).toHaveBeenCalledWith({
      workspaceId: 42,
      channelConnectionId: 8,
      bindingEpoch: 3,
      userKey: "u2",
    });
    expect(admitWhatsAppGenerationScopeMock).not.toHaveBeenCalled();
    expect(getOrCreateStateMock).not.toHaveBeenCalled();
    expect(deleteUserDataAndSendResultMock).toHaveBeenCalledOnce();
    expect(sendWhatsAppErasureControlTextReplyMock).toHaveBeenCalledWith(
      "32999999",
      "deletion outcome",
      expect.stringMatching(/^[a-f0-9]{64}$/)
    );
  });

  it("never opens handoff or dispatch when a recognized control is stale", async () => {
    isWhatsAppPrivacyOrConsentControlMock.mockReturnValue(true);
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
        textBody: "I agree",
      },
    ]);
    claimWebhookReplayKeyMock.mockResolvedValue(true);
    getOrCreateStateMock.mockResolvedValue({
      consentGiven: true,
      userKey: "u2",
    });
    // An already-consented state does not consume the textual acknowledgement.
    // The webhook classification must still prevent it becoming normal input.
    handleWhatsAppConsentGateMock.mockResolvedValue(false);

    const { processWhatsAppWebhookPayload } =
      await import("./_core/whatsappWebhook");
    await processWhatsAppWebhookPayload({
      object: "whatsapp_business_account",
    });

    expect(admitWhatsAppGenerationScopeMock).toHaveBeenCalledWith(
      expect.objectContaining({ allowReactivation: false })
    );
    expect(setLastUserMessageAtMock).not.toHaveBeenCalled();
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
    resolveWhatsAppGenerationOwnershipMock.mockResolvedValueOnce({
      workspaceId: 99,
      channelConnectionId: 18,
      bindingEpoch: 7,
      userKey: "u2",
    });
    admitWhatsAppGenerationScopeMock.mockResolvedValueOnce({
      workspaceId: 99,
      channelConnectionId: 18,
      bindingEpoch: 7,
      privacyEpoch: 2,
      userKey: "u2",
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
    resolveWhatsAppGenerationOwnershipMock.mockRejectedValue(
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

  it("admits privacy before claiming replay and keeps the request id stable", async () => {
    const event = {
      channel: "whatsapp" as const,
      endpoint: {
        channel: "whatsapp" as const,
        wabaId: "303030303030303",
        phoneNumberId: "404040404040404",
      },
      senderId: "32999999",
      userId: "u2",
      messageId: "wamid.stable",
      timestamp: 1_777_000_000_000,
      messageType: "text" as const,
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

    const requestIds: string[] = [];
    handleWhatsAppTextEventMock.mockImplementation((_event, context) => {
      requestIds.push(context.reqId);
    });
    const { processWhatsAppWebhookPayload } =
      await import("./_core/whatsappWebhook");
    await processWhatsAppWebhookPayload({
      object: "whatsapp_business_account",
    });
    await processWhatsAppWebhookPayload({
      object: "whatsapp_business_account",
    });

    expect(claimWebhookReplayKeyMock).toHaveBeenCalledTimes(2);
    expect(admitWhatsAppGenerationScopeMock).toHaveBeenCalledTimes(2);
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).toBe(requestIds[1]);
    expect(requestIds[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(
      admitWhatsAppGenerationScopeMock.mock.invocationCallOrder[0]
    ).toBeLessThan(claimWebhookReplayKeyMock.mock.invocationCallOrder[0]);
  });

  it("does not touch state or dispatch when a replay is rejected after admission", async () => {
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
        messageId: "wamid.replay",
        messageType: "text",
        rawMessageType: "text",
        textBody: "maak een beeld",
      },
    ]);
    claimWebhookReplayKeyMock.mockResolvedValue(false);

    const { processWhatsAppWebhookPayload } =
      await import("./_core/whatsappWebhook");
    await processWhatsAppWebhookPayload({
      object: "whatsapp_business_account",
    });

    expect(admitWhatsAppGenerationScopeMock).toHaveBeenCalledOnce();
    expect(getOrCreateStateMock).not.toHaveBeenCalled();
    expect(setLastUserMessageAtMock).not.toHaveBeenCalled();
    expect(handleWhatsAppTextEventMock).not.toHaveBeenCalled();
  });

  it("retries a transient admission failure without consuming replay", async () => {
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
        messageId: "wamid.transient-admission",
        messageType: "text",
        rawMessageType: "text",
        textBody: "maak een beeld",
      },
    ]);
    admitWhatsAppGenerationScopeMock
      .mockRejectedValueOnce(
        new WhatsAppGenerationScopeError({ retryable: true })
      )
      .mockResolvedValueOnce({
        workspaceId: 42,
        channelConnectionId: 8,
        bindingEpoch: 3,
        privacyEpoch: 2,
        userKey: "u2",
      });
    claimWebhookReplayKeyMock.mockResolvedValue(true);
    getOrCreateStateMock.mockResolvedValue({
      consentGiven: true,
      userKey: "u2",
    });
    handleWhatsAppConsentGateMock.mockResolvedValue(false);

    const { processWhatsAppWebhookPayload } =
      await import("./_core/whatsappWebhook");
    await expect(
      processWhatsAppWebhookPayload({ object: "whatsapp_business_account" })
    ).rejects.toBeInstanceOf(WhatsAppGenerationScopeError);
    expect(claimWebhookReplayKeyMock).not.toHaveBeenCalled();

    await expect(
      processWhatsAppWebhookPayload({ object: "whatsapp_business_account" })
    ).resolves.toBeUndefined();
    expect(claimWebhookReplayKeyMock).toHaveBeenCalledOnce();
    expect(handleWhatsAppTextEventMock).toHaveBeenCalledOnce();
  });

  it("keeps concurrent duplicates behind the post-admission replay claim", async () => {
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
        messageId: "wamid.concurrent",
        messageType: "text",
        rawMessageType: "text",
        textBody: "maak een beeld",
      },
    ]);
    claimWebhookReplayKeyMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    getOrCreateStateMock.mockResolvedValue({
      consentGiven: true,
      userKey: "u2",
    });
    handleWhatsAppConsentGateMock.mockResolvedValue(false);

    const { processWhatsAppWebhookPayload } =
      await import("./_core/whatsappWebhook");
    await Promise.all([
      processWhatsAppWebhookPayload({ object: "whatsapp_business_account" }),
      processWhatsAppWebhookPayload({ object: "whatsapp_business_account" }),
    ]);

    expect(admitWhatsAppGenerationScopeMock).toHaveBeenCalledTimes(2);
    expect(claimWebhookReplayKeyMock).toHaveBeenCalledTimes(2);
    expect(handleWhatsAppTextEventMock).toHaveBeenCalledOnce();
  });

  it("sends a generic handler fallback inside the verified tenant context", async () => {
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
        messageId: "wamid.fallback",
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
    handleWhatsAppTextEventMock.mockRejectedValue(new Error("handler failed"));
    sendWhatsAppTextReplyMock.mockImplementation(async () => {
      expect(getMessengerRequestChannel()).toBe("whatsapp");
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
    await expect(
      processWhatsAppWebhookPayload({ object: "whatsapp_business_account" })
    ).resolves.toBeUndefined();

    expect(sendWhatsAppTextReplyMock).toHaveBeenCalledWith(
      "32999999",
      "localized message"
    );
  });

  it("never sends the generic fallback for a terminal scope denial", async () => {
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
        messageId: "wamid.scope-denied",
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
    handleWhatsAppTextEventMock.mockRejectedValue(
      new WhatsAppGenerationScopeError()
    );

    const { processWhatsAppWebhookPayload } =
      await import("./_core/whatsappWebhook");
    await expect(
      processWhatsAppWebhookPayload({ object: "whatsapp_business_account" })
    ).resolves.toBeUndefined();

    expect(sendWhatsAppTextReplyMock).not.toHaveBeenCalled();
  });

  it("never sends a second fallback after an ambiguous Graph outcome", async () => {
    const { WhatsAppDeliveryError } = await import("./_core/whatsappApi");
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
        messageId: "wamid.delivery-ambiguous",
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
    handleWhatsAppTextEventMock.mockRejectedValue(
      new WhatsAppDeliveryError("ambiguous", "a".repeat(64))
    );

    const { processWhatsAppWebhookPayload } =
      await import("./_core/whatsappWebhook");
    await expect(
      processWhatsAppWebhookPayload({ object: "whatsapp_business_account" })
    ).rejects.toMatchObject({
      name: "WhatsAppDeliveryError",
      outcome: "ambiguous",
    });

    expect(sendWhatsAppTextReplyMock).not.toHaveBeenCalled();
  });
});
