import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canGenerate,
  canGenerateVideo,
  canTranscribe,
  checkAndIncrementTranscription,
  commitImageGenerationSuccess,
  commitTranscriptionSuccess,
  commitVideoGenerationSuccess,
  increment,
  incrementTranscription,
  releaseImageGenerationReservation,
  releaseTranscriptionReservation,
  releaseVideoGenerationReservation,
  reserveImageGenerationForAttempt,
  reserveTranscriptionForAttempt,
  reserveVideoGenerationForAttempt,
} from "./_core/messengerQuota";
import { getOrCreateState, resetStateStore, setFlowState, setPendingImage } from "./_core/messengerState";
import { getDayKey } from "./_core/messengerStateNormalization";
import { deleteState, readState, updateStoredState } from "./_core/stateStore";

const TEST_PEPPER = "ci-test-pepper";
const originalPrivacyPepper = process.env.PRIVACY_PEPPER;

describe("messenger quota dayKey", () => {
  beforeAll(() => {
    process.env.PRIVACY_PEPPER = TEST_PEPPER;
  });

  beforeEach(() => {
    resetStateStore();
    vi.useRealTimers();
    delete process.env.MESSENGER_QUOTA_BYPASS_IDS;
    delete process.env.MESSENGER_FREE_DAILY_LIMIT;
    delete process.env.MESSENGER_AUDIO_TRANSCRIPTION_DAILY_LIMIT;
    delete process.env.MESSENGER_VIDEO_GENERATION_DAILY_LIMIT;
  });

  afterAll(() => {
    if (originalPrivacyPepper === undefined) {
      delete process.env.PRIVACY_PEPPER;
      return;
    }

    process.env.PRIVACY_PEPPER = originalPrivacyPepper;
  });

  it("initializes new state with the current server dayKey", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T14:30:00.000Z"));

    const state = await Promise.resolve(getOrCreateState("quota-user"));

    expect(state.quota.dayKey).toBe("2026-03-01");
    expect(state.quota.count).toBe(0);
  });

  it("keeps the same dayKey throughout the same UTC day", async () => {
    const userId = "same-day-user";
    process.env.MESSENGER_FREE_DAILY_LIMIT = "3";
    const initialDayKey = (await Promise.resolve(getOrCreateState(userId))).quota.dayKey;

    await increment(userId);

    expect(await canGenerate(userId)).toBe(true);

    await increment(userId);

    expect(await canGenerate(userId)).toBe(true);

    await increment(userId);

    expect(await canGenerate(userId)).toBe(false);
    expect((await Promise.resolve(getOrCreateState(userId))).quota).toEqual({
      dayKey: initialDayKey,
      count: 3,
    });
  });

  it("resets quota state when increment runs across midnight", async () => {
    const userId = "midnight-user";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T23:59:59.999Z"));

    const initialDayKey = (await Promise.resolve(getOrCreateState(userId))).quota.dayKey;

    await increment(userId);
    vi.setSystemTime(new Date("2026-03-02T00:00:00.000Z"));

    expect(await canGenerate(userId)).toBe(true);
    expect((await Promise.resolve(getOrCreateState(userId))).quota).toEqual({
      dayKey: "2026-03-02",
      count: 0,
    });
    expect(initialDayKey).toBe("2026-03-01");
  });

  it("keeps active session state in the same store while quota changes", async () => {
    const userId = "shared-store-user";

    await Promise.resolve(setPendingImage(userId, "https://img.example/photo.jpg", 1000));
    await Promise.resolve(setFlowState(userId, "PROCESSING"));
    await increment(userId);

    const state = await Promise.resolve(getOrCreateState(userId));

    expect(state.stage).toBe("PROCESSING");
    expect(state.lastPhotoUrl).toBe("https://img.example/photo.jpg");
    expect(state.lastPhoto).toBe("https://img.example/photo.jpg");
    expect(state.quota.count).toBe(1);
  });

  it("skips quota limits for configured bypass ids", async () => {
    const userId = "bypass-user";
    process.env.MESSENGER_QUOTA_BYPASS_IDS = "bypass-user";

    await increment(userId);
    await increment(userId);
    await increment(userId);

    expect(await canGenerate(userId)).toBe(true);
    expect((await Promise.resolve(getOrCreateState(userId))).quota.count).toBe(0);
  });

  it("uses the configured daily quota limit", async () => {
    const userId = "configured-limit-user";
    process.env.MESSENGER_FREE_DAILY_LIMIT = "5";

    await increment(userId);
    await increment(userId);
    await increment(userId);

    expect(await canGenerate(userId)).toBe(true);

    await increment(userId);
    await increment(userId);

    expect(await canGenerate(userId)).toBe(false);
    expect((await Promise.resolve(getOrCreateState(userId))).quota.count).toBe(5);
  });

  it("uses 20 image provider attempts as the default daily quota limit", async () => {
    const userId = "default-image-limit-user";

    for (let index = 0; index < 20; index += 1) {
      await increment(userId);
    }

    expect(await canGenerate(userId)).toBe(false);
    expect((await Promise.resolve(getOrCreateState(userId))).quota.count).toBe(20);
  });

  it("commits a normal reserved image quota success", async () => {
    const userId = "reserved-image-user";
    process.env.MESSENGER_FREE_DAILY_LIMIT = "1";

    const reservation = await reserveImageGenerationForAttempt(userId);

    expect(reservation).not.toBeNull();
    let state = await Promise.resolve(getOrCreateState(userId));
    expect(state.quota.count).toBe(0);
    expect(state.imageGenerationQuotaReservation?.token).toBe(
      reservation!.token
    );

    await expect(
      commitImageGenerationSuccess(userId, reservation!)
    ).resolves.toBe(true);

    state = await Promise.resolve(getOrCreateState(userId));
    expect(state.quota.count).toBe(1);
    expect(state.imageGenerationQuotaReservation).toBeNull();
    expect(await canGenerate(userId)).toBe(false);
  });

  it("rejects a fabricated image quota reservation token", async () => {
    const userId = "fabricated-image-reservation-user";
    process.env.MESSENGER_FREE_DAILY_LIMIT = "1";

    await expect(
      commitImageGenerationSuccess(userId, { token: "fabricated-token" })
    ).resolves.toBe(false);

    expect((await Promise.resolve(getOrCreateState(userId))).quota.count).toBe(0);
    expect(await canGenerate(userId)).toBe(true);
  });

  it("rejects a stale image quota reservation", async () => {
    const userId = "stale-image-reservation-user";
    process.env.MESSENGER_FREE_DAILY_LIMIT = "1";
    const now = Date.now();

    await Promise.resolve(getOrCreateState(userId));
    await Promise.resolve(
      updateStoredState(userId, storedState => ({
        ...storedState!,
        imageGenerationQuotaReservation: {
          token: "stale-token",
          expiresAt: now - 1,
        },
      }))
    );

    await expect(
      commitImageGenerationSuccess(userId, { token: "stale-token" })
    ).resolves.toBe(false);

    const state = await Promise.resolve(getOrCreateState(userId));
    expect(state.quota.count).toBe(0);
    expect(state.imageGenerationQuotaReservation).toBeNull();
    expect(await canGenerate(userId)).toBe(true);
  });

  it("rejects a double image quota commit", async () => {
    const userId = "double-commit-image-reservation-user";
    process.env.MESSENGER_FREE_DAILY_LIMIT = "2";

    const reservation = await reserveImageGenerationForAttempt(userId);

    expect(reservation).not.toBeNull();
    await expect(
      commitImageGenerationSuccess(userId, reservation!)
    ).resolves.toBe(true);
    await expect(
      commitImageGenerationSuccess(userId, reservation!)
    ).resolves.toBe(false);

    const state = await Promise.resolve(getOrCreateState(userId));
    expect(state.quota.count).toBe(1);
    expect(state.imageGenerationQuotaReservation).toBeNull();
  });

  it("tolerates releasing an image quota reservation after commit", async () => {
    const userId = "release-after-commit-image-reservation-user";
    process.env.MESSENGER_FREE_DAILY_LIMIT = "2";

    const reservation = await reserveImageGenerationForAttempt(userId);

    expect(reservation).not.toBeNull();
    await expect(
      commitImageGenerationSuccess(userId, reservation!)
    ).resolves.toBe(true);
    await expect(
      releaseImageGenerationReservation(userId, reservation!)
    ).resolves.toBeUndefined();

    const state = await Promise.resolve(getOrCreateState(userId));
    expect(state.quota.count).toBe(1);
    expect(state.imageGenerationQuotaReservation).toBeNull();
  });

  it("releases a normal reserved image quota failure without incrementing", async () => {
    const userId = "released-image-user";
    process.env.MESSENGER_FREE_DAILY_LIMIT = "1";

    const reservation = await reserveImageGenerationForAttempt(userId);

    expect(reservation).not.toBeNull();
    await releaseImageGenerationReservation(userId, reservation!);

    const state = await Promise.resolve(getOrCreateState(userId));
    expect(state.quota.count).toBe(0);
    expect(state.imageGenerationQuotaReservation).toBeNull();
    expect(await canGenerate(userId)).toBe(true);
  });

  it("does not recreate deleted state when releasing an image reservation", async () => {
    const userId = "deleted-release-image-reservation-user";
    process.env.MESSENGER_FREE_DAILY_LIMIT = "1";

    const reservation = await reserveImageGenerationForAttempt(userId);

    expect(reservation).not.toBeNull();
    await Promise.resolve(deleteState(userId));
    await expect(
      releaseImageGenerationReservation(userId, reservation!)
    ).resolves.toBeUndefined();

    expect(await Promise.resolve(readState(userId))).toBeNull();
  });

  it("does not recreate deleted state when committing an image reservation", async () => {
    const userId = "deleted-commit-image-reservation-user";
    process.env.MESSENGER_FREE_DAILY_LIMIT = "1";

    const reservation = await reserveImageGenerationForAttempt(userId);

    expect(reservation).not.toBeNull();
    await Promise.resolve(deleteState(userId));
    await expect(
      commitImageGenerationSuccess(userId, reservation!)
    ).resolves.toBe(false);

    expect(await Promise.resolve(readState(userId))).toBeNull();
  });

  it("does not reserve image quota when the daily limit is exhausted", async () => {
    const userId = "image-quota-exhausted-user";
    process.env.MESSENGER_FREE_DAILY_LIMIT = "1";

    await increment(userId);

    await expect(reserveImageGenerationForAttempt(userId)).resolves.toBeNull();
    expect((await Promise.resolve(getOrCreateState(userId))).quota.count).toBe(1);
  });

  it("prevents concurrent active image quota reservations", async () => {
    const userId = "concurrent-image-reservation-user";
    process.env.MESSENGER_FREE_DAILY_LIMIT = "2";

    const results = await Promise.all([
      reserveImageGenerationForAttempt(userId),
      reserveImageGenerationForAttempt(userId),
    ]);
    const reservations = results.filter(result => result !== null);

    expect(reservations).toHaveLength(1);
    expect((await Promise.resolve(getOrCreateState(userId))).quota.count).toBe(0);

    await releaseImageGenerationReservation(userId, reservations[0]!);

    await expect(reserveImageGenerationForAttempt(userId)).resolves.not.toBeNull();
  });

  it("keeps image quota unchanged for configured bypass ids", async () => {
    const userId = "image-bypass-user";
    process.env.MESSENGER_QUOTA_BYPASS_IDS = userId;
    process.env.MESSENGER_FREE_DAILY_LIMIT = "0";

    const reservation = await reserveImageGenerationForAttempt(userId);

    expect(reservation).not.toBeNull();
    await commitImageGenerationSuccess(userId, reservation!);

    expect(await canGenerate(userId)).toBe(true);
    expect((await Promise.resolve(getOrCreateState(userId))).quota.count).toBe(0);
  });

  it("commits a normal reserved video quota success", async () => {
    const userId = "reserved-video-user";
    process.env.MESSENGER_VIDEO_GENERATION_DAILY_LIMIT = "1";

    const reservation = await reserveVideoGenerationForAttempt(userId);

    expect(reservation).not.toBeNull();
    let state = await Promise.resolve(getOrCreateState(userId));
    expect(state.videoGenerationQuota.count).toBe(0);
    expect(state.videoGenerationQuotaReservation?.token).toBe(
      reservation!.token
    );

    await expect(
      commitVideoGenerationSuccess(userId, reservation!)
    ).resolves.toBe(true);

    state = await Promise.resolve(getOrCreateState(userId));
    expect(state.videoGenerationQuota.count).toBe(1);
    expect(state.videoGenerationQuotaReservation).toBeNull();
    expect(await canGenerateVideo(userId)).toBe(false);
  });

  it("does not reserve video quota when the daily limit is exhausted", async () => {
    const userId = "video-quota-exhausted-user";
    process.env.MESSENGER_VIDEO_GENERATION_DAILY_LIMIT = "1";

    const reservation = await reserveVideoGenerationForAttempt(userId);
    expect(reservation).not.toBeNull();
    await expect(
      commitVideoGenerationSuccess(userId, reservation!)
    ).resolves.toBe(true);

    await expect(reserveVideoGenerationForAttempt(userId)).resolves.toBeNull();
  });

  it("rejects a double video quota commit and tolerates release after commit", async () => {
    const userId = "double-video-commit-user";
    process.env.MESSENGER_VIDEO_GENERATION_DAILY_LIMIT = "2";

    const reservation = await reserveVideoGenerationForAttempt(userId);

    expect(reservation).not.toBeNull();
    await expect(
      commitVideoGenerationSuccess(userId, reservation!)
    ).resolves.toBe(true);
    await expect(
      commitVideoGenerationSuccess(userId, reservation!)
    ).resolves.toBe(false);
    await expect(
      releaseVideoGenerationReservation(userId, reservation!)
    ).resolves.toBeUndefined();

    const state = await Promise.resolve(getOrCreateState(userId));
    expect(state.videoGenerationQuota.count).toBe(1);
    expect(state.videoGenerationQuotaReservation).toBeNull();
  });

  it("prevents concurrent active video quota reservations", async () => {
    const userId = "concurrent-video-reservation-user";
    process.env.MESSENGER_VIDEO_GENERATION_DAILY_LIMIT = "2";

    const results = await Promise.all([
      reserveVideoGenerationForAttempt(userId),
      reserveVideoGenerationForAttempt(userId),
    ]);
    const reservations = results.filter(result => result !== null);

    expect(reservations).toHaveLength(1);
    expect((await Promise.resolve(getOrCreateState(userId))).videoGenerationQuota.count).toBe(
      0
    );

    await releaseVideoGenerationReservation(userId, reservations[0]!);

    await expect(reserveVideoGenerationForAttempt(userId)).resolves.not.toBeNull();
  });

  it("tracks transcription quota independently from image quota", async () => {
    const userId = "audio-quota-separate-user";
    process.env.MESSENGER_AUDIO_TRANSCRIPTION_DAILY_LIMIT = "3";

    await increment(userId);
    await incrementTranscription(userId);
    await incrementTranscription(userId);

    expect(await canTranscribe(userId)).toBe(true);
    expect(await canGenerate(userId)).toBe(true);

    await incrementTranscription(userId);

    expect(await canTranscribe(userId)).toBe(false);
    expect(await canGenerate(userId)).toBe(true);
  });

  it("uses configured transcription quota limit", async () => {
    const userId = "configured-transcription-limit-user";
    process.env.MESSENGER_AUDIO_TRANSCRIPTION_DAILY_LIMIT = "1";

    expect(await canTranscribe(userId)).toBe(true);

    await incrementTranscription(userId);

    expect(await canTranscribe(userId)).toBe(false);
  });

  it("uses 5 audio transcription provider attempts as the default daily quota limit", async () => {
    const userId = "default-audio-limit-user";

    for (let index = 0; index < 5; index += 1) {
      await incrementTranscription(userId);
    }

    expect(await canTranscribe(userId)).toBe(false);
    expect((await Promise.resolve(getOrCreateState(userId))).transcriptionQuota.count).toBe(
      5
    );
  });

  it("prevents concurrent transcription quota bypass", async () => {
    const userId = "concurrent-transcription-user";
    process.env.MESSENGER_AUDIO_TRANSCRIPTION_DAILY_LIMIT = "2";

    const results = await Promise.all([
      checkAndIncrementTranscription(userId),
      checkAndIncrementTranscription(userId),
      checkAndIncrementTranscription(userId),
    ]);

    expect(results.filter(Boolean)).toHaveLength(2);
    expect(results.filter(result => !result)).toHaveLength(1);
    expect(await canTranscribe(userId)).toBe(false);
    expect((await Promise.resolve(getOrCreateState(userId))).transcriptionQuota.count).toBe(
      2
    );
  });

  it("only increments reserved transcription quota on commit", async () => {
    const userId = "reserved-transcription-user";
    process.env.MESSENGER_AUDIO_TRANSCRIPTION_DAILY_LIMIT = "1";

    const reservation = await reserveTranscriptionForAttempt(userId);

    expect(reservation).not.toBeNull();
    expect((await Promise.resolve(getOrCreateState(userId))).transcriptionQuota.count).toBe(
      0
    );

    await commitTranscriptionSuccess(userId, reservation!);

    expect((await Promise.resolve(getOrCreateState(userId))).transcriptionQuota.count).toBe(
      1
    );
    expect(await canTranscribe(userId)).toBe(false);
  });

  it("does not commit transcription quota without an active matching reservation", async () => {
    const userId = "fabricated-transcription-reservation-user";
    process.env.MESSENGER_AUDIO_TRANSCRIPTION_DAILY_LIMIT = "1";

    await expect(
      commitTranscriptionSuccess(userId, { token: "fabricated-token" })
    ).resolves.toBe(false);

    expect((await Promise.resolve(getOrCreateState(userId))).transcriptionQuota.count).toBe(
      0
    );
    expect(await canTranscribe(userId)).toBe(true);
  });

  it("releases reserved transcription quota without incrementing on failure", async () => {
    const userId = "released-transcription-user";
    process.env.MESSENGER_AUDIO_TRANSCRIPTION_DAILY_LIMIT = "1";

    const reservation = await reserveTranscriptionForAttempt(userId);

    expect(reservation).not.toBeNull();
    await releaseTranscriptionReservation(userId, reservation!);

    expect((await Promise.resolve(getOrCreateState(userId))).transcriptionQuota.count).toBe(
      0
    );
    expect(await canTranscribe(userId)).toBe(true);
  });

  it("backfills missing transcription quota from legacy state", async () => {
    const userId = "legacy-transcription-user";
    const dayKey = getDayKey();

    await Promise.resolve(setFlowState(userId, "IDLE"));
    await Promise.resolve(
      updateStoredState(userId, storedState => {
        const nextState = { ...(storedState as object) } as Record<string, unknown>;
        delete nextState.transcriptionQuota;
        return nextState as typeof storedState;
      })
    );

    const legacyState = await readState<Record<string, unknown>>(userId);
    expect(legacyState?.transcriptionQuota).toBeUndefined();

    await canTranscribe(userId);

    const hydratedState = await Promise.resolve(getOrCreateState(userId));
    const persistedState = await readState<{
      transcriptionQuota?: {
        dayKey: string;
        count: number;
      };
    }>(userId);

    expect(hydratedState.transcriptionQuota).toEqual({
      dayKey,
      count: 0,
    });
    expect(persistedState?.transcriptionQuota?.dayKey).toBe(dayKey);
  });

});
