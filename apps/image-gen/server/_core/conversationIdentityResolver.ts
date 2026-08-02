import { and, eq, isNull } from "drizzle-orm";
import { channelConnections } from "../../drizzle/schema";
import { getDatabaseOrThrow } from "../db";
import {
  getConversationIdentityKey,
  type ConversationIdentityKey,
} from "./conversationIdentityConfig";
import {
  ConversationIdentityError,
  revalidateConversationEndpoint,
  resolveConversationSenderId,
  type ConversationEndpoint,
  type ConversationSenderId,
  type MessengerEndpoint,
  type WhatsAppEndpoint,
} from "./conversationEndpoint";
import {
  deriveConversationSubjectV2,
  type ConversationSubjectV2,
} from "./conversationSubject";

type ChannelConnectionStatus =
  | "connected"
  | "missing_permissions"
  | "token_expired"
  | "webhook_unhealthy"
  | "disconnected";

export type ConversationBindingRecord = Readonly<{
  id: number;
  workspaceId: number;
  channel: "facebook_messenger" | "whatsapp" | "web";
  status: ChannelConnectionStatus;
  externalId: string | null;
  providerAccountExternalId: string | null;
}>;

export type MessengerDeliveryTarget = Readonly<{
  channel: "messenger";
  channelConnectionId: number;
  pageId: string;
  senderId: ConversationSenderId;
}>;

export type WhatsAppDeliveryTarget = Readonly<{
  channel: "whatsapp";
  channelConnectionId: number;
  wabaId: string;
  phoneNumberId: string;
  senderId: ConversationSenderId;
}>;

export type ConversationDeliveryTarget =
  MessengerDeliveryTarget | WhatsAppDeliveryTarget;

type DegradedConnectionStatus = Exclude<
  ChannelConnectionStatus,
  "connected" | "disconnected"
>;

export type ResolvedConversationIdentityV2 =
  | Readonly<{
      subject: ConversationSubjectV2;
      delivery: ConversationDeliveryTarget;
      connectionStatus: "connected";
    }>
  | Readonly<{
      subject: ConversationSubjectV2;
      delivery: null;
      connectionStatus: DegradedConnectionStatus;
    }>;

export type ConversationIdentityResolverDeps = Readonly<{
  findBindings: (
    endpoint: ConversationEndpoint
  ) => Promise<readonly ConversationBindingRecord[]>;
  getIdentityKey: () => ConversationIdentityKey;
}>;

function bindingMatchesEndpoint(
  binding: ConversationBindingRecord,
  endpoint: ConversationEndpoint
): boolean {
  if (endpoint.channel === "messenger") {
    return (
      binding.channel === "facebook_messenger" &&
      binding.externalId === endpoint.pageId &&
      binding.providerAccountExternalId === null
    );
  }
  return (
    binding.channel === "whatsapp" &&
    binding.externalId === endpoint.phoneNumberId &&
    binding.providerAccountExternalId === endpoint.wabaId
  );
}

function isUsableOwnershipStatus(
  status: ChannelConnectionStatus
): status is Exclude<ChannelConnectionStatus, "disconnected"> {
  return (
    status === "connected" ||
    status === "missing_permissions" ||
    status === "token_expired" ||
    status === "webhook_unhealthy"
  );
}

function createDeliveryTarget(
  endpoint: ConversationEndpoint,
  channelConnectionId: number,
  senderId: ConversationSenderId
): ConversationDeliveryTarget {
  if (endpoint.channel === "messenger") {
    return Object.freeze({
      channel: "messenger",
      channelConnectionId,
      pageId: endpoint.pageId,
      senderId,
    });
  }
  return Object.freeze({
    channel: "whatsapp",
    channelConnectionId,
    wabaId: endpoint.wabaId,
    phoneNumberId: endpoint.phoneNumberId,
    senderId,
  });
}

export async function resolveConversationIdentityV2WithDeps(
  untrustedEndpoint: ConversationEndpoint,
  untrustedSenderId: unknown,
  deps: ConversationIdentityResolverDeps
): Promise<ResolvedConversationIdentityV2> {
  const endpoint = revalidateConversationEndpoint(untrustedEndpoint);
  const senderId = resolveConversationSenderId(untrustedSenderId);
  let bindings: readonly ConversationBindingRecord[];
  try {
    bindings = await deps.findBindings(endpoint);
  } catch {
    throw new ConversationIdentityError("binding_lookup_failed", true);
  }

  if (bindings.length === 0) {
    throw new ConversationIdentityError("binding_not_found");
  }
  if (bindings.length !== 1) {
    throw new ConversationIdentityError("binding_ambiguous");
  }

  const binding = bindings[0];
  if (!bindingMatchesEndpoint(binding, endpoint)) {
    throw new ConversationIdentityError("binding_lookup_failed");
  }
  if (!isUsableOwnershipStatus(binding.status)) {
    throw new ConversationIdentityError("binding_inactive");
  }

  const subject = deriveConversationSubjectV2({
    workspaceId: binding.workspaceId,
    channelConnectionId: binding.id,
    endpoint,
    senderId,
    key: deps.getIdentityKey(),
  });

  if (binding.status === "connected") {
    return Object.freeze({
      subject,
      delivery: createDeliveryTarget(endpoint, binding.id, senderId),
      connectionStatus: binding.status,
    });
  }

  return Object.freeze({
    subject,
    delivery: null,
    connectionStatus: binding.status,
  });
}

async function findDatabaseBindings(
  endpoint: ConversationEndpoint
): Promise<ConversationBindingRecord[]> {
  const database = await getDatabaseOrThrow();
  const endpointWhere =
    endpoint.channel === "messenger"
      ? and(
          eq(channelConnections.channel, "facebook_messenger"),
          eq(channelConnections.externalId, endpoint.pageId),
          isNull(channelConnections.providerAccountExternalId)
        )
      : and(
          eq(channelConnections.channel, "whatsapp"),
          eq(channelConnections.externalId, endpoint.phoneNumberId),
          eq(channelConnections.providerAccountExternalId, endpoint.wabaId)
        );

  return await database
    .select({
      id: channelConnections.id,
      workspaceId: channelConnections.workspaceId,
      channel: channelConnections.channel,
      status: channelConnections.status,
      externalId: channelConnections.externalId,
      providerAccountExternalId: channelConnections.providerAccountExternalId,
    })
    .from(channelConnections)
    .where(endpointWhere)
    .limit(2);
}

const databaseResolverDeps: ConversationIdentityResolverDeps = {
  findBindings: findDatabaseBindings,
  getIdentityKey: getConversationIdentityKey,
};

export async function resolveConversationIdentityV2(
  endpoint: MessengerEndpoint | WhatsAppEndpoint,
  senderId: unknown
): Promise<ResolvedConversationIdentityV2> {
  return await resolveConversationIdentityV2WithDeps(
    endpoint,
    senderId,
    databaseResolverDeps
  );
}
