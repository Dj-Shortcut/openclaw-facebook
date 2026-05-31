import { safeLog } from "./messengerApi";
import { ingestExternalSourceImage } from "./sourceImageStore";
import { summarizeSensitiveUrl } from "./utils/urlSummarizer";

type NormalizeMessengerInboundImageInput = {
  inboundImageUrl: string;
  psidHash: string;
  reqId: string;
};

export async function normalizeMessengerInboundImage(
  input: NormalizeMessengerInboundImageInput
): Promise<string | null> {
  try {
    const storedSourceImage = await ingestExternalSourceImage(
      input.inboundImageUrl,
      input.reqId
    );
    return storedSourceImage.url;
  } catch (error) {
    safeLog("messenger_inbound_image_ingest_failed", {
      psidHash: input.psidHash,
      reqId: input.reqId,
      inboundImageUrl: summarizeSensitiveUrl(input.inboundImageUrl),
      errorCode:
        error instanceof Error ? error.constructor.name : "UnknownError",
    });
    return null;
  }
}

type StoredMessengerImageDecisionInput = {
  lastPhotoUrl: string | null;
  storedSourceImageUrl: string;
};

export type StoredMessengerImageDecision =
  | {
      action: "request_edit_prompt";
      hadPreviousPhoto: boolean;
      incomingImageUrl: string;
    };

export function getStoredMessengerImageDecision(
  input: StoredMessengerImageDecisionInput
): StoredMessengerImageDecision {
  const hadPreviousPhoto = Boolean(input.lastPhotoUrl);

  return {
    action: "request_edit_prompt",
    hadPreviousPhoto,
    incomingImageUrl: input.storedSourceImageUrl,
  };
}
