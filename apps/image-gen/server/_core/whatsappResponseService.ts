import { sendWhatsAppBotResponse } from "./botResponseAdapters";
import type { BotResponse, ConversationAction } from "./botResponse";
import type { ConversationState } from "./messengerState";
import {
  sendWhatsAppButtons,
  sendWhatsAppImage,
  sendWhatsAppText,
} from "./whatsappApi";
import { setPendingConversationActions } from "./messengerState";

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

async function sendWhatsAppStateText(
  senderId: string,
  _state: ConversationState,
  text: string
): Promise<void> {
  await sendWhatsAppText(senderId, text);
}

export async function sendWhatsAppBotStateResponse(
  senderId: string,
  response: BotResponse | null,
  replyState: ConversationState | null | undefined
): Promise<void> {
  await sendWhatsAppBotResponse(response, {
    sendText: text => sendWhatsAppText(senderId, text),
    sendActionPrompt: async (text, actions) => {
      await Promise.resolve(setPendingConversationActions(senderId, actions));
      await sendWhatsAppText(senderId, buildWhatsAppActionListText(text, actions));
    },
    replyState: replyState ?? undefined,
    sendStateText: (stateName, text) =>
      sendWhatsAppStateText(senderId, stateName, text),
  });
}

export function createWhatsAppResponseSender(senderId: string) {
  return {
    sendText: (text: string) => sendWhatsAppText(senderId, text),
    sendImage: (imageUrl: string) => sendWhatsAppImage(senderId, imageUrl),
    sendActions: async (text: string, actions: ConversationAction[]) => {
      await Promise.resolve(setPendingConversationActions(senderId, actions));
      await sendWhatsAppText(senderId, buildWhatsAppActionListText(text, actions));
    },
  };
}
