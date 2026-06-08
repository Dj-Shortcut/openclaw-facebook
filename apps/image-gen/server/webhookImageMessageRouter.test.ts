import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getBotFeaturesMock,
  getStoredMessengerImageDecisionMock,
  handleTextMessageMock,
  isFaceMemoryEnabledMock,
  normalizeMessengerInboundImageMock,
  safeLogMock,
} = vi.hoisted(() => ({
  getBotFeaturesMock: vi.fn(() => []),
  getStoredMessengerImageDecisionMock: vi.fn(() => ({
    hadPreviousPhoto: false,
    incomingImageUrl: "https://example.com/inbound.jpg",
    action: "request_edit_prompt" as const,
  })),
  handleTextMessageMock: vi.fn(async () => undefined),
  isFaceMemoryEnabledMock: vi.fn(() => false),
  normalizeMessengerInboundImageMock: vi.fn(async () => {
    return "https://assets.example/generated/source.jpg";
  }),
  safeLogMock: vi.fn(),
}));

vi.mock("./_core/bot/features", () => ({
  getBotFeatures: getBotFeaturesMock,
}));

vi.mock("./_core/faceMemory", () => ({
  isFaceMemoryEnabled: isFaceMemoryEnabledMock,
  updateConsentedFaceMemorySource: vi.fn(async () => undefined),
}));

vi.mock("./_core/messengerApi", () => ({
  safeLog: safeLogMock,
}));

vi.mock("./_core/messengerImageIngress", () => ({
  getStoredMessengerImageDecision: getStoredMessengerImageDecisionMock,
  normalizeMessengerInboundImage: normalizeMessengerInboundImageMock,
}));

vi.mock("./_core/webhookTextMessageRouter", () => ({
  handleTextMessage: handleTextMessageMock,
}));

import { tryHandleImageMessage } from "./_core/webhookImageMessageRouter";
import {
  getState,
  resetStateStore,
  setFlowState,
  setLastGenerated,
} from "./_core/messengerState";
import type { HandlerContext } from "./_core/webhookHandlerTypes";
import { t } from "./_core/i18n";

const originalPrivacyPepper = process.env.PRIVACY_PEPPER;

function makeHandlerContext(): HandlerContext {
  return {
    defaultLang: "nl",
    claimEventReplayOrLog: vi.fn(async () => true),
    createFeatureImageContext: vi.fn(),
    createFeaturePayloadContext: vi.fn(),
    createFeatureTextContext: vi.fn(),
    debugWebhookLog: vi.fn(),
    getAttachmentHostname: vi.fn(() => "example.com"),
    logImageFlowDecision: vi.fn(),
    logIncomingMessage: vi.fn(),
    logUserState: vi.fn(),
    maybeSendInFlightMessage: vi.fn(async () => ({ handled: false })),
    runImageGeneration: vi.fn(async () => ({ sent: true })),
    sendFaceMemoryConsentPrompt: vi.fn(async () => ({ sent: true })),
    sendFlowExplanation: vi.fn(async () => ({ sent: true })),
    sendLoggedImage: vi.fn(async () => ({ sent: true })),
    sendLoggedActions: vi.fn(async () => ({ sent: true })),
    sendLoggedText: vi.fn(async () => ({ sent: true })),
    sendPhotoReceivedPrompt: vi.fn(async () => ({ sent: true })),
  };
}

