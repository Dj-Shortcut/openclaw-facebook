import type { BotFeature } from "../features";
import type { BotTextContext } from "../../botContext";
import { isAssistantCommandText } from "./assistantCommandsFeature";
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

function shouldUseExistingImageContext(
  ctx: BotTextContext,
  text: string
): boolean {
  const sourcePhotoUrl = getSourcePhotoUrl(ctx);
  if (!sourcePhotoUrl) {
    return false;
  }

  return (
    referencesExistingImage(text) ||
    (ctx.channel === "messenger" && !isFreshImageRequest(text))
  );
}

function logTextToImageWithIgnoredSourceContext(
  ctx: BotTextContext,
  text: string
): void {
  const sourcePhotoUrl = getSourcePhotoUrl(ctx);
  if (!sourcePhotoUrl) {
    return;
  }

  ctx.logger.warn("bot_feature_text_to_image_ignored_source_context", {
    promptChars: text.length,
    stage: ctx.state.stage,
    hasGeneratedImage: Boolean(
      ctx.state.lastGeneratedUrl ?? ctx.state.lastImageUrl
    ),
    hasUploadedPhoto: Boolean(ctx.state.lastPhotoUrl ?? ctx.state.lastPhoto),
    reason: isFreshImageRequest(text) ? "fresh_image_request" : "unclassified",
  });
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

function shouldTreatAsEditableImagePrompt(
  ctx: BotTextContext,
  text: string
): boolean {
  return Boolean(
    getSourcePhotoUrl(ctx) &&
    ctx.state.stage === "AWAITING_EDIT_PROMPT" &&
    ctx.channel === "messenger" &&
    !isFreshImageRequest(text) &&
    !isAssistantCommandText(ctx.normalizedText)
  );
}

export const imageRequestFeature: BotFeature = {
  name: "imageRequest",
  async onText(ctx: BotTextContext) {
    const text = ctx.messageText.trim();
    if (!text || text.startsWith("/") || isPromptWritingRequest(text)) {
      return { handled: false };
    }

    const imageGenerationRequest = isImageGenerationRequest(text);
    if (
      (isExplicitSourceImageEditRequest(text) && !imageGenerationRequest) ||
      isLikelyNonImageArtifactRequest(text)
    ) {
      return { handled: false };
    }

    if (
      !imageGenerationRequest &&
      !shouldTreatAsEditableImagePrompt(ctx, text)
    ) {
      return { handled: false };
    }

    if (shouldUseExistingImageContext(ctx, text)) {
      ctx.logger.info("bot_feature_source_image_edit_default", {
        promptChars: text.length,
        stage: ctx.state.stage,
        hasGeneratedImage: Boolean(
          ctx.state.lastGeneratedUrl ?? ctx.state.lastImageUrl
        ),
        hasUploadedPhoto: Boolean(
          ctx.state.lastPhotoUrl ?? ctx.state.lastPhoto
        ),
      });
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

    logTextToImageWithIgnoredSourceContext(ctx, text);
    ctx.logger.info("bot_feature_text_to_image", {
      promptChars: text.length,
    });

    await ctx.runImageGeneration(undefined, text, "text_to_image");
    return { handled: true };
  },
};
