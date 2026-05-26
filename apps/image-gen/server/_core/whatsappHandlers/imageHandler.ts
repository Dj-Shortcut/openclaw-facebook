import { downloadWhatsAppMedia } from "../whatsappApi";
import { storeInboundSourceImage } from "../sourceImageStore";
import { toLogUser } from "../privacy";
import { t } from "../i18n";
import {
  getOrCreateState,
  setPendingImage,
  setPreselectedStyle,
  setFlowState,
} from "../messengerState";
import {
  normalizeStyle,
} from "../webhookHelpers";
import {
  sendWhatsAppStyleCategoryPrompt,
} from "../whatsappFlows/styleSelectionFlow";
import { runWhatsAppStyleGeneration } from "../whatsappFlows/styleGenerationFlow";
import { sendWhatsAppTextReply } from "../whatsappResponseService";
import type { NormalizedWhatsAppEvent, WhatsAppHandlerContext } from "../whatsappTypes";

export async function handleWhatsAppImageEvent(
  event: NormalizedWhatsAppEvent,
  context: WhatsAppHandlerContext
): Promise<void> {
  if (!event.imageId) {
    console.warn("[whatsapp webhook] image event missing image id", {
      user: toLogUser(event.userId),
    });
    return;
  }

  let persistedImageUrl: string;
  try {
    const media = await downloadWhatsAppMedia(event.imageId);
    console.info("[whatsapp webhook] image downloaded", {
      user: toLogUser(event.userId),
      imageId: event.imageId,
      contentType: media.contentType,
      byteLength: media.buffer.length,
    });

    persistedImageUrl = await storeInboundSourceImage(
      media.buffer,
      media.contentType,
      context.reqId
    );
    console.info("[whatsapp webhook] image persisted", {
      user: toLogUser(event.userId),
      imageId: event.imageId,
      persistedImageUrl,
    });
  } catch (error) {
    console.error("[whatsapp webhook] failed to process inbound image", {
      user: toLogUser(event.userId),
      imageId: event.imageId,
      reqId: context.reqId,
      error: error instanceof Error ? error.message : String(error),
    });
    await setFlowState(event.senderId, "AWAITING_PHOTO");
    await sendWhatsAppTextReply(event.senderId, t(context.lang, "missingInputImage"));
    return;
  }

  const state = await Promise.resolve(getOrCreateState(event.senderId));
  const preselectedStyle = normalizeStyle(state.preselectedStyle ?? "");
  await setPendingImage(event.senderId, persistedImageUrl, Date.now(), "stored");

  if (preselectedStyle) {
    await setPreselectedStyle(event.senderId, null);
    await runWhatsAppStyleGeneration({
      senderId: event.senderId,
      userId: event.userId,
      style: preselectedStyle,
      reqId: context.reqId,
      lang: context.lang,
      sourceImageUrl: persistedImageUrl,
    });
    return;
  }

  await sendWhatsAppStyleCategoryPrompt(event.senderId, context.lang);
}
