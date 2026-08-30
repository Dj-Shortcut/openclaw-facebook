import { setLastUserMessageAt } from "./messengerState";
import type { InboundEventClassification } from "./messengerInboundClassification";
import type { FacebookWebhookEvent } from "./webhookHelpers";

export async function recordInboundUserActivity(
  psid: string,
  event: FacebookWebhookEvent,
  classification: InboundEventClassification,
  options: {
    entryId?: string;
    now?: number;
    allowPaidRecovery?: boolean;
  } = {}
): Promise<void> {
  if (!classification.isInboundUserEvent) return;
  const timestamp = event.timestamp;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return;
  await setLastUserMessageAt(psid, timestamp);

}
