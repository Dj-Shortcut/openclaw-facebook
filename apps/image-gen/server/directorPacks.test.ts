import { describe, expect, it } from "vitest";
import { DIRECTOR_MODES } from "./_core/image-generation/director/directorModes";
import {
  DIRECTOR_PACK_CONFIGS,
  DIRECTOR_PACKS,
  directorPackPayloadToPackId,
  getDirectorPackModes,
} from "./_core/image-generation/director/directorPacks";
import type { DirectorMode } from "./_core/image-generation/director/directorTypes";

describe("director packs", () => {
  it("defines the planned premium and event pack set", () => {
    expect(Object.keys(DIRECTOR_PACKS)).toEqual([
      "diva_edition",
      "nightlife",
      "festival",
      "business_profile",
      "creator_pack",
      "dating_profile",
      "promo_flyer",
      "old_school_nostalgia",
    ]);
  });

  it("keeps pack payloads unique and parseable", () => {
    const payloads = DIRECTOR_PACK_CONFIGS.map(pack => pack.payload);

    expect(new Set(payloads).size).toBe(payloads.length);
    for (const pack of DIRECTOR_PACK_CONFIGS) {
      expect(directorPackPayloadToPackId(pack.payload)).toBe(pack.id);
    }
  });

  it("only references existing director modes", () => {
    const validModes = new Set(Object.keys(DIRECTOR_MODES) as DirectorMode[]);

    for (const pack of DIRECTOR_PACK_CONFIGS) {
      expect(pack.modes.length).toBeGreaterThan(0);
      expect(pack.modes.every(mode => validModes.has(mode))).toBe(true);
      expect(getDirectorPackModes(pack.id)).toEqual(pack.modes);
    }
  });

  it("keeps each pack usable for future product surfaces", () => {
    for (const pack of DIRECTOR_PACK_CONFIGS) {
      expect(pack.label).toBeTruthy();
      expect(pack.description).toBeTruthy();
      expect(pack.positioning).toBeTruthy();
      expect(pack.promptDirective).toBeTruthy();
      expect(pack.suggestedUseCases.length).toBeGreaterThan(0);
      expect(pack.premium).toBe(true);
    }
  });
});
