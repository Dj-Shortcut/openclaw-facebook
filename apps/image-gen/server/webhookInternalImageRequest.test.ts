import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { normalizeMessengerInboundImageMock } = vi.hoisted(() => ({
  normalizeMessengerInboundImageMock: vi.fn(),
}));

vi.mock("./_core/messengerImageIngress", () => ({
  normalizeMessengerInboundImage: normalizeMessengerInboundImageMock,
}));

import { createInternalMessengerImageRequestHandler } from "./_core/webhookInternalImageRequest";
import { resetStateStore, setFlowState } from "./_core/messengerState";
import { MESSENGER_SEND_SKIPPED } from "./_core/webhookFallback";

const originalPrivacyPepper = process.env.PRIVACY_PEPPER;

afterAll(() => {
  if (originalPrivacyPepper === undefined) {
    delete process.env.PRIVACY_PEPPER;
    return;
  }

  process.env.PRIVACY_PEPPER = originalPrivacyPepper;
});

beforeEach(() => {
  process.env.PRIVACY_PEPPER = "webhook-internal-image-request-test-pepper";
  normalizeMessengerInboundImageMock.mockReset();
  resetStateStore();
});

describe("internal Messenger image request handling", () => {
  it("does not persist source images for skipped in-flight requests", async () => {
    const maybeSendInFlightMessage = vi.fn(async () => ({
      handled: false as const,
    }));
    const handler = createInternalMessengerImageRequestHandler({
      defaultLang: "nl",
      maybeSendInFlightMessage,
      runImageGeneration: vi.fn(),
      sendLoggedText: vi.fn(async () => ({ sent: true })),
    });

    await Promise.resolve(
      setFlowState("processing-internal-user", "PROCESSING")
    );

    await expect(
      handler.acceptInternalMessengerImageRequest({
        psid: "processing-internal-user",
        prompt: "Restyle deze foto cinematic",
        reqId: "req-processing-internal",
        lang: "nl",
        sourceImageUrl: "https://img.example/should-not-persist.jpg",
      })
    ).resolves.toBe(MESSENGER_SEND_SKIPPED);

    expect(maybeSendInFlightMessage).toHaveBeenCalledWith(
      "processing-internal-user",
      "req-processing-internal",
      "nl"
    );
    expect(normalizeMessengerInboundImageMock).not.toHaveBeenCalled();
  });
});
