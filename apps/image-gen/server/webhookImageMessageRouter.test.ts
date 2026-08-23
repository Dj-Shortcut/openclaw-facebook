import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  cleanupNormalizedMessengerInboundImagesMock,
  getBotFeaturesMock,
  getStoredMessengerImageDecisionMock,
  handleTextMessageMock,
  isFaceMemoryEnabledMock,
  normalizeMessengerInboundImageMock,
  safeLogMock,
} = vi.hoisted(() => ({
  cleanupNormalizedMessengerInboundImagesMock: vi.fn(async () => undefined),
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
  cleanupNormalizedMessengerInboundImages:
    cleanupNormalizedMessengerInboundImagesMock,
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
  setPendingImage,
  setPendingStoredImages,
} from "./_core/messengerState";
import * as messengerState from "./_core/messengerState";
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
    cleanupNormalizedMessengerInboundImagesMock.mockClear();
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
      psid: "image-router-user",
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

  it("detects multiple uploaded photos and offers a channel-neutral combine action", async () => {
    const ctx = makeHandlerContext();
    normalizeMessengerInboundImageMock
      .mockResolvedValueOnce("https://assets.example/generated/source-1.jpg")
      .mockResolvedValueOnce("https://assets.example/generated/source-2.jpg");

    await expect(
      tryHandleImageMessage(ctx, {
        psid: "multi-image-router-user",
        userId: "multi-image-router-user-key",
        reqId: "req-multi-image-router",
        lang: "nl",
        attachments: [
          { type: "image", payload: { url: "https://example.com/one.jpg" } },
          { type: "image", payload: { url: "https://example.com/two.jpg" } },
        ],
      })
    ).resolves.toBe(true);

    expect(ctx.sendLoggedActions).toHaveBeenCalledWith(
      "multi-image-router-user",
      t("nl", "multiPhotoPrompt"),
      expect.arrayContaining([
        {
          id: "combine_photos",
          label: "Samenvoegen",
          inputText: "combine_photos",
        },
      ]),
      "req-multi-image-router"
    );
    expect(ctx.sendPhotoReceivedPrompt).not.toHaveBeenCalled();
    expect(
      await Promise.resolve(getState("multi-image-router-user"))
    ).toMatchObject({
      stage: "AWAITING_EDIT_PROMPT",
      pendingImageUrls: [
        "https://assets.example/generated/source-1.jpg",
        "https://assets.example/generated/source-2.jpg",
      ],
      lastPhotoUrl: "https://assets.example/generated/source-2.jpg",
      lastPhotoSource: "stored",
    });
  });

  it("does not download or persist a fifth photo when four are already retained", async () => {
    const ctx = makeHandlerContext();
    const psid = "image-router-full-source-user";
    const retainedImageUrls = [
      "https://assets.example/generated/source-1.jpg",
      "https://assets.example/generated/source-2.jpg",
      "https://assets.example/generated/source-3.jpg",
      "https://assets.example/generated/source-4.jpg",
    ];
    await setPendingStoredImages(psid, retainedImageUrls);

    await expect(
      tryHandleImageMessage(ctx, {
        psid,
        userId: "image-router-full-source-key",
        reqId: "req-image-router-fifth-source",
        lang: "nl",
        attachments: [
          { type: "image", payload: { url: "https://example.com/five.jpg" } },
        ],
      })
    ).resolves.toBe(true);

    expect(normalizeMessengerInboundImageMock).not.toHaveBeenCalled();
    expect(ctx.sendLoggedText).toHaveBeenCalledWith(
      psid,
      t("nl", "maxSourceImagesRetained"),
      "req-image-router-fifth-source"
    );
    expect(await Promise.resolve(getState(psid))).toMatchObject({
      pendingImageUrls: retainedImageUrls,
      lastPhotoUrl: retainedImageUrls[3],
    });
  });

  it("downloads only one of two new photos when three are already retained", async () => {
    const ctx = makeHandlerContext();
    const psid = "image-router-one-slot-user";
    const retainedImageUrls = [
      "https://assets.example/generated/source-1.jpg",
      "https://assets.example/generated/source-2.jpg",
      "https://assets.example/generated/source-3.jpg",
    ];
    const fourthImageUrl = "https://assets.example/generated/source-4.jpg";
    await setPendingStoredImages(psid, retainedImageUrls);
    normalizeMessengerInboundImageMock.mockResolvedValueOnce(fourthImageUrl);

    await expect(
      tryHandleImageMessage(ctx, {
        psid,
        userId: "image-router-one-slot-key",
        reqId: "req-image-router-one-slot",
        lang: "en",
        attachments: [
          { type: "image", payload: { url: "https://example.com/four.jpg" } },
          { type: "image", payload: { url: "https://example.com/five.jpg" } },
        ],
      })
    ).resolves.toBe(true);

    expect(normalizeMessengerInboundImageMock).toHaveBeenCalledTimes(1);
    expect(normalizeMessengerInboundImageMock).toHaveBeenCalledWith({
      inboundImageUrl: "https://example.com/four.jpg",
      psid,
      psidHash: expect.stringMatching(/^[a-f0-9]{12}$/),
      reqId: "req-image-router-one-slot",
    });
    expect(ctx.sendLoggedText).toHaveBeenCalledWith(
      psid,
      t("en", "maxSourceImagesRetained"),
      "req-image-router-one-slot"
    );
    expect(await Promise.resolve(getState(psid))).toMatchObject({
      pendingImageUrls: [...retainedImageUrls, fourthImageUrl],
      lastPhotoUrl: fourthImageUrl,
    });
  });

  it("counts a legacy single stored photo before accepting a multi-photo batch", async () => {
    const ctx = makeHandlerContext();
    const psid = "image-router-legacy-single-user";
    const legacyImageUrl =
      "https://assets.example/generated/legacy-single-source.jpg";
    const appendedImageUrls = [
      "https://assets.example/generated/new-source-1.jpg",
      "https://assets.example/generated/new-source-2.jpg",
      "https://assets.example/generated/new-source-3.jpg",
    ];
    await Promise.resolve(
      setPendingImage(psid, legacyImageUrl, Date.now(), "stored")
    );
    normalizeMessengerInboundImageMock
      .mockResolvedValueOnce(appendedImageUrls[0])
      .mockResolvedValueOnce(appendedImageUrls[1])
      .mockResolvedValueOnce(appendedImageUrls[2]);

    await expect(
      tryHandleImageMessage(ctx, {
        psid,
        userId: "image-router-legacy-single-key",
        reqId: "req-image-router-legacy-single",
        lang: "nl",
        attachments: [
          { type: "image", payload: { url: "https://example.com/new-1.jpg" } },
          { type: "image", payload: { url: "https://example.com/new-2.jpg" } },
          { type: "image", payload: { url: "https://example.com/new-3.jpg" } },
          { type: "image", payload: { url: "https://example.com/new-4.jpg" } },
        ],
      })
    ).resolves.toBe(true);

    expect(normalizeMessengerInboundImageMock).toHaveBeenCalledTimes(3);
    expect(await Promise.resolve(getState(psid))).toMatchObject({
      pendingImageUrls: [legacyImageUrl, ...appendedImageUrls],
      lastPhotoUrl: appendedImageUrls[2],
    });
  });

  it("cleans up new uploads when the privacy-fenced state write loses the erasure race", async () => {
    const ctx = makeHandlerContext();
    const storedImageUrl =
      "https://assets.example/generated/privacy-race-source.jpg";
    normalizeMessengerInboundImageMock.mockResolvedValueOnce(storedImageUrl);
    const persistSpy = vi
      .spyOn(messengerState, "setPendingStoredImages")
      .mockRejectedValueOnce(new Error("Messenger state subject is erased"));

    await expect(
      tryHandleImageMessage(ctx, {
        psid: "image-router-privacy-race-user",
        userId: "image-router-privacy-race-key",
        reqId: "req-image-router-privacy-race",
        lang: "nl",
        attachments: [
          {
            type: "image",
            payload: { url: "https://example.com/privacy-race.jpg" },
          },
        ],
      })
    ).rejects.toThrow("Messenger state subject is erased");

    expect(cleanupNormalizedMessengerInboundImagesMock).toHaveBeenCalledWith([
      storedImageUrl,
    ]);
    persistSpy.mockRestore();
  });

  it("serializes concurrent fourth-photo writes and cleans the losing upload", async () => {
    const ctx = makeHandlerContext();
    const psid = "image-router-concurrent-fourth-user";
    const retainedImageUrls = [
      "https://assets.example/generated/concurrent-source-1.jpg",
      "https://assets.example/generated/concurrent-source-2.jpg",
      "https://assets.example/generated/concurrent-source-3.jpg",
    ];
    const competingImageUrls = [
      "https://assets.example/generated/concurrent-source-a.jpg",
      "https://assets.example/generated/concurrent-source-b.jpg",
    ];
    await setPendingStoredImages(psid, retainedImageUrls);
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

    await expect(
      Promise.all(
        ["a", "b"].map(suffix =>
          tryHandleImageMessage(ctx, {
            psid,
            userId: "image-router-concurrent-fourth-key",
            reqId: `req-image-router-concurrent-${suffix}`,
            lang: "nl",
            attachments: [
              {
                type: "image",
                payload: {
                  url: `https://example.com/concurrent-${suffix}.jpg`,
                },
              },
            ],
          })
        )
      )
    ).resolves.toEqual([true, true]);

    const finalState = await Promise.resolve(getState(psid));
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
