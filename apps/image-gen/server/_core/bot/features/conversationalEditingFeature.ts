import type { BotFeature } from "../features";
import { interpretConversationalEdit } from "../../conversationalEditInterpreter";
import type { BotTextContext } from "../../botContext";
import {
  isExplicitSourceImageEditRequest,
  normalizeImageIntentText,
} from "../../imageIntent";

const UNAMBIGUOUS_VISUAL_CORRECTION_SUBJECT =
  "(?:samurai|samoerai|persoon|mens|man|vrouw|gezicht|paard|robot|soldaat|krijger|gladiator|ninja|stad|landschap|logo|poster|tekst|titel|zwaard|katana|helm|subject|person|face|horse|warrior|city|landscape|text|title|sword)";

const EDIT_ACTION_COMMANDS = new Set([
  "edit",
  "edit image",
  "edit this image",
  "edit photo",
  "edit this photo",
  "pas aan",
  "pas afbeelding aan",
  "pas deze afbeelding aan",
  "pas foto aan",
  "pas deze foto aan",
  "bewerk afbeelding",
  "bewerk deze afbeelding",
  "bewerk foto",
  "bewerk deze foto",
]);

const UI_INTENT_COMMANDS = new Set([
  "new_image",
  "new image",
  "nieuwe afbeelding",
  "nieuwe foto",
  "nieuw beeld",
  "change_background",
  "andere achtergrond",
  "different background",
  "help",
  "/help",
  "menu",
  "/menu",
  "privacy",
  "privacybeleid",
  "privacy policy",
  "surprise",
  "surprise me",
  "verras me",
  "random",
]);

function shouldSkipConversationalEdit(normalizedText: string): boolean {
  return (
    normalizedText.startsWith("remix") ||
    normalizedText.startsWith("/") ||
    EDIT_ACTION_COMMANDS.has(normalizedText) ||
    UI_INTENT_COMMANDS.has(normalizedText)
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

function getDeterministicEditPrompt(text: string): string | undefined {
  if (isExplicitSourceImageEditRequest(text)) {
    return text;
  }

  return undefined;
}

function getPendingEditPrompt(ctx: BotTextContext): string | undefined {
  if (ctx.state.pendingEditIntent === "change_background") {
    return `Change the background to: ${ctx.messageText.trim()}`;
  }

  return undefined;
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

    const explicitEditPromptHint = getDeterministicEditPrompt(ctx.messageText);
    const decision = explicitEditPromptHint
      ? null
      : await interpretConversationalEdit({
          text: ctx.messageText,
          lang: ctx.lang,
        });
    const deterministicPromptHint =
      explicitEditPromptHint ??
      getPendingEditPrompt(ctx) ??
      (isUnambiguousVisualCorrectionRequest(ctx.messageText)
        ? ctx.messageText
        : undefined);
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
