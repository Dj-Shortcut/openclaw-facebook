import { and, eq } from "drizzle-orm";
import { channelConnections } from "../../drizzle/schema";
import { getDatabaseOrThrow } from "../db";
import type { CostLedgerTenantScope } from "./costLedger";
import type { WhatsAppEndpoint } from "./conversationEndpoint";
import { resolveConversationIdentityV2 } from "./conversationIdentityResolver";
import {
  admitMessengerPrivacySubjectFromMetaEvent,
  assertMessengerPrivacySubject,
} from "./messengerPrivacySubject";
import { toUserKey } from "./privacy";

export class WhatsAppGenerationScopeError extends Error {
  constructor() {
    super("WhatsApp generation ownership is unavailable");
    this.name = "WhatsAppGenerationScopeError";
  }
}

export type WhatsAppGenerationOwnership = Readonly<
  Omit<CostLedgerTenantScope, "privacyEpoch">
>;

/**
 * Resolves the immutable tenant/binding/privacy tuple used by paid generation.
 * The second, exact binding read is intentional: the generic identity resolver
 * does not expose credentials or the mutable binding epoch.
 */
export async function resolveWhatsAppGenerationScope(input: {
  endpoint: WhatsAppEndpoint;
  senderId: string;
  userKey: string;
  eventOccurredAt: Date;
  allowReactivation?: boolean;
  allowCreation?: boolean;
}): Promise<CostLedgerTenantScope> {
  try {
    const ownership = await resolveWhatsAppGenerationOwnership(input);
    return await admitWhatsAppGenerationScope({
      endpoint: input.endpoint,
      ownership,
      eventOccurredAt: input.eventOccurredAt,
      allowReactivation: input.allowReactivation ?? true,
      allowCreation: input.allowCreation ?? input.allowReactivation ?? true,
    });
  } catch (error) {
    if (error instanceof WhatsAppGenerationScopeError) {
      throw error;
    }
    throw new WhatsAppGenerationScopeError();
  }
}

export async function resolveWhatsAppGenerationOwnership(input: {
  endpoint: WhatsAppEndpoint;
  senderId: string;
  userKey: string;
}): Promise<WhatsAppGenerationOwnership> {
  try {
    return await resolveWhatsAppGenerationOwnershipInternal(input);
  } catch (error) {
    if (error instanceof WhatsAppGenerationScopeError) throw error;
    throw new WhatsAppGenerationScopeError();
  }
}

async function resolveWhatsAppGenerationOwnershipInternal(input: {
  endpoint: WhatsAppEndpoint;
  senderId: string;
  userKey: string;
}): Promise<WhatsAppGenerationOwnership> {
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

  return Object.freeze({
    workspaceId,
    channelConnectionId,
    bindingEpoch: Number(bindingEpoch),
    userKey: expectedUserKey,
  });
}

export async function admitWhatsAppGenerationScope(input: {
  endpoint: WhatsAppEndpoint;
  ownership: WhatsAppGenerationOwnership;
  eventOccurredAt: Date;
  allowReactivation: boolean;
  allowCreation?: boolean;
}): Promise<CostLedgerTenantScope> {
  try {
    return await admitWhatsAppGenerationScopeInternal(input);
  } catch (error) {
    if (error instanceof WhatsAppGenerationScopeError) throw error;
    throw new WhatsAppGenerationScopeError();
  }
}

async function admitWhatsAppGenerationScopeInternal(input: {
  endpoint: WhatsAppEndpoint;
  ownership: WhatsAppGenerationOwnership;
  eventOccurredAt: Date;
  allowReactivation: boolean;
  allowCreation?: boolean;
}): Promise<CostLedgerTenantScope> {
  const privacyEpoch = await admitMessengerPrivacySubjectFromMetaEvent({
    workspaceId: input.ownership.workspaceId,
    channelConnectionId: input.ownership.channelConnectionId,
    userKey: input.ownership.userKey,
    eventOccurredAt: input.eventOccurredAt,
    allowReactivation: input.allowReactivation,
    allowCreation: input.allowCreation,
  });
  if (!Number.isSafeInteger(privacyEpoch) || privacyEpoch <= 0) {
    throw new WhatsAppGenerationScopeError();
  }

  const scope = Object.freeze({
    ...input.ownership,
    privacyEpoch,
  });
  await assertWhatsAppGenerationScopeActive({
    endpoint: input.endpoint,
    scope,
  });
  return scope;
}

/** Rechecks an already-admitted scope without creating or reactivating it. */
export async function assertWhatsAppGenerationScopeActive(input: {
  endpoint: WhatsAppEndpoint;
  scope: CostLedgerTenantScope;
}): Promise<void> {
  try {
    const { scope } = input;
    if (
      !scope.userKey.trim() ||
      !Number.isSafeInteger(scope.workspaceId) ||
      scope.workspaceId <= 0 ||
      !Number.isSafeInteger(scope.channelConnectionId) ||
      scope.channelConnectionId <= 0 ||
      !Number.isSafeInteger(scope.bindingEpoch) ||
      scope.bindingEpoch <= 0 ||
      !Number.isSafeInteger(scope.privacyEpoch) ||
      scope.privacyEpoch <= 0
    ) {
      throw new WhatsAppGenerationScopeError();
    }

    const database = await getDatabaseOrThrow();
    const bindings = await database
      .select({ id: channelConnections.id })
      .from(channelConnections)
      .where(
        and(
          eq(channelConnections.id, scope.channelConnectionId),
          eq(channelConnections.workspaceId, scope.workspaceId),
          eq(channelConnections.channel, "whatsapp"),
          eq(channelConnections.status, "connected"),
          eq(channelConnections.externalId, input.endpoint.phoneNumberId),
          eq(
            channelConnections.providerAccountExternalId,
            input.endpoint.wabaId
          ),
          eq(channelConnections.bindingEpoch, scope.bindingEpoch)
        )
      )
      .limit(2);
    if (bindings.length !== 1) {
      throw new WhatsAppGenerationScopeError();
    }
    await assertMessengerPrivacySubject({
      workspaceId: scope.workspaceId,
      channelConnectionId: scope.channelConnectionId,
      userKey: scope.userKey,
      privacyEpoch: scope.privacyEpoch,
    });
  } catch (error) {
    if (error instanceof WhatsAppGenerationScopeError) throw error;
    throw new WhatsAppGenerationScopeError();
  }
}
