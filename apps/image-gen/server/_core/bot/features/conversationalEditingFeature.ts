import type { BotFeature } from "../features";
import { t } from "../../i18n";
import { DIRECTOR_GENERATION_STYLE } from "../../image-generation/director/directorModes";
import { normalizeStyle } from "../../webhookHelpers";
import { interpretConversationalEdit } from "../../conversationalEditInterpreter";
import type { BotTextContext } from "../../botContext";

function shouldSkipConversationalEdit(normalizedText: string): boolean {
  return (
    normalizedText.startsWith("remix") ||
    normalizedText === "nieuwe stijl" ||
    normalizedText === "new style" ||
    normalizedText.startsWith("/")
  );
}

function getSourcePhotoUrl(ctx: BotTextContext): string | null {
  return ctx.state.lastPhotoUrl ?? ctx.state.lastPhoto ?? null;
}

function hasPriorGeneration(ctx: BotTextContext): boolean {
  return Boolean(ctx.state.lastGeneratedUrl ?? ctx.state.lastImageUrl);
}

function getLastStyle(ctx: BotTextContext) {
  return normalizeStyle(ctx.state.selectedStyle ?? "") ?? ctx.state.lastStyle;
}

export const conversationalEditingFeature: BotFeature = {
  name: "conversationalEditing",
  async onText(ctx) {
    if (shouldSkipConversationalEdit(ctx.normalizedText)) {
      return { handled: false };
    }

    const sourcePhotoUrl = getSourcePhotoUrl(ctx);
    if (!hasPriorGeneration(ctx) || !sourcePhotoUrl) {
      return { handled: false };
    }

    const decision = await interpretConversationalEdit({
      text: ctx.messageText,
      lang: ctx.lang,
      lastStyle: getLastStyle(ctx),
      lastDirectorMode: ctx.state.lastDirectorMode,
    });
    if (!decision?.shouldEdit) {
      return { handled: false };
    }

    const style = decision.style ?? getLastStyle(ctx);
    const directorMode =
      decision.directorMode ??
      (decision.style ? undefined : ctx.state.lastDirectorMode);
    if (!style) {
      await ctx.sendStateQuickReplies("AWAITING_STYLE", t(ctx.lang, "stylePicker"));
      return { handled: true };
    }

    const combinedPrompt = [ctx.state.lastPrompt, decision.promptHint]
      .map(value => value?.trim())
      .filter(Boolean)
      .join(" | ");

    ctx.logger.info("bot_feature_conversational_edit", {
      style,
      directorMode,
      hasPromptHint: Boolean(decision.promptHint),
    });

    await ctx.runStyleGeneration(
      directorMode ? DIRECTOR_GENERATION_STYLE : style,
      sourcePhotoUrl,
      combinedPrompt || ctx.state.lastPrompt,
      directorMode,
    );
    return { handled: true };
  },
};
