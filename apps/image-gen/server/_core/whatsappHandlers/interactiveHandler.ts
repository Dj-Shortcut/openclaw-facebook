import type { NormalizedWhatsAppEvent, WhatsAppHandlerContext } from "../whatsappTypes";
import { handleWhatsAppTextEvent } from "./textHandler";

export async function handleWhatsAppInteractiveEvent(
  event: NormalizedWhatsAppEvent,
  context: WhatsAppHandlerContext
): Promise<void> {
  await handleWhatsAppTextEvent(event, context);
}
