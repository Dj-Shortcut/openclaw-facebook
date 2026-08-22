import { createHash } from "node:crypto";
import {
  setLastPaidHandoffEligibleAt,
  setLastUserMessageAt,
} from "./messengerState";
import type { InboundEventClassification } from "./messengerInboundClassification";
import type { FacebookWebhookEvent } from "./webhookHelpers";
import { getMessengerRequestPageId } from "./messengerRequestContext";
import { toUserKey } from "./privacy";
import { rearmFailedPortalHandoffAfterInbound } from "./billing/portalHandoffRecovery";
import { getEventDedupeKey } from "./webhookHelpers";

const RECOVERY_EVENT_MAX_AGE_MS = 5 * 60 * 1000;
const RECOVERY_EVENT_MAX_FUTURE_SKEW_MS = 60 * 1000;

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

  if (options.allowPaidRecovery !== true) return;
  const isAllowlistedNormalMessage = Boolean(
    event.message &&
    !event.message.is_echo &&
    !event.message.quick_reply?.payload &&
    !event.postback &&
    (event.message.text?.trim() || event.message.attachments?.length)
  );
  if (!isAllowlistedNormalMessage) return;
  const now = options.now ?? Date.now();

  const facebookPageId = getMessengerRequestPageId();
  const recipientPageId = event.recipient?.id?.trim();
  const dedupeKey = getEventDedupeKey(event, toUserKey(psid), options.entryId);
  if (
    !facebookPageId ||
    recipientPageId !== facebookPageId ||
    classification.isPrivacyOrConsentControl ||
    !dedupeKey ||
    timestamp < now - RECOVERY_EVENT_MAX_AGE_MS ||
    timestamp > now + RECOVERY_EVENT_MAX_FUTURE_SKEW_MS
  ) {
    return;
  }

  await setLastPaidHandoffEligibleAt(psid, timestamp);

  await rearmFailedPortalHandoffAfterInbound({
    facebookPageId,
    messengerSenderUserKey: toUserKey(psid),
    eventIdHash: createHash("sha256").update(dedupeKey).digest("hex"),
    eventTimestamp: new Date(timestamp),
    source: "verified_messenger_inbound",
  });
}
