import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  anonymizePsid,
  getOrCreateState,
  getQuickRepliesForState,
  getStyleRepliesForCategory,
  resetStateStore,
  setChosenStyle,
  setFlowState,
  setPendingImage,
} from "./_core/messengerState";
import { STYLE_CATEGORY_CONFIGS } from "./_core/messengerStyles";

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
    expect(state.stage).toBe("AWAITING_STYLE");
    expect(state.lastPhoto).toBe("https://img.example/pic.jpg");
    expect(state.hasSeenIntro).toBe(false);
  });

  it("handles style-first transition", () => {
    const userId = "style-first-user";

    setFlowState(userId, "IDLE", 1000);
    setChosenStyle(userId, "Anime", 1001);

    const state = getOrCreateState(userId);
    expect(state.stage).toBe("IDLE");
    expect(state.selectedStyle).toBe("Anime");
    expect(state.lastPhoto).toBeNull();
  });

  it("maps quick replies by state", () => {
    expect(getQuickRepliesForState("IDLE")).toEqual([
      { title: "Wat doe ik?", payload: "WHAT_IS_THIS" },
      { title: "Privacy", payload: "PRIVACY_INFO" },
    ]);
    expect(getQuickRepliesForState("AWAITING_PHOTO")).toEqual([]);
    expect(getQuickRepliesForState("AWAITING_STYLE")).toEqual(
      STYLE_CATEGORY_CONFIGS.map(category => ({
        title: category.label,
        payload: category.payload,
      })),
    );
    expect(getQuickRepliesForState("PROCESSING")).toEqual([]);
    expect(getQuickRepliesForState("RESULT_READY")).toEqual([
      { title: "Nieuwe stijl", payload: "CHOOSE_STYLE" },
      { title: "Privacy", payload: "PRIVACY_INFO" },
    ]);
    expect(getQuickRepliesForState("FAILURE")).toEqual([
      { title: "Probeer opnieuw", payload: "RETRY_STYLE" },
      { title: "Andere stijl", payload: "CHOOSE_STYLE" },
    ]);
  });

  it("maps per-category style replies with a back action", () => {
    expect(getStyleRepliesForCategory("bold")).toEqual([
      { title: "Afroman", payload: "STYLE_AFROMAN_AMERICANA" },
      { title: "✨ Gold", payload: "STYLE_GOLD" },
      { title: "🌃 Cyberpunk", payload: "STYLE_CYBERPUNK" },
      { title: "🪩 Disco Glow", payload: "STYLE_DISCO" },
      { title: "↩️ Categorieen", payload: "CHOOSE_STYLE" },
    ]);
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
