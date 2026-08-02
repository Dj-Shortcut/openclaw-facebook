import type {
  ConversationIdentityKey,
  ConversationScopeKeyId,
} from "./conversationIdentityConfig";
import {
  ConversationIdentityError,
  revalidateConversationEndpoint,
  resolveConversationSenderId,
  type ConversationEndpoint,
} from "./conversationEndpoint";

const CANONICAL_MAGIC = Buffer.from(
  "leaderbot.conversation.identity\0",
  "ascii"
);
const IDENTITY_VERSION = 2;
const MAX_DATABASE_ID = 2_147_483_647;

declare const workspaceIdBrand: unique symbol;
declare const channelConnectionIdBrand: unique symbol;
declare const tenantKeyV2Brand: unique symbol;
declare const bindingKeyV2Brand: unique symbol;
declare const conversationUserKeyV2Brand: unique symbol;

export type WorkspaceId = number & { readonly [workspaceIdBrand]: true };
export type ChannelConnectionId = number & {
  readonly [channelConnectionIdBrand]: true;
};
export type TenantKeyV2 = string & { readonly [tenantKeyV2Brand]: true };
export type BindingKeyV2 = string & { readonly [bindingKeyV2Brand]: true };
export type ConversationUserKeyV2 = string & {
  readonly [conversationUserKeyV2Brand]: true;
};

export type ConversationSubjectV2 = Readonly<{
  version: 2;
  keyId: ConversationScopeKeyId;
  workspaceId: WorkspaceId;
  channel: "messenger" | "whatsapp";
  channelConnectionId: ChannelConnectionId;
  tenantKey: TenantKeyV2;
  bindingKey: BindingKeyV2;
  userKey: ConversationUserKeyV2;
}>;

type CanonicalField = Readonly<{ tag: number; value: Uint8Array }>;

function parseDatabaseId(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_DATABASE_ID
  ) {
    throw new ConversationIdentityError("invalid_input");
  }
  return value;
}

function encodeUint64(value: number): Buffer {
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64BE(BigInt(value));
  return encoded;
}

function encodeLength(length: number): Buffer {
  const encoded = Buffer.alloc(4);
  encoded.writeUInt32BE(length);
  return encoded;
}

function encodeCanonicalInput(
  purpose: 1 | 2 | 3,
  keyId: ConversationScopeKeyId,
  fields: readonly CanonicalField[]
): Buffer {
  const keyIdBytes = Buffer.from(keyId, "utf8");
  const chunks: Buffer[] = [
    CANONICAL_MAGIC,
    Buffer.from([IDENTITY_VERSION, purpose]),
    encodeLength(keyIdBytes.length),
    keyIdBytes,
  ];

  let previousTag = 0;
  for (const field of fields) {
    if (
      !Number.isInteger(field.tag) ||
      field.tag <= previousTag ||
      field.tag > 255
    ) {
      throw new ConversationIdentityError("invalid_input");
    }
    previousTag = field.tag;
    const value = Buffer.from(field.value);
    chunks.push(Buffer.from([field.tag]), encodeLength(value.length), value);
  }

  return Buffer.concat(chunks);
}

function signCanonicalInput(
  key: ConversationIdentityKey,
  purpose: 1 | 2 | 3,
  fields: readonly CanonicalField[]
): Buffer {
  const digest = key.sign(encodeCanonicalInput(purpose, key.keyId, fields));
  if (!Buffer.isBuffer(digest) || digest.length !== 32) {
    throw new ConversationIdentityError("invalid_input");
  }
  return digest;
}

function formatOpaqueKey(
  prefix: "t2" | "b2" | "u2",
  keyId: ConversationScopeKeyId,
  digest: Buffer
): string {
  return `${prefix}.${keyId}.${digest.toString("hex")}`;
}

function channelByte(channel: "messenger" | "whatsapp"): Buffer {
  return Buffer.from([channel === "messenger" ? 1 : 2]);
}

export function deriveConversationSubjectV2(input: {
  workspaceId: unknown;
  channelConnectionId: unknown;
  endpoint: ConversationEndpoint;
  senderId: unknown;
  key: ConversationIdentityKey;
}): ConversationSubjectV2 {
  const workspaceId = parseDatabaseId(input.workspaceId) as WorkspaceId;
  const channelConnectionId = parseDatabaseId(
    input.channelConnectionId
  ) as ChannelConnectionId;
  const endpoint = revalidateConversationEndpoint(input.endpoint);
  const senderId = resolveConversationSenderId(input.senderId);
  const workspaceBytes = encodeUint64(workspaceId);
  const connectionBytes = encodeUint64(channelConnectionId);
  const channel = channelByte(endpoint.channel);

  const tenantDigest = signCanonicalInput(input.key, 1, [
    { tag: 1, value: workspaceBytes },
  ]);
  const bindingFields: CanonicalField[] = [
    { tag: 1, value: workspaceBytes },
    { tag: 2, value: channel },
    { tag: 3, value: connectionBytes },
  ];
  if (endpoint.channel === "messenger") {
    bindingFields.push({
      tag: 4,
      value: Buffer.from(endpoint.pageId, "ascii"),
    });
  } else {
    bindingFields.push(
      { tag: 4, value: Buffer.from(endpoint.wabaId, "ascii") },
      { tag: 5, value: Buffer.from(endpoint.phoneNumberId, "ascii") }
    );
  }
  const bindingDigest = signCanonicalInput(input.key, 2, bindingFields);
  const userDigest = signCanonicalInput(input.key, 3, [
    { tag: 1, value: workspaceBytes },
    { tag: 2, value: channel },
    { tag: 3, value: connectionBytes },
    { tag: 4, value: bindingDigest },
    { tag: 5, value: Buffer.from(senderId, "ascii") },
  ]);

  return Object.freeze({
    version: 2,
    keyId: input.key.keyId,
    workspaceId,
    channel: endpoint.channel,
    channelConnectionId,
    tenantKey: formatOpaqueKey(
      "t2",
      input.key.keyId,
      tenantDigest
    ) as TenantKeyV2,
    bindingKey: formatOpaqueKey(
      "b2",
      input.key.keyId,
      bindingDigest
    ) as BindingKeyV2,
    userKey: formatOpaqueKey(
      "u2",
      input.key.keyId,
      userDigest
    ) as ConversationUserKeyV2,
  });
}
