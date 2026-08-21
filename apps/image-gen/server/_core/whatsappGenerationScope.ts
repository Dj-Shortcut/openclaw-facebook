import { and, eq } from "drizzle-orm";
import { channelConnections } from "../../drizzle/schema";
import { getDatabaseOrThrow } from "../db";
import type { CostLedgerScope } from "./costLedger";
import type { WhatsAppEndpoint } from "./conversationEndpoint";
import { resolveConversationIdentityV2 } from "./conversationIdentityResolver";
import { ensureActiveMessengerPrivacySubject } from "./messengerPrivacySubject";
import { toUserKey } from "./privacy";

export class WhatsAppGenerationScopeError extends Error {
  constructor() {
    super("WhatsApp generation ownership is unavailable");
    this.name = "WhatsAppGenerationScopeError";
  }
}

/**
 * Resolves the immutable tenant/binding/privacy tuple used by paid generation.
 * The second, exact binding read is intentional: the generic identity resolver
 * does not expose credentials or the mutable binding epoch.
 */
export async function resolveWhatsAppGenerationScope(input: {
  endpoint: WhatsAppEndpoint;
  senderId: string;
  userKey: string;
}): Promise<CostLedgerScope> {
  try {
    return await resolveWhatsAppGenerationScopeInternal(input);
  } catch (error) {
    if (error instanceof WhatsAppGenerationScopeError) {
      throw error;
    }
    throw new WhatsAppGenerationScopeError();
  }
}

async function resolveWhatsAppGenerationScopeInternal(input: {
  endpoint: WhatsAppEndpoint;
  senderId: string;
  userKey: string;
}): Promise<CostLedgerScope> {
  const expectedUserKey = toUserKey(input.senderId);
  if (input.userKey !== expectedUserKey) {
    throw new WhatsAppGenerationScopeError();
  }

  const identity = await resolveConversationIdentityV2(
    input.endpoint,
    input.senderId
  );
  if (
    identity.connectionStatus !== "connected" ||
    identity.delivery?.channel !== "whatsapp"
  ) {
    throw new WhatsAppGenerationScopeError();
  }

  const workspaceId = Number(identity.subject.workspaceId);
  const channelConnectionId = identity.delivery.channelConnectionId;
  const database = await getDatabaseOrThrow();
  const bindings = await database
    .select({ bindingEpoch: channelConnections.bindingEpoch })
    .from(channelConnections)
    .where(
      and(
        eq(channelConnections.id, channelConnectionId),
        eq(channelConnections.workspaceId, workspaceId),
        eq(channelConnections.channel, "whatsapp"),
        eq(channelConnections.status, "connected"),
        eq(channelConnections.externalId, input.endpoint.phoneNumberId),
        eq(channelConnections.providerAccountExternalId, input.endpoint.wabaId)
      )
    )
    .limit(2);
  const bindingEpoch = bindings[0]?.bindingEpoch;
  if (
    bindings.length !== 1 ||
    !Number.isSafeInteger(bindingEpoch) ||
    Number(bindingEpoch) <= 0
  ) {
    throw new WhatsAppGenerationScopeError();
  }

  const privacyEpoch = await ensureActiveMessengerPrivacySubject({
    workspaceId,
    channelConnectionId,
    userKey: expectedUserKey,
  });
  if (!Number.isSafeInteger(privacyEpoch) || privacyEpoch <= 0) {
    throw new WhatsAppGenerationScopeError();
  }

  return Object.freeze({
    workspaceId,
    channelConnectionId,
    bindingEpoch: Number(bindingEpoch),
    privacyEpoch,
  });
}
