import { describe, expect, it } from "vitest";
import {
  isExplicitSourceImageEditRequest,
  isImageGenerationRequest,
  isSourceImageTransformRequest,
  isVisualCorrectionRequest,
  referencesExistingImage,
} from "./_core/imageIntent";

describe("image intent primitives", () => {
  it("keeps ambiguous make-me prompts as image-generation requests", () => {
    expect(isImageGenerationRequest("Maak me een samurai aub")).toBe(true);
    expect(isImageGenerationRequest("Kan je me een samurai maken")).toBe(true);
    expect(isSourceImageTransformRequest("Maak me een samurai aub")).toBe(false);
    expect(isSourceImageTransformRequest("Kan je me een samurai maken")).toBe(false);
  });

  it("detects explicit source-image edits and transforms", () => {
    expect(isExplicitSourceImageEditRequest("Bewerk deze foto cinematic")).toBe(true);
    expect(isSourceImageTransformRequest("Verander me in een samurai")).toBe(true);
    expect(isSourceImageTransformRequest("Turn me into a samurai")).toBe(true);
  });

  it("separates source references from fresh image requests", () => {
    expect(referencesExistingImage("Maak een poster van dit resultaat")).toBe(true);
    expect(referencesExistingImage("Maak een nieuwe afbeelding van een draak")).toBe(false);
  });

  it("detects missing-subject correction language", () => {
    expect(isVisualCorrectionRequest("Ik zie geen samurai bro")).toBe(true);
    expect(isVisualCorrectionRequest("The samurai is missing")).toBe(true);
  });
});
