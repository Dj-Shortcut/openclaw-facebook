import { createHash } from "node:crypto";
import { downloadWhatsAppMedia } from "../whatsappApi";
import {
  createInboundSourceImageObjectKey,
  storeInboundSourceImage,
} from "../sourceImageStore";
import { toLogUser } from "../privacy";
import { t } from "../i18n";
import { setPendingImage, setFlowState } from "../messengerState";
import { sendWhatsAppTextReply } from "../whatsappResponseService";
import type {
  NormalizedWhatsAppEvent,
  WhatsAppHandlerContext,
} from "../whatsappTypes";
import { safeLog } from "../logger";
import {
  finalizeWhatsAppProviderAttemptFence,
  markWhatsAppProviderAttemptStarted,
  reserveWhatsAppProviderAttemptFence,
  type WhatsAppProviderAttemptFence,
} from "../whatsappProviderAttemptFence";
import { assertWhatsAppGenerationScopeActive } from "../whatsappGenerationScope";
import { uploadMessengerStorageObject } from "../messengerStorageUpload";

function hashMediaId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

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
  let downloadFence: WhatsAppProviderAttemptFence | null = null;
  let downloadStarted = false;
  try {
    await assertWhatsAppGenerationScopeActive({
      endpoint: event.endpoint,
      scope: context.costLedgerScope,
    });
    downloadFence = await reserveWhatsAppProviderAttemptFence({
      reqId: context.reqId,
      userKey: event.userId,
      providerOperation: "whatsapp_meta_image_download",
      expectedScope: context.costLedgerScope,
    });
    await markWhatsAppProviderAttemptStarted(downloadFence);
    downloadStarted = true;
    const media = await downloadWhatsAppMedia(event.imageId);
    await finalizeWhatsAppProviderAttemptFence(downloadFence, "succeeded");
    downloadFence = null;
    await assertWhatsAppGenerationScopeActive({
      endpoint: event.endpoint,
      scope: context.costLedgerScope,
    });
    safeLog("whatsapp_image_downloaded", {
      user: toLogUser(event.userId),
      mediaIdHash: hashMediaId(event.imageId),
      contentType: media.contentType,
      byteLength: media.buffer.length,
    });

    const objectKey = createInboundSourceImageObjectKey(
      media.contentType,
      context.costLedgerScope
    );
    persistedImageUrl = await uploadMessengerStorageObject({
      objectKey,
      scope: {
        ...context.costLedgerScope,
        pageId: event.endpoint.phoneNumberId,
        channel: "whatsapp",
      },
      reqId: context.reqId,
      providerOperation: "source_image_storage_upload",
      upload: () =>
        storeInboundSourceImage(
          media.buffer,
          media.contentType,
          context.reqId,
          objectKey
        ),
    });
    safeLog("whatsapp_image_persisted", {
      user: toLogUser(event.userId),
      mediaIdHash: hashMediaId(event.imageId),
      persistedImageLocation: summarizePersistedImageUrl(persistedImageUrl),
    });
  } catch (error) {
    if (downloadFence) {
      try {
        await finalizeWhatsAppProviderAttemptFence(
          downloadFence,
          downloadStarted ? "ambiguous" : "known_failed"
        );
      } catch (fenceError) {
        error = new AggregateError(
          [error, fenceError],
          "WhatsApp image download fence finalization failed",
          { cause: error }
        );
      }
    }
    safeLog("whatsapp_inbound_image_processing_failed", {
      level: "error",
      user: toLogUser(event.userId),
      mediaIdHash: hashMediaId(event.imageId),
      reqId: context.reqId,
      error: error instanceof Error ? error.name : "unknown_error",
    });
    await setFlowState(event.senderId, "AWAITING_PHOTO");
    await sendWhatsAppTextReply(
      event.senderId,
      t(context.lang, "missingInputImage")
    );
    return;
  }

  await setPendingImage(
    event.senderId,
    persistedImageUrl,
    Date.now(),
    "stored"
  );

  await sendWhatsAppTextReply(
    event.senderId,
    t(context.lang, "photoEditPrompt")
  );
}

function summarizePersistedImageUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return parsed.hostname.toLowerCase();
  } catch {
    return "invalid";
  }
}
