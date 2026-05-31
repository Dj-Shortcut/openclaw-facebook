import { describe, expect, it } from "vitest";
import { buildLegacyPresetPrompt } from "./_core/image-generation/legacyPresetPrompts";

describe("legacy preset prompts", () => {
  it("keeps preset catalog prompts isolated from prompt-first builders", () => {
    const prompt = buildLegacyPresetPrompt("disco", "more glitter in the background");

    expect(prompt).toContain("glamorous disco-era hero shot");
    expect(prompt).toContain("Additional direction: more glitter in the background.");
  });
});
