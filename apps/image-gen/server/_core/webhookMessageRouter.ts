import { type Lang } from "./i18n";
import { safeLog } from "./messengerApi";
import { t } from "./i18n";
import { decodeMessengerActionInput } from "./messengerActionPayload";
import { anonymizePsid } from "./messengerState";
import {
  getNormalizedAttachmentTypes,
  hasAudioAttachment,
  hasFileAttachment,
  hasLinkAttachment,
  hasGifAttachment,
  hasImageAttachment,
  hasReadableImageAttachment,
  hasUnknownAttachment,
  hasVideoAttachment,
  type FacebookWebhookEvent,
  type MessengerNormalizedAttachment,
  normalizeMessengerInboundMessage,
} from "./webhookHelpers";
import { handlePayload } from "./webhookPayloadBranch";
import type { HandlerContext } from "./webhookHandlerTypes";
import { handleTextMessage } from "./webhookTextMessageRouter";
import { tryHandleImageMessage } from "./webhookImageMessageRouter";

type MessageEventInput = {
  psid: string;
  userId: string;
  event: FacebookWebhookEvent;
  reqId: string;
  lang: Lang;
};

type UnsupportedAttachmentRoute = "gif" | "audio" | "unsupported_media";

function getUnsupportedResponseKey(
  route: UnsupportedAttachmentRoute
): "unsupportedGif" | "unsupportedAudio" | "unsupportedMedia" {
  if (route === "gif") {
    return "unsupportedGif";
  }

  if (route === "audio") {
    return "unsupportedAudio";
  }

  return "unsupportedMedia";
}

/** Handles a non-echo Messenger message event and dispatches payload, image, or text flows. */
export async function handleMessageEvent(
  ctx: HandlerContext,
  input: MessageEventInput
): Promise<void> {
  const message = input.event.message;
  if (!message || message.is_echo) return;

  if (
    (await ctx.maybeSendInFlightMessage(input.psid, input.reqId, input.lang))
      .handled
  ) {
    return;
  }

  const quickPayload = message.quick_reply?.payload;
  if (quickPayload) {
    const actionInput = decodeMessengerActionInput(quickPayload);
    if (actionInput) {
      await handleTextMessage(ctx, {
        psid: input.psid,
        userId: input.userId,
        reqId: input.reqId,
        lang: input.lang,
        text: actionInput,
        replyToMessageId: message.reply_to?.mid,
        timestamp: input.event.timestamp ?? Date.now(),
      });
      return;
    }

    await handlePayload(ctx, {
      psid: input.psid,
      userId: input.userId,
      payload: quickPayload,
      reqId: input.reqId,
      lang: input.lang,
    });
    return;
  }

  const normalizedInbound = normalizeMessengerInboundMessage(message);
  const normalizedAttachments = normalizedInbound.attachments;
  const trimmedText = normalizedInbound.text?.trim();
  const hasAttachments = normalizedAttachments.length > 0;

  if (normalizedAttachments.length) {
    await logMessengerAttachments(ctx, input, normalizedAttachments, trimmedText);
  }

  if (
    hasImageAttachment(normalizedAttachments) &&
    hasReadableImageAttachment(normalizedAttachments)
  ) {
    const imageHandled = await tryHandleImageMessage(ctx, {
      psid: input.psid,
      userId: input.userId,
      reqId: input.reqId,
      lang: input.lang,
      attachments: message.attachments,
      text: message.text,
      timestamp: input.event.timestamp ?? Date.now(),
    });
    if (imageHandled) {
      await logMessengerImageRouted(
        ctx,
        input,
        normalizedAttachments,
        trimmedText,
        true
      );
      return;
    }
  }

  const unsupportedRoute = resolveUnsupportedAttachmentRoute(normalizedAttachments);
  if (unsupportedRoute) {
    await sendUnsupportedAttachmentResponse(
      ctx,
      input,
      normalizedAttachments,
      trimmedText,
      unsupportedRoute
    );
    return;
  }

  if (hasAttachments) {
    await sendUnsupportedAttachmentResponse(
      ctx,
      input,
      normalizedAttachments,
      trimmedText,
      "unsupported_media"
    );
    return;
  }

  if (!trimmedText) {
    return;
  }

  await handleTextMessage(ctx, {
    psid: input.psid,
    userId: input.userId,
    reqId: input.reqId,
    lang: input.lang,
    text: trimmedText,
    replyToMessageId: message.reply_to?.mid,
    timestamp: input.event.timestamp ?? Date.now(),
  });
}

