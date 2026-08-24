import { createHash } from "node:crypto";

import { sendWhatsAppBotResponse } from "./botResponseAdapters";
import type { BotResponse, ConversationAction } from "./botResponse";
import type { ConversationState } from "./messengerState";
import {
  sendWhatsAppButtons,
  sendWhatsAppErasureControlText,
  sendWhatsAppImage,
  sendWhatsAppImageWithReceipt,
  sendWhatsAppText,
  type WhatsAppDeliveryReceipt,
} from "./whatsappApi";
import { setPendingConversationActions } from "./messengerState";

function createWhatsAppResponseOperationId(
  reqId: string,
  responseSlot: string
): string {
  const normalizedReqId = reqId.trim();
  const normalizedSlot = responseSlot.trim();
  if (!normalizedReqId || !normalizedSlot) {
    throw new Error("WhatsApp response operation identity is required");
  }
  return createHash("sha256")
    .update("whatsapp:response-slot:v1", "utf8")
    .update("\0")
    .update(normalizedReqId)
    .update("\0")
    .update(normalizedSlot)
    .digest("hex");
}

export async function sendWhatsAppTextReply(
  senderId: string,
  text: string,
  reqId: string,
  responseSlot: string
): Promise<void> {
  await sendWhatsAppText(
    senderId,
    text,
    createWhatsAppResponseOperationId(reqId, responseSlot)
  );
}

export async function sendWhatsAppErasureControlTextReply(
  senderId: string,
  text: string,
  reqId: string
): Promise<void> {
  await sendWhatsAppErasureControlText(senderId, text, reqId);
}

export async function sendWhatsAppImageReply(
  senderId: string,
  imageUrl: string,
  reqId: string
): Promise<void> {
  await sendWhatsAppImage(senderId, imageUrl, reqId);
}

export async function sendWhatsAppImageReplyWithReceipt(
  senderId: string,
  imageUrl: string,
  reqId: string
): Promise<WhatsAppDeliveryReceipt> {
  return sendWhatsAppImageWithReceipt(senderId, imageUrl, reqId);
}

export async function sendWhatsAppButtonsReply(
  senderId: string,
  text: string,
  options: Array<{ id: string; title: string }>,
  reqId: string,
  responseSlot: string
): Promise<void> {
  await sendWhatsAppButtons(
    senderId,
    text,
    options,
    createWhatsAppResponseOperationId(reqId, responseSlot)
  );
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
  text: string,
  operationId: string
): Promise<void> {
  await sendWhatsAppText(senderId, text, operationId);
}

export async function sendWhatsAppBotStateResponse(
  senderId: string,
  response: BotResponse | null,
  replyState: ConversationState | null | undefined,
  reqId: string
): Promise<void> {
  const imageOperationId = (imageUrl: string) =>
    createHash("sha256")
      .update("whatsapp-bot-image\0")
      .update(reqId)
      .update("\0")
      .update(imageUrl)
      .digest("hex");
  await sendWhatsAppBotResponse(response, {
    sendText: text =>
      sendWhatsAppText(
        senderId,
        text,
        createWhatsAppResponseOperationId(reqId, "bot-text")
      ),
    sendActionPrompt: async (text, actions) => {
      await Promise.resolve(setPendingConversationActions(senderId, actions));
      await sendWhatsAppText(
        senderId,
        buildWhatsAppActionListText(text, actions),
        createWhatsAppResponseOperationId(reqId, "bot-action-prompt")
      );
    },
    replyState: replyState ?? undefined,
    sendImage: imageUrl =>
      sendWhatsAppImage(senderId, imageUrl, imageOperationId(imageUrl)),
    sendStateText: (stateName, text) =>
      sendWhatsAppStateText(
        senderId,
        stateName,
        text,
        createWhatsAppResponseOperationId(
          reqId,
          `bot-state:${String(stateName)}`
        )
      ),
  });
}

export function createWhatsAppResponseSender(senderId: string, reqId: string) {
  const imageOperationId = (imageUrl: string) =>
    createHash("sha256")
      .update("whatsapp-feature-image\0")
      .update(reqId)
      .update("\0")
      .update(imageUrl)
      .digest("hex");
  return {
    sendText: (text: string) =>
      sendWhatsAppText(
        senderId,
        text,
        createWhatsAppResponseOperationId(reqId, "feature-text")
      ),
    sendImage: (imageUrl: string) =>
      sendWhatsAppImage(senderId, imageUrl, imageOperationId(imageUrl)),
    sendActions: async (text: string, actions: ConversationAction[]) => {
      await Promise.resolve(setPendingConversationActions(senderId, actions));
      await sendWhatsAppText(
        senderId,
        buildWhatsAppActionListText(text, actions),
        createWhatsAppResponseOperationId(reqId, "feature-actions")
      );
    },
  };
}
