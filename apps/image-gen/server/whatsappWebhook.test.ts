import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  extractWhatsAppEventsMock,
  logWhatsAppWebhookPayloadMock,
  claimWhatsAppWebhookReplayLeaseMock,
  completeWhatsAppWebhookReplayLeaseMock,
  markWhatsAppWebhookEffectsStartedMock,
  markWhatsAppWebhookFallbackPendingMock,
  releaseWhatsAppWebhookReplayLeaseMock,
  runWithWhatsAppWebhookReplayLeaseHeartbeatMock,
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
  assertWhatsAppGenerationScopeActiveMock,
  safeLogMock,
} = vi.hoisted(() => ({
  extractWhatsAppEventsMock: vi.fn(),
  logWhatsAppWebhookPayloadMock: vi.fn(),
  claimWhatsAppWebhookReplayLeaseMock: vi.fn(),
  completeWhatsAppWebhookReplayLeaseMock: vi.fn(),
  markWhatsAppWebhookEffectsStartedMock: vi.fn(),
  markWhatsAppWebhookFallbackPendingMock: vi.fn(),
  releaseWhatsAppWebhookReplayLeaseMock: vi.fn(),
  runWithWhatsAppWebhookReplayLeaseHeartbeatMock: vi.fn(),
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
  assertWhatsAppGenerationScopeActiveMock: vi.fn(),
  safeLogMock: vi.fn(),
}));

const TEST_PRIVACY_PEPPER = "ci-whatsapp-pepper";
const originalPrivacyPepper = process.env.PRIVACY_PEPPER;
const REPLAY_LEASE = Object.freeze({
  replayKey: `webhook-replay:whatsapp:v2:${"a".repeat(64)}:${"b".repeat(64)}`,
  ownerToken: `wr1.${"c".repeat(32)}`,
  mode: "event" as const,
});
const FALLBACK_REPLAY_LEASE = Object.freeze({
  ...REPLAY_LEASE,
  ownerToken: `wr1.${"d".repeat(32)}`,
  mode: "fallback" as const,
});
const ACQUIRED_REPLAY_CLAIM = Object.freeze({
  status: "acquired" as const,
  lease: REPLAY_LEASE,
});
const DUPLICATE_REPLAY_CLAIM = Object.freeze({ status: "duplicate" as const });

vi.mock("./_core/inbound/whatsappInbound", () => ({
  extractWhatsAppEvents: (payload: unknown) => {
    const events = extractWhatsAppEventsMock(payload) as Array<
      Record<string, unknown>
    >;
    return events.map(event => ({
      timestamp: 1_777_000_000_000,
      ...event,
    }));
  },
  logWhatsAppWebhookPayload: logWhatsAppWebhookPayloadMock,
}));