function resolveUnsupportedAttachmentRoute(
  attachments: MessengerNormalizedAttachment[]
): UnsupportedAttachmentRoute | null {
  if (hasGifAttachment(attachments)) {
    return "gif";
  }

  if (hasAudioAttachment(attachments)) {
    return "audio";
  }

  if (
    hasVideoAttachment(attachments) ||
    hasFileAttachment(attachments) ||
    hasLinkAttachment(attachments) ||
    hasUnknownAttachment(attachments)
  ) {
    return "unsupported_media";
  }

  return null;
}

async function logMessengerAttachments(
  ctx: HandlerContext,
  input: MessageEventInput,
  attachments: MessengerNormalizedAttachment[],
  trimmedText: string | undefined
): Promise<void> {
  safeLog("messenger_attachment_received", {
    reqId: input.reqId,
    psidHash: anonymizePsid(input.psid).slice(0, 12),
    attachmentKinds: getNormalizedAttachmentTypes(attachments),
    attachmentCount: attachments?.length ?? 0,
    hasText: Boolean(trimmedText),
    textLength: trimmedText?.length ?? 0,
  });
  ctx.debugWebhookLog({
    msg: "attachment_received",
    reqId: input.reqId,
    attachmentCount: attachments?.length ?? 0,
    hasAttachments: true,
  });
}

async function logMessengerImageRouted(
  ctx: HandlerContext,
  input: MessageEventInput,
  attachments: MessengerNormalizedAttachment[],
  trimmedText: string | undefined,
  imageHandled: boolean
): Promise<void> {
  await logMessengerAttachmentRouted(
    ctx,
    input,
    attachments,
    trimmedText,
    imageHandled ? "image" : "image_noop"
  );
}

async function sendUnsupportedAttachmentResponse(
  ctx: HandlerContext,
  input: MessageEventInput,
  attachments: MessengerNormalizedAttachment[],
  trimmedText: string | undefined,
  route: UnsupportedAttachmentRoute
): Promise<void> {
  await logMessengerAttachmentRouted(
    ctx,
    input,
    attachments,
    trimmedText,
    route
  );
  safeLog("messenger_attachment_unsupported", {
    reqId: input.reqId,
    psidHash: anonymizePsid(input.psid).slice(0, 12),
    route,
    attachmentKinds: getNormalizedAttachmentTypes(attachments),
    attachmentCount: attachments?.length ?? 0,
    hasText: Boolean(trimmedText),
    textLength: trimmedText?.length ?? 0,
  });
  await ctx.sendLoggedText(
    input.psid,
    t(input.lang, getUnsupportedResponseKey(route)),
    input.reqId
  );
}

async function logMessengerAttachmentRouted(
  ctx: HandlerContext,
  input: MessageEventInput,
  attachments: MessengerNormalizedAttachment[],
  trimmedText: string | undefined,
  route: string
): Promise<void> {
  safeLog("messenger_attachment_routed", {
    reqId: input.reqId,
    psidHash: anonymizePsid(input.psid).slice(0, 12),
    route,
    attachmentKinds: getNormalizedAttachmentTypes(attachments),
    attachmentCount: attachments?.length ?? 0,
    hasText: Boolean(trimmedText),
    textLength: trimmedText?.length ?? 0,
  });
  ctx.debugWebhookLog({
    msg: "attachment_routed",
    reqId: input.reqId,
    route,
  });
}
