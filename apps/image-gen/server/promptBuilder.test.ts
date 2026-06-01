import { describe, expect, it } from "vitest";
import {
  buildSourceImageEditPrompt,
  buildTextToImagePrompt,
  normalizeTextToImageUserPrompt,
} from "./_core/image-generation/promptBuilder";

describe("text-to-image prompt builder", () => {
  it("keeps natural visual requests intact", () => {
    expect(
      normalizeTextToImageUserPrompt("Maak een landschap met mistige bergen")
    ).toBe("Maak een landschap met mistige bergen");
  });

  it("removes pasted-prompt wrappers without rewriting the creative prompt", () => {
    expect(
      normalizeTextToImageUserPrompt(
        "Gebruik deze prompt en maak een afbeelding: Maak een krachtige samurai poster, geen tekst, geen logo"
      )
    ).toBe("Maak een krachtige samurai poster, geen tekst, geen logo");

    expect(
      normalizeTextToImageUserPrompt(
        "```text\nPrompt: cinematic portrait, centered, elegant, no watermark\n```"
      )
    ).toBe("cinematic portrait, centered, elegant, no watermark");

    expect(
      normalizeTextToImageUserPrompt(
        "Gebruik deze prompt en maak een afbeelding\uFF1A Maak een logo met blauwe neon"
      )
    ).toBe("Maak een logo met blauwe neon");
  });

  it("sends the cleaned prompt to the image model", () => {
    const prompt = buildTextToImagePrompt(
      "Use this prompt to generate an image: a neon city at sunset"
    );

    expect(prompt).toContain("User request: a neon city at sunset");
    expect(prompt).toContain("Treat the user's words as the creative brief");
    expect(prompt).toContain("The requested main subject must be visibly present");
    expect(prompt).toContain("Never substitute the requested subject");
    expect(prompt).toContain("senior creative director");
    expect(prompt).toContain("camera angle or framing");
    expect(prompt).toContain("polished, high-end image quality");
    expect(prompt).toContain("Avoid generic filler");
    expect(prompt).not.toContain("Use this prompt");
  });

  it("enhances short text-to-image prompts without turning them into presets", () => {
    const prompt = buildTextToImagePrompt("Maak een draak boven Antwerpen");

    expect(prompt).toContain("clear focal subject");
    expect(prompt).toContain("foreground and background depth");
    expect(prompt).toContain("one or two distinctive details");
    expect(prompt).toContain("User request: Maak een draak boven Antwerpen");
    expect(prompt).not.toContain("storybook");
    expect(prompt).not.toContain("prestige-film still");
  });

  it("builds source-image edits from the user's prompt without preset bias", () => {
    const prompt = buildSourceImageEditPrompt("Kan je me een samurai maken");

    expect(prompt).toContain("Edit the uploaded/source image");
    expect(prompt).toContain("preserve recognizable facial structure");
    expect(prompt).toContain("coherent lighting");
    expect(prompt).toContain("clean edges");
    expect(prompt).toContain("instead of looking like a pasted sticker");
    expect(prompt).toContain("User request: Kan je me een samurai maken");
    expect(prompt).not.toContain("prestige-film still");
    expect(prompt).not.toContain("teal-and-amber");
    expect(prompt).not.toContain("Additional direction");
  });

  it("treats missing-subject feedback as a real image correction", () => {
    const prompt = buildSourceImageEditPrompt("Das mooi, maar geen samurai bro");

    expect(prompt).toContain("treat that as a visual correction");
    expect(prompt).toContain("add or emphasize that subject clearly");
    expect(prompt).toContain("Do not answer with a rewritten prompt");
    expect(prompt).toContain("User request: Das mooi, maar geen samurai bro");
  });
});
