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
import { safeLog } from "../logger";

export async function handleWhatsAppImageEvent(
  event: NormalizedWhatsAppEvent,
  context: WhatsAppHandlerContext
): Promise<void> {
  if (!event.imageId) {
    safeLog("whatsapp_image_event_missing_image_id", {
      level: "warn",
      user: toLogUser(event.userId),
    });
    return;
  }

  let persistedImageUrl: string;
  try {
    const media = await downloadWhatsAppMedia(event.imageId);
    safeLog("whatsapp_image_downloaded", {
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
    safeLog("whatsapp_image_persisted", {
      user: toLogUser(event.userId),
      imageId: event.imageId,
      persistedImageLocation: summarizePersistedImageUrl(persistedImageUrl),
    });
  } catch (error) {
    safeLog("whatsapp_inbound_image_processing_failed", {
      level: "error",
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

function summarizePersistedImageUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return parsed.hostname.toLowerCase();
  } catch {
    return "invalid";
  }
}
