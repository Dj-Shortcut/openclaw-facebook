import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleTextMessage } from "./_core/webhookTextMessageRouter";
import { t } from "./_core/i18n";
import { getState, resetStateStore } from "./_core/messengerState";
import type { HandlerContext } from "./_core/webhookHandlerTypes";

const originalPrivacyPepper = process.env.PRIVACY_PEPPER;

function makeHandlerContext(
  overrides: Partial<HandlerContext> = {}
): HandlerContext {
  return {
    defaultLang: "nl",
    claimEventReplayOrLog: vi.fn(async () => true),
    createFeatureImageContext: vi.fn(),
    createFeaturePayloadContext: vi.fn(),
    createFeatureTextContext: vi.fn(),
    debugWebhookLog: vi.fn(),
    getAttachmentHostname: vi.fn(() => null),
    logImageFlowDecision: vi.fn(),
    logIncomingMessage: vi.fn(),
    logUserState: vi.fn(),
    maybeSendInFlightMessage: vi.fn(async () => ({ handled: false })),
    runImageGeneration: vi.fn(async () => ({ sent: true })),
    sendFaceMemoryConsentPrompt: vi.fn(async () => ({ sent: true })),
    sendFlowExplanation: vi.fn(async () => ({ sent: true })),
    sendLoggedImage: vi.fn(async () => ({ sent: true })),
    sendLoggedActions: vi.fn(async () => ({
      sent: true,
      messageId: "mid-text-actions",
    })),
    sendLoggedText: vi.fn(async () => ({ sent: true })),
    sendPhotoReceivedPrompt: vi.fn(async () => ({ sent: true })),
    ...overrides,
  };
}

describe("webhook text message router", () => {
  beforeEach(() => {
    process.env.PRIVACY_PEPPER = "webhook-text-router-test-pepper";
    resetStateStore();
  });

  afterEach(() => {
    resetStateStore();
    if (originalPrivacyPepper === undefined) {
      delete process.env.PRIVACY_PEPPER;
    } else {
      process.env.PRIVACY_PEPPER = originalPrivacyPepper;
    }
  });

  it("sends action prompts, stores pending actions, and applies after-send state", async () => {
    const psid = "text-router-user";
    const ctx = makeHandlerContext();

    await handleTextMessage(ctx, {
      psid,
      userId: "text-router-user-key",
      reqId: "req-text-router",
      lang: "nl",
      text: "hi",
      timestamp: 1730000000000,
    });

    expect(ctx.sendLoggedActions).toHaveBeenCalledWith(
      psid,
      t("nl", "flowExplanation"),
      expect.arrayContaining([
        expect.objectContaining({
          id: "new_image",
          label: t("nl", "newImage"),
        }),
      ]),
      "req-text-router"
    );
    expect(ctx.sendLoggedText).not.toHaveBeenCalled();

    const state = await Promise.resolve(getState(psid));
    expect(state?.hasSeenIntro).toBe(true);
    expect(state?.pendingConversationActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "new_image",
          label: t("nl", "newImage"),
        }),
      ])
    );
    expect(state?.pendingConversationActionsByMessageId?.[
      "mid-text-actions"
    ]).toEqual(state?.pendingConversationActions);
  });
});
