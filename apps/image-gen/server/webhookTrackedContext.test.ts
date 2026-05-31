import { describe, expect, it, vi } from "vitest";
import { createTrackedHandlerContext } from "./_core/webhookTrackedContext";
import type { HandlerContext } from "./_core/webhookHandlers";
import type { MessengerUserState } from "./_core/messengerState";

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
  it("preserves generationKind when tracking direct generation calls", async () => {
    const runImageGeneration = vi.fn(async () => ({ sent: true }));
    const ctx = makeHandlerContext(runImageGeneration);
    const tracked = createTrackedHandlerContext(ctx, vi.fn());

    await tracked.runImageGeneration(
      "tracked-user",
      "tracked-user-key",
      undefined,
      "req-tracked-direct",
      "nl",
      "https://img.example/source.jpg",
      "Maak me cyberpunk",
      undefined,
      "source_image_edit"
    );

    expect(runImageGeneration).toHaveBeenCalledWith(
      "tracked-user",
      "tracked-user-key",
      undefined,
      "req-tracked-direct",
      "nl",
      "https://img.example/source.jpg",
      "Maak me cyberpunk",
      undefined,
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
      undefined,
      "https://img.example/source.jpg",
      "Maak me cyberpunk",
      undefined,
      "source_image_edit"
    );

    expect(runImageGeneration).toHaveBeenCalledWith(
      "tracked-user",
      "tracked-user-key",
      undefined,
      "req-tracked-feature",
      "nl",
      "https://img.example/source.jpg",
      "Maak me cyberpunk",
      undefined,
      "source_image_edit"
    );
  });
});
