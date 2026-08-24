import type { CostLedgerTenantScope } from "./costLedger";
import type { MessengerGenerationJob } from "./messengerGenerationJob";
import {
  claimWhatsAppErasureControlProviderAttemptFence as claimSharedWhatsAppErasureControlProviderAttemptFence,
  finalizeMessengerProviderAttemptFence,
  markMessengerProviderAttemptStarted,
  reserveMessengerProviderAttemptFence,
  WHATSAPP_ERASURE_CONTROL_PROVIDER_OPERATION,
  type MessengerProviderAttemptFence,
  type MessengerProviderAttemptOutcome,
} from "./messengerProviderAttemptFence";
import {
  getMessengerRequestErasurePrivacySubject,
  getMessengerRequestOwnership,
  getMessengerRequestPageId,
  getMessengerRequestPrivacySubject,
  getMessengerRequestChannel,
  isMessengerErasureControlDelivery,
} from "./messengerRequestContext";

const LOCAL_FENCE: MessengerProviderAttemptFence = Object.freeze({
  leaseToken: null,
  attemptKeyHash: null,
});

export class WhatsAppProviderAttemptFenceError extends Error {
  constructor() {
    super("WhatsApp provider attempt ownership is unavailable");
    this.name = "WhatsAppProviderAttemptFenceError";
  }
}

export type WhatsAppErasureControlProviderAttemptClaim =
  | Readonly<{ kind: "owned"; fence: MessengerProviderAttemptFence }>
  | Readonly<{ kind: "succeeded"; attemptKeyHash: string }>
  | Readonly<{ kind: "ambiguous"; attemptKeyHash: string }>;

/**
 * Pins an outbound WhatsApp disclosure to the immutable inbound tenant,
 * connection, binding and privacy epoch. The underlying durable fence is
 * shared with Messenger so disconnect and privacy erasure have one linear
 * transport barrier for every Meta channel.
 */
export async function reserveWhatsAppProviderAttemptFence(input: {
  reqId: string;
  userKey: string;
  providerOperation: string;
  expectedScope?: CostLedgerTenantScope;
}): Promise<MessengerProviderAttemptFence> {
  const pageId = getMessengerRequestPageId();
  const requestChannel = getMessengerRequestChannel();
  const ownership = getMessengerRequestOwnership();
  const privacy = getMessengerRequestPrivacySubject();
  const hasAnyRequestScope = Boolean(
    pageId || requestChannel || ownership || privacy
  );
  if (!pageId || !ownership || requestChannel !== "whatsapp" || !privacy) {
    if (process.env.NODE_ENV === "production" || hasAnyRequestScope) {
      throw new WhatsAppProviderAttemptFenceError();
    }
    return LOCAL_FENCE;
  }
  if (
    !input.reqId.trim() ||
    !input.providerOperation.trim() ||
    privacy.userKey !== input.userKey ||
    (input.expectedScope &&
      (input.expectedScope.userKey !== input.userKey ||
        input.expectedScope.workspaceId !== ownership.workspaceId ||
        input.expectedScope.channelConnectionId !==
          ownership.channelConnectionId ||
        input.expectedScope.bindingEpoch !== ownership.bindingEpoch ||
        input.expectedScope.privacyEpoch !== privacy.privacyEpoch))
  ) {
    throw new WhatsAppProviderAttemptFenceError();
  }

  if (
    isMessengerErasureControlDelivery() ||
    input.providerOperation === WHATSAPP_ERASURE_CONTROL_PROVIDER_OPERATION
  ) {
    throw new WhatsAppProviderAttemptFenceError();
  }

  const job: MessengerGenerationJob = {
    psid: input.userKey,
    userId: input.userKey,
    pageId,
    workspaceId: ownership.workspaceId,
    channelConnectionId: ownership.channelConnectionId,
    bindingEpoch: ownership.bindingEpoch,
    privacyEpoch: privacy.privacyEpoch,
    reqId: input.reqId,
    lang: "nl",
  };
  return reserveMessengerProviderAttemptFence(
    job,
    input.providerOperation,
    1,
    new Date(),
    "whatsapp"
  );
}

export async function claimWhatsAppErasureControlProviderAttempt(input: {
  reqId: string;
  userKey: string;
}): Promise<WhatsAppErasureControlProviderAttemptClaim> {
  const pageId = getMessengerRequestPageId();
  const requestChannel = getMessengerRequestChannel();
  const ownership = getMessengerRequestOwnership();
  const privacy = getMessengerRequestPrivacySubject();
  const erasure = getMessengerRequestErasurePrivacySubject();
  if (
    !pageId ||
    !ownership ||
    requestChannel !== "whatsapp" ||
    !privacy ||
    !erasure ||
    !isMessengerErasureControlDelivery() ||
    !input.reqId.trim() ||
    privacy.userKey !== input.userKey ||
    erasure.userKey !== input.userKey ||
    erasure.privacyEpoch !== privacy.privacyEpoch
  ) {
    throw new WhatsAppProviderAttemptFenceError();
  }

  const claim = await claimSharedWhatsAppErasureControlProviderAttemptFence(
    {
      psid: input.userKey,
      userId: input.userKey,
      pageId,
      workspaceId: ownership.workspaceId,
      channelConnectionId: ownership.channelConnectionId,
      bindingEpoch: ownership.bindingEpoch,
      privacyEpoch: erasure.privacyEpoch,
      reqId: input.reqId,
      lang: "nl",
    },
    new Date()
  );
  if (claim.kind === "owned") return claim;
  if (
    claim.kind === "unsafe_or_done" &&
    claim.attemptKeyHash &&
    claim.status === "succeeded"
  ) {
    return { kind: "succeeded", attemptKeyHash: claim.attemptKeyHash };
  }
  if (
    claim.kind === "unsafe_or_done" &&
    claim.attemptKeyHash &&
    (claim.status === "started" || claim.status === "ambiguous")
  ) {
    return { kind: "ambiguous", attemptKeyHash: claim.attemptKeyHash };
  }
  throw new WhatsAppProviderAttemptFenceError();
}

export async function markWhatsAppProviderAttemptStarted(
  fence: MessengerProviderAttemptFence
): Promise<void> {
  await markMessengerProviderAttemptStarted(fence);
}

export async function finalizeWhatsAppProviderAttemptFence(
  fence: MessengerProviderAttemptFence,
  outcome: MessengerProviderAttemptOutcome
): Promise<void> {
  await finalizeMessengerProviderAttemptFence(fence, outcome);
}

export type { MessengerProviderAttemptFence as WhatsAppProviderAttemptFence };
