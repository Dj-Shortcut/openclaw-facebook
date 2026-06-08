import type { BotFeature } from "../features";
import type { BotTextContext } from "../../botContext";
import {
  isExplicitSourceImageEditRequest,
  isFreshImageRequest,
  isImageGenerationRequest,
  isLikelyNonImageArtifactRequest,
  isPromptWritingRequest,
  referencesExistingImage,
} from "../../imageIntent";

function getSourcePhotoUrl(ctx: BotTextContext): string | undefined {
  return (
    ctx.state.lastGeneratedUrl ??
    ctx.state.lastImageUrl ??
    ctx.state.lastPhotoUrl ??
    ctx.state.lastPhoto ??
    undefined
  );
}

function shouldUseExistingImageContext(ctx: BotTextContext, text: string): boolean {
  const sourcePhotoUrl = getSourcePhotoUrl(ctx);
  if (!sourcePhotoUrl) {
    return false;
  }

  if (
    ctx.state.stage === "AWAITING_EDIT_PROMPT" &&
    ctx.state.pendingEditIntent === "change_background" &&
    !isFreshImageRequest(text)
  ) {
    return true;
  }

  return Boolean(
    ctx.hasPhoto &&
      sourcePhotoUrl &&
      referencesExistingImage(text) &&
      !isFreshImageRequest(text)
  );
}

function getPromptHint(ctx: BotTextContext, text: string): string {
  if (
    ctx.state.stage === "AWAITING_EDIT_PROMPT" &&
    ctx.state.pendingEditIntent === "change_background"
  ) {
    return `Change the background to: ${text}`;
  }

  return text;
}

export const imageRequestFeature: BotFeature = {
  name: "imageRequest",
  async onText(ctx: BotTextContext) {
    const text = ctx.messageText.trim();
    if (!text || text.startsWith("/") || isPromptWritingRequest(text)) {
      return { handled: false };
    }

    if (isExplicitSourceImageEditRequest(text) || isLikelyNonImageArtifactRequest(text)) {
      return { handled: false };
    }

    if (!isImageGenerationRequest(text)) {
      return { handled: false };
    }

    ctx.logger.info("bot_feature_text_to_image", {
      promptChars: text.length,
    });

    if (shouldUseExistingImageContext(ctx, text)) {
      await ctx.runImageGeneration(
        getSourcePhotoUrl(ctx),
        getPromptHint(ctx, text),
        "source_image_edit"
      );
      return { handled: true };
    }

    if (
      ctx.state.pendingEditIntent === "change_background" &&
      ctx.setPendingEditIntent
    ) {
      await ctx.setPendingEditIntent(null);
    }

    await ctx.runImageGeneration(
      undefined,
      text,
      "text_to_image"
    );
    return { handled: true };
  },
};
