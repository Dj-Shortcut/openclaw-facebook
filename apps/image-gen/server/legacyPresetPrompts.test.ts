import { describe, expect, it } from "vitest";
import { buildLegacyPresetPrompt } from "./_core/image-generation/legacyPresetPrompts";

describe("legacy preset prompts", () => {
  it("routes stale preset jobs through the prompt-first source-image edit builder", () => {
    const prompt = buildLegacyPresetPrompt("disco", "more glitter in the background");

    expect(prompt).toContain("Edit the uploaded/source image according to the user's request.");
    expect(prompt).toContain("not as a preset style catalog");
    expect(prompt).toContain("User request: more glitter in the background");
    expect(prompt).not.toContain("glamorous disco-era hero shot");
    expect(prompt).not.toContain("Additional direction:");
  });

  it("keeps stale style-only jobs as natural-language direction", () => {
    const prompt = buildLegacyPresetPrompt("storybook-anime");

    expect(prompt).toContain(
      "User request: Apply storybook anime as natural-language visual direction."
    );
    expect(prompt).not.toContain("whimsical hand-drawn fantasy illustration");
  });
});
