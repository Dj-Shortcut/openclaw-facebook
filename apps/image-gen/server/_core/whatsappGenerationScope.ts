import { and, eq } from "drizzle-orm";
import { channelConnections } from "../../drizzle/schema";
import { getDatabaseOrThrow } from "../db";
import type { CostLedgerTenantScope } from "./costLedger";
import {
  ConversationIdentityError,
  type WhatsAppEndpoint,
} from "./conversationEndpoint";
import { resolveConversationIdentityV2 } from "./conversationIdentityResolver";
import { safeLog } from "./logger";
import {
  admitMessengerPrivacySubjectFromMetaEvent,
  assertMessengerPrivacySubject,
  MessengerPrivacyFenceError,
} from "./messengerPrivacySubject";
import { toUserKey } from "./privacy";

export class WhatsAppGenerationScopeError extends Error {
  readonly retryable: boolean;

  constructor(options?: { retryable?: boolean }) {
    super("WhatsApp generation ownership is unavailable");
    this.name = "WhatsAppGenerationScopeError";
    this.retryable = options?.retryable === true;
  }
}

function classifyWhatsAppGenerationScopeError(
  error: unknown
): WhatsAppGenerationScopeError {
  if (error instanceof WhatsAppGenerationScopeError) {
    return error;
  }
  if (error instanceof ConversationIdentityError) {
    return new WhatsAppGenerationScopeError({ retryable: error.retryable });
  }
  if (error instanceof MessengerPrivacyFenceError) {
    return new WhatsAppGenerationScopeError();
  }
  // Unexpected database/driver failures are retryable. Explicit ownership,
  // binding and privacy mismatches above remain terminal and fail closed.
  return new WhatsAppGenerationScopeError({ retryable: true });
}

function logWhatsAppGenerationScopeFailure(
  stage: "resolve" | "ownership" | "admission" | "recheck",
  error: unknown
): void {
  if (error instanceof WhatsAppGenerationScopeError) return;
  safeLog("whatsapp_generation_scope_denied", {
    level: "warn",
    stage,
    error: error instanceof Error ? error.name : "unknown_error",
  });
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
    logWhatsAppGenerationScopeFailure("resolve", error);
    throw classifyWhatsAppGenerationScopeError(error);
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
    logWhatsAppGenerationScopeFailure("ownership", error);
    throw classifyWhatsAppGenerationScopeError(error);
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
    logWhatsAppGenerationScopeFailure("admission", error);
    throw classifyWhatsAppGenerationScopeError(error);
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
    logWhatsAppGenerationScopeFailure("recheck", error);
    throw classifyWhatsAppGenerationScopeError(error);
  }
}
