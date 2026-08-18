import { setLastUserMessageAt } from "./messengerState";
import type { InboundEventClassification } from "./messengerInboundClassification";
import type { FacebookWebhookEvent } from "./webhookHelpers";
import { getMessengerRequestPageId } from "./messengerRequestContext";
import { toUserKey } from "./privacy";
import { rearmFailedPortalHandoffAfterInbound } from "./billing/portalHandoffRecovery";

export async function recordInboundUserActivity(
  psid: string,
  event: FacebookWebhookEvent,
  classification: InboundEventClassification
): Promise<void> {
  if (classification.isInboundUserEvent) {
    await setLastUserMessageAt(psid, event.timestamp ?? Date.now());
    const facebookPageId = getMessengerRequestPageId();
    if (facebookPageId) {
      await rearmFailedPortalHandoffAfterInbound({
        facebookPageId,
        messengerSenderUserKey: toUserKey(psid),
      });
    }
  }
}
