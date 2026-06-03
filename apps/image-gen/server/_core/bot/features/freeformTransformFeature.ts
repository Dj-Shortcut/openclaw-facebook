import type { BotFeature } from "../features";
import type { BotTextContext } from "../../botContext";
import { isSourceImageTransformRequest } from "../../imageIntent";

function normalizePromptHint(messageText: string): string {
  return messageText.replace(/\s+/g, " ").trim();
}

function isFreeformTransformRequest(messageText: string): boolean {
  const promptHint = normalizePromptHint(messageText);
  if (!promptHint || promptHint.startsWith("/")) {
    return false;
  }

  return isSourceImageTransformRequest(promptHint);
}

function buildPromptHint(messageText: string): string {
  const promptHint = normalizePromptHint(messageText);
  return [
    "Preserve the photographed person's recognizable identity, face, pose, and main framing.",
    `User requested transformation: ${promptHint}`,
  ].join(" ");
}

function getSourcePhotoUrl(ctx: BotTextContext): string | undefined {
  return (
    ctx.state.lastGeneratedUrl ??
    ctx.state.lastImageUrl ??
    ctx.state.lastPhotoUrl ??
    ctx.state.lastPhoto ??
    undefined
  );
}

export const freeformTransformFeature: BotFeature = {
  name: "freeformTransform",
  async onText(ctx) {
    if (!isFreeformTransformRequest(ctx.messageText)) {
      return { handled: false };
    }

    const sourcePhotoUrl = getSourcePhotoUrl(ctx);
    if (!sourcePhotoUrl) {
      await ctx.runImageGeneration(
        undefined,
        ctx.messageText,
        "text_to_image"
      );
      return { handled: true };
    }

    ctx.logger.info("bot_feature_freeform_transform", {
      promptChars: ctx.messageText.trim().length,
    });

    await ctx.runImageGeneration(
      sourcePhotoUrl,
      buildPromptHint(ctx.messageText),
      "source_image_edit"
    );
    return { handled: true };
  },
};
