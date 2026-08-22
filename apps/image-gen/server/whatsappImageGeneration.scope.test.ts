import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeGenerationFlow: vi.fn(),
  runGuardedGeneration: vi.fn(),
  canUseImageGeneration: vi.fn(),
  reserveImageGenerationUsage: vi.fn(),
  commitImageGenerationUsage: vi.fn(),
  releaseImageGenerationUsage: vi.fn(),
  getOrCreateState: vi.fn(),
  setFlowState: vi.fn(),
  setLastGenerated: vi.fn(),
  setLastGenerationContext: vi.fn(),
  clearPendingImageState: vi.fn(),
  sendWhatsAppImageReplyWithReceipt: vi.fn(),
  sendWhatsAppTextReply: vi.fn(),
  reserveProviderFence: vi.fn(),
  markProviderFence: vi.fn(),
  finalizeProviderFence: vi.fn(),
  markGenerationCompleted: vi.fn(),
  markGenerationDelivered: vi.fn(),
  scheduleArtifactCleanup: vi.fn(),
  createPublishHooks: vi.fn((fence: unknown) => ({
    fence,
    beforeStore: vi.fn(),
    afterStoreFailure: vi.fn(),
  })),
  getRequestPageId: vi.fn(),
  getRequestOwnership: vi.fn(),
  getRequestPrivacySubject: vi.fn(),
}));

vi.mock("./_core/generationFlow", () => ({
  executeGenerationFlow: mocks.executeGenerationFlow,
}));

vi.mock("./_core/image-generation/openAiImageClient", () => ({
  getGenerationMetrics: vi.fn(),
}));

vi.mock("./_core/generationGuard", () => ({
  runGuardedGeneration: mocks.runGuardedGeneration,
}));

vi.mock("./_core/limits/generationQuota", () => {
  class MessengerQuotaReservationCommitError extends Error {}
  return {
    canUseImageGeneration: mocks.canUseImageGeneration,
    reserveImageGenerationUsage: mocks.reserveImageGenerationUsage,
    commitImageGenerationUsage: mocks.commitImageGenerationUsage,
    releaseImageGenerationUsage: mocks.releaseImageGenerationUsage,
    MessengerQuotaReservationCommitError,
  };
});

vi.mock("./_core/messengerState", () => ({
  getOrCreateState: mocks.getOrCreateState,
  setFlowState: mocks.setFlowState,
  setLastGenerated: mocks.setLastGenerated,
  setLastGenerationContext: mocks.setLastGenerationContext,
  clearPendingImageState: mocks.clearPendingImageState,
}));

vi.mock("./_core/whatsappResponseService", () => ({
  sendWhatsAppImageReplyWithReceipt: mocks.sendWhatsAppImageReplyWithReceipt,
  sendWhatsAppTextReply: mocks.sendWhatsAppTextReply,
}));

vi.mock("./_core/logger", () => ({ safeLog: vi.fn() }));

vi.mock("./_core/messengerGenerationCompletion", () => ({
  createMessengerGenerationPublishHooks: mocks.createPublishHooks,
  markMessengerGenerationCompleted: mocks.markGenerationCompleted,
  markMessengerGenerationDelivered: mocks.markGenerationDelivered,
  scheduleMessengerGenerationArtifactCleanup: mocks.scheduleArtifactCleanup,
}));

vi.mock("./_core/messengerRequestContext", () => ({
  getMessengerRequestPageId: mocks.getRequestPageId,
  getMessengerRequestOwnership: mocks.getRequestOwnership,
  getMessengerRequestPrivacySubject: mocks.getRequestPrivacySubject,
}));

vi.mock("./_core/whatsappProviderAttemptFence", () => {
  class WhatsAppProviderAttemptFenceError extends Error {}
  return {
    reserveWhatsAppProviderAttemptFence: mocks.reserveProviderFence,
    markWhatsAppProviderAttemptStarted: mocks.markProviderFence,
    finalizeWhatsAppProviderAttemptFence: mocks.finalizeProviderFence,
    WhatsAppProviderAttemptFenceError,
  };
});

import { runWhatsAppImageGeneration } from "./_core/whatsappFlows/imageGenerationFlow";

const SCOPE = Object.freeze({
  workspaceId: 42,
  channelConnectionId: 8,
  bindingEpoch: 3,
  privacyEpoch: 2,
});