vi.mock("./_core/webhookReplayProtection", () => ({
  claimWhatsAppWebhookReplayLease: claimWhatsAppWebhookReplayLeaseMock,
  completeWhatsAppWebhookReplayLease: completeWhatsAppWebhookReplayLeaseMock,
  markWhatsAppWebhookEffectsStarted: markWhatsAppWebhookEffectsStartedMock,
  markWhatsAppWebhookFallbackPending: markWhatsAppWebhookFallbackPendingMock,
  releaseWhatsAppWebhookReplayLease: releaseWhatsAppWebhookReplayLeaseMock,
  runWithWhatsAppWebhookReplayLeaseHeartbeat:
    runWithWhatsAppWebhookReplayLeaseHeartbeatMock,
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
    assertWhatsAppGenerationScopeActive:
      assertWhatsAppGenerationScopeActiveMock,
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
  claimWhatsAppWebhookReplayLeaseMock.mockReset();
  completeWhatsAppWebhookReplayLeaseMock.mockReset();
  markWhatsAppWebhookEffectsStartedMock.mockReset();
  markWhatsAppWebhookFallbackPendingMock.mockReset();
  releaseWhatsAppWebhookReplayLeaseMock.mockReset();
  runWithWhatsAppWebhookReplayLeaseHeartbeatMock.mockReset();
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
  assertWhatsAppGenerationScopeActiveMock.mockReset();
  safeLogMock.mockReset();
  vi.restoreAllMocks();
});

describe("whatsappWebhook", () => {
  beforeEach(() => {
    process.env.PRIVACY_PEPPER = TEST_PRIVACY_PEPPER;
    isDeleteCommandMock.mockReturnValue(false);
    isWhatsAppPrivacyOrConsentControlMock.mockReturnValue(false);
    getErasingMessengerPrivacySubjectMock.mockResolvedValue(null);
    runWithWhatsAppWebhookReplayLeaseHeartbeatMock.mockImplementation(
      async (_lease, callback) => await callback()
    );
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
    assertWhatsAppGenerationScopeActiveMock.mockResolvedValue(undefined);
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
    claimWhatsAppWebhookReplayLeaseMock.mockResolvedValue(
      ACQUIRED_REPLAY_CLAIM
    );
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
    claimWhatsAppWebhookReplayLeaseMock.mockResolvedValue(
      ACQUIRED_REPLAY_CLAIM
    );
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
    claimWhatsAppWebhookReplayLeaseMock.mockResolvedValue(
      ACQUIRED_REPLAY_CLAIM
    );
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
    const replayKey = claimWhatsAppWebhookReplayLeaseMock.mock.calls[0]?.[0];
    expect(replayKey).toMatch(/^whatsapp:v2:[a-f0-9]{64}:[a-f0-9]{64}$/);
    expect(replayKey).not.toContain("u2");
    expect(replayKey).not.toContain("maak een beeld");
  });

  it("drops an event without a stable timestamp before admission or replay", async () => {
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
        messageId: "wamid.no-timestamp",
        messageType: "text",
        rawMessageType: "text",
        textBody: "maak een beeld",
        timestamp: undefined,
      },
    ]);

    const { processWhatsAppWebhookPayload } =
      await import("./_core/whatsappWebhook");
    await expect(
      processWhatsAppWebhookPayload({ object: "whatsapp_business_account" })
    ).resolves.toBeUndefined();

    expect(admitWhatsAppGenerationScopeMock).not.toHaveBeenCalled();
    expect(claimWhatsAppWebhookReplayLeaseMock).not.toHaveBeenCalled();
    expect(handleWhatsAppTextEventMock).not.toHaveBeenCalled();
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
    claimWhatsAppWebhookReplayLeaseMock.mockResolvedValue(
      ACQUIRED_REPLAY_CLAIM
    );
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

  it("rechecks an ingress-bound active scope without readmitting privacy", async () => {
    const expectedScope = {
      workspaceId: 42,
      channelConnectionId: 8,
      bindingEpoch: 3,
      privacyEpoch: 2,
      userKey: "u2",
    };
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
        messageId: "wamid.ingress-scope",
        messageType: "text",
        rawMessageType: "text",
        textBody: "maak een beeld",
      },
    ]);
    claimWhatsAppWebhookReplayLeaseMock.mockResolvedValue(
      ACQUIRED_REPLAY_CLAIM
    );
    getOrCreateStateMock.mockResolvedValue({
      consentGiven: true,
      userKey: "u2",
    });
    handleWhatsAppConsentGateMock.mockResolvedValue(false);

    const { processWhatsAppWebhookPayload } =
      await import("./_core/whatsappWebhook");
    await processWhatsAppWebhookPayload(
      { object: "whatsapp_business_account" },
      { expectedScope }
    );

    expect(admitWhatsAppGenerationScopeMock).not.toHaveBeenCalled();
    expect(assertWhatsAppGenerationScopeActiveMock).toHaveBeenCalledWith({
      endpoint: {
        channel: "whatsapp",
        wabaId: "303030303030303",
        phoneNumberId: "404040404040404",
      },
      scope: expectedScope,
    });
    expect(
      assertWhatsAppGenerationScopeActiveMock.mock.invocationCallOrder[0]
    ).toBeLessThan(
      claimWhatsAppWebhookReplayLeaseMock.mock.invocationCallOrder[0]
    );
  });

  it("rejects an ingress ownership mismatch before claiming replay", async () => {
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
        messageId: "wamid.wrong-ingress-scope",
        messageType: "text",
        rawMessageType: "text",
        textBody: "maak een beeld",
      },
    ]);

    const { processWhatsAppWebhookPayload } =
      await import("./_core/whatsappWebhook");
    await expect(
      processWhatsAppWebhookPayload(
        { object: "whatsapp_business_account" },
        {
          expectedScope: {
            workspaceId: 99,
            channelConnectionId: 8,
            bindingEpoch: 3,
            privacyEpoch: 2,
            userKey: "u2",
          },
        }
      )
    ).resolves.toBeUndefined();

    expect(assertWhatsAppGenerationScopeActiveMock).not.toHaveBeenCalled();
    expect(claimWhatsAppWebhookReplayLeaseMock).not.toHaveBeenCalled();
    expect(getOrCreateStateMock).not.toHaveBeenCalled();
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
    claimWhatsAppWebhookReplayLeaseMock.mockResolvedValue(
      ACQUIRED_REPLAY_CLAIM
    );
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
    await processWhatsAppWebhookPayload(
      { object: "whatsapp_business_account" },
      {
        expectedScope: {
          workspaceId: 42,
          channelConnectionId: 8,
          bindingEpoch: 3,
          privacyEpoch: 6,
          userKey: "u2",
        },
      }
    );

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

  it("rejects an ingress erasure epoch mismatch before claiming replay", async () => {
    isWhatsAppPrivacyOrConsentControlMock.mockReturnValue(true);
    isDeleteCommandMock.mockReturnValue(true);
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

    const { processWhatsAppWebhookPayload } =
      await import("./_core/whatsappWebhook");
    await expect(
      processWhatsAppWebhookPayload(
        { object: "whatsapp_business_account" },
        {
          expectedScope: {
            workspaceId: 42,
            channelConnectionId: 8,
            bindingEpoch: 3,
            privacyEpoch: 7,
            userKey: "u2",
          },
        }
      )
    ).resolves.toBeUndefined();

    expect(claimWhatsAppWebhookReplayLeaseMock).not.toHaveBeenCalled();
    expect(deleteUserDataAndSendResultMock).not.toHaveBeenCalled();
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
    claimWhatsAppWebhookReplayLeaseMock.mockResolvedValue(
      ACQUIRED_REPLAY_CLAIM
    );
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
    claimWhatsAppWebhookReplayLeaseMock.mockResolvedValue(
      ACQUIRED_REPLAY_CLAIM
    );
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
    const firstKey = claimWhatsAppWebhookReplayLeaseMock.mock.calls[0]?.[0];

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
    const secondKey = claimWhatsAppWebhookReplayLeaseMock.mock.calls[1]?.[0];

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

    expect(claimWhatsAppWebhookReplayLeaseMock).not.toHaveBeenCalled();
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
    claimWhatsAppWebhookReplayLeaseMock.mockResolvedValue(
      ACQUIRED_REPLAY_CLAIM
    );
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

    expect(claimWhatsAppWebhookReplayLeaseMock).toHaveBeenCalledTimes(2);
    expect(admitWhatsAppGenerationScopeMock).toHaveBeenCalledTimes(2);
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).toBe(requestIds[1]);
    expect(requestIds[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(
      admitWhatsAppGenerationScopeMock.mock.invocationCallOrder[0]
    ).toBeLessThan(
      claimWhatsAppWebhookReplayLeaseMock.mock.invocationCallOrder[0]
    );
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
    claimWhatsAppWebhookReplayLeaseMock.mockResolvedValue(
      DUPLICATE_REPLAY_CLAIM
    );

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
    claimWhatsAppWebhookReplayLeaseMock.mockResolvedValue(
      ACQUIRED_REPLAY_CLAIM
    );
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
    expect(claimWhatsAppWebhookReplayLeaseMock).not.toHaveBeenCalled();

    await expect(
      processWhatsAppWebhookPayload({ object: "whatsapp_business_account" })
    ).resolves.toBeUndefined();
    expect(claimWhatsAppWebhookReplayLeaseMock).toHaveBeenCalledOnce();
    expect(handleWhatsAppTextEventMock).toHaveBeenCalledOnce();
  });

  it("does not replay when the first state write reports a retryable failure", async () => {
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
        messageId: "wamid.retryable-after-claim",
        messageType: "text",
        rawMessageType: "text",
        textBody: "maak een beeld",
      },
    ]);
    claimWhatsAppWebhookReplayLeaseMock.mockResolvedValue(
      ACQUIRED_REPLAY_CLAIM
    );
    getOrCreateStateMock.mockRejectedValueOnce(
      new WhatsAppGenerationScopeError({ retryable: true })
    );
    handleWhatsAppConsentGateMock.mockResolvedValue(false);
    handleWhatsAppTextEventMock.mockResolvedValue(undefined);

    const { processWhatsAppWebhookPayload } =
      await import("./_core/whatsappWebhook");
    await expect(
      processWhatsAppWebhookPayload({ object: "whatsapp_business_account" })
    ).rejects.toBeInstanceOf(WhatsAppGenerationScopeError);
    expect(completeWhatsAppWebhookReplayLeaseMock).toHaveBeenCalledWith(
      REPLAY_LEASE
    );
    expect(releaseWhatsAppWebhookReplayLeaseMock).not.toHaveBeenCalled();
    expect(handleWhatsAppTextEventMock).not.toHaveBeenCalled();
  });

  it("releases for a full retry without effects when phase sealing fails", async () => {
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
        messageId: "wamid.phase-seal-failed",
        messageType: "text",
        rawMessageType: "text",
        textBody: "maak een beeld",
      },
    ]);
    claimWhatsAppWebhookReplayLeaseMock.mockResolvedValue(
      ACQUIRED_REPLAY_CLAIM
    );
    markWhatsAppWebhookEffectsStartedMock.mockRejectedValueOnce(
      new Error("replay store unavailable")
    );

    const { processWhatsAppWebhookPayload } =
      await import("./_core/whatsappWebhook");
    await expect(
      processWhatsAppWebhookPayload({ object: "whatsapp_business_account" })
    ).rejects.toThrow("replay store unavailable");

    expect(releaseWhatsAppWebhookReplayLeaseMock).toHaveBeenCalledWith(
      REPLAY_LEASE
    );
    expect(getOrCreateStateMock).not.toHaveBeenCalled();
    expect(handleWhatsAppTextEventMock).not.toHaveBeenCalled();
    expect(sendWhatsAppTextReplyMock).not.toHaveBeenCalled();
    expect(completeWhatsAppWebhookReplayLeaseMock).not.toHaveBeenCalled();
  });

  it("never releases a retryable scope failure after effects may have started", async () => {
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
        messageId: "wamid.retryable-after-effects",
        messageType: "text",
        rawMessageType: "text",
        textBody: "maak een beeld",
      },
    ]);
    claimWhatsAppWebhookReplayLeaseMock.mockResolvedValue(
      ACQUIRED_REPLAY_CLAIM
    );
    getOrCreateStateMock.mockResolvedValue({
      consentGiven: true,
      userKey: "u2",
    });
    handleWhatsAppConsentGateMock.mockResolvedValue(false);
    handleWhatsAppTextEventMock.mockRejectedValue(
      new WhatsAppGenerationScopeError({ retryable: true })
    );

    const { processWhatsAppWebhookPayload } =
      await import("./_core/whatsappWebhook");
    await expect(
      processWhatsAppWebhookPayload({ object: "whatsapp_business_account" })
    ).rejects.toBeInstanceOf(WhatsAppGenerationScopeError);

    expect(completeWhatsAppWebhookReplayLeaseMock).toHaveBeenCalledWith(
      REPLAY_LEASE
    );
    expect(releaseWhatsAppWebhookReplayLeaseMock).not.toHaveBeenCalled();
  });

  it("fails retryably while another owner is still processing", async () => {
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
    const busyError = Object.assign(new Error("replay lease busy"), {
      code: "claim_busy",
      retryable: true,
    });
    claimWhatsAppWebhookReplayLeaseMock
      .mockResolvedValueOnce(ACQUIRED_REPLAY_CLAIM)
      .mockRejectedValueOnce(busyError);
    getOrCreateStateMock.mockResolvedValue({
      consentGiven: true,
      userKey: "u2",
    });
    handleWhatsAppConsentGateMock.mockResolvedValue(false);

    const { processWhatsAppWebhookPayload } =
      await import("./_core/whatsappWebhook");
    const outcomes = await Promise.allSettled([
      processWhatsAppWebhookPayload({ object: "whatsapp_business_account" }),
      processWhatsAppWebhookPayload({ object: "whatsapp_business_account" }),
    ]);

    expect(
      outcomes.filter(outcome => outcome.status === "fulfilled")
    ).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === "rejected")).toEqual([
      expect.objectContaining({ reason: busyError }),
    ]);
    expect(admitWhatsAppGenerationScopeMock).toHaveBeenCalledTimes(2);
    expect(claimWhatsAppWebhookReplayLeaseMock).toHaveBeenCalledTimes(2);
    expect(handleWhatsAppTextEventMock).toHaveBeenCalledOnce();
    expect(completeWhatsAppWebhookReplayLeaseMock).toHaveBeenCalledOnce();
    expect(releaseWhatsAppWebhookReplayLeaseMock).not.toHaveBeenCalled();
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
    claimWhatsAppWebhookReplayLeaseMock.mockResolvedValue(
      ACQUIRED_REPLAY_CLAIM
    );
    getOrCreateStateMock.mockResolvedValue({
      consentGiven: true,
      userKey: "u2",
    });
    handleWhatsAppConsentGateMock.mockResolvedValue(false);
    handleWhatsAppTextEventMock.mockRejectedValue(new Error("handler failed"));
    let observedContext:
      | {
          channel: unknown;
          ownership: unknown;
          privacy: unknown;
        }
      | undefined;
    sendWhatsAppTextReplyMock.mockImplementation(async () => {
      observedContext = {
        channel: getMessengerRequestChannel(),
        ownership: getMessengerRequestOwnership(),
        privacy: getMessengerRequestPrivacySubject(),
      };
    });

    const { processWhatsAppWebhookPayload } =
      await import("./_core/whatsappWebhook");
    await expect(
      processWhatsAppWebhookPayload({ object: "whatsapp_business_account" })
    ).resolves.toBeUndefined();

    expect(observedContext).toEqual({
      channel: "whatsapp",
      ownership: {
        workspaceId: 42,
        channelConnectionId: 8,
        bindingEpoch: 3,
      },
      privacy: { userKey: "u2", privacyEpoch: 2 },
    });
    expect(sendWhatsAppTextReplyMock).toHaveBeenCalledWith(
      "32999999",
      "localized message",
      expect.stringMatching(/^[a-f0-9]{64}$/),
      "error-fallback"
    );
  });

  it("retries a pre-transport fallback without rerunning ordinary effects", async () => {
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
        messageId: "wamid.fallback-retry",
        messageType: "text",
        rawMessageType: "text",
        textBody: "maak een beeld",
      },
    ]);
    claimWhatsAppWebhookReplayLeaseMock
      .mockResolvedValueOnce(ACQUIRED_REPLAY_CLAIM)
      .mockResolvedValueOnce({
        status: "acquired" as const,
        lease: FALLBACK_REPLAY_LEASE,
      });
    getOrCreateStateMock.mockResolvedValue({
      consentGiven: true,
      userKey: "u2",
    });
    handleWhatsAppConsentGateMock.mockResolvedValue(false);
    handleWhatsAppTextEventMock.mockRejectedValue(new Error("handler failed"));
    sendWhatsAppTextReplyMock
      .mockRejectedValueOnce(new WhatsAppDeliveryError("pre_transport", null))
      .mockResolvedValueOnce(undefined);

    const { processWhatsAppWebhookPayload } =
      await import("./_core/whatsappWebhook");
    await expect(
      processWhatsAppWebhookPayload({ object: "whatsapp_business_account" })
    ).rejects.toThrow("WhatsApp handler and fallback delivery failed");

    expect(markWhatsAppWebhookFallbackPendingMock).toHaveBeenCalledWith(
      REPLAY_LEASE
    );
    expect(markWhatsAppWebhookEffectsStartedMock).toHaveBeenCalledBefore(
      getOrCreateStateMock
    );
    expect(completeWhatsAppWebhookReplayLeaseMock).not.toHaveBeenCalled();
    const firstFallbackOperationId =
      sendWhatsAppTextReplyMock.mock.calls[0]?.[2];

    await expect(
      processWhatsAppWebhookPayload({ object: "whatsapp_business_account" })
    ).resolves.toBeUndefined();

    expect(getOrCreateStateMock).toHaveBeenCalledOnce();
    expect(handleWhatsAppTextEventMock).toHaveBeenCalledOnce();
    expect(sendWhatsAppTextReplyMock).toHaveBeenCalledTimes(2);
    expect(sendWhatsAppTextReplyMock.mock.calls[1]?.[2]).toBe(
      firstFallbackOperationId
    );
    expect(completeWhatsAppWebhookReplayLeaseMock).toHaveBeenCalledWith(
      FALLBACK_REPLAY_LEASE
    );
  });

  it("returns a fallback-only pre-transport failure to pending", async () => {
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
        messageId: "wamid.fallback-remains-pending",
        messageType: "text",
        rawMessageType: "text",
        textBody: "maak een beeld",
      },
    ]);
    claimWhatsAppWebhookReplayLeaseMock.mockResolvedValue({
      status: "acquired" as const,
      lease: FALLBACK_REPLAY_LEASE,
    });
    sendWhatsAppTextReplyMock.mockRejectedValue(
      new WhatsAppDeliveryError("pre_transport", null)
    );

    const { processWhatsAppWebhookPayload } =
      await import("./_core/whatsappWebhook");
    await expect(
      processWhatsAppWebhookPayload({ object: "whatsapp_business_account" })
    ).rejects.toMatchObject({ outcome: "pre_transport" });

    expect(releaseWhatsAppWebhookReplayLeaseMock).toHaveBeenCalledWith(
      FALLBACK_REPLAY_LEASE
    );
    expect(completeWhatsAppWebhookReplayLeaseMock).not.toHaveBeenCalled();
    expect(getOrCreateStateMock).not.toHaveBeenCalled();
    expect(handleWhatsAppTextEventMock).not.toHaveBeenCalled();
  });

  it("completes an ambiguous fallback replay without rerunning or reposting", async () => {
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
        messageId: "wamid.fallback-ambiguous",
        messageType: "text",
        rawMessageType: "text",
        textBody: "maak een beeld",
      },
    ]);
    claimWhatsAppWebhookReplayLeaseMock
      .mockResolvedValueOnce({
        status: "acquired" as const,
        lease: FALLBACK_REPLAY_LEASE,
      })
      .mockResolvedValueOnce(DUPLICATE_REPLAY_CLAIM);
    sendWhatsAppTextReplyMock.mockRejectedValueOnce(
      new WhatsAppDeliveryError("ambiguous", "a".repeat(64))
    );

    const { processWhatsAppWebhookPayload } =
      await import("./_core/whatsappWebhook");
    await expect(
      processWhatsAppWebhookPayload({ object: "whatsapp_business_account" })
    ).rejects.toMatchObject({ outcome: "ambiguous" });
    await expect(
      processWhatsAppWebhookPayload({ object: "whatsapp_business_account" })
    ).resolves.toBeUndefined();

    expect(completeWhatsAppWebhookReplayLeaseMock).toHaveBeenCalledWith(
      FALLBACK_REPLAY_LEASE
    );
    expect(sendWhatsAppTextReplyMock).toHaveBeenCalledOnce();
    expect(getOrCreateStateMock).not.toHaveBeenCalled();
    expect(handleWhatsAppTextEventMock).not.toHaveBeenCalled();
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
    claimWhatsAppWebhookReplayLeaseMock.mockResolvedValue(
      ACQUIRED_REPLAY_CLAIM
    );
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
    expect(completeWhatsAppWebhookReplayLeaseMock).toHaveBeenCalledWith(
      REPLAY_LEASE
    );
    expect(releaseWhatsAppWebhookReplayLeaseMock).not.toHaveBeenCalled();
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
    claimWhatsAppWebhookReplayLeaseMock.mockResolvedValue(
      ACQUIRED_REPLAY_CLAIM
    );
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
    expect(completeWhatsAppWebhookReplayLeaseMock).toHaveBeenCalledWith(
      REPLAY_LEASE
    );
    expect(releaseWhatsAppWebhookReplayLeaseMock).not.toHaveBeenCalled();

    claimWhatsAppWebhookReplayLeaseMock.mockResolvedValueOnce(
      DUPLICATE_REPLAY_CLAIM
    );
    await expect(
      processWhatsAppWebhookPayload({ object: "whatsapp_business_account" })
    ).resolves.toBeUndefined();
    expect(handleWhatsAppTextEventMock).toHaveBeenCalledOnce();
  });
});
