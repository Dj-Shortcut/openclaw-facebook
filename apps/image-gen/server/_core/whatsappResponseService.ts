import { sendWhatsAppBotResponse } from "./botResponseAdapters";
import type { BotResponse } from "./botResponse";
import type { Lang } from "./i18n";
import type { QuickReply } from "./messengerApi";
import type { ConversationState } from "./messengerState";
import {
  sendWhatsAppButtons,
  sendWhatsAppImage,
  sendWhatsAppList,
  sendWhatsAppText,
} from "./whatsappApi";
import { buildStateResponseText } from "./stateResponseText";

function buildWhatsAppReplyListText(text: string, replies: QuickReply[]): string {
  if (replies.length === 0) {
    return text;
  }

  return [
    text,
    "",
    ...replies.map((reply, index) => `${index + 1}. ${reply.title}`),
  ].join("\n");
}

export async function sendWhatsAppTextReply(
  senderId: string,
  text: string
): Promise<void> {
  await sendWhatsAppText(senderId, text);
}

export async function sendWhatsAppImageReply(
  senderId: string,
  imageUrl: string
): Promise<void> {
  await sendWhatsAppImage(senderId, imageUrl);
}

export async function sendWhatsAppButtonsReply(
  senderId: string,
  text: string,
  options: Array<{ id: string; title: string }>
): Promise<void> {
  await sendWhatsAppButtons(senderId, text, options);
}

export async function sendWhatsAppListReply(
  senderId: string,
  text: string,
  buttonLabel: string,
  rows: Array<{ id: string; title: string; description?: string }>,
  sectionTitle: string
): Promise<void> {
  await sendWhatsAppList(senderId, text, buttonLabel, rows, sectionTitle);
}

export async function sendWhatsAppStateText(
  senderId: string,
  state: ConversationState,
  text: string,
  lang: Lang
): Promise<void> {
  await sendWhatsAppText(senderId, buildStateResponseText(state, text, lang));
}

export function createWhatsAppRouteResponseSender(senderId: string) {
  return {
    sendText: (text: string) => sendWhatsAppText(senderId, text),
    sendOptionsPrompt: (
      prompt: string,
      options: Array<{ id: string; title: string }>,
      fallbackText?: string
    ) =>
      sendWhatsAppText(
        senderId,
        fallbackText ?? [prompt, ...options.map(option => option.title)].join("\n")
      ),
    sendImage: (imageUrl: string, caption?: string) => {
      if (caption) {
        return sendWhatsAppText(senderId, caption).then(() =>
          sendWhatsAppImage(senderId, imageUrl)
        );
      }

      return sendWhatsAppImage(senderId, imageUrl);
    },
  };
}

export async function sendWhatsAppExperienceRouteResponse(
  senderId: string,
  route: {
    response?: BotResponse | null;
    afterSend?: (() => Promise<BotResponse | null>) | undefined;
  }
): Promise<void> {
  await sendWhatsAppBotResponse(
    route.response ?? null,
    createWhatsAppRouteResponseSender(senderId)
  );

  if (!route.afterSend) {
    return;
  }

  const followUpResponse = await route.afterSend();
  await sendWhatsAppBotResponse(
    followUpResponse,
    createWhatsAppRouteResponseSender(senderId)
  );
}

export async function sendWhatsAppBotStateResponse(
  senderId: string,
  response: BotResponse | null,
  replyState: ConversationState | null | undefined,
  lang: Lang
): Promise<void> {
  await sendWhatsAppBotResponse(response, {
    sendText: text => sendWhatsAppText(senderId, text),
    replyState: replyState ?? undefined,
    sendStateText: (stateName, text) =>
      sendWhatsAppStateText(senderId, stateName, text, lang),
  });
}

export function createWhatsAppQuickReplySender(senderId: string) {
  return {
    sendText: (text: string) => sendWhatsAppText(senderId, text),
    sendImage: (imageUrl: string) => sendWhatsAppImage(senderId, imageUrl),
    sendQuickReplies: (text: string, replies: QuickReply[]) =>
      sendWhatsAppText(senderId, buildWhatsAppReplyListText(text, replies)),
    sendStateQuickReplies: (
      nextState: ConversationState,
      text: string,
      lang: Lang
    ) => sendWhatsAppStateText(senderId, nextState, text, lang),
  };
}
