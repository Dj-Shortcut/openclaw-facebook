import { sendWhatsAppBotResponse } from "./botResponseAdapters";
import type { BotResponse, ConversationAction } from "./botResponse";
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
import { setPendingConversationActions } from "./messengerState";

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

function buildWhatsAppActionListText(
  text: string,
  actions: ConversationAction[]
): string {
  if (actions.length === 0) {
    return text;
  }

  return [
    text,
    "",
    ...actions.map((action, index) => `${index + 1}. ${action.label}`),
  ].join("\n");
}

export async function sendWhatsAppStateText(
  senderId: string,
  state: ConversationState,
  text: string,
  lang: Lang
): Promise<void> {
  await sendWhatsAppText(senderId, buildStateResponseText(state, text, lang));
}

export async function sendWhatsAppBotStateResponse(
  senderId: string,
  response: BotResponse | null,
  replyState: ConversationState | null | undefined,
  lang: Lang
): Promise<void> {
  await sendWhatsAppBotResponse(response, {
    sendText: text => sendWhatsAppText(senderId, text),
    sendActionPrompt: async (text, actions) => {
      await Promise.resolve(setPendingConversationActions(senderId, actions));
      await sendWhatsAppText(senderId, buildWhatsAppActionListText(text, actions));
    },
    replyState: replyState ?? undefined,
    sendStateText: (stateName, text) =>
      sendWhatsAppStateText(senderId, stateName, text, lang),
  });
}

export function createWhatsAppQuickReplySender(senderId: string) {
  return {
    sendText: (text: string) => sendWhatsAppText(senderId, text),
    sendImage: (imageUrl: string) => sendWhatsAppImage(senderId, imageUrl),
    sendActions: async (text: string, actions: ConversationAction[]) => {
      await Promise.resolve(setPendingConversationActions(senderId, actions));
      await sendWhatsAppText(senderId, buildWhatsAppActionListText(text, actions));
    },
    sendQuickReplies: (text: string, replies: QuickReply[]) =>
      sendWhatsAppText(senderId, buildWhatsAppReplyListText(text, replies)),
    sendStateQuickReplies: (
      nextState: ConversationState,
      text: string,
      lang: Lang
    ) => sendWhatsAppStateText(senderId, nextState, text, lang),
  };
}
