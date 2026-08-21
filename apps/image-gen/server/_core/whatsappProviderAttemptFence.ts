import type { CostLedgerScope } from "./costLedger";
import type { MessengerGenerationJob } from "./messengerGenerationJob";
import {
  finalizeMessengerProviderAttemptFence,
  markMessengerProviderAttemptStarted,
  reserveMessengerProviderAttemptFence,
  type MessengerProviderAttemptFence,
  type MessengerProviderAttemptOutcome,
} from "./messengerProviderAttemptFence";
import {
  getMessengerRequestOwnership,
  getMessengerRequestPageId,
  getMessengerRequestPrivacySubject,
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
  expectedScope?: CostLedgerScope;
}): Promise<MessengerProviderAttemptFence> {
  const pageId = getMessengerRequestPageId();
  const ownership = getMessengerRequestOwnership();
  const privacy = getMessengerRequestPrivacySubject();
  if (!pageId || !ownership || !privacy) {
    if (process.env.NODE_ENV === "production") {
      throw new WhatsAppProviderAttemptFenceError();
    }
    return LOCAL_FENCE;
  }
  if (
    !input.reqId.trim() ||
    !input.providerOperation.trim() ||
    privacy.userKey !== input.userKey ||
    (input.expectedScope &&
      (input.expectedScope.workspaceId !== ownership.workspaceId ||
        input.expectedScope.channelConnectionId !==
          ownership.channelConnectionId ||
        input.expectedScope.bindingEpoch !== ownership.bindingEpoch ||
        input.expectedScope.privacyEpoch !== privacy.privacyEpoch))
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
