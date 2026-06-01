import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrackedHandlerContext } from "./_core/webhookTrackedContext";
import type { HandlerContext } from "./_core/webhookHandlers";
import {
  getState,
  resetStateStore,
  type MessengerUserState,
} from "./_core/messengerState";

const originalPrivacyPepper = process.env.PRIVACY_PEPPER;

function makeState(): MessengerUserState {
  return {
    psid: "tracked-user",
    userKey: "tracked-user-key",
    stage: "IDLE",
    state: "IDLE",
    lastPhotoUrl: null,
    lastPhoto: null,
    lastPhotoSource: null,
    preferredLang: "nl",
    consentGiven: true,
    pendingDeleteConfirm: false,
    hasSeenIntro: true,
    faceMemoryConsent: null,
    lastSourceImageUrl: null,
    lastSourceImageUpdatedAt: null,
    pendingSourceImageDeleteUrl: null,
    lastGeneratedUrl: null,
    quota: { dayKey: "2026-05-31", count: 0 },
    updatedAt: 1,
  };
}

function makeHandlerContext(
  runImageGeneration: HandlerContext["runImageGeneration"]
): HandlerContext {
  return {
    defaultLang: "nl",
    claimEventReplayOrLog: vi.fn(async () => true),
    createFeatureImageContext: vi.fn(),
    createFeaturePayloadContext: vi.fn(),
    createFeatureTextContext: vi.fn((psid, userId, reqId, lang, state) => ({
      channel: "messenger",
      capabilities: { quickReplies: true, richTemplates: true },
      senderId: psid,
      userId,
      reqId,
      lang,
      state,
      messageText: "Maak me cyberpunk",
      normalizedText: "maak me cyberpunk",
      hasPhoto: true,
      sendText: vi.fn(),
      sendImage: vi.fn(),
      sendActions: vi.fn(),
      setFlowState: vi.fn(),
      runImageGeneration: vi.fn(),
      getRuntimeStats: vi.fn(() => ({
        startedAt: 1,
        total: 0,
        successes: 0,
        failures: 0,
      })),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    })),
    debugWebhookLog: vi.fn(),
    getAttachmentHostname: vi.fn(() => null),
    logImageFlowDecision: vi.fn(),
    logIncomingMessage: vi.fn(),
    logUserState: vi.fn(),
    maybeSendInFlightMessage: vi.fn(async () => ({ handled: false })),
    runImageGeneration,
    sendFaceMemoryConsentPrompt: vi.fn(async () => ({ sent: true })),
    sendFlowExplanation: vi.fn(async () => ({ sent: true })),
    sendLoggedImage: vi.fn(async () => ({ sent: true })),
    sendLoggedQuickReplies: vi.fn(async () => ({ sent: true })),
    sendLoggedText: vi.fn(async () => ({ sent: true })),
    sendPhotoReceivedPrompt: vi.fn(async () => ({ sent: true })),
  };
}

describe("webhook tracked context", () => {
  afterEach(() => {
    resetStateStore();
    if (originalPrivacyPepper === undefined) {
      delete process.env.PRIVACY_PEPPER;
    } else {
      process.env.PRIVACY_PEPPER = originalPrivacyPepper;
    }
  });

  it("preserves generationKind when tracking direct generation calls", async () => {
    const runImageGeneration = vi.fn(async () => ({ sent: true }));
    const ctx = makeHandlerContext(runImageGeneration);
    const tracked = createTrackedHandlerContext(ctx, vi.fn());

    await tracked.runImageGeneration(
      "tracked-user",
      "tracked-user-key",
      "req-tracked-direct",
      "nl",
      "https://img.example/source.jpg",
      "Maak me cyberpunk",
      "source_image_edit"
    );

    expect(runImageGeneration).toHaveBeenCalledWith(
      "tracked-user",
      "tracked-user-key",
      "req-tracked-direct",
      "nl",
      "https://img.example/source.jpg",
      "Maak me cyberpunk",
      "source_image_edit"
    );
  });

  it("preserves generationKind from decorated feature contexts", async () => {
    const runImageGeneration = vi.fn(async () => ({ sent: true }));
    const ctx = makeHandlerContext(runImageGeneration);
    const tracked = createTrackedHandlerContext(ctx, vi.fn());
    const featureCtx = tracked.createFeatureTextContext(
      "tracked-user",
      "tracked-user-key",
      "req-tracked-feature",
      "nl",
      makeState(),
      "Maak me cyberpunk",
      "maak me cyberpunk",
      true
    );

    await featureCtx.runImageGeneration(
      "https://img.example/source.jpg",
      "Maak me cyberpunk",
      "source_image_edit"
    );

    expect(runImageGeneration).toHaveBeenCalledWith(
      "tracked-user",
      "tracked-user-key",
      "req-tracked-feature",
      "nl",
      "https://img.example/source.jpg",
      "Maak me cyberpunk",
      "source_image_edit"
    );
  });

  it("renders numbered feature text as Messenger quick replies", async () => {
    process.env.PRIVACY_PEPPER = "test-pepper";
    const sendLoggedQuickReplies = vi.fn(async () => ({
      sent: true,
      messageId: "mid-feature-choices",
    }));
    const ctx = {
      ...makeHandlerContext(vi.fn(async () => ({ sent: true }))),
      sendLoggedQuickReplies,
    };
    const tracked = createTrackedHandlerContext(ctx, vi.fn());
    const featureCtx = tracked.createFeatureTextContext(
      "tracked-user",
      "tracked-user-key",
      "req-feature-choices",
      "nl",
      makeState(),
      "Kan je me een samurai maken",
      "kan je me een samurai maken",
      true
    );

    await featureCtx.sendText(
      [
        "Ja. Wil je dat ik een:",
        "",
        "1. samurai-portret maak,",
        "2. samurai-avatar/sticker maak,",
      ].join("\n")
    );

    expect(ctx.sendLoggedText).not.toHaveBeenCalled();
    expect(sendLoggedQuickReplies).toHaveBeenCalledWith(
      "tracked-user",
      "Ja. Wil je dat ik een:",
      [
        {
          content_type: "text",
          title: "samurai-portret",
          payload: "OPENCLAW_ACTION:Maak%20me%20een%20samurai-portret",
        },
        {
          content_type: "text",
          title: "samurai-avatar/stick",
          payload:
            "OPENCLAW_ACTION:Maak%20me%20een%20samurai-avatar%2Fsticker",
        },
      ],
      "req-feature-choices"
    );
    expect(getState("tracked-user")?.pendingConversationActions).toEqual([
      {
        id: "choice_1",
        label: "samurai-portret",
        inputText: "Maak me een samurai-portret",
      },
      {
        id: "choice_2",
        label: "samurai-avatar/sticker",
        inputText: "Maak me een samurai-avatar/sticker",
      },
    ]);
    expect(
      getState("tracked-user")?.pendingConversationActionsByMessageId?.[
        "mid-feature-choices"
      ]
    ).toHaveLength(2);
  });
});
