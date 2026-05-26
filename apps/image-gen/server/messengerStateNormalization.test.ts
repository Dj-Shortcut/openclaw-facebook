import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDefaultState,
  getDayKey,
  getUserKey,
  normalizeState,
} from "./_core/messengerStateNormalization";

const originalPrivacyPepper = process.env.PRIVACY_PEPPER;

describe("messenger state normalization", () => {
  beforeEach(() => {
    process.env.PRIVACY_PEPPER = "test-privacy-pepper";
  });

  afterEach(() => {
    if (originalPrivacyPepper === undefined) {
      delete process.env.PRIVACY_PEPPER;
      return;
    }

    process.env.PRIVACY_PEPPER = originalPrivacyPepper;
  });

  it("creates a complete default state for a new user", () => {
    const now = Date.UTC(2026, 3, 27, 10, 30, 0);
    const psid =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    expect(createDefaultState(psid, now)).toMatchObject({
      psid,
      userKey: psid,
      stage: "IDLE",
      state: "IDLE",
      lastEntryIntent: null,
      activeExperience: null,
      lastPhotoUrl: null,
      lastPhoto: null,
      selectedStyle: null,
      chosenStyle: null,
      preferredLang: "nl",
      consentGiven: false,
      pendingDeleteConfirm: false,
      hasSeenIntro: false,
      lastGeneratedUrl: null,
      quota: {
        dayKey: "2026-04-27",
        count: 0,
      },
      updatedAt: now,
    });
  });

  it("normalizes legacy aliases while preserving explicit state fields", () => {
    const normalized = normalizeState("fallback-psid", {
      psid: "stored-psid",
      userKey: "legacy-raw-user-key",
      state: "RESULT_READY",
      lastPhoto: "https://example.test/legacy-photo.jpg",
      chosenStyle: "disco",
      lastImageUrl: "https://example.test/generated.jpg",
      consentGiven: true,
      consentTimestamp: 1234,
      pendingDeleteConfirm: true,
      hasSeenIntro: true,
      preferredLang: "en",
      quota: {
        dayKey: "2026-04-26",
        count: 3,
      },
      updatedAt: 5678,
    });

    expect(normalized).toMatchObject({
      psid: "stored-psid",
      userKey: getUserKey("legacy-raw-user-key"),
      stage: "RESULT_READY",
      state: "RESULT_READY",
      lastPhotoUrl: "https://example.test/legacy-photo.jpg",
      lastPhoto: "https://example.test/legacy-photo.jpg",
      selectedStyle: "disco",
      chosenStyle: "disco",
      lastImageUrl: "https://example.test/generated.jpg",
      lastGeneratedUrl: "https://example.test/generated.jpg",
      consentGiven: true,
      consentTimestamp: 1234,
      pendingDeleteConfirm: true,
      hasSeenIntro: true,
      preferredLang: "en",
      quota: {
        dayKey: "2026-04-26",
        count: 3,
      },
      updatedAt: 5678,
    });
  });

  it("derives a UTC day key from a timestamp", () => {
    expect(getDayKey(Date.UTC(2026, 3, 27, 23, 59, 59))).toBe("2026-04-27");
  });
});
