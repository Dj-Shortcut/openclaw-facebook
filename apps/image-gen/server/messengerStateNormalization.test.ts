import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDefaultState,
  getDayKey,
  getUserKey,
  normalizeState,
} from "./_core/messengerStateNormalization";

const originalPrivacyPepper = process.env.PRIVACY_PEPPER;

describe("messenger state normalization", () => {
  it("preserves the server-side daily limit on video quota reservations", () => {
    const normalized = normalizeState("video-quota-limit-user", {
      videoGenerationQuotaReservation: {
        token: "video-reservation-token",
        expiresAt: 1_900_000_000_000,
        dailyLimit: 10,
      },
    });

    expect(normalized.videoGenerationQuotaReservation).toEqual({
      token: "video-reservation-token",
      expiresAt: 1_900_000_000_000,
      dailyLimit: 10,
    });
  });

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
      lastPhotoUrl: null,
      lastPhoto: null,
      preferredLang: undefined,
      preferredLangSource: undefined,
      consentGiven: false,
      consentDeclinedAt: undefined,
      pendingDeleteConfirm: false,
      pendingDeleteConfirmAt: undefined,
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
      lastImageUrl: "https://example.test/generated.jpg",
      consentGiven: true,
      consentTimestamp: 1234,
      pendingDeleteConfirm: true,
      pendingDeleteConfirmAt: 1200,
      hasSeenIntro: true,
      preferredLang: "en",
      preferredLangSource: "sender_locale",
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
      lastImageUrl: "https://example.test/generated.jpg",
      lastGeneratedUrl: "https://example.test/generated.jpg",
      consentGiven: true,
      consentTimestamp: 1234,
      pendingDeleteConfirm: true,
      pendingDeleteConfirmAt: 1200,
      hasSeenIntro: true,
      preferredLang: "en",
      quota: {
        dayKey: "2026-04-26",
        count: 3,
      },
      updatedAt: 5678,
    });
  });

  it("keeps unanswered and declined consent distinct while failing legacy deletion prompts closed", () => {
    expect(
      normalizeState("legacy-unanswered", { consentGiven: false })
    ).toMatchObject({
      consentGiven: false,
      consentDeclinedAt: undefined,
      pendingDeleteConfirm: false,
    });

    expect(
      normalizeState("stored-decline", {
        consentGiven: false,
        consentDeclinedAt: 1234,
      })
    ).toMatchObject({
      consentGiven: false,
      consentDeclinedAt: 1234,
    });

    expect(
      normalizeState("legacy-delete-confirm", {
        pendingDeleteConfirm: true,
      })
    ).toMatchObject({
      pendingDeleteConfirm: false,
      pendingDeleteConfirmAt: undefined,
    });
  });

  it("clears an obsolete decline marker after consent was accepted", () => {
    expect(
      normalizeState("accepted-consent", {
        consentGiven: true,
        consentTimestamp: 5678,
        consentDeclinedAt: 1234,
      })
    ).toMatchObject({
      consentGiven: true,
      consentTimestamp: 5678,
      consentDeclinedAt: undefined,
    });
  });

  it.each([
    ["string", "1234"],
    ["boolean", true],
    ["object", { value: 1234 }],
    ["array", [1234]],
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
  ])("drops a malformed consentPromptedAt %s value", (_label, value) => {
    const normalized = normalizeState(
      "malformed-consent-prompt-timestamp",
      { consentPromptedAt: value } as unknown as Parameters<
        typeof normalizeState
      >[1]
    );

    expect(normalized.consentPromptedAt).toBeUndefined();
  });

  it("preserves a finite consentPromptedAt value", () => {
    expect(
      normalizeState("valid-consent-prompt-timestamp", {
        consentPromptedAt: 1234,
      }).consentPromptedAt
    ).toBe(1234);
  });

  it("marks the legacy implicit Dutch default as account-derived", () => {
    expect(
      normalizeState("legacy-dutch", { preferredLang: "nl" })
    ).toMatchObject({
      preferredLang: "nl",
      preferredLangSource: "account_default",
    });
  });

  it("preserves an explicit language source marker", () => {
    expect(
      normalizeState("stored-language-source", {
        preferredLang: "nl",
        preferredLangSource: "sender_locale",
      })
    ).toMatchObject({
      preferredLang: "nl",
      preferredLangSource: "sender_locale",
    });
  });

  it("maps the legacy style-waiting state to the prompt-first edit state", () => {
    const normalized = normalizeState("legacy-style-psid", {
      state: "AWAITING_STYLE",
      lastPhoto: "https://example.test/source.jpg",
    });

    expect(normalized).toMatchObject({
      stage: "AWAITING_EDIT_PROMPT",
      state: "AWAITING_EDIT_PROMPT",
      lastPhotoUrl: "https://example.test/source.jpg",
    });
  });

  it("derives a UTC day key from a timestamp", () => {
    expect(getDayKey(Date.UTC(2026, 3, 27, 23, 59, 59))).toBe("2026-04-27");
  });
});
