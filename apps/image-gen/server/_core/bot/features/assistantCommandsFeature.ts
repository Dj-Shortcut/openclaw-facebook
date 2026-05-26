import type { BotFeature } from "../features";
import { t } from "../../i18n";
import { type Style } from "../../messengerStyles";
import { STYLE_LABELS, STYLE_OPTIONS } from "../../webhookHelpers";

const HELP_COMMANDS = new Set([
  "help",
  "/help",
  "menu",
  "/menu",
  "commands",
  "commando",
  "commando's",
  "wat kan je",
  "what can you do",
]);

const SURPRISE_COMMANDS = new Set([
  "surprise",
  "surprise me",
  "verras me",
  "random",
  "random style",
]);

function pickRandomStyle() {
  const randomIndex = Math.floor(Math.random() * STYLE_OPTIONS.length);
  return STYLE_OPTIONS[randomIndex] ?? STYLE_OPTIONS[0];
}

function getRandomStyleLabel(style: Style): string {
  return STYLE_LABELS[style];
}

export const assistantCommandsFeature: BotFeature = {
  name: "assistant_commands",
  async onText(ctx) {
    if (HELP_COMMANDS.has(ctx.normalizedText)) {
      if (ctx.hasPhoto) {
        await ctx.sendStateQuickReplies(
          "AWAITING_STYLE",
          t(ctx.lang, "assistantQuickActions")
        );
      } else {
        await ctx.sendText(
          [
            t(ctx.lang, "textWithoutPhoto"),
            t(ctx.lang, "assistantPhotoTip"),
          ].join("\n\n")
        );
      }

      return { handled: true };
    }

    if (!SURPRISE_COMMANDS.has(ctx.normalizedText)) {
      return { handled: false };
    }

    if (!ctx.hasPhoto) {
      await ctx.setFlowState("AWAITING_PHOTO");
      await ctx.sendText(t(ctx.lang, "textWithoutPhoto"));
      return { handled: true };
    }

    const style = pickRandomStyle();
    await ctx.sendText(
      t(ctx.lang, "assistantRandomStyle", {
        styleLabel: getRandomStyleLabel(style),
      })
    );
    await ctx.runStyleGeneration(style, ctx.state.lastPhotoUrl ?? ctx.state.lastPhoto ?? undefined);

    return { handled: true };
  },
};
