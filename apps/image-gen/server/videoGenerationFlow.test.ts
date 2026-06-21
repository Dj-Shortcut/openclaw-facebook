import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const { safeLogMock, storagePutMock } = vi.hoisted(() => ({
  safeLogMock: vi.fn(),
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

vi.mock("./_core/messengerApi", async importOriginal => {
  const actual = await importOriginal<typeof import("./_core/messengerApi")>();
  return {
    ...actual,
    safeLog: safeLogMock,
  };
});

import { t } from "./_core/i18n";
import { appendCostLedgerEntry, readCostLedgerPeriod } from "./_core/costLedger";
import { getOrCreateState, resetStateStore } from "./_core/messengerState";
import { commitVideoGenerationSuccess, reserveVideoGenerationForAttempt } from "./_core/messengerQuota";
import { createMessengerVideoGenerationRunner } from "./_core/videoGenerationFlow";
import { setVideoProviderForTests } from "./_core/video-generation/videoProviderRegistry";
import type { VideoProvider } from "./_core/video-generation/videoProvider";

function requestSummaryKey(reqId: string): string {
  return `sha256:${createHash("sha256").update(reqId).digest("hex").slice(0, 12)}`;
}

const FIXED_LEDGER_NOW = new Date("2026-06-21T12:00:00.000Z");
const FIXED_LEDGER_PERIOD = "2026-06-21";

function makeProvider(result: Awaited<ReturnType<VideoProvider["generateVideo"]>>): VideoProvider {
  return {
    generateVideo: vi.fn(async input => {
      await input.onProviderAttempt?.();
      return result;
    }),
  };
}

function makeDelayedProvider(
  delayMs: number,
  result: Awaited<ReturnType<VideoProvider["generateVideo"]>>
): VideoProvider {
  return {
    generateVideo: vi.fn(
      input =>
        new Promise(resolve =>
          setTimeout(async () => {
            await input.onProviderAttempt?.();
            resolve(result);
          }, delayMs)
        )
    ),
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
    safeLogMock.mockClear();
    setVideoProviderForTests(null);
  });

  afterEach(() => {
    resetStateStore();
    setVideoProviderForTests(null);
    delete process.env.MESSENGER_VIDEO_GENERATION_DAILY_LIMIT;
    delete process.env.MESSENGER_PSID_LOCK_TTL_MS;
    delete process.env.MESSENGER_GLOBAL_DAILY_VIDEO_CAP;
    delete process.env.MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD;
    delete process.env.MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD;
    delete process.env.OPENAI_VIDEO_GENERATION_ESTIMATED_COST_USD;
    delete process.env.MESSENGER_VIDEO_FLOW_TIMEOUT_MS;
    vi.useRealTimers();
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

  it("records priced video attempts with final cost when configured", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_LEDGER_NOW);
    process.env.OPENAI_VIDEO_GENERATION_ESTIMATED_COST_USD = "0.12";
    const provider = makeProvider({
      kind: "success",
      provider: "test",
      providerJobId: "video-job-priced",
      videoBytes: new Uint8Array([1, 2, 3]),
      contentType: "video/mp4",
    });
    setVideoProviderForTests(provider);
    const deps = makeDeps();
    const runVideoGeneration = createMessengerVideoGenerationRunner(deps);

    await runVideoGeneration(
      "video-priced-user",
      "video-priced-user-key",
      "req-video-priced",
      "nl",
      "https://img.example/source.jpg",
      "laat hem zwaaien"
    );

    const ledgerEntries = await readCostLedgerPeriod(FIXED_LEDGER_PERIOD);
    expect(ledgerEntries).toEqual([
      expect.objectContaining({
        id: "req-video-priced:video:1",
        operation: "video_generation",
        provider: "video-provider",
        model: null,
        userKey: "video-priced-user-key",
        reqId: requestSummaryKey("req-video-priced"),
        status: "provider_attempt_succeeded",
        estimatedCostUsd: 0.12,
        estimatedOutputCostUsd: null,
        finalCostUsd: 0.12,
        costEstimateComplete: true,
        estimateSource: "env_override",
        unpricedCostComponents: [],
      }),
    ]);
    expect(JSON.stringify(ledgerEntries)).not.toContain("laat hem zwaaien");
    expect(JSON.stringify(ledgerEntries)).not.toContain("https://img.example/source.jpg");
    expect(JSON.stringify(ledgerEntries)).not.toContain("video-priced-user\"");
  });

  it("keeps provider success ledger status when downstream video storage fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_LEDGER_NOW);
    process.env.OPENAI_VIDEO_GENERATION_ESTIMATED_COST_USD = "0.12";
    storagePutMock.mockRejectedValueOnce(new Error("storage unavailable"));
    const provider = makeProvider({
      kind: "success",
      provider: "test",
      providerJobId: "video-job-storage-fails",
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
      "laat hem zwaaien"
    );

    expect(deps.sendLoggedText).toHaveBeenCalledWith(
      "video-storage-failure-user",
      t("nl", "videoGenerationGenericFailure"),
      "req-video-storage-failure"
    );
    expect(await readCostLedgerPeriod(FIXED_LEDGER_PERIOD)).toEqual([
      expect.objectContaining({
        id: "req-video-storage-failure:video:1",
        status: "provider_attempt_succeeded",
        finalCostUsd: 0.12,
      }),
    ]);
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

  it("does not count quota when video provider configuration is missing", async () => {
    setVideoProviderForTests(null);
    const deps = makeDeps();
    const runVideoGeneration = createMessengerVideoGenerationRunner(deps);

    await runVideoGeneration(
      "video-provider-config-missing-user",
      "video-provider-config-missing-user-key",
      "req-video-provider-config-missing",
      "nl",
      "https://img.example/source.jpg",
      "laat hem bewegen"
    );

    expect(storagePutMock).not.toHaveBeenCalled();
    expect(deps.sendLoggedVideo).not.toHaveBeenCalled();
    expect(deps.sendLoggedText).toHaveBeenCalledWith(
      "video-provider-config-missing-user",
      t("nl", "videoGenerationGenericFailure"),
      "req-video-provider-config-missing"
    );
    const state = await Promise.resolve(
      getOrCreateState("video-provider-config-missing-user")
    );
    expect(state.videoGenerationQuota.count).toBe(0);
    expect(state.videoGenerationQuotaReservation).toBeNull();
  });

  it("counts quota and sends specific copy on provider failure", async () => {
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
    expect(state.videoGenerationQuota.count).toBe(1);
    expect(state.videoGenerationQuotaReservation).toBeNull();
  });

  it("counts each video provider retry against quota", async () => {
    process.env.MESSENGER_VIDEO_GENERATION_DAILY_LIMIT = "2";
    const provider: VideoProvider = {
      generateVideo: vi.fn(async input => {
        await input.onProviderAttempt?.();
        await input.onProviderAttempt?.();
        return {
          kind: "failure",
          provider: "test",
          errorClass: "provider",
          retryable: false,
        };
      }),
    };
    setVideoProviderForTests(provider);
    const deps = makeDeps();
    const runVideoGeneration = createMessengerVideoGenerationRunner(deps);

    await runVideoGeneration(
      "video-provider-retry-user",
      "video-provider-retry-user-key",
      "req-video-provider-retry",
      "nl",
      "https://img.example/source.jpg",
      "laat hem bewegen"
    );

    const state = await Promise.resolve(getOrCreateState("video-provider-retry-user"));
    const ledgerEntries = await readCostLedgerPeriod(new Date().toISOString().slice(0, 10));
    expect(state.videoGenerationQuota.count).toBe(2);
    expect(state.videoGenerationQuotaReservation).toBeNull();
    expect(ledgerEntries).toEqual([
      expect.objectContaining({
        id: "req-video-provider-retry:video:1",
        channel: "facebook_messenger",
        operation: "video_generation",
        provider: "video-provider",
        model: null,
        userKey: "video-provider-retry-user-key",
        reqId: requestSummaryKey("req-video-provider-retry"),
        status: "provider_attempt_failed",
        costEstimateComplete: false,
        estimateSource: "unpriced",
        unpricedCostComponents: ["video_generation"],
      }),
      expect.objectContaining({
        id: "req-video-provider-retry:video:2",
        userKey: "video-provider-retry-user-key",
        status: "provider_attempt_failed",
      }),
    ]);
    expect(JSON.stringify(ledgerEntries)).not.toContain("laat hem bewegen");
    expect(JSON.stringify(ledgerEntries)).not.toContain("https://img.example/source.jpg");
  });

  it("stops video provider retries when quota is exhausted", async () => {
    process.env.MESSENGER_VIDEO_GENERATION_DAILY_LIMIT = "1";
    const provider: VideoProvider = {
      generateVideo: vi.fn(async input => {
        await input.onProviderAttempt?.();
        await input.onProviderAttempt?.();
        throw new Error("second provider attempt should be rejected by quota");
      }),
    };
    setVideoProviderForTests(provider);
    const deps = makeDeps();
    const runVideoGeneration = createMessengerVideoGenerationRunner(deps);

    await runVideoGeneration(
      "video-provider-retry-exhausted-user",
      "video-provider-retry-exhausted-user-key",
      "req-video-provider-retry-exhausted",
      "nl",
      "https://img.example/source.jpg",
      "laat hem bewegen"
    );

    const state = await Promise.resolve(
      getOrCreateState("video-provider-retry-exhausted-user")
    );
    const ledgerEntries = await readCostLedgerPeriod(new Date().toISOString().slice(0, 10));
    expect(state.videoGenerationQuota.count).toBe(1);
    expect(state.videoGenerationQuotaReservation).toBeNull();
    expect(deps.sendLoggedText).toHaveBeenCalledWith(
      "video-provider-retry-exhausted-user",
      t("nl", "outOfVideoCredits"),
      "req-video-provider-retry-exhausted"
    );
    expect(ledgerEntries).toHaveLength(1);
    expect(ledgerEntries[0]).toMatchObject({
      id: "req-video-provider-retry-exhausted:video:1",
      operation: "video_generation",
      userKey: "video-provider-retry-exhausted-user-key",
      status: "provider_attempt_failed",
    });
  });

  it("blocks misconfigured video generation cost overrides when spend caps are enabled", async () => {
    process.env.OPENAI_VIDEO_GENERATION_ESTIMATED_COST_USD = "0.025usd";
    process.env.MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD = "1";
    const provider: VideoProvider = {
      generateVideo: vi.fn(async input => {
        await input.onProviderAttempt?.();
        throw new Error("video provider should not continue after spend cap");
      }),
    };
    setVideoProviderForTests(provider);
    const deps = makeDeps();
    const runVideoGeneration = createMessengerVideoGenerationRunner(deps);

    await runVideoGeneration(
      "video-spend-cap-user",
      "video-spend-cap-user-key",
      "req-video-spend-cap",
      "nl",
      "https://img.example/source.jpg",
      "laat hem bewegen"
    );

    const state = await Promise.resolve(getOrCreateState("video-spend-cap-user"));
    expect(state.videoGenerationQuota.count).toBe(0);
    expect(state.videoGenerationQuotaReservation).toBeNull();
    expect(deps.sendLoggedText).toHaveBeenCalledWith(
      "video-spend-cap-user",
      t("nl", "outOfVideoCredits"),
      "req-video-spend-cap"
    );
    expect(await readCostLedgerPeriod(new Date().toISOString().slice(0, 10))).toEqual([]);
  });

  it("uses configured video generation estimates for spend cap checks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_LEDGER_NOW);
    process.env.OPENAI_VIDEO_GENERATION_ESTIMATED_COST_USD = "0.025";
    process.env.MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD = "0.03";
    await appendCostLedgerEntry(
      {
        id: "req-existing-video-spend:attempt-1",
        channel: "facebook_messenger",
        operation: "video_generation",
        provider: "video-provider",
        model: null,
        userKey: "other-user",
        reqId: "req-existing-video-spend",
        status: "provider_attempt_started",
        estimatedCostUsd: 0.02,
        estimatedOutputCostUsd: null,
        finalCostUsd: null,
        costEstimateComplete: true,
        estimateSource: "env_override",
        unpricedCostComponents: [],
      },
      FIXED_LEDGER_NOW
    );
    const provider: VideoProvider = {
      generateVideo: vi.fn(async input => {
        await input.onProviderAttempt?.();
        throw new Error("video provider should not continue after spend cap");
      }),
    };
    setVideoProviderForTests(provider);
    const deps = makeDeps();
    const runVideoGeneration = createMessengerVideoGenerationRunner(deps);

    await runVideoGeneration(
      "video-priced-spend-cap-user",
      "video-priced-spend-cap-user-key",
      "req-video-priced-spend-cap",
      "nl",
      "https://img.example/source.jpg",
      "laat hem bewegen"
    );

    const state = await Promise.resolve(getOrCreateState("video-priced-spend-cap-user"));
    expect(state.videoGenerationQuota.count).toBe(0);
    expect(state.videoGenerationQuotaReservation).toBeNull();
    expect(deps.sendLoggedText).toHaveBeenCalledWith(
      "video-priced-spend-cap-user",
      t("nl", "outOfVideoCredits"),
      "req-video-priced-spend-cap"
    );
    const ledgerEntries = await readCostLedgerPeriod(FIXED_LEDGER_PERIOD);
    expect(ledgerEntries).toHaveLength(1);
    expect(ledgerEntries[0]?.id).toBe("req-existing-video-spend:attempt-1");
  });

  it("uses timeout copy and counts quota on provider timeout", async () => {
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
    expect(state.videoGenerationQuota.count).toBe(1);
    expect(state.videoGenerationQuotaReservation).toBeNull();
  });

  it("uses timeout copy and counts quota when the full video flow exceeds its deadline", async () => {
    vi.useFakeTimers();
    process.env.MESSENGER_VIDEO_FLOW_TIMEOUT_MS = "5";
    const provider = makeDelayedProvider(10, {
      kind: "success",
      provider: "test",
      providerJobId: "video-job-too-slow",
      videoBytes: new Uint8Array([1, 2, 3]),
      contentType: "video/mp4",
    });
    setVideoProviderForTests(provider);
    const deps = makeDeps();
    const runVideoGeneration = createMessengerVideoGenerationRunner(deps);

    const runPromise = runVideoGeneration(
      "video-flow-timeout-user",
      "video-flow-timeout-user-key",
      "req-video-flow-timeout",
      "nl",
      "https://img.example/source.jpg",
      "laat hem dansen"
    );
    await vi.advanceTimersByTimeAsync(10);
    await runPromise;

    expect(storagePutMock).not.toHaveBeenCalled();
    expect(deps.sendLoggedVideo).not.toHaveBeenCalled();
    expect(deps.sendLoggedText).toHaveBeenCalledWith(
      "video-flow-timeout-user",
      t("nl", "videoGenerationTimeout"),
      "req-video-flow-timeout"
    );
    const state = await Promise.resolve(
      getOrCreateState("video-flow-timeout-user")
    );
    expect(state.videoGenerationQuota.count).toBe(1);
    expect(state.videoGenerationQuotaReservation).toBeNull();
    expect(safeLogMock).toHaveBeenCalledWith(
      "messenger_video_generation_flow_timeout",
      expect.objectContaining({
        reqId: "req-video-flow-timeout",
        timeoutMs: 5,
      })
    );
  });

  it("logs when a post-webhook failure notification cannot be delivered", async () => {
    const provider = makeProvider({
      kind: "failure",
      provider: "test",
      errorClass: "provider",
      retryable: false,
    });
    setVideoProviderForTests(provider);
    const deps = makeDeps();
    deps.sendLoggedText.mockResolvedValueOnce({ sent: true });
    deps.sendLoggedText.mockResolvedValueOnce({
      sent: false,
      reason: "response_window_closed",
    });
    const runVideoGeneration = createMessengerVideoGenerationRunner(deps);

    await runVideoGeneration(
      "video-window-closed-user",
      "video-window-closed-user-key",
      "req-video-window-closed",
      "nl",
      "https://img.example/source.jpg",
      "laat hem bewegen"
    );

    expect(deps.sendLoggedVideo).not.toHaveBeenCalled();
    expect(safeLogMock).toHaveBeenCalledWith(
      "messenger_video_generation_notification_skipped",
      expect.objectContaining({
        reqId: "req-video-window-closed",
        phase: "provider_failed",
        reason: "response_window_closed",
      })
    );
  });

  it("counts quota when generated video storage fails after provider success", async () => {
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
    expect(state.videoGenerationQuota.count).toBe(1);
    expect(state.videoGenerationQuotaReservation).toBeNull();
  });
});
