import type { BotFeature } from "../features";
import { interpretConversationalEdit } from "../../conversationalEditInterpreter";
import type { BotTextContext } from "../../botContext";
import { normalizeImageIntentText } from "../../imageIntent";

const UNAMBIGUOUS_VISUAL_CORRECTION_SUBJECT =
  "(?:samurai|samoerai|persoon|mens|man|vrouw|gezicht|paard|robot|soldaat|krijger|gladiator|ninja|stad|landschap|logo|poster|tekst|titel|zwaard|katana|helm|subject|person|face|horse|warrior|city|landscape|text|title|sword)";

function shouldSkipConversationalEdit(normalizedText: string): boolean {
  return (
    normalizedText.startsWith("remix") ||
    normalizedText.startsWith("/")
  );
}

function getSourcePhotoUrl(ctx: BotTextContext): string | null {
  return (
    ctx.state.lastGeneratedUrl ??
    ctx.state.lastImageUrl ??
    ctx.state.lastPhotoUrl ??
    ctx.state.lastPhoto ??
    null
  );
}

function isUnambiguousVisualCorrectionRequest(text: string): boolean {
  const normalized = normalizeImageIntentText(text);
  return (
    new RegExp(
      `\\b(?:ik\\s+zie|zie)\\s+(?:geen|niet\\s+de)\\s+${UNAMBIGUOUS_VISUAL_CORRECTION_SUBJECT}\\b`
    ).test(normalized) ||
    new RegExp(
      `\\b(?:maar|wel\\s+mooi\\s+maar|mooi\\s+maar)\\s+(?:geen|niet\\s+de)\\s+${UNAMBIGUOUS_VISUAL_CORRECTION_SUBJECT}\\b`
    ).test(normalized) ||
    new RegExp(
      `\\b(?:er\\s+mist|mist|ontbreekt)\\s+(?:een\\s+|de\\s+)?${UNAMBIGUOUS_VISUAL_CORRECTION_SUBJECT}\\b`
    ).test(normalized) ||
    new RegExp(
      `\\b(?:i\\s+do\\s+not\\s+see|i\\s+don't\\s+see|missing)\\s+(?:a\\s+|the\\s+)?${UNAMBIGUOUS_VISUAL_CORRECTION_SUBJECT}\\b`
    ).test(normalized) ||
    new RegExp(
      `\\b(?:a\\s+|the\\s+)?${UNAMBIGUOUS_VISUAL_CORRECTION_SUBJECT}\\s+(?:is\\s+|are\\s+)?(?:missing|not\\s+visible)\\b`
    ).test(normalized)
  );
}

export const conversationalEditingFeature: BotFeature = {
  name: "conversationalEditing",
  async onText(ctx) {
    if (shouldSkipConversationalEdit(ctx.normalizedText)) {
      return { handled: false };
    }

    const sourcePhotoUrl = getSourcePhotoUrl(ctx);
    if (!sourcePhotoUrl) {
      return { handled: false };
    }

    const decision = await interpretConversationalEdit({
      text: ctx.messageText,
      lang: ctx.lang,
    });
    const deterministicPromptHint = isUnambiguousVisualCorrectionRequest(ctx.messageText)
      ? ctx.messageText
      : undefined;
    if (!decision?.shouldEdit && !deterministicPromptHint) {
      return { handled: false };
    }

    const promptHint =
      decision?.promptHint?.trim() || deterministicPromptHint || ctx.state.lastPrompt;

    ctx.logger.info("bot_feature_conversational_edit", {
      hasPromptHint: Boolean(decision?.promptHint),
      deterministicVisualCorrection: Boolean(!decision?.shouldEdit && deterministicPromptHint),
    });

    await ctx.runImageGeneration(
      sourcePhotoUrl,
      promptHint,
      "source_image_edit",
    );
    return { handled: true };
  },
};
