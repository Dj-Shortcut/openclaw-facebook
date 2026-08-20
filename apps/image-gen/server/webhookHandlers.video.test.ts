import { beforeEach, describe, expect, it, vi } from "vitest";

const { videoRunnerMock, sendLoggedTextMock, sendLoggedVideoMock } = vi.hoisted(
  () => ({
    videoRunnerMock: vi.fn(async () => ({ sent: true as const })),
    sendLoggedTextMock: vi.fn(async () => ({ sent: true as const })),
    sendLoggedVideoMock: vi.fn(async () => ({ sent: true as const })),
  })
);

vi.mock("./_core/bot/defaultFeatures", () => ({
  ensureDefaultBotFeaturesRegistered: vi.fn(),
}));
vi.mock("./_core/webhookEventRouter", () => ({ handleEntry: vi.fn() }));
vi.mock("./_core/webhookHandlerContext", () => ({
  createHandlerContext: vi.fn(() => ({
    maybeSendInFlightMessage: vi.fn(async () => ({ handled: false })),
    sendLoggedImage: vi.fn(async () => ({ sent: true })),
    sendLoggedActions: vi.fn(async () => ({ sent: true })),
    sendLoggedText: sendLoggedTextMock,
    sendLoggedVideo: sendLoggedVideoMock,
  })),
}));
vi.mock("./_core/webhookGenerationJobs", () => ({
  createMessengerGenerationJobRunner: vi.fn(() => ({
    runImageGeneration: vi.fn(async () => ({ sent: true })),
    processMessengerGenerationJob: vi.fn(async () => ({ sent: true })),
    processMessengerGenerationJobDeadLetter: vi.fn(async () => ({
      sent: true,
    })),
  })),
}));
vi.mock("./_core/videoGenerationFlow", () => ({
  createMessengerVideoGenerationRunner: vi.fn(() => videoRunnerMock),
}));
vi.mock("./_core/webhookInternalImageRequest", () => ({
  createInternalMessengerImageRequestHandler: vi.fn(() => ({
    acceptInternalMessengerImageRequest: vi.fn(),
    processInternalMessengerImageRequest: vi.fn(),
  })),
}));

import { createWebhookHandlers } from "./_core/webhookHandlers";
import { t } from "./_core/i18n";
import { getMessengerRequestPageId } from "./_core/messengerRequestContext";

describe("queued Messenger video handlers", () => {
  beforeEach(() => {
    videoRunnerMock.mockReset();
    sendLoggedTextMock.mockClear();
  });

  it("restores the receiving Page context while processing a video job", async () => {
    let observedPageId: string | undefined;
    videoRunnerMock.mockImplementationOnce(async () => {
      observedPageId = getMessengerRequestPageId();
      return { sent: true };
    });
    const handlers = createWebhookHandlers({ defaultLang: "nl" });

    await handlers.processMessengerGenerationJob({
      operation: "video",
      psid: "video-user",
      userId: "video-user-key",
      pageId: "page-42",
      reqId: "req-video-job",
      lang: "nl",
      sourceImageUrl: "https://img.example/source.jpg",
      promptHint: "laat hem zwaaien",
    });

    expect(observedPageId).toBe("page-42");
  });

  it("restores Page context and localizes the video dead-letter response", async () => {
    let observedPageId: string | undefined;
    sendLoggedTextMock.mockImplementationOnce(async () => {
      observedPageId = getMessengerRequestPageId();
      return { sent: true };
    });
    const handlers = createWebhookHandlers({ defaultLang: "nl" });

    await handlers.processMessengerGenerationJobDeadLetter({
      operation: "video",
      psid: "video-user-en",
      userId: "video-user-en-key",
      pageId: "page-english",
      reqId: "req-video-dead-letter",
      lang: "en",
    });

    expect(observedPageId).toBe("page-english");
    expect(sendLoggedTextMock).toHaveBeenCalledWith(
      "video-user-en",
      t("en", "videoGenerationGenericFailure"),
      "req-video-dead-letter"
    );
  });
});
