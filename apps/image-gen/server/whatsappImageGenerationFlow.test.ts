import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  canUseImageGeneration: vi.fn(),
  clearPendingImageState: vi.fn(),
  commitImageGenerationUsage: vi.fn(),
  executeGenerationFlow: vi.fn(),
  getOrCreateState: vi.fn(),
  releaseImageGenerationUsage: vi.fn(),
  reserveImageGenerationUsage: vi.fn(),
  runGuardedGeneration: vi.fn(),
  safeLog: vi.fn(),
  sendWhatsAppImageReply: vi.fn(),
  sendWhatsAppTextReply: vi.fn(),
  setFlowState: vi.fn(),
  setLastGenerated: vi.fn(),
  setLastGenerationContext: vi.fn(),
}));

vi.mock("./_core/generationFlow", () => ({
  executeGenerationFlow: mocks.executeGenerationFlow,
}));

vi.mock("./_core/image-generation/openAiImageClient", () => ({
  getGenerationMetrics: () => undefined,
}));

vi.mock("./_core/generationGuard", () => ({
  runGuardedGeneration: mocks.runGuardedGeneration,
}));

vi.mock("./_core/limits/generationQuota", () => ({
  canUseImageGeneration: mocks.canUseImageGeneration,
  commitImageGenerationUsage: mocks.commitImageGenerationUsage,
  MessengerQuotaReservationCommitError: class MessengerQuotaReservationCommitError extends Error {},
  releaseImageGenerationUsage: mocks.releaseImageGenerationUsage,
  reserveImageGenerationUsage: mocks.reserveImageGenerationUsage,
}));

vi.mock("./_core/messengerState", () => ({
  clearPendingImageState: mocks.clearPendingImageState,
  getOrCreateState: mocks.getOrCreateState,
  setFlowState: mocks.setFlowState,
  setLastGenerated: mocks.setLastGenerated,
  setLastGenerationContext: mocks.setLastGenerationContext,
}));

vi.mock("./_core/whatsappResponseService", () => ({
  sendWhatsAppImageReply: mocks.sendWhatsAppImageReply,
  sendWhatsAppTextReply: mocks.sendWhatsAppTextReply,
}));

vi.mock("./_core/logger", () => ({ safeLog: mocks.safeLog }));

import { runWhatsAppImageGeneration } from "./_core/whatsappFlows/imageGenerationFlow";

describe("WhatsApp image generation customer errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canUseImageGeneration.mockResolvedValue(true);
    mocks.getOrCreateState.mockReturnValue({
      lastPhotoUrl: null,
      lastPhotoSource: null,
    });
    mocks.reserveImageGenerationUsage.mockResolvedValue({ token: "quota" });
    mocks.releaseImageGenerationUsage.mockResolvedValue(undefined);
    mocks.runGuardedGeneration.mockImplementation(
      async (_senderId: string, work: () => Promise<void>) => {
        await work();
        return true;
      }
    );
    mocks.sendWhatsAppTextReply.mockResolvedValue(undefined);
    mocks.setFlowState.mockResolvedValue(undefined);
  });

  it("maps an OpenAI account limit to a neutral Dutch provider error", async () => {
    mocks.executeGenerationFlow.mockResolvedValue({
      kind: "error",
      errorKind: "generation_budget_reached",
      error: new Error("OpenAI budget exceeded"),
      trustedSourceImageUrl: false,
    });

    await runWhatsAppImageGeneration({
      senderId: "whatsapp-sender",
      userId: "opaque-user",
      reqId: "request-id",
      lang: "nl",
      promptHint: "maak een kat",
    });

    expect(mocks.sendWhatsAppTextReply).toHaveBeenNthCalledWith(
      2,
      "whatsapp-sender",
      "Ik kan nu even geen afbeelding maken. Probeer later opnieuw."
    );
    const customerMessages = mocks.sendWhatsAppTextReply.mock.calls
      .map(([, message]) => message)
      .join("\n");
    expect(customerMessages).not.toMatch(/budget|maand/i);
    expect(mocks.setFlowState).toHaveBeenLastCalledWith(
      "whatsapp-sender",
      "AWAITING_EDIT_PROMPT"
    );
  });
});
