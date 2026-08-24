import {
  downloadWhatsAppMedia,
  hasAmbiguousWhatsAppDeliveryOutcome,
  hasPreTransportWhatsAppDeliveryOutcome,
} from "./_core/whatsappApi";

export function hasAmbiguousWhatsAppTransportOutcome(error: unknown): boolean {
  return hasAmbiguousWhatsAppDeliveryOutcome(error);
}

export function hasPreTransportWhatsAppTransportOutcome(
  error: unknown
): boolean {
  return hasPreTransportWhatsAppDeliveryOutcome(error);
}

export async function downloadWhatsAppInboundMedia(
  mediaId: string
): Promise<{ buffer: Buffer; contentType: string }> {
  return downloadWhatsAppMedia(mediaId);
}
