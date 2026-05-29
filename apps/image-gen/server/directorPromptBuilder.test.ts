import { describe, expect, it } from "vitest";
import { DIRECTOR_MODES } from "./_core/image-generation/director/directorModes";
import { buildDirectorPrompt } from "./_core/image-generation/director/directorPromptBuilder";
import type { DirectorMode } from "./_core/image-generation/director/directorTypes";

describe("buildDirectorPrompt", () => {
  const modes = Object.keys(DIRECTOR_MODES) as DirectorMode[];

  it.each(modes)("builds a non-empty prompt for %s", mode => {
    const prompt = buildDirectorPrompt({ mode });

    expect(prompt.trim().length).toBeGreaterThan(500);
  });

  it.each(modes)("includes the configured label and vibe for %s", mode => {
    const prompt = buildDirectorPrompt({ mode });
    const config = DIRECTOR_MODES[mode];

    expect(prompt).toContain(config.label);
    expect(prompt).toContain(config.vibe);
  });

  it("includes optional user instruction when provided", () => {
    const prompt = buildDirectorPrompt({
      mode: "berlin_underground",
      userInstruction: "make it feel like a late-night event poster",
    });

    expect(prompt).toContain("make it feel like a late-night event poster");
  });

  it("includes optional photo analysis when provided", () => {
    const prompt = buildDirectorPrompt({
      mode: "vogue_editorial",
      photoAnalysis: "The source photo is a mirror selfie with flat bathroom lighting.",
    });

    expect(prompt).toContain(
      "The source photo is a mirror selfie with flat bathroom lighting."
    );
  });

  it("always includes identity and quality constraints", () => {
    const prompt = buildDirectorPrompt({ mode: "midnight_luxury" });

    expect(prompt).toContain("recognizable identity and facial structure");
    expect(prompt).toContain("apparent age range");
    expect(prompt).toContain("natural body proportions");
    expect(prompt).toContain("original subject as the visual hero");
    expect(prompt).toContain("social-media-ready impact");
  });

  it("always includes common failure-mode constraints", () => {
    const prompt = buildDirectorPrompt({ mode: "hyperpop_idol" });

    expect(prompt).toContain("distorted faces");
    expect(prompt).toContain("extra fingers");
    expect(prompt).toContain("fake plastic skin");
    expect(prompt).toContain("unreadable logos");
    expect(prompt).toContain("oversexualized styling");
    expect(prompt).toContain("changing the person's age");
    expect(prompt).toContain("different person");
  });
});
