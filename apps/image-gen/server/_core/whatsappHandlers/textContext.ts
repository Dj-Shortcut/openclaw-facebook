import { getBotFeatures } from "../bot/features";
import type { BotLogger, BotTextContext } from "../botContext";
import { getTodayRuntimeStats } from "../botRuntimeStats";
import {
  clearPendingImageState,
  setFlowState,
} from "../messengerState";
import { toLogUser } from "../privacy";
import { createWhatsAppResponseSender } from "../whatsappResponseService";
import { runWhatsAppImageGeneration } from "../whatsappFlows/imageGenerationFlow";
import type { NormalizedWhatsAppEvent, WhatsAppHandlerContext } from "../whatsappTypes";
import { safeLog } from "../logger";

function createWhatsAppFeatureLogger(userId: string): BotLogger {
  return {
    info(event, details = {}) {
      safeLog(event, { user: toLogUser(userId), ...details });
    },
    warn(event, details = {}) {
      safeLog(event, { level: "warn", user: toLogUser(userId), ...details });
    },
    error(event, details = {}) {
      safeLog(event, { level: "error", user: toLogUser(userId), ...details });
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
  const sender = createWhatsAppResponseSender(event.senderId);
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
    sendActions: sender.sendActions,
    setFlowState: nextState =>
      Promise.resolve(setFlowState(event.senderId, nextState)),
    clearImageContext: () =>
      Promise.resolve(clearPendingImageState(event.senderId)).then(() => undefined),
    runImageGeneration: (sourceImageUrl, promptHint, generationKind) =>
      runWhatsAppImageGeneration({
        senderId: event.senderId,
        userId: event.userId,
        reqId: context.reqId,
        lang: context.lang,
        sourceImageUrl,
        promptHint,
        generationKind,
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
