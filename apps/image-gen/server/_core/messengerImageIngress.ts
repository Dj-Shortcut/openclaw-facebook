import { safeLog } from "./messengerApi";
import type { Style } from "./messengerStyles";
import { ingestExternalSourceImage } from "./sourceImageStore";
import { summarizeSensitiveUrl } from "./utils/urlSummarizer";
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
      inboundImageUrl: summarizeSensitiveUrl(input.inboundImageUrl),
      errorCode:
        error instanceof Error ? error.constructor.name : "UnknownError",
    });
    return null;
  }
}

type StoredMessengerImageDecisionInput = {
  lastPhotoUrl: string | null;
  selectedStyle?: string | null;
  preselectedStyle?: string | null;
  storedSourceImageUrl: string;
};

export type StoredMessengerImageDecision =
  | {
      action: "show_style_picker";
      hadPreviousPhoto: boolean;
      incomingImageUrl: string;
      styleToRun: null;
    }
  | {
      action: "auto_run_preselected_style";
      hadPreviousPhoto: boolean;
      incomingImageUrl: string;
      styleToRun: Style;
    }
  | {
      action: "auto_run_selected_style";
      hadPreviousPhoto: boolean;
      incomingImageUrl: string;
      styleToRun: Style;
    };

export function getStoredMessengerImageDecision(
  input: StoredMessengerImageDecisionInput
): StoredMessengerImageDecision {
  const hadPreviousPhoto = Boolean(input.lastPhotoUrl);
  const selectedStyle = normalizeStyle(input.selectedStyle ?? "") ?? null;
  const preselectedStyle = normalizeStyle(input.preselectedStyle ?? "") ?? null;

  if (preselectedStyle && !hadPreviousPhoto) {
    return {
      action: "auto_run_preselected_style",
      hadPreviousPhoto,
      incomingImageUrl: input.storedSourceImageUrl,
      styleToRun: preselectedStyle,
    };
  }

  if (selectedStyle) {
    return {
      action: "auto_run_selected_style",
      hadPreviousPhoto,
      incomingImageUrl: input.storedSourceImageUrl,
      styleToRun: selectedStyle,
    };
  }

  return {
    action: "show_style_picker",
    hadPreviousPhoto,
    incomingImageUrl: input.storedSourceImageUrl,
    styleToRun: null,
  };
}
