import type { BotFeature } from "../features";
import { interpretConversationalEdit } from "../../conversationalEditInterpreter";
import type { BotTextContext } from "../../botContext";

function shouldSkipConversationalEdit(normalizedText: string): boolean {
  return (
    normalizedText.startsWith("remix") ||
    normalizedText.startsWith("/")
  );
}

function getSourcePhotoUrl(ctx: BotTextContext): string | null {
  return (
    ctx.state.lastPhotoUrl ??
    ctx.state.lastPhoto ??
    ctx.state.lastGeneratedUrl ??
    ctx.state.lastImageUrl ??
    null
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
      lastDirectorMode: ctx.state.lastDirectorMode,
    });
    if (!decision?.shouldEdit) {
      return { handled: false };
    }

    const combinedPrompt = [ctx.state.lastPrompt, decision.promptHint]
      .map(value => value?.trim())
      .filter(Boolean)
      .join(" | ");

    ctx.logger.info("bot_feature_conversational_edit", {
      directorMode: decision.directorMode,
      hasPromptHint: Boolean(decision.promptHint),
    });

    await ctx.runImageGeneration(
      sourcePhotoUrl,
      combinedPrompt || ctx.state.lastPrompt,
      decision.directorMode,
      "source_image_edit",
    );
    return { handled: true };
  },
};
