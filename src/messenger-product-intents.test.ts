import { describe, expect, it } from "vitest";
import {
  classifyMessengerFastLaneIntent,
  hasMessengerImageGenerationIntent,
  hasMessengerSourceImageEditIntent,
  normalizeFastLaneText,
  resolveMessengerConversationIntent,
  resolveMessengerFastLaneReply,
  resolveMessengerSourceImageGenerationPrompt,
  shouldForwardMessengerImageOnlyEventToImageGen,
  shouldForwardMessengerTextToImageGen,
} from "./messenger-product-intents.js";

describe("normalizeFastLaneText", () => {
  it("normalizes case, diacritics, punctuation, and whitespace", () => {
    expect(normalizeFastLaneText("  HÉLLO,   Wéreld!!! ")).toBe("hello wereld");
  });
});

describe("classifyMessengerFastLaneIntent", () => {
  it.each([
    ["Hoi!", "greeting"],
    ["wat kun je?", "help"],
    ["Ben je online?", "status"],
    ["Verwijder mijn gegevens alsjeblieft", "delete_data"],
    ["delete my data please", "delete_data"],
    ["Maak een afbeelding van een robot", "image"],
    ["Bewerk deze foto", "image"],
  ] as const)("classifies %s as %s", (text, intent) => {
    expect(classifyMessengerFastLaneIntent(text)).toBe(intent);
  });

  it.each([
    "Vertel me iets over Brussel",
    "Schrijf een e-mail over een afbeelding",
    "Maak een planning voor morgen",
  ])("keeps non-image conversation out of the fast lane: %s", (text) => {
    expect(classifyMessengerFastLaneIntent(text)).toBeNull();
  });
});

describe("resolveMessengerConversationIntent", () => {
  it("keeps prompt writing separate from billable image generation", () => {
    expect(resolveMessengerConversationIntent({ text: "Schrijf een prompt voor een logo" })).toEqual({
      kind: "write_prompt",
      confidence: 0.92,
      prompt: "Schrijf een prompt voor een logo",
    });
    expect(hasMessengerImageGenerationIntent("Schrijf een prompt voor een logo")).toBe(false);
  });

  it("keeps visual analysis separate from generation", () => {
    expect(resolveMessengerConversationIntent({ text: "Beschrijf deze foto" })).toMatchObject({
      kind: "analyze_image",
    });
    expect(shouldForwardMessengerTextToImageGen("Beschrijf deze foto")).toBe(false);
  });

  it("routes personal transformations according to source-image context", () => {
    expect(
      resolveMessengerConversationIntent({
        text: "Maak mij een samoerai",
        hasSourceImage: true,
      }),
    ).toMatchObject({ kind: "edit_source_image" });
    expect(
      resolveMessengerConversationIntent({
        text: "Maak mij een samoerai",
        hasSourceImage: false,
      }),
    ).toMatchObject({ kind: "generate_image" });
  });

  it("recognizes visual correction follow-ups as source edits", () => {
    expect(resolveMessengerConversationIntent({ text: "Mooi, maar ik zie geen zwaard" })).toMatchObject({
      kind: "edit_source_image",
    });
  });

  it("recognizes explicit and natural-language creation requests", () => {
    expect(resolveMessengerConversationIntent({ text: "Genereer een afbeelding van Antwerpen" })).toMatchObject({
      kind: "generate_image",
    });
    expect(resolveMessengerConversationIntent({ text: "Kun je voor mij een futuristische stad maken" })).toMatchObject({
      kind: "generate_image",
    });
  });

  it("returns unknown for empty and ordinary conversation", () => {
    expect(resolveMessengerConversationIntent({ text: "   " })).toEqual({
      kind: "unknown",
      confidence: 0,
    });
    expect(resolveMessengerConversationIntent({ text: "Hoe gaat het?" })).toEqual({
      kind: "unknown",
      confidence: 0.2,
    });
  });
});

describe("source-image routing helpers", () => {
  it("returns the original prompt only for an edit with a source image", () => {
    expect(
      resolveMessengerSourceImageGenerationPrompt({
        hasSourceImage: true,
        text: "Bewerk deze foto als aquarel",
      }),
    ).toBe("Bewerk deze foto als aquarel");
    expect(
      resolveMessengerSourceImageGenerationPrompt({
        hasSourceImage: false,
        text: "Bewerk deze foto als aquarel",
      }),
    ).toBeNull();
  });

  it("forwards image-only events only when an attachment exists and text is blank", () => {
    expect(shouldForwardMessengerImageOnlyEventToImageGen({ hasSourceImage: true, text: "" })).toBe(true);
    expect(shouldForwardMessengerImageOnlyEventToImageGen({ hasSourceImage: false, text: "" })).toBe(false);
    expect(shouldForwardMessengerImageOnlyEventToImageGen({ hasSourceImage: true, text: "Beschrijf dit" })).toBe(false);
  });

  it("recognizes explicit source-image edit wording", () => {
    expect(hasMessengerSourceImageEditIntent("Restyle deze foto")).toBe(true);
    expect(hasMessengerSourceImageEditIntent("Vertel een verhaal")).toBe(false);
  });
});

describe("resolveMessengerFastLaneReply", () => {
  it("returns localized channel-neutral replies for conversational intents", () => {
    const dutch = resolveMessengerFastLaneReply("help", "nl");
    const english = resolveMessengerFastLaneReply("help", "en");

    expect(dutch).toMatchObject({ intent: "help" });
    expect(english).toMatchObject({ intent: "help" });
    expect(dutch?.reply).toBeTruthy();
    expect(english?.reply).toBeTruthy();
    expect(dutch?.reply).not.toBe(english?.reply);
  });

  it("returns localized replies for delete-data requests", () => {
    const dutch = resolveMessengerFastLaneReply(
      "Verwijder mijn gegevens",
      "nl"
    );
    const english = resolveMessengerFastLaneReply("delete my data", "en");

    expect(dutch).toMatchObject({ intent: "delete_data" });
    expect(english).toMatchObject({ intent: "delete_data" });
    expect(dutch?.reply).toBeTruthy();
    expect(english?.reply).toBeTruthy();
    expect(dutch?.reply).not.toBe(english?.reply);
  });

  it("does not synthesize a fast-lane reply for image generation", () => {
    expect(resolveMessengerFastLaneReply("Maak een foto van een kat")).toBeNull();
  });
});
