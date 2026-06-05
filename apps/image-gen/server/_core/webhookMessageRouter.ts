import { type Lang } from "./i18n";
import { decodeMessengerActionInput } from "./messengerActionPayload";
import { type FacebookWebhookEvent } from "./webhookHelpers";
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

  if (
    await tryHandleImageMessage(ctx, {
      psid: input.psid,
      userId: input.userId,
      reqId: input.reqId,
      lang: input.lang,
      attachments: message.attachments,
      text: message.text,
      timestamp: input.event.timestamp ?? Date.now(),
    })
  ) {
    return;
  }

  const text = message.text;
  const trimmedText = text?.trim();
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
