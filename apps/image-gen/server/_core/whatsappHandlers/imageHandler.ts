import { downloadWhatsAppMedia } from "../whatsappApi";
import { storeInboundSourceImage } from "../sourceImageStore";
import { toLogUser } from "../privacy";
import { t } from "../i18n";
import {
  setPendingImage,
  setFlowState,
} from "../messengerState";
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

  await setPendingImage(event.senderId, persistedImageUrl, Date.now(), "stored");

  await sendWhatsAppTextReply(event.senderId, t(context.lang, "photoEditPrompt"));
}
