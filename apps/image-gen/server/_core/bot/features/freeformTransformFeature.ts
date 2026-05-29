import type { BotFeature } from "../features";
import type { BotTextContext } from "../../botContext";
import { t } from "../../i18n";

const TRANSFORM_REQUEST_PATTERNS = [
  /\bmake\s+(?:me|him|her|us|this)\s+(?:a|an|into)\b/i,
  /\bturn\s+(?:me|him|her|us|this)\s+into\b/i,
  /\btransform\s+(?:me|him|her|us|this)\s+into\b/i,
  /\bmaak\s+(?:me|mij|hem|haar|ons|dit|deze)\s+(?:een|als|tot)\b/i,
  /\bverander\s+(?:me|mij|hem|haar|ons|dit|deze)\s+(?:in|naar|tot)\b/i,
  /\btover\s+(?:me|mij|hem|haar|ons|dit|deze)\s+(?:om\s+)?(?:in|tot)\b/i,
  /\bzet\s+(?:me|mij|hem|haar|ons)\s+(?:neer\s+)?als\b/i,
];

function normalizePromptHint(messageText: string): string {
  return messageText.replace(/\s+/g, " ").trim();
}

function isFreeformTransformRequest(messageText: string): boolean {
  const promptHint = normalizePromptHint(messageText);
  if (!promptHint || promptHint.startsWith("/")) {
    return false;
  }

  return TRANSFORM_REQUEST_PATTERNS.some(pattern => pattern.test(promptHint));
}

function buildPromptHint(messageText: string): string {
  const promptHint = normalizePromptHint(messageText);
  return [
    "Preserve the photographed person's recognizable identity, face, pose, and main framing.",
    `User requested transformation: ${promptHint}`,
  ].join(" ");
}

function getSourcePhotoUrl(ctx: BotTextContext): string | undefined {
  return ctx.state.lastPhotoUrl ?? ctx.state.lastPhoto ?? undefined;
}

export const freeformTransformFeature: BotFeature = {
  name: "freeformTransform",
  async onText(ctx) {
    if (!isFreeformTransformRequest(ctx.messageText)) {
      return { handled: false };
    }

    const sourcePhotoUrl = getSourcePhotoUrl(ctx);
    if (!sourcePhotoUrl) {
      await ctx.setFlowState("AWAITING_PHOTO");
      await ctx.sendText(t(ctx.lang, "styleWithoutPhoto"));
      return { handled: true };
    }

    ctx.logger.info("bot_feature_freeform_transform", {
      promptChars: ctx.messageText.trim().length,
    });

    await ctx.runStyleGeneration(
      "cinematic",
      sourcePhotoUrl,
      buildPromptHint(ctx.messageText)
    );
    return { handled: true };
  },
};