afterEach(() => {
  vi.clearAllMocks();
});

function installProviderFence(): void {
  mocks.reserveProviderFence.mockResolvedValue({
    leaseToken: "provider-lease",
    attemptKeyHash: "b".repeat(64),
  });
  mocks.markProviderFence.mockResolvedValue(undefined);
  mocks.finalizeProviderFence.mockResolvedValue(undefined);
  mocks.markGenerationCompleted.mockResolvedValue(undefined);
  mocks.markGenerationDelivered.mockResolvedValue(undefined);
  mocks.scheduleArtifactCleanup.mockResolvedValue("scheduled");
  mocks.sendWhatsAppImageReplyWithReceipt.mockResolvedValue({
    outcome: "accepted",
    attemptKeyHash: "c".repeat(64),
  });
  mocks.getRequestPageId.mockReturnValue("whatsapp-phone-42");
  mocks.getRequestOwnership.mockReturnValue({
    workspaceId: SCOPE.workspaceId,
    channelConnectionId: SCOPE.channelConnectionId,
    bindingEpoch: SCOPE.bindingEpoch,
  });
  mocks.getRequestPrivacySubject.mockReturnValue({
    userKey: "u:scoped-user",
    privacyEpoch: SCOPE.privacyEpoch,
  });
}

describe("WhatsApp image generation tenant scope", () => {
  it("rejects a production-shaped unscoped call before quota or provider flow", async () => {
    await expect(
      runWhatsAppImageGeneration({
        senderId: "32470000001",
        userId: "u:scoped-user",
        reqId: "wa-unscoped",
        lang: "nl",
        generationKind: "text_to_image",
      } as Parameters<typeof runWhatsAppImageGeneration>[0])
    ).rejects.toMatchObject({ name: "CostLedgerScopeError" });

    expect(mocks.runGuardedGeneration).not.toHaveBeenCalled();
    expect(mocks.canUseImageGeneration).not.toHaveBeenCalled();
    expect(mocks.executeGenerationFlow).not.toHaveBeenCalled();
  });

  it("passes the exact immutable scope into generation admission", async () => {
    installProviderFence();
    mocks.runGuardedGeneration.mockImplementation(
      async (_senderId: string, action: () => Promise<void>) => await action()
    );
    mocks.canUseImageGeneration.mockResolvedValue(true);
    mocks.reserveImageGenerationUsage.mockResolvedValue({
      token: "reservation",
    });
    mocks.commitImageGenerationUsage.mockResolvedValue(true);
    mocks.getOrCreateState.mockReturnValue({
      lastPhotoUrl: null,
      lastPhotoSource: null,
    });
    mocks.executeGenerationFlow.mockImplementation(async input => {
      const admission = await input.onProviderAttempt();
      await admission.markTransportStarted();
      return {
        kind: "success",
        imageUrl: "https://storage.test/result.png",
        metrics: { totalMs: 1 },
        proof: {
          incomingLen: 0,
          incomingSha256: "empty",
          openaiInputLen: 0,
          openaiInputSha256: "empty",
        },
        mode: "openai",
        resolvedSourceImageUrl: "",
        trustedSourceImageUrl: false,
      };
    });

    await runWhatsAppImageGeneration({
      senderId: "32470000001",
      userId: "u:scoped-user",
      reqId: "wa-scoped",
      lang: "nl",
      generationKind: "text_to_image",
      costLedgerScope: SCOPE,
    });

    expect(mocks.executeGenerationFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        costLedgerScope: SCOPE,
        generatedImagePublishHooks: expect.objectContaining({
          beforeStore: expect.any(Function),
          afterStoreFailure: expect.any(Function),
        }),
      })
    );
    const forwardedScope =
      mocks.executeGenerationFlow.mock.calls[0]?.[0].costLedgerScope;
    expect(forwardedScope).toEqual(SCOPE);
    expect(forwardedScope).not.toBe(SCOPE);
    expect(Object.isFrozen(forwardedScope)).toBe(true);
    expect(mocks.reserveProviderFence).toHaveBeenCalledWith({
      reqId: "wa-scoped",
      userKey: "u:scoped-user",
      providerOperation: "whatsapp_openai_image",
      expectedScope: SCOPE,
    });
    expect(mocks.markProviderFence).toHaveBeenCalledOnce();
    expect(mocks.markGenerationCompleted).toHaveBeenCalledBefore(
      mocks.sendWhatsAppImageReplyWithReceipt
    );
    expect(mocks.sendWhatsAppImageReplyWithReceipt).toHaveBeenCalledBefore(
      mocks.markGenerationDelivered
    );
    expect(mocks.markGenerationDelivered).toHaveBeenCalledBefore(
      mocks.setLastGenerated
    );
    expect(mocks.finalizeProviderFence).toHaveBeenCalledWith(
      expect.any(Object),
      "succeeded"
    );
  });

  it("blocks delivery when deletion wins at the provider transport boundary", async () => {
    installProviderFence();
    mocks.markProviderFence.mockRejectedValueOnce(
      new Error("WhatsApp provider privacy changed")
    );
    mocks.runGuardedGeneration.mockImplementation(
      async (_senderId: string, action: () => Promise<void>) => await action()
    );
    mocks.canUseImageGeneration.mockResolvedValue(true);
    mocks.reserveImageGenerationUsage.mockResolvedValue({
      token: "reservation",
    });
    mocks.commitImageGenerationUsage.mockResolvedValue(true);
    mocks.getOrCreateState.mockReturnValue({
      lastPhotoUrl: null,
      lastPhotoSource: null,
    });
    mocks.executeGenerationFlow.mockImplementation(async input => {
      const admission = await input.onProviderAttempt();
      try {
        await admission.markTransportStarted();
      } catch (error) {
        await admission.abortBeforeTransport();
        throw error;
      }
      throw new Error("unreachable");
    });

    await expect(
      runWhatsAppImageGeneration({
        senderId: "32470000001",
        userId: "u:scoped-user",
        reqId: "wa-delete-race",
        lang: "nl",
        generationKind: "text_to_image",
        costLedgerScope: SCOPE,
      })
    ).rejects.toThrow("WhatsApp provider privacy changed");

    expect(mocks.sendWhatsAppImageReplyWithReceipt).not.toHaveBeenCalled();
    expect(mocks.commitImageGenerationUsage).not.toHaveBeenCalled();
    expect(mocks.finalizeProviderFence).toHaveBeenCalledWith(
      expect.any(Object),
      "known_failed"
    );
  });

  it("retains a durably inventoried delivered object when a later state write fails", async () => {
    installProviderFence();
    mocks.runGuardedGeneration.mockImplementation(
      async (_senderId: string, action: () => Promise<void>) => await action()
    );
    mocks.canUseImageGeneration.mockResolvedValue(true);
    mocks.reserveImageGenerationUsage.mockResolvedValue({
      token: "reservation",
    });
    mocks.commitImageGenerationUsage.mockResolvedValue(true);
    mocks.getOrCreateState.mockReturnValue({
      lastPhotoUrl: null,
      lastPhotoSource: null,
    });
    mocks.sendWhatsAppImageReplyWithReceipt.mockResolvedValue({
      outcome: "accepted",
      attemptKeyHash: "c".repeat(64),
    });
    mocks.setLastGenerated.mockRejectedValue(
      new Error("WhatsApp privacy tombstone changed")
    );
    mocks.executeGenerationFlow.mockImplementation(async input => {
      const admission = await input.onProviderAttempt();
      await admission.markTransportStarted();
      return {
        kind: "success",
        imageUrl: "https://storage.test/result.png",
        metrics: { totalMs: 1 },
        proof: {
          incomingLen: 0,
          incomingSha256: "empty",
          openaiInputLen: 0,
          openaiInputSha256: "empty",
        },
        mode: "openai",
        resolvedSourceImageUrl: "",
        trustedSourceImageUrl: false,
      };
    });

    await expect(
      runWhatsAppImageGeneration({
        senderId: "32470000001",
        userId: "u:scoped-user",
        reqId: "wa-state-race",
        lang: "nl",
        generationKind: "text_to_image",
        costLedgerScope: SCOPE,
      })
    ).rejects.toThrow("WhatsApp privacy tombstone changed");

    expect(mocks.markGenerationCompleted).toHaveBeenCalledWith(
      "wa-state-race",
      "https://storage.test/result.png",
      "u:scoped-user",
      expect.any(Number),
      expect.objectContaining({
        channel: "whatsapp",
        pageId: "whatsapp-phone-42",
        ...SCOPE,
      })
    );
    expect(mocks.markGenerationDelivered).toHaveBeenCalledWith(
      "wa-state-race",
      "https://storage.test/result.png",
      "u:scoped-user",
      expect.any(Number),
      expect.objectContaining({ channel: "whatsapp", ...SCOPE })
    );
    expect(mocks.finalizeProviderFence).toHaveBeenCalledWith(
      expect.any(Object),
      "succeeded"
    );
  });

  it("durably schedules cleanup after a proven Graph rejection", async () => {
    installProviderFence();
    mocks.runGuardedGeneration.mockImplementation(
      async (_senderId: string, action: () => Promise<void>) => await action()
    );
    mocks.canUseImageGeneration.mockResolvedValue(true);
    mocks.reserveImageGenerationUsage.mockResolvedValue({
      token: "reservation",
    });
    mocks.commitImageGenerationUsage.mockResolvedValue(true);
    mocks.getOrCreateState.mockReturnValue({
      lastPhotoUrl: null,
      lastPhotoSource: null,
    });
    mocks.sendWhatsAppImageReplyWithReceipt.mockRejectedValue(
      Object.assign(new Error("delivery rejected"), {
        outcome: "known_rejected",
      })
    );
    mocks.executeGenerationFlow.mockImplementation(async input => {
      const admission = await input.onProviderAttempt();
      await admission.markTransportStarted();
      return successfulGenerationResult();
    });

    await expect(
      runWhatsAppImageGeneration({
        senderId: "32470000001",
        userId: "u:scoped-user",
        reqId: "wa-known-reject",
        lang: "nl",
        generationKind: "text_to_image",
        costLedgerScope: SCOPE,
      })
    ).rejects.toThrow("delivery rejected");

    expect(mocks.scheduleArtifactCleanup).toHaveBeenCalledWith({
      reqId: "wa-known-reject",
      imageUrl: "https://storage.test/result.png",
      userKey: "u:scoped-user",
      fence: expect.objectContaining({ channel: "whatsapp", ...SCOPE }),
      reason: "pre_transport_rejected",
    });
    expect(mocks.markGenerationDelivered).not.toHaveBeenCalled();
  });

  it("keeps an ambiguous Graph outcome inventoried without automatic cleanup", async () => {
    installProviderFence();
    mocks.runGuardedGeneration.mockImplementation(
      async (_senderId: string, action: () => Promise<void>) => await action()
    );
    mocks.canUseImageGeneration.mockResolvedValue(true);
    mocks.reserveImageGenerationUsage.mockResolvedValue({
      token: "reservation",
    });
    mocks.commitImageGenerationUsage.mockResolvedValue(true);
    mocks.getOrCreateState.mockReturnValue({
      lastPhotoUrl: null,
      lastPhotoSource: null,
    });
    mocks.sendWhatsAppImageReplyWithReceipt.mockRejectedValue(
      Object.assign(new Error("delivery ambiguous"), { outcome: "ambiguous" })
    );
    mocks.executeGenerationFlow.mockImplementation(async input => {
      const admission = await input.onProviderAttempt();
      await admission.markTransportStarted();
      return successfulGenerationResult();
    });

    await expect(
      runWhatsAppImageGeneration({
        senderId: "32470000001",
        userId: "u:scoped-user",
        reqId: "wa-ambiguous",
        lang: "nl",
        generationKind: "text_to_image",
        costLedgerScope: SCOPE,
      })
    ).rejects.toThrow("delivery ambiguous");

    expect(mocks.scheduleArtifactCleanup).not.toHaveBeenCalled();
    expect(mocks.markGenerationDelivered).not.toHaveBeenCalled();
  });
});

function successfulGenerationResult() {
  return {
    kind: "success" as const,
    imageUrl: "https://storage.test/result.png",
    metrics: { totalMs: 1 },
    proof: {
      incomingLen: 0,
      incomingSha256: "empty",
      openaiInputLen: 0,
      openaiInputSha256: "empty",
    },
    mode: "openai" as const,
    resolvedSourceImageUrl: "",
    trustedSourceImageUrl: false,
  };
}