describe("webhook image message router", () => {
  beforeEach(() => {
    process.env.PRIVACY_PEPPER = "webhook-image-router-test-pepper";
    resetStateStore();
    getBotFeaturesMock.mockReturnValue([]);
    getStoredMessengerImageDecisionMock.mockClear();
    handleTextMessageMock.mockClear();
    isFaceMemoryEnabledMock.mockReturnValue(false);
    normalizeMessengerInboundImageMock.mockClear();
    safeLogMock.mockClear();
  });

  afterEach(() => {
    resetStateStore();
    if (originalPrivacyPepper === undefined) {
      delete process.env.PRIVACY_PEPPER;
    } else {
      process.env.PRIVACY_PEPPER = originalPrivacyPepper;
    }
  });

  it("routes prompt-first captioned image messages into text handling", async () => {
    const ctx = makeHandlerContext();

    await expect(
      tryHandleImageMessage(ctx, {
        psid: "image-router-user",
        userId: "image-router-user-key",
        reqId: "req-image-router",
        lang: "nl",
        attachments: [
          {
            type: "image",
            payload: {
              url: "https://example.com/inbound.jpg",
            },
          },
        ],
        text: "  Maak een futuristische robot  ",
        timestamp: 1730000000000,
      })
    ).resolves.toBe(true);

    expect(normalizeMessengerInboundImageMock).toHaveBeenCalledWith({
      inboundImageUrl: "https://example.com/inbound.jpg",
      psidHash: expect.stringMatching(/^[a-f0-9]{12}$/),
      reqId: "req-image-router",
    });
    expect(safeLogMock).toHaveBeenCalledWith(
      "messenger_image_message_parsed",
      expect.objectContaining({
        attachmentType: "image",
        attachmentHostname: "example.com",
        attachmentPayloadUrl: {
          host: "example.com",
          shortHash: expect.stringMatching(/^[a-f0-9]{12}$/),
        },
      })
    );
    expect(handleTextMessageMock).toHaveBeenCalledWith(ctx, {
      psid: "image-router-user",
      userId: "image-router-user-key",
      reqId: "req-image-router",
      lang: "nl",
      text: "Maak een futuristische robot",
      timestamp: 1730000000000,
    });
    expect(ctx.sendPhotoReceivedPrompt).not.toHaveBeenCalled();
  });

  it("preserves the editable image context when an inbound image cannot be read", async () => {
    const ctx = makeHandlerContext();
    const psid = "image-router-failed-upload-user";
    normalizeMessengerInboundImageMock.mockResolvedValueOnce(null);
    await Promise.resolve(
      setLastGenerated(psid, "https://assets.example/current.jpg")
    );
    await Promise.resolve(setFlowState(psid, "AWAITING_EDIT_PROMPT"));

    await expect(
      tryHandleImageMessage(ctx, {
        psid,
        userId: "image-router-failed-upload-key",
        reqId: "req-image-router-failed-upload",
        lang: "nl",
        attachments: [
          {
            type: "image",
            payload: {
              url: "https://example.com/unreadable.jpg",
            },
          },
        ],
        timestamp: 1730000000000,
      })
    ).resolves.toBe(true);

    expect(ctx.sendLoggedActions).toHaveBeenCalledWith(
      psid,
      t("nl", "messengerMissingInputImageWithEditableImage"),
      [
        {
          id: "change_background",
          label: "Andere achtergrond",
          inputText: "change_background",
        },
        { id: "new_image", label: "Nieuwe afbeelding", inputText: "new_image" },
      ],
      "req-image-router-failed-upload"
    );
    expect(await Promise.resolve(getState(psid))).toMatchObject({
      stage: "AWAITING_EDIT_PROMPT",
      state: "AWAITING_EDIT_PROMPT",
      lastGeneratedUrl: "https://assets.example/current.jpg",
      lastImageUrl: "https://assets.example/current.jpg",
    });
  });

  it("guides unreadable first-photo uploads away from the same attachment loop", async () => {
    const ctx = makeHandlerContext();
    const psid = "image-router-first-upload-fail-user";
    normalizeMessengerInboundImageMock.mockResolvedValueOnce(null);

    await expect(
      tryHandleImageMessage(ctx, {
        psid,
        userId: "image-router-first-upload-fail-key",
        reqId: "req-image-router-first-upload-fail",
        lang: "nl",
        attachments: [
          {
            type: "image",
            payload: {
              url: "https://example.com/unreadable-first.jpg",
            },
          },
        ],
        timestamp: 1730000000000,
      })
    ).resolves.toBe(true);

    expect(ctx.sendLoggedActions).toHaveBeenCalledWith(
      psid,
      t("nl", "messengerMissingInputImage"),
      [{ id: "new_image", label: "Nieuwe afbeelding", inputText: "new_image" }],
      "req-image-router-first-upload-fail"
    );
    expect(await Promise.resolve(getState(psid))).toMatchObject({
      stage: "AWAITING_PHOTO",
      state: "AWAITING_PHOTO",
      lastGeneratedUrl: null,
      lastPhotoUrl: null,
    });
  });
});
