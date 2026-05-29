import type { Style } from "../../messengerStyles";
import { t } from "../../i18n";
import { normalizeStyle } from "../../webhookHelpers";
import type { BotFeature } from "../features";

function getRequestedStyle(messageText: string): Style | undefined {
  const trimmedText = messageText.trim();
  const colonMatch = /^style\s*:\s*(.+)$/i.exec(trimmedText);
  if (colonMatch) {
    return normalizeStyle(colonMatch[1] ?? "");
  }

  const slashMatch = /^\/style\s+(.+)$/i.exec(trimmedText);
  if (slashMatch) {
    return normalizeStyle(slashMatch[1] ?? "");
  }

  return undefined;
}

export const styleCommandsFeature: BotFeature = {
  name: "styleCommands",
  async onText(ctx) {
    const requestedStyle = getRequestedStyle(ctx.messageText);
    if (!requestedStyle) {
      return { handled: false };
    }

    if (!ctx.state.lastPhotoUrl && !ctx.state.lastPhoto) {
      await ctx.preselectStyle(requestedStyle);
      await ctx.setFlowState("AWAITING_PHOTO");
      await ctx.sendText(
        [
          ctx.lang === "en"
            ? `✅ Style set to ${requestedStyle}.`
            : `✅ Stijl ingesteld op ${requestedStyle}.`,
          t(ctx.lang, "styleWithoutPhoto"),
        ].join("\n\n")
      );
      return { handled: true };
    }

    await ctx.chooseStyle(requestedStyle);
    return { handled: true };
  },
};
