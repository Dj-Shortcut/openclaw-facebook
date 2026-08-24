import { beforeEach, describe, expect, it, vi } from "vitest";

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
  assertGenerationScopeActive: vi.fn(),
  getRequestPageId: vi.fn(),
  getRequestChannel: vi.fn(),
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
  markMessengerGenerationCompleted: mocks.markGenerationCompleted,
  markMessengerGenerationDelivered: mocks.markGenerationDelivered,
}));

vi.mock("./_core/messengerRequestContext", () => ({
  getMessengerRequestPageId: mocks.getRequestPageId,
  getMessengerRequestChannel: mocks.getRequestChannel,
  getMessengerRequestOwnership: mocks.getRequestOwnership,
  getMessengerRequestPrivacySubject: mocks.getRequestPrivacySubject,
}));

vi.mock("./_core/whatsappProviderAttemptFence", () => ({
  reserveWhatsAppProviderAttemptFence: mocks.reserveProviderFence,
  markWhatsAppProviderAttemptStarted: mocks.markProviderFence,
  finalizeWhatsAppProviderAttemptFence: mocks.finalizeProviderFence,
}));

vi.mock("./_core/whatsappGenerationScope", () => {
  class WhatsAppGenerationScopeError extends Error {
    constructor() {
      super("WhatsApp generation scope is unavailable");
      this.name = "WhatsAppGenerationScopeError";
    }
  }
  return {
    assertWhatsAppGenerationScopeActive: mocks.assertGenerationScopeActive,
    WhatsAppGenerationScopeError,
  };
});

import { resolveWhatsAppEndpoint } from "./_core/conversationEndpoint";
import { runWhatsAppImageGeneration } from "./_core/whatsappFlows/imageGenerationFlow";

