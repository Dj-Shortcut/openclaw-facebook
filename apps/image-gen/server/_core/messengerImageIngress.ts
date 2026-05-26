import { safeLog } from "./messengerApi";
import type { Style } from "./messengerStyles";
import { ingestExternalSourceImage } from "./sourceImageStore";
import { normalizeStyle } from "./webhookHelpers";

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
      inboundImageUrl: input.inboundImageUrl,
      errorCode:
        error instanceof Error ? error.constructor.name : "UnknownError",
    });
    return null;
  }
}

type StoredMessengerImageDecisionInput = {
  lastPhotoUrl: string | null;
  preselectedStyle?: string | null;
  storedSourceImageUrl: string;
};

export type StoredMessengerImageDecision =
  | {
      action: "show_style_picker";
      hadPreviousPhoto: boolean;
      incomingImageUrl: string;
      preselectedStyle: null;
    }
  | {
      action: "auto_run_preselected_style";
      hadPreviousPhoto: boolean;
      incomingImageUrl: string;
      preselectedStyle: Style;
    };

export function getStoredMessengerImageDecision(
  input: StoredMessengerImageDecisionInput
): StoredMessengerImageDecision {
  const hadPreviousPhoto = Boolean(input.lastPhotoUrl);
  const preselectedStyle = normalizeStyle(input.preselectedStyle ?? "") ?? null;

  if (preselectedStyle && !hadPreviousPhoto) {
    return {
      action: "auto_run_preselected_style",
      hadPreviousPhoto,
      incomingImageUrl: input.storedSourceImageUrl,
      preselectedStyle,
    };
  }

  return {
    action: "show_style_picker",
    hadPreviousPhoto,
    incomingImageUrl: input.storedSourceImageUrl,
    preselectedStyle: null,
  };
}
