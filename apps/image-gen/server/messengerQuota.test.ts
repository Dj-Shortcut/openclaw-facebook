import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { canGenerate, canTranscribe, increment, incrementTranscription } from "./_core/messengerQuota";
import { getOrCreateState, resetStateStore, setFlowState, setPendingImage } from "./_core/messengerState";

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

  it("tracks transcription quota independently from image quota", async () => {
    const userId = "audio-quota-separate-user";

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

});