const SENDER_ID = "32470000001";
const USER_KEY = "u:scoped-user";
const ENDPOINT = resolveWhatsAppEndpoint({
  wabaId: "303030303030303",
  phoneNumberId: "404040404040404",
});
const SCOPE = Object.freeze({
  workspaceId: 42,
  channelConnectionId: 8,
  bindingEpoch: 3,
  privacyEpoch: 2,
  userKey: USER_KEY,
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

function generationInput(reqId: string) {
  return {
    senderId: SENDER_ID,
    userId: USER_KEY,
    reqId,
    lang: "nl" as const,
    generationKind: "text_to_image" as const,
    endpoint: ENDPOINT,
    costLedgerScope: SCOPE,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runGuardedGeneration.mockImplementation(
    async (_senderId: string, action: () => Promise<void>) => await action()
  );
  mocks.canUseImageGeneration.mockResolvedValue(true);
  mocks.reserveImageGenerationUsage.mockResolvedValue({ token: "reservation" });
  mocks.commitImageGenerationUsage.mockResolvedValue(true);
  mocks.releaseImageGenerationUsage.mockResolvedValue(undefined);
  mocks.getOrCreateState.mockReturnValue({
    lastPhotoUrl: null,
    lastPhotoSource: null,
  });
  mocks.sendWhatsAppImageReplyWithReceipt.mockResolvedValue({
    outcome: "accepted",
    attemptKeyHash: "c".repeat(64),
  });
  mocks.reserveProviderFence.mockResolvedValue({
    leaseToken: "provider-lease",
    attemptKeyHash: "b".repeat(64),
  });
  mocks.markProviderFence.mockResolvedValue(undefined);
  mocks.finalizeProviderFence.mockResolvedValue(undefined);
  mocks.markGenerationCompleted.mockResolvedValue(undefined);
  mocks.markGenerationDelivered.mockResolvedValue(undefined);
  mocks.assertGenerationScopeActive.mockResolvedValue(undefined);
  mocks.getRequestPageId.mockReturnValue(ENDPOINT.phoneNumberId);
  mocks.getRequestChannel.mockReturnValue("whatsapp");
  mocks.getRequestOwnership.mockReturnValue({
    workspaceId: SCOPE.workspaceId,
    channelConnectionId: SCOPE.channelConnectionId,
    bindingEpoch: SCOPE.bindingEpoch,
  });
  mocks.getRequestPrivacySubject.mockReturnValue({
    userKey: SCOPE.userKey,
    privacyEpoch: SCOPE.privacyEpoch,
  });
});

describe("WhatsApp image generation tenant scope", () => {
  it("rejects an unscoped call before quota or provider admission", async () => {
    const input = generationInput("wa-unscoped");
    delete (input as Partial<typeof input>).costLedgerScope;

    await expect(
      runWhatsAppImageGeneration(
        input as Parameters<typeof runWhatsAppImageGeneration>[0]
      )
    ).rejects.toMatchObject({ name: "WhatsAppGenerationScopeError" });

    expect(mocks.runGuardedGeneration).not.toHaveBeenCalled();
    expect(mocks.canUseImageGeneration).not.toHaveBeenCalled();
    expect(mocks.reserveProviderFence).not.toHaveBeenCalled();
    expect(mocks.executeGenerationFlow).not.toHaveBeenCalled();
  });

  it("rejects a wrong privacy subject before quota or provider admission", async () => {
    await expect(
      runWhatsAppImageGeneration({
        ...generationInput("wa-wrong-user"),
        userId: "u:other-tenant",
      })
    ).rejects.toMatchObject({ name: "WhatsAppGenerationScopeError" });

    expect(mocks.runGuardedGeneration).not.toHaveBeenCalled();
    expect(mocks.reserveProviderFence).not.toHaveBeenCalled();
    expect(mocks.executeGenerationFlow).not.toHaveBeenCalled();
  });

  it("rejects a partial request scope before provider admission", async () => {
    mocks.getRequestPrivacySubject.mockReturnValue(undefined);

    await expect(
      runWhatsAppImageGeneration(generationInput("wa-partial-scope"))
    ).rejects.toMatchObject({ name: "WhatsAppGenerationScopeError" });

    expect(mocks.reserveProviderFence).not.toHaveBeenCalled();
    expect(mocks.executeGenerationFlow).not.toHaveBeenCalled();
    expect(mocks.releaseImageGenerationUsage).toHaveBeenCalledOnce();
  });

  it("passes an immutable exact scope through provider and completion admission", async () => {
    const providerCall = vi.fn();
    mocks.executeGenerationFlow.mockImplementation(async input => {
      const admission = await input.onProviderAttempt();
      await admission.markTransportStarted();
      providerCall();
      await input.onProviderSuccess();
      return successfulGenerationResult();
    });

    await runWhatsAppImageGeneration(generationInput("wa-scoped"));

    const forwardedScope =
      mocks.executeGenerationFlow.mock.calls[0]?.[0].costLedgerScope;
    expect(forwardedScope).toEqual(SCOPE);
    expect(forwardedScope).not.toBe(SCOPE);
    expect(Object.isFrozen(forwardedScope)).toBe(true);
    expect(mocks.executeGenerationFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        costLedgerChannel: "whatsapp",
        costLedgerScope: forwardedScope,
        onProviderSuccess: expect.any(Function),
      })
    );
    expect(mocks.reserveProviderFence).toHaveBeenCalledWith({
      reqId: "wa-scoped",
      userKey: USER_KEY,
      providerOperation: "whatsapp_openai_image",
      expectedScope: forwardedScope,
    });
    expect(mocks.markProviderFence).toHaveBeenCalledBefore(providerCall);
    expect(mocks.assertGenerationScopeActive).toHaveBeenCalledWith({
      endpoint: ENDPOINT,
      scope: forwardedScope,
    });
    expect(mocks.markGenerationCompleted).toHaveBeenCalledBefore(
      mocks.sendWhatsAppImageReplyWithReceipt
    );
    expect(mocks.sendWhatsAppImageReplyWithReceipt).toHaveBeenCalledBefore(
      mocks.markGenerationDelivered
    );
    expect(mocks.markGenerationCompleted).toHaveBeenCalledWith(
      "wa-scoped",
      "https://storage.test/result.png",
      USER_KEY,
      expect.any(Number),
      {
        pageId: ENDPOINT.phoneNumberId,
        channel: "whatsapp",
        ...SCOPE,
      }
    );
    expect(mocks.finalizeProviderFence).toHaveBeenCalledWith(
      expect.any(Object),
      "succeeded"
    );
  });

  it("does not call the provider when a rebind/privacy CAS loses", async () => {
    const providerCall = vi.fn();
    mocks.markProviderFence.mockRejectedValueOnce(
      new Error("WhatsApp provider privacy changed")
    );
    mocks.executeGenerationFlow.mockImplementation(async input => {
      const admission = await input.onProviderAttempt();
      try {
        await admission.markTransportStarted();
      } catch (error) {
        await admission.abortBeforeTransport();
        throw error;
      }
      providerCall();
      return successfulGenerationResult();
    });

    await expect(
      runWhatsAppImageGeneration(generationInput("wa-rebind-race"))
    ).rejects.toThrow("WhatsApp provider privacy changed");

    expect(providerCall).not.toHaveBeenCalled();
    expect(mocks.commitImageGenerationUsage).not.toHaveBeenCalled();
    expect(mocks.sendWhatsAppImageReplyWithReceipt).not.toHaveBeenCalled();
    expect(mocks.finalizeProviderFence).toHaveBeenCalledWith(
      expect.any(Object),
      "known_failed"
    );
  });

  it("blocks delivery after provider success when the privacy epoch changes", async () => {
    const providerCall = vi.fn();
    mocks.executeGenerationFlow.mockImplementation(async input => {
      const admission = await input.onProviderAttempt();
      await admission.markTransportStarted();
      providerCall();
      await input.onProviderSuccess();
      return successfulGenerationResult();
    });
    mocks.assertGenerationScopeActive.mockRejectedValueOnce(
      new Error("WhatsApp generation scope is unavailable")
    );

    await expect(
      runWhatsAppImageGeneration(generationInput("wa-post-success-delete"))
    ).rejects.toThrow("WhatsApp generation scope is unavailable");

    expect(providerCall).toHaveBeenCalledOnce();
    expect(mocks.finalizeProviderFence).toHaveBeenCalledWith(
      expect.any(Object),
      "succeeded"
    );
    expect(mocks.finalizeProviderFence).not.toHaveBeenCalledWith(
      expect.any(Object),
      "ambiguous"
    );
    expect(mocks.sendWhatsAppImageReplyWithReceipt).not.toHaveBeenCalled();
  });

  it("keeps a failed success-finalization fence for ambiguous cleanup", async () => {
    const fence = {
      leaseToken: "provider-lease",
      attemptKeyHash: "b".repeat(64),
    };
    mocks.reserveProviderFence.mockResolvedValueOnce(fence);
    mocks.finalizeProviderFence
      .mockRejectedValueOnce(new Error("provider fence persistence failed"))
      .mockResolvedValueOnce(undefined);
    mocks.executeGenerationFlow.mockImplementation(async input => {
      const admission = await input.onProviderAttempt();
      await admission.markTransportStarted();
      await input.onProviderSuccess();
      return successfulGenerationResult();
    });

    await expect(
      runWhatsAppImageGeneration(generationInput("wa-finalize-failure"))
    ).rejects.toThrow("provider fence persistence failed");

    expect(mocks.finalizeProviderFence).toHaveBeenNthCalledWith(
      1,
      fence,
      "succeeded"
    );
    expect(mocks.finalizeProviderFence).toHaveBeenNthCalledWith(
      2,
      fence,
      "ambiguous"
    );
    expect(mocks.sendWhatsAppImageReplyWithReceipt).not.toHaveBeenCalled();
  });

  it("releases a retry reservation when ambiguous fence cleanup fails", async () => {
    const firstFence = {
      leaseToken: "provider-lease-first",
      attemptKeyHash: "a".repeat(64),
    };
    const retryFence = {
      leaseToken: "provider-lease-retry",
      attemptKeyHash: "b".repeat(64),
    };
    const initialReservation = { token: "initial-reservation" };
    const retryReservation = { token: "retry-reservation" };
    mocks.reserveImageGenerationUsage
      .mockResolvedValueOnce(initialReservation)
      .mockResolvedValueOnce(retryReservation);
    mocks.reserveProviderFence
      .mockResolvedValueOnce(firstFence)
      .mockResolvedValueOnce(retryFence);
    mocks.finalizeProviderFence.mockImplementation(
      async (_fence: unknown, outcome: string) => {
        if (outcome === "ambiguous") {
          throw new Error("provider fence cleanup failed");
        }
      }
    );
    mocks.executeGenerationFlow.mockImplementation(async input => {
      const firstAdmission = await input.onProviderAttempt();
      await firstAdmission.markTransportStarted();
      const retryAdmission = await input.onProviderAttempt();
      await retryAdmission.abortBeforeTransport();
      throw new Error("generation failed before retry transport");
    });

    await expect(
      runWhatsAppImageGeneration(generationInput("wa-cleanup-release"))
    ).rejects.toThrow("generation failed before retry transport");

    expect(mocks.finalizeProviderFence).toHaveBeenCalledWith(
      firstFence,
      "ambiguous"
    );
    expect(mocks.finalizeProviderFence).toHaveBeenCalledWith(
      retryFence,
      "known_failed"
    );
    expect(mocks.releaseImageGenerationUsage).toHaveBeenCalledWith({
      channel: "whatsapp",
      senderId: SENDER_ID,
      reservation: retryReservation,
    });
  });

  it("preserves the operation failure when reservation release also fails", async () => {
    mocks.executeGenerationFlow.mockRejectedValueOnce(
      new Error("generation operation failed")
    );
    mocks.releaseImageGenerationUsage.mockRejectedValueOnce(
      new Error("quota release failed")
    );

    await expect(
      runWhatsAppImageGeneration(generationInput("wa-release-failure"))
    ).rejects.toThrow("generation operation failed");

    expect(mocks.releaseImageGenerationUsage).toHaveBeenCalledOnce();
  });

  it("marks an outstanding fence ambiguous exactly once on generation failure", async () => {
    mocks.executeGenerationFlow.mockImplementation(async input => {
      const admission = await input.onProviderAttempt();
      await admission.markTransportStarted();
      return {
        kind: "error" as const,
        errorKind: "generation_timeout" as const,
        error: new Error("generation timed out"),
        trustedSourceImageUrl: false,
      };
    });

    await runWhatsAppImageGeneration(generationInput("wa-failed"));

    expect(
      mocks.finalizeProviderFence.mock.calls.filter(
        call => call[1] === "ambiguous"
      )
    ).toHaveLength(1);
    expect(mocks.sendWhatsAppImageReplyWithReceipt).not.toHaveBeenCalled();
    expect(mocks.markGenerationCompleted).not.toHaveBeenCalled();
  });

  it("retains completion inventory for an ambiguous Graph outcome", async () => {
    mocks.executeGenerationFlow.mockImplementation(async input => {
      const admission = await input.onProviderAttempt();
      await admission.markTransportStarted();
      await input.onProviderSuccess();
      return successfulGenerationResult();
    });
    mocks.sendWhatsAppImageReplyWithReceipt.mockRejectedValueOnce(
      Object.assign(new Error("delivery ambiguous"), { outcome: "ambiguous" })
    );

    await expect(
      runWhatsAppImageGeneration(generationInput("wa-ambiguous"))
    ).rejects.toThrow("delivery ambiguous");

    expect(mocks.markGenerationCompleted).toHaveBeenCalledOnce();
    expect(mocks.markGenerationDelivered).not.toHaveBeenCalled();
    expect(mocks.finalizeProviderFence).toHaveBeenCalledWith(
      expect.any(Object),
      "succeeded"
    );
  });
});
