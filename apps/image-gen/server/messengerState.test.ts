import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  anonymizePsid,
  clearPendingImageState,
  getOrCreateState,
  resetStateStore,
  setPendingImage,
} from "./_core/messengerState";

const TEST_PEPPER = "ci-test-pepper";
const originalPrivacyPepper = process.env.PRIVACY_PEPPER;

describe("messenger state flow", () => {
  beforeAll(() => {
    process.env.PRIVACY_PEPPER = TEST_PEPPER;
  });

  beforeEach(() => {
    resetStateStore();
  });

  afterAll(() => {
    if (originalPrivacyPepper === undefined) {
      delete process.env.PRIVACY_PEPPER;
      return;
    }

    process.env.PRIVACY_PEPPER = originalPrivacyPepper;
  });

  it("handles photo-first transition", () => {
    const userId = "photo-first-user";

    setPendingImage(userId, "https://img.example/pic.jpg", 1000);

    const state = getOrCreateState(userId);
    expect(state.stage).toBe("AWAITING_EDIT_PROMPT");
    expect(state.lastPhoto).toBe("https://img.example/pic.jpg");
    expect(state.hasSeenIntro).toBe(false);
  });

  it("clears stale generated image pointers when a new photo becomes pending", () => {
    const userId = "fresh-photo-user";
    const state = getOrCreateState(userId);
    state.lastGeneratedUrl = "https://img.example/old-generated.jpg";
    state.lastImageUrl = "https://img.example/old-image.jpg";

    setPendingImage(userId, "https://img.example/new-photo.jpg", 1000);

    const updated = getOrCreateState(userId);
    expect(updated.lastPhotoUrl).toBe("https://img.example/new-photo.jpg");
    expect(updated.lastGeneratedUrl).toBeNull();
    expect(updated.lastImageUrl).toBeUndefined();
  });

  it("clears stale generated image pointers when pending image state is cleared", () => {
    const userId = "clear-pending-photo-user";
    setPendingImage(userId, "https://img.example/new-photo.jpg", 1000);
    const state = getOrCreateState(userId);
    state.lastGeneratedUrl = "https://img.example/old-generated.jpg";
    state.lastImageUrl = "https://img.example/old-image.jpg";

    clearPendingImageState(userId, 2000);

    const updated = getOrCreateState(userId);
    expect(updated.lastPhotoUrl).toBeNull();
    expect(updated.lastPhoto).toBeNull();
    expect(updated.lastGeneratedUrl).toBeNull();
    expect(updated.lastImageUrl).toBeUndefined();
  });

  it("hashes PSID deterministically", () => {
    const first = anonymizePsid("12345");
    const second = anonymizePsid("12345");
    const other = anonymizePsid("abcde");

    expect(first).toHaveLength(64);
    expect(first).toBe(second);
    expect(first).not.toBe(other);
  });
});
