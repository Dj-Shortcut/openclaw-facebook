import type { BotFeature } from "../features";
import type { BotTextContext } from "../../botContext";

const PROMPT_WRITING_PATTERNS = [
  /\b(?:schrijf|write|maak|create)\s+(?:een\s+)?prompt\b/iu,
  /\bprompt\s+(?:voor|for)\b/iu,
];

const EXPLICIT_SOURCE_EDIT_PATTERNS = [
  /\b(?:bewerk|edit|restyle|pas\s+aan|retoucheer)\b/iu,
  /\b(?:deze|this)\s+(?:foto|afbeelding|image|photo)\b.*\b(?:aanpassen|bewerken|edit|restyle)\b/iu,
];

const NON_IMAGE_ARTIFACT_PATTERNS = [
  /\b(?:maak|create)\s+(?:een\s+)?(?:plan|lijst|samenvatting|tekst|email|e-mail|brief|gedicht|verhaal|script|code|functie|schema|planning)\b/iu,
  /\b(?:kan|kun|could|can)\s+(?:je|jij|you)\b.*\b(?:plan|lijst|samenvatting|tekst|email|e-mail|brief|gedicht|verhaal|script|code|functie|schema|planning|afspraak|reservering|boeking)\b.*\b(?:maken|make|create|write)\b/iu,
  /\b(?:write|make|create)\s+(?:a\s+)?(?:plan|list|summary|text|email|letter|poem|story|script|code|function|schedule)\b/iu,
  /\b(?:could|can)\s+you\b.*\b(?:plan|list|summary|text|email|letter|poem|story|script|code|function|schedule|appointment|reservation|booking)\b.*\b(?:make|create|write)\b/iu,
];

const IMAGE_GENERATION_PATTERNS = [
  /\b(?:maak|genereer|creeer|create|generate)\b.*\b(?:afbeelding|foto|plaatje|image|picture)\b/iu,
  /\b(?:afbeelding|foto|plaatje|image|picture)\b.*\b(?:maak|maken|genereer|genereren|create|generate)\b/iu,
  /\b(?:maak|genereer|creeer|create|generate)\b.*\b(?:landschap|stad|poster|logo|portret|avatar|sticker|illustratie|productfoto|scene|cover)\b/iu,
  /\b(?:kan|kun|could|can)\s+(?:je|jij|you)\b.*\b(?:landschap|stad|poster|logo|portret|avatar|sticker|illustratie|productfoto|scene|cover)\b.*\b(?:maken|genereren|make|create|generate)\b/iu,
];

const ARBITRARY_VISUAL_CREATE_PATTERNS = [
  /\b(?:maak|genereer|creeer|create|generate)\s+(?:voor\s+mij\s+|voor\s+me\s+|me\s+|mij\s+)?(?:een|a|an)\s+(.{3,})/iu,
  /\b(?:kan|kun|could|can)\s+(?:je|jij|you)\b.*\b(?:een|a|an)\s+(.{3,}?)\s+\b(?:maken|genereren|make|create|generate)\b/iu,
];

const VAGUE_OBJECT_PATTERNS = [
  /^(?:dit|deze|dat|this|that|it)\b/iu,
  /^(?:beter|better|anders|different|mooier|nicer)\b/iu,
];

function isPromptWritingRequest(text: string): boolean {
  return PROMPT_WRITING_PATTERNS.some(pattern => pattern.test(text));
}

function isExplicitSourceEditRequest(text: string): boolean {
  return EXPLICIT_SOURCE_EDIT_PATTERNS.some(pattern => pattern.test(text));
}

function isLikelyNonImageArtifactRequest(text: string): boolean {
  return NON_IMAGE_ARTIFACT_PATTERNS.some(pattern => pattern.test(text));
}

function hasArbitraryVisualSubject(text: string): boolean {
  for (const pattern of ARBITRARY_VISUAL_CREATE_PATTERNS) {
    const match = pattern.exec(text);
    const subject = match?.[1]?.trim().replace(/[?.!,]+$/u, "");
    if (subject && !VAGUE_OBJECT_PATTERNS.some(vague => vague.test(subject))) {
      return true;
    }
  }

  return false;
}

function isImageGenerationRequest(text: string): boolean {
  return (
    IMAGE_GENERATION_PATTERNS.some(pattern => pattern.test(text)) ||
    hasArbitraryVisualSubject(text)
  );
}

export const imageRequestFeature: BotFeature = {
  name: "imageRequest",
  async onText(ctx: BotTextContext) {
    const text = ctx.messageText.trim();
    if (!text || text.startsWith("/") || isPromptWritingRequest(text)) {
      return { handled: false };
    }

    if (isExplicitSourceEditRequest(text) || isLikelyNonImageArtifactRequest(text)) {
      return { handled: false };
    }

    if (!isImageGenerationRequest(text)) {
      return { handled: false };
    }

    ctx.logger.info("bot_feature_text_to_image", {
      promptChars: text.length,
    });

    await ctx.runImageGeneration(
      undefined,
      undefined,
      text,
      undefined,
      "text_to_image"
    );
    return { handled: true };
  },
};
