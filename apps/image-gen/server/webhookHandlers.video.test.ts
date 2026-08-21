import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  videoRunnerMock,
  sendLoggedTextMock,
  sendLoggedVideoMock,
  createHandlerContextMock,
  enqueueGenerationMock,
  resolveOwnershipMock,
  ensurePrivacySubjectMock,
  assertOwnershipMock,
  assertPrivacySubjectMock,
} = vi.hoisted(() => ({
  videoRunnerMock: vi.fn(async () => ({ sent: true as const })),
  sendLoggedTextMock: vi.fn(async () => ({ sent: true as const })),
  sendLoggedVideoMock: vi.fn(async () => ({ sent: true as const })),
  createHandlerContextMock: vi.fn(),
  enqueueGenerationMock: vi.fn(),
  resolveOwnershipMock: vi.fn(),
  ensurePrivacySubjectMock: vi.fn(),
  assertOwnershipMock: vi.fn(),
  assertPrivacySubjectMock: vi.fn(),
}));

vi.mock("./_core/bot/defaultFeatures", () => ({
  ensureDefaultBotFeaturesRegistered: vi.fn(),
}));
vi.mock("./_core/webhookEventRouter", () => ({ handleEntry: vi.fn() }));
vi.mock("./_core/webhookHandlerContext", () => ({
  createHandlerContext: createHandlerContextMock,
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
vi.mock("./_core/messengerGenerationQueue", () => ({
  enqueueOrRunMessengerGenerationJob: enqueueGenerationMock,
}));
vi.mock("./_core/workspaceEntitlementRuntime", () => ({
  assertMessengerGenerationOwnership: assertOwnershipMock,
  resolveMessengerGenerationOwnership: resolveOwnershipMock,
  WorkspaceEntitlementLookupError: class WorkspaceEntitlementLookupError extends Error {},
}));
vi.mock("./_core/messengerPrivacySubject", () => ({
  assertMessengerPrivacySubject: assertPrivacySubjectMock,
  ensureActiveMessengerPrivacySubject: ensurePrivacySubjectMock,
  MessengerPrivacyFenceError: class MessengerPrivacyFenceError extends Error {},
}));
vi.mock("./_core/webhookInternalImageRequest", () => ({
  createInternalMessengerImageRequestHandler: vi.fn(() => ({
    acceptInternalMessengerImageRequest: vi.fn(),
    processInternalMessengerImageRequest: vi.fn(),
  })),
}));

import { createWebhookHandlers } from "./_core/webhookHandlers";
import { t } from "./_core/i18n";
import {
  getMessengerRequestPageId,
  runWithMessengerRequestContext,
} from "./_core/messengerRequestContext";

describe("queued Messenger video handlers", () => {
  beforeEach(() => {
    videoRunnerMock.mockReset();
    sendLoggedTextMock.mockClear();
    createHandlerContextMock.mockReset();
    createHandlerContextMock.mockImplementation(input => ({
      maybeSendInFlightMessage: vi.fn(async () => ({ handled: false })),
      sendLoggedImage: vi.fn(async () => ({ sent: true })),
      sendLoggedActions: vi.fn(async () => ({ sent: true })),
      sendLoggedText: sendLoggedTextMock,
      sendLoggedVideo: sendLoggedVideoMock,
      runVideoGeneration: input.runVideoGeneration,
    }));
    enqueueGenerationMock.mockReset();
    enqueueGenerationMock.mockResolvedValue({ mode: "queued" });
    resolveOwnershipMock.mockReset();
    resolveOwnershipMock.mockResolvedValue({
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      pageId: "page-42",
    });
    ensurePrivacySubjectMock.mockReset();
    ensurePrivacySubjectMock.mockResolvedValue(5);
    assertOwnershipMock.mockReset();
    assertPrivacySubjectMock.mockReset();
  });

  it("binds queued video work to immutable ownership and privacy epochs", async () => {
    createWebhookHandlers({ defaultLang: "nl" });
    const context = createHandlerContextMock.mock.results[0]?.value as {
      runVideoGeneration: (
        psid: string,
        userId: string,
        reqId: string,
        lang: "nl",
        sourceImageUrl: string,
        promptHint: string
      ) => Promise<unknown>;
    };

    await runWithMessengerRequestContext("page-42", async () => {
      await context.runVideoGeneration(
        "video-user",
        "video-user-key",
        "req-video-enqueue",
        "nl",
        "https://img.example/source.jpg",
        "laat hem zwaaien"
      );
    });

    expect(enqueueGenerationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "video",
        pageId: "page-42",
        workspaceId: 42,
        channelConnectionId: 7,
        bindingEpoch: 3,
        privacyEpoch: 5,
      }),
      expect.any(Function),
      expect.objectContaining({ onDeadLetter: expect.any(Function) })
    );
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
