import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { storagePutMock } = vi.hoisted(() => ({
  storagePutMock: vi.fn(async () => ({
    key: "generated/videos/test.mp4",
    url: "https://cdn.example/generated/videos/test.mp4",
  })),
}));

vi.mock("./storage", async importOriginal => {
  const actual = await importOriginal<typeof import("./storage")>();
  return {
    ...actual,
    storagePut: storagePutMock,
  };
});

import { t } from "./_core/i18n";
import { getOrCreateState, resetStateStore } from "./_core/messengerState";
import { commitVideoGenerationSuccess, reserveVideoGenerationForAttempt } from "./_core/messengerQuota";
import { createMessengerVideoGenerationRunner } from "./_core/videoGenerationFlow";
import { setVideoProviderForTests } from "./_core/video-generation/videoProviderRegistry";
import type { VideoProvider } from "./_core/video-generation/videoProvider";

function makeProvider(result: Awaited<ReturnType<VideoProvider["generateVideo"]>>): VideoProvider {
  return {
    generateVideo: vi.fn(async () => result),
  };
}

function makeDeps() {
  return {
    maybeSendInFlightMessage: vi.fn(async () => ({ handled: false })),
    sendLoggedText: vi.fn(async () => ({ sent: true as const })),
    sendLoggedVideo: vi.fn(async () => ({ sent: true as const, messageId: "mid-video" })),
  };
}

