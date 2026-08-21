import * as db from "../db";
import { isMessengerAdmin } from "./messengerAdmin";
import { sendPortalHandoffLink } from "./portalHandoffDelivery";

const PORTAL_REENTRY_TTL_MS = 10 * 60 * 1000;

export type MessengerPortalHandoffResult =
  "sent" | "not_linked" | "unavailable";

export async function requestMessengerPortalHandoff(input: {
  facebookPageId?: string | null;
  messengerSenderId: string;
  messengerSenderUserKey: string;
  requestId: string;
}): Promise<MessengerPortalHandoffResult> {
  const facebookPageId = input.facebookPageId?.trim();
  if (!facebookPageId) return "not_linked";

  let binding: db.PortalHandoffReentryBinding | null;
  try {
    binding = await db.findPortalHandoffReentryBinding({
      facebookPageId,
      messengerSenderUserKey: input.messengerSenderUserKey,
    });
  } catch {
    return "unavailable";
  }
  let workspaceId = binding?.workspaceId;
  let restrictedUserId = binding?.userId ?? null;
  let messageVariant: "portal_reentry" | "admin_onboarding" = "portal_reentry";

  if (!binding) {
    if (
      !isMessengerAdmin(input.messengerSenderId, input.messengerSenderUserKey)
    ) {
      return "not_linked";
    }
    try {
      workspaceId =
        (await db.findUniqueConnectedFacebookWorkspaceId(facebookPageId)) ??
        undefined;
    } catch {
      return "unavailable";
    }
    if (!workspaceId) return "not_linked";
    restrictedUserId = null;
    messageVariant = "admin_onboarding";
  }
  if (!workspaceId) return "not_linked";

  const result = await sendPortalHandoffLink({
    workspaceId,
    messengerSenderUserKey: input.messengerSenderUserKey,
    expectedFacebookPageId: facebookPageId,
    createdByUserId: restrictedUserId,
    ttlMs: PORTAL_REENTRY_TTL_MS,
    deliveryIdempotencyKey: [
      "messenger_portal_reentry_v1",
      workspaceId,
      restrictedUserId ?? "admin-bootstrap",
      input.requestId,
    ].join(":"),
    messageVariant,
  });

  return result.ok ? "sent" : "unavailable";
}
