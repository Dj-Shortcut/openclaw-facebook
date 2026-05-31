import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  anonymizePsid,
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

  it("hashes PSID deterministically", () => {
    const first = anonymizePsid("12345");
    const second = anonymizePsid("12345");
    const other = anonymizePsid("abcde");

    expect(first).toHaveLength(64);
    expect(first).toBe(second);
    expect(first).not.toBe(other);
  });
});
