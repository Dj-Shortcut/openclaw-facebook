import { setLastUserMessageAt } from "./messengerState";
import type { InboundEventClassification } from "./messengerInboundClassification";
import type { FacebookWebhookEvent } from "./webhookHelpers";

export async function recordInboundUserActivity(
  psid: string,
  event: FacebookWebhookEvent,
  classification: InboundEventClassification
): Promise<void> {
  if (classification.isInboundUserEvent) {
    await setLastUserMessageAt(psid, event.timestamp ?? Date.now());
  }
}
