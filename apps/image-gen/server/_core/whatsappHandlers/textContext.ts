import { getBotFeatures } from "../bot/features";
import type { BotLogger, BotTextContext } from "../botContext";
import { getTodayRuntimeStats } from "../botRuntimeStats";
import {
  setFlowState,
  setPreselectedStyle,
} from "../messengerState";
import { toLogUser } from "../privacy";
import { createWhatsAppQuickReplySender } from "../whatsappResponseService";
import { runWhatsAppStyleGeneration } from "../whatsappFlows/styleGenerationFlow";
import type { NormalizedWhatsAppEvent, WhatsAppHandlerContext } from "../whatsappTypes";

function createWhatsAppFeatureLogger(userId: string): BotLogger {
  return {
    info(event, details = {}) {
      console.info("[whatsapp feature]", event, { user: toLogUser(userId), ...details });
    },
    warn(event, details = {}) {
      console.warn("[whatsapp feature]", event, { user: toLogUser(userId), ...details });
    },
    error(event, details = {}) {
      console.error("[whatsapp feature]", event, { user: toLogUser(userId), ...details });
    },
  };
}

export function createWhatsAppTextContext(
  event: NormalizedWhatsAppEvent,
  context: WhatsAppHandlerContext,
  state: BotTextContext["state"],
  messageText: string,
  normalizedText: string,
  hasPhoto: boolean
): BotTextContext {
  const sender = createWhatsAppQuickReplySender(event.senderId);
  return {
    channel: "whatsapp",
    capabilities: { quickReplies: false, richTemplates: false },
    senderId: event.senderId,
    userId: event.userId,
    reqId: context.reqId,
    lang: context.lang,
    state,
    messageText,
    normalizedText,
    hasPhoto,
    sendText: sender.sendText,
    sendImage: sender.sendImage,
    sendQuickReplies: sender.sendQuickReplies,
    sendStateQuickReplies: (nextState, text) =>
      sender.sendStateQuickReplies(nextState, text, context.lang),
    setFlowState: nextState =>
      Promise.resolve(setFlowState(event.senderId, nextState)),
    preselectStyle: style =>
      Promise.resolve(setPreselectedStyle(event.senderId, style)).then(() => undefined),
    chooseStyle: style =>
      runWhatsAppStyleGeneration({
        senderId: event.senderId,
        userId: event.userId,
        style,
        reqId: context.reqId,
        lang: context.lang,
      }),
    runStyleGeneration: (style, sourceImageUrl, promptHint, directorMode) =>
      runWhatsAppStyleGeneration({
        senderId: event.senderId,
        userId: event.userId,
        style,
        reqId: context.reqId,
        lang: context.lang,
        sourceImageUrl,
        promptHint,
        directorMode,
      }),
    getRuntimeStats: () => getTodayRuntimeStats(),
    logger: createWhatsAppFeatureLogger(event.userId),
  };
}

export async function runWhatsAppTextFeatures(
  event: NormalizedWhatsAppEvent,
  context: WhatsAppHandlerContext,
  featureInput: {
    state: BotTextContext["state"];
    messageText: string;
    normalizedText: string;
    hasPhoto: boolean;
  }
): Promise<boolean> {
  for (const feature of getBotFeatures()) {
    const featureResult = await feature.onText?.(
      createWhatsAppTextContext(
        event,
        context,
        featureInput.state,
        featureInput.messageText,
        featureInput.normalizedText,
        featureInput.hasPhoto
      )
    );
    if (featureResult?.handled) {
      return true;
    }
  }

  return false;
}
