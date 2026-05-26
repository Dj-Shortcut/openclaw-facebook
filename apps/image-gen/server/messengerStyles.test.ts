import { describe, expect, it } from "vitest";
import {
  STYLE_CATEGORY_CONFIGS,
  getStylesForCategory,
} from "./_core/messengerStyles";

describe("messengerStyles", () => {
  it("exposes canonical styles through category groupings", () => {
    const styles = STYLE_CATEGORY_CONFIGS.flatMap(category =>
      getStylesForCategory(category.category).map(style => style.style)
    );

    expect(new Set(styles)).toEqual(new Set([
      "caricature",
      "storybook-anime",
      "afroman-americana",
      "petals",
      "gold",
      "cinematic",
      "oil-paint",
      "cyberpunk",
      "norman-blackwell",
      "disco",
      "clouds",
    ]));
  });

  it("keeps button payloads aligned with style ids", () => {
    const styles = STYLE_CATEGORY_CONFIGS.flatMap(category =>
      getStylesForCategory(category.category)
    );

    expect(styles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "STYLE_AFROMAN_AMERICANA",
          label: expect.stringContaining("Afroman"),
          payload: "STYLE_AFROMAN_AMERICANA",
          style: "afroman-americana",
        }),
        expect.objectContaining({
          id: "STYLE_STORYBOOK_ANIME",
          label: expect.stringContaining("Storybook Anime"),
          payload: "STYLE_STORYBOOK_ANIME",
          style: "storybook-anime",
        }),
        expect.objectContaining({
          id: "STYLE_OIL_PAINT",
          label: expect.stringContaining("Oil Paint"),
          payload: "STYLE_OIL_PAINT",
          style: "oil-paint",
        }),
        expect.objectContaining({
          id: "STYLE_CYBERPUNK",
          label: expect.stringContaining("Cyberpunk"),
          payload: "STYLE_CYBERPUNK",
          style: "cyberpunk",
        }),
        expect.objectContaining({
          id: "STYLE_NORMAN_BLACKWELL",
          label: expect.stringContaining("Norman Blackwell"),
          payload: "STYLE_NORMAN_BLACKWELL",
          style: "norman-blackwell",
        }),
        expect.objectContaining({
          id: "STYLE_DISCO",
          label: expect.stringContaining("Disco"),
          payload: "STYLE_DISCO",
          style: "disco",
        }),
      ])
    );
  });

  it("exposes style categories and maps styles into them", () => {
    expect(STYLE_CATEGORY_CONFIGS.map(category => category.category)).toEqual([
      "illustrated",
      "atmosphere",
      "bold",
    ]);
    expect(STYLE_CATEGORY_CONFIGS).toContainEqual(
      expect.objectContaining({
        category: "atmosphere",
        id: "STYLE_CATEGORY_ATMOSPHERE",
        label: expect.stringContaining("Atmosphere"),
        payload: "STYLE_CATEGORY_ATMOSPHERE",
      })
    );
    expect(getStylesForCategory("illustrated").map(style => style.style)).toEqual([
      "caricature",
      "storybook-anime",
      "oil-paint",
      "norman-blackwell",
    ]);
    expect(getStylesForCategory("bold").map(style => style.style)).toEqual([
      "afroman-americana",
      "gold",
      "cyberpunk",
      "disco",
    ]);
  });
});
