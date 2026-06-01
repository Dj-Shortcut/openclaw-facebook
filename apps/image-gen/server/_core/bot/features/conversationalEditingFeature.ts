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
    ctx.state.lastGeneratedUrl ??
    ctx.state.lastImageUrl ??
    ctx.state.lastPhotoUrl ??
    ctx.state.lastPhoto ??
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
    });
    if (!decision?.shouldEdit) {
      return { handled: false };
    }

    const promptHint = decision.promptHint?.trim() || ctx.state.lastPrompt;

    ctx.logger.info("bot_feature_conversational_edit", {
      hasPromptHint: Boolean(decision.promptHint),
    });

    await ctx.runImageGeneration(
      sourcePhotoUrl,
      promptHint,
      "source_image_edit",
    );
    return { handled: true };
  },
};