describe("messenger video generation flow", () => {
  beforeEach(() => {
    process.env.PRIVACY_PEPPER = "video-flow-test-pepper";
    process.env.MESSENGER_VIDEO_GENERATION_DAILY_LIMIT = "1";
    process.env.MESSENGER_PSID_LOCK_TTL_MS = "1000";
    resetStateStore();
    storagePutMock.mockClear();
    setVideoProviderForTests(null);
  });

  afterEach(() => {
    resetStateStore();
    setVideoProviderForTests(null);
    delete process.env.MESSENGER_VIDEO_GENERATION_DAILY_LIMIT;
    delete process.env.MESSENGER_PSID_LOCK_TTL_MS;
    delete process.env.MESSENGER_GLOBAL_DAILY_VIDEO_CAP;
  });

  it("generates, stores, commits quota, and sends a Messenger video", async () => {
    const provider = makeProvider({
      kind: "success",
      provider: "test",
      providerJobId: "video-job-1",
      videoBytes: new Uint8Array([1, 2, 3]),
      contentType: "video/mp4",
    });
    setVideoProviderForTests(provider);
    const deps = makeDeps();
    const runVideoGeneration = createMessengerVideoGenerationRunner(deps);

    await runVideoGeneration(
      "video-success-user",
      "video-success-user-key",
      "req-video-success",
      "nl",
      "https://img.example/source.jpg",
      "laat hem dansen"
    );

    expect(provider.generateVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "laat hem dansen",
        sourceImageUrl: "https://img.example/source.jpg",
      })
    );
    expect(storagePutMock).toHaveBeenCalledWith(
      expect.stringMatching(/^generated\/videos\/.*req-video-success.*\.mp4$/),
      new Uint8Array([1, 2, 3]),
      "video/mp4"
    );
    expect(deps.sendLoggedVideo).toHaveBeenCalledWith(
      "video-success-user",
      "https://cdn.example/generated/videos/test.mp4",
      "req-video-success"
    );
    const state = await Promise.resolve(getOrCreateState("video-success-user"));
    expect(state.videoGenerationQuota.count).toBe(1);
    expect(state.videoGenerationQuotaReservation).toBeNull();
    expect(state.lastGeneratedVideoUrl).toBe(
      "https://cdn.example/generated/videos/test.mp4"
    );
  });

  it("does not call the provider when video quota is exhausted", async () => {
    const psid = "video-exhausted-user";
    const reservation = await reserveVideoGenerationForAttempt(psid);
    expect(reservation).not.toBeNull();
    await commitVideoGenerationSuccess(psid, reservation!);
    const provider = makeProvider({
      kind: "success",
      provider: "test",
      providerJobId: "should-not-run",
      videoBytes: new Uint8Array([1]),
      contentType: "video/mp4",
    });
    setVideoProviderForTests(provider);
    const deps = makeDeps();
    const runVideoGeneration = createMessengerVideoGenerationRunner(deps);

    await runVideoGeneration(
      psid,
      "video-exhausted-user-key",
      "req-video-exhausted",
      "nl",
      "https://img.example/source.jpg",
      "laat hem zingen"
    );

    expect(provider.generateVideo).not.toHaveBeenCalled();
    expect(storagePutMock).not.toHaveBeenCalled();
    expect(deps.sendLoggedVideo).not.toHaveBeenCalled();
    expect(deps.sendLoggedText).toHaveBeenCalledWith(
      psid,
      t("nl", "outOfVideoCredits"),
      "req-video-exhausted"
    );
  });

  it("releases reservation and sends specific copy on provider failure", async () => {
    const provider = makeProvider({
      kind: "failure",
      provider: "test",
      errorClass: "provider",
      retryable: false,
    });
    setVideoProviderForTests(provider);
    const deps = makeDeps();
    const runVideoGeneration = createMessengerVideoGenerationRunner(deps);

    await runVideoGeneration(
      "video-provider-failure-user",
      "video-provider-failure-user-key",
      "req-video-provider-failure",
      "nl",
      "https://img.example/source.jpg",
      "laat hem bewegen"
    );

    expect(storagePutMock).not.toHaveBeenCalled();
    expect(deps.sendLoggedVideo).not.toHaveBeenCalled();
    expect(deps.sendLoggedText).toHaveBeenCalledWith(
      "video-provider-failure-user",
      t("nl", "videoGenerationGenericFailure"),
      "req-video-provider-failure"
    );
    const state = await Promise.resolve(
      getOrCreateState("video-provider-failure-user")
    );
    expect(state.videoGenerationQuota.count).toBe(0);
    expect(state.videoGenerationQuotaReservation).toBeNull();
  });

  it("uses timeout copy and releases reservation on provider timeout", async () => {
    const provider = makeProvider({
      kind: "failure",
      provider: "test",
      errorClass: "timeout",
      retryable: true,
    });
    setVideoProviderForTests(provider);
    const deps = makeDeps();
    const runVideoGeneration = createMessengerVideoGenerationRunner(deps);

    await runVideoGeneration(
      "video-timeout-user",
      "video-timeout-user-key",
      "req-video-timeout",
      "nl",
      "https://img.example/source.jpg",
      "laat hem dansen"
    );

    expect(deps.sendLoggedVideo).not.toHaveBeenCalled();
    expect(deps.sendLoggedText).toHaveBeenCalledWith(
      "video-timeout-user",
      t("nl", "videoGenerationTimeout"),
      "req-video-timeout"
    );
    const state = await Promise.resolve(getOrCreateState("video-timeout-user"));
    expect(state.videoGenerationQuota.count).toBe(0);
    expect(state.videoGenerationQuotaReservation).toBeNull();
  });

  it("releases reservation when generated video storage fails", async () => {
    storagePutMock.mockRejectedValueOnce(new Error("storage unavailable"));
    const provider = makeProvider({
      kind: "success",
      provider: "test",
      providerJobId: "video-job-storage-fail",
      videoBytes: new Uint8Array([1, 2, 3]),
      contentType: "video/mp4",
    });
    setVideoProviderForTests(provider);
    const deps = makeDeps();
    const runVideoGeneration = createMessengerVideoGenerationRunner(deps);

    await runVideoGeneration(
      "video-storage-failure-user",
      "video-storage-failure-user-key",
      "req-video-storage-failure",
      "nl",
      "https://img.example/source.jpg",
      "laat hem bewegen"
    );

    expect(deps.sendLoggedVideo).not.toHaveBeenCalled();
    expect(deps.sendLoggedText).toHaveBeenCalledWith(
      "video-storage-failure-user",
      t("nl", "videoGenerationGenericFailure"),
      "req-video-storage-failure"
    );
    const state = await Promise.resolve(
      getOrCreateState("video-storage-failure-user")
    );
    expect(state.videoGenerationQuota.count).toBe(0);
    expect(state.videoGenerationQuotaReservation).toBeNull();
  });
});
