import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
  cleanupNormalizedMessengerInboundImagesMock,
  normalizeMessengerInboundImageMock,
} = vi.hoisted(() => ({
  cleanupNormalizedMessengerInboundImagesMock: vi.fn(async () => undefined),
  normalizeMessengerInboundImageMock: vi.fn(),
}));

vi.mock("./_core/messengerImageIngress", () => ({
  cleanupNormalizedMessengerInboundImages:
    cleanupNormalizedMessengerInboundImagesMock,
  normalizeMessengerInboundImage: normalizeMessengerInboundImageMock,
}));

import { createInternalMessengerImageRequestHandler } from "./_core/webhookInternalImageRequest";
import {
  getState,
  resetStateStore,
  setFlowState,
  setPendingImage,
  setPendingStoredImages,
} from "./_core/messengerState";
import * as messengerState from "./_core/messengerState";
import { MESSENGER_SEND_SKIPPED } from "./_core/webhookFallback";
import { runWithMessengerRequestContext } from "./_core/messengerRequestContext";
import { t } from "./_core/i18n";

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
  cleanupNormalizedMessengerInboundImagesMock.mockClear();
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

    await runWithMessengerRequestContext("page-processing-internal", () =>
      Promise.resolve(setFlowState("processing-internal-user", "PROCESSING"))
    );

    await expect(
      handler.acceptInternalMessengerImageRequest({
        psid: "processing-internal-user",
        pageId: "page-processing-internal",
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

  it("does not download a new internal source after four photos are retained", async () => {
    const pageId = "page-full-internal";
    const psid = "full-internal-user";
    const retainedImageUrls = [
      "https://assets.example/generated/source-1.jpg",
      "https://assets.example/generated/source-2.jpg",
      "https://assets.example/generated/source-3.jpg",
      "https://assets.example/generated/source-4.jpg",
    ];
    await runWithMessengerRequestContext(pageId, () =>
      setPendingStoredImages(psid, retainedImageUrls)
    );

    const runImageGeneration = vi.fn(async () => ({ sent: true as const }));
    const sendLoggedText = vi.fn(async () => ({ sent: true as const }));
    const handler = createInternalMessengerImageRequestHandler({
      defaultLang: "nl",
      maybeSendInFlightMessage: vi.fn(async () => ({
        handled: false as const,
      })),
      runImageGeneration,
      sendLoggedText,
    });

    await expect(
      handler.acceptInternalMessengerImageRequest({
        psid,
        pageId,
        prompt: "Combineer deze foto's",
        reqId: "req-full-internal",
        lang: "nl",
        sourceImageUrl: "https://img.example/should-not-persist.jpg",
      })
    ).resolves.toEqual({ sent: true });

    expect(normalizeMessengerInboundImageMock).not.toHaveBeenCalled();
    expect(sendLoggedText).toHaveBeenCalledWith(
      psid,
      t("nl", "maxSourceImagesRetained"),
      "req-full-internal"
    );
    expect(runImageGeneration).toHaveBeenCalledWith(
      psid,
      expect.any(String),
      "req-full-internal",
      "nl",
      retainedImageUrls[3],
      "Combineer deze foto's",
      "source_image_edit"
    );
    await expect(
      runWithMessengerRequestContext(pageId, () =>
        Promise.resolve(getState(psid))
      )
    ).resolves.toMatchObject({
      pendingImageUrls: retainedImageUrls,
      lastPhotoUrl: retainedImageUrls[3],
    });
  });

  it("counts a legacy single photo and appends without replacing it", async () => {
    const pageId = "page-legacy-single-internal";
    const psid = "legacy-single-internal-user";
    const legacyImageUrl =
      "https://assets.example/generated/legacy-internal-source.jpg";
    const storedImageUrl =
      "https://assets.example/generated/new-internal-source.jpg";
    await runWithMessengerRequestContext(pageId, () =>
      Promise.resolve(
        setPendingImage(psid, legacyImageUrl, Date.now(), "stored")
      )
    );
    normalizeMessengerInboundImageMock.mockResolvedValueOnce(storedImageUrl);
    const handler = createInternalMessengerImageRequestHandler({
      defaultLang: "nl",
      maybeSendInFlightMessage: vi.fn(async () => ({
        handled: false as const,
      })),
      runImageGeneration: vi.fn(async () => ({ sent: true as const })),
      sendLoggedText: vi.fn(async () => ({ sent: true as const })),
    });

    await handler.acceptInternalMessengerImageRequest({
      psid,
      pageId,
      prompt: "Combineer deze foto's",
      reqId: "req-legacy-single-internal",
      sourceImageUrl: "https://img.example/new-internal-source.jpg",
    });

    await expect(
      runWithMessengerRequestContext(pageId, () =>
        Promise.resolve(getState(psid))
      )
    ).resolves.toMatchObject({
      pendingImageUrls: [legacyImageUrl, storedImageUrl],
      lastPhotoUrl: storedImageUrl,
    });
  });

  it("cleans up an internal upload when its privacy-fenced state write fails", async () => {
    const storedImageUrl =
      "https://assets.example/generated/internal-privacy-race.jpg";
    normalizeMessengerInboundImageMock.mockResolvedValueOnce(storedImageUrl);
    const persistSpy = vi
      .spyOn(messengerState, "setPendingStoredImages")
      .mockRejectedValueOnce(new Error("Messenger state subject is erased"));
    const handler = createInternalMessengerImageRequestHandler({
      defaultLang: "nl",
      maybeSendInFlightMessage: vi.fn(async () => ({
        handled: false as const,
      })),
      runImageGeneration: vi.fn(async () => ({ sent: true as const })),
      sendLoggedText: vi.fn(async () => ({ sent: true as const })),
    });

    await expect(
      handler.acceptInternalMessengerImageRequest({
        psid: "internal-privacy-race-user",
        pageId: "page-internal-privacy-race",
        prompt: "Bewerk deze foto",
        reqId: "req-internal-privacy-race",
        sourceImageUrl: "https://img.example/internal-privacy-race.jpg",
      })
    ).rejects.toThrow("Messenger state subject is erased");

    expect(cleanupNormalizedMessengerInboundImagesMock).toHaveBeenCalledWith([
      storedImageUrl,
    ]);
    persistSpy.mockRestore();
  });

  it("serializes concurrent direct uploads and cleans the photo that loses the fourth slot", async () => {
    const pageId = "page-concurrent-internal";
    const psid = "concurrent-internal-user";
    const retainedImageUrls = [
      "https://assets.example/generated/internal-source-1.jpg",
      "https://assets.example/generated/internal-source-2.jpg",
      "https://assets.example/generated/internal-source-3.jpg",
    ];
    const competingImageUrls = [
      "https://assets.example/generated/internal-source-a.jpg",
      "https://assets.example/generated/internal-source-b.jpg",
    ];
    await runWithMessengerRequestContext(pageId, () =>
      setPendingStoredImages(psid, retainedImageUrls)
    );
    let uploadedCount = 0;
    let releaseUploads!: () => void;
    const bothUploaded = new Promise<void>(resolve => {
      releaseUploads = resolve;
    });
    normalizeMessengerInboundImageMock.mockImplementation(
      async (input: { inboundImageUrl: string }) => {
        const result = input.inboundImageUrl.endsWith("a.jpg")
          ? competingImageUrls[0]
          : competingImageUrls[1];
        uploadedCount += 1;
        if (uploadedCount === 2) releaseUploads();
        await bothUploaded;
        return result;
      }
    );
    const handler = createInternalMessengerImageRequestHandler({
      defaultLang: "nl",
      maybeSendInFlightMessage: vi.fn(async () => ({
        handled: false as const,
      })),
      runImageGeneration: vi.fn(async () => ({ sent: true as const })),
      sendLoggedText: vi.fn(async () => ({ sent: true as const })),
    });

    await expect(
      Promise.all(
        ["a", "b"].map(suffix =>
          handler.acceptInternalMessengerImageRequest({
            psid,
            pageId,
            prompt: "Combineer deze foto's",
            reqId: `req-concurrent-internal-${suffix}`,
            sourceImageUrl: `https://img.example/concurrent-${suffix}.jpg`,
          })
        )
      )
    ).resolves.toEqual([{ sent: true }, { sent: true }]);

    const finalState = await runWithMessengerRequestContext(pageId, () =>
      Promise.resolve(getState(psid))
    );
    expect(finalState?.pendingImageUrls).toHaveLength(4);
    expect(finalState?.pendingImageUrls).toEqual(
      expect.arrayContaining(retainedImageUrls)
    );
    const acceptedCompeting = competingImageUrls.filter(url =>
      finalState?.pendingImageUrls?.includes(url)
    );
    const cleanedCompeting =
      cleanupNormalizedMessengerInboundImagesMock.mock.calls.flatMap(
        ([urls]) => urls
      );
    expect(acceptedCompeting).toHaveLength(1);
    expect(cleanedCompeting).toEqual([
      competingImageUrls.find(url => !acceptedCompeting.includes(url)),
    ]);
  });
});
