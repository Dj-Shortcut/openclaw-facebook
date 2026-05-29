import { describe, expect, it } from "vitest";
import {
  normalizeStyle,
  parseReferralStyle,
  parseStyle,
  stylePayloadToStyle,
} from "./_core/webhookHelpers";

describe("style normalization", () => {
  it("normalizes storybook anime aliases to the canonical key", () => {
    expect(normalizeStyle("ghibli")).toBe("storybook-anime");
    expect(normalizeStyle("ghibli style")).toBe("storybook-anime");
    expect(normalizeStyle("studio ghibli")).toBe("storybook-anime");
    expect(normalizeStyle("storybook anime")).toBe("storybook-anime");
    expect(normalizeStyle("whimsical anime")).toBe("storybook-anime");
    expect(parseStyle("storybook anime")).toBe("storybook-anime");
    expect(stylePayloadToStyle("STYLE_STORYBOOK_ANIME")).toBe(
      "storybook-anime"
    );
    expect(parseReferralStyle("style_storybook-anime")).toBe(
      "storybook-anime"
    );
  });

  it("normalizes oil paint aliases to the canonical oil-paint key", () => {
    expect(normalizeStyle("oil paint")).toBe("oil-paint");
    expect(normalizeStyle("oil painting")).toBe("oil-paint");
    expect(normalizeStyle("oil_paint")).toBe("oil-paint");
    expect(normalizeStyle(" oil-paint ")).toBe("oil-paint");
  });

  it("applies canonical normalization through parse helpers", () => {
    expect(parseStyle("oil painting")).toBe("oil-paint");
    expect(stylePayloadToStyle("STYLE_OIL_PAINT")).toBe("oil-paint");
    expect(parseReferralStyle("style_oil-paint")).toBe("oil-paint");
  });

  it("normalizes Afroman aliases to the canonical key", () => {
    expect(normalizeStyle("Afroman")).toBe("afroman-americana");
    expect(normalizeStyle("afroman americana")).toBe("afroman-americana");
    expect(parseStyle("afroman")).toBe("afroman-americana");
    expect(stylePayloadToStyle("STYLE_AFROMAN_AMERICANA")).toBe(
      "afroman-americana"
    );
    expect(parseReferralStyle("style_afroman-americana")).toBe(
      "afroman-americana"
    );
  });
});

it("normalizes Norman Blackwell aliases to the canonical key", () => {
  expect(normalizeStyle("Norman Blackwell")).toBe("norman-blackwell");
  expect(normalizeStyle("blackwell")).toBe("norman-blackwell");
  expect(parseStyle("norman blackwell")).toBe("norman-blackwell");
  expect(stylePayloadToStyle("STYLE_NORMAN_BLACKWELL")).toBe(
    "norman-blackwell"
  );
  expect(parseReferralStyle("style_norman-blackwell")).toBe("norman-blackwell");
});
