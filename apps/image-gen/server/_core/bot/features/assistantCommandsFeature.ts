import type { BotFeature } from "../features";
import type { BotTextContext } from "../../botContext";
import { t } from "../../i18n";
import {
  buildAssistantPhotoHelpResponse,
  buildQuickStartResponse,
} from "../../conversationActions";

const HELP_COMMANDS = new Set([
  "help",
  "/help",
  "menu",
  "/menu",
  "commands",
  "commando",
  "commando's",
  "help eens",
  "help me eens",
  "wat kan je",
  "wat doe ik",
  "wat doe ik?",
  "what can you do",
  "what is this",
  "what is this?",
]);

const SURPRISE_COMMANDS = new Set([
  "surprise",
  "surprise me",
  "verras me",
  "random",
]);

const NEW_IMAGE_COMMANDS = new Set([
  "new_image",
  "new image",
  "nieuwe afbeelding",
  "nieuwe foto",
  "nieuw beeld",
]);

const EDIT_PHOTO_COMMANDS = new Set([
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

const CHANGE_BACKGROUND_COMMANDS = new Set([
  "change_background",
  "andere achtergrond",
  "different background",
]);

const PRIVACY_COMMANDS = new Set([
  "privacy",
  "privacybeleid",
  "privacy policy",
]);

function resolvePrivacyPolicyUrl(): string | undefined {
  const configured = process.env.PRIVACY_POLICY_URL?.trim();
  if (configured) {
    return configured;
  }

  const appBaseUrl = (process.env.APP_BASE_URL ?? process.env.BASE_URL)?.trim();
  if (appBaseUrl && /^https?:\/\//i.test(appBaseUrl)) {
    return `${appBaseUrl.replace(/\/$/, "")}/privacy`;
  }

  return undefined;
}

function getEditableImageUrl(ctx: BotTextContext): string | undefined {
  return (
    ctx.state.lastPhotoUrl ??
    ctx.state.lastPhoto ??
    ctx.state.lastGeneratedUrl ??
    ctx.state.lastImageUrl ??
    undefined
  );
}

export const assistantCommandsFeature: BotFeature = {
  name: "assistant_commands",
  async onText(ctx) {
    if (HELP_COMMANDS.has(ctx.normalizedText)) {
      if (getEditableImageUrl(ctx)) {
        const response = buildAssistantPhotoHelpResponse(ctx.lang);
        await ctx.sendActions(response.text ?? "", response.actions ?? []);
      } else {
        const response = buildQuickStartResponse(ctx.lang);
        await ctx.sendActions(response.text ?? "", response.actions ?? []);
      }

      return { handled: true };
    }

    if (NEW_IMAGE_COMMANDS.has(ctx.normalizedText)) {
      await ctx.setPendingEditIntent?.(null);
      await ctx.clearImageContext?.();
      await ctx.setFlowState("IDLE");
      await ctx.sendText(t(ctx.lang, "newImagePrompt"));
      return { handled: true };
    }

    if (CHANGE_BACKGROUND_COMMANDS.has(ctx.normalizedText)) {
      if (!getEditableImageUrl(ctx)) {
        await ctx.setPendingEditIntent?.(null);
        await ctx.setFlowState("AWAITING_PHOTO");
        await ctx.sendText(t(ctx.lang, "changeBackgroundRequiresPhoto"));
        return { handled: true };
      }

      await ctx.setFlowState("AWAITING_EDIT_PROMPT");
      await ctx.setPendingEditIntent?.("change_background");
      await ctx.sendText(t(ctx.lang, "changeBackgroundPrompt"));
      return { handled: true };
    }

    if (EDIT_PHOTO_COMMANDS.has(ctx.normalizedText)) {
      await ctx.setPendingEditIntent?.(null);
      if (!getEditableImageUrl(ctx)) {
        await ctx.setFlowState("AWAITING_PHOTO");
        await ctx.sendText(t(ctx.lang, "editRequiresPhoto"));
        return { handled: true };
      }

      await ctx.setFlowState("AWAITING_EDIT_PROMPT");
      await ctx.sendText(t(ctx.lang, "editImagePrompt"));
      return { handled: true };
    }

    if (PRIVACY_COMMANDS.has(ctx.normalizedText)) {
      await ctx.sendText(t(ctx.lang, "privacy", { link: resolvePrivacyPolicyUrl() }));
      return { handled: true };
    }

    if (!SURPRISE_COMMANDS.has(ctx.normalizedText)) {
      return { handled: false };
    }

    const editableImageUrl = getEditableImageUrl(ctx);
    if (!editableImageUrl) {
      const response = buildQuickStartResponse(ctx.lang);
      await ctx.sendActions(response.text ?? "", response.actions ?? []);
      return { handled: true };
    }

    const response = buildAssistantPhotoHelpResponse(ctx.lang);
    await ctx.sendActions(response.text ?? "", response.actions ?? []);
    return { handled: true };
  },
};
