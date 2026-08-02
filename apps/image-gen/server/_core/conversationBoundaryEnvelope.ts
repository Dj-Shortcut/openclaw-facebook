import { createHash, timingSafeEqual } from "node:crypto";
import {
  getConversationIdentityKey,
  type ConversationIdentityKey,
  type ConversationScopeKeyId,
} from "./conversationIdentityConfig";
import {
  ConversationIdentityError,
  revalidateConversationEndpoint,
  resolveConversationSenderId,
  type ConversationEndpoint,
  type ConversationSenderId,
} from "./conversationEndpoint";
import {
  resolveConversationIdentityV2,
  type ConversationDeliveryTarget,
  type ResolvedConversationIdentityV2,
} from "./conversationIdentityResolver";
import {
  deriveConversationSubjectV2,
  type BindingKeyV2,
  type ChannelConnectionId,
  type ConversationSubjectV2,
  type ConversationUserKeyV2,
  type TenantKeyV2,
  type WorkspaceId,
} from "./conversationSubject";

const BOUNDARY_MAGIC = Buffer.from(
  "leaderbot.conversation.boundary\0",
  "ascii"
);
const BOUNDARY_VERSION = 2;
const MAX_DATABASE_ID = 2_147_483_647;
const KEY_ID_PATTERN = /^k[1-9][0-9]{0,5}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const ENVELOPE_KEYS = Object.freeze([
  "authenticationTag",
  "bindingKey",
  "channel",
  "channelConnectionId",
  "keyId",
  "payloadKind",
  "tenantKey",
  "userKey",
  "version",
  "workspaceId",
] as const);

declare const conversationBoundaryAuthenticationTagBrand: unique symbol;
const verifiedConversationBoundaryBrand: unique symbol = Symbol(
  "verifiedConversationBoundaryV2"
);
const verifiedConversationBoundaries = new WeakSet<object>();
const verifiedQueuedConversationBoundaryBrand: unique symbol = Symbol(
  "verifiedQueuedConversationBoundaryV2"
);
const verifiedQueuedConversationBoundaries = new WeakSet<object>();

export type ConversationBoundaryAuthenticationTagV2 = string & {
  readonly [conversationBoundaryAuthenticationTagBrand]: true;
};

export type ConversationBoundaryPayloadKindV2 =
  "meta_messenger_event" | "meta_whatsapp_message";

export type ConversationBoundaryEnvelopeV2 = Readonly<{
  version: 2;
  keyId: ConversationScopeKeyId;
  payloadKind: ConversationBoundaryPayloadKindV2;
  workspaceId: WorkspaceId;
  channel: "messenger" | "whatsapp";
  channelConnectionId: ChannelConnectionId;
  tenantKey: TenantKeyV2;
  bindingKey: BindingKeyV2;
  userKey: ConversationUserKeyV2;
  authenticationTag: ConversationBoundaryAuthenticationTagV2;
}>;

export type ConversationBoundaryEnvelopeErrorCode =
  | "invalid_envelope"
  | "key_configuration_unavailable"
  | "key_id_unknown"
  | "authentication_failed"
  | "payload_kind_mismatch"
  | "scope_mismatch"
  | "identity_unavailable"
  | "identity_mismatch"
  | "binding_stale"
  | "binding_reassigned"
  | "binding_ambiguous"
  | "binding_inactive"
  | "delivery_unavailable";

export class ConversationBoundaryEnvelopeError extends Error {
  readonly code: ConversationBoundaryEnvelopeErrorCode;
  readonly retryable: boolean;

  constructor(code: ConversationBoundaryEnvelopeErrorCode, retryable = false) {
    super("Conversation boundary is unavailable");
    this.name = "ConversationBoundaryEnvelopeError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type ConversationBoundaryVerifierDeps = Readonly<{
  getIdentityKey: () => ConversationIdentityKey;
  resolveIdentity: (
    endpoint: ConversationEndpoint,
    senderId: ConversationSenderId
  ) => Promise<ResolvedConversationIdentityV2>;
}>;

export type VerifiedConversationBoundaryV2 = Readonly<{
  envelope: ConversationBoundaryEnvelopeV2;
  identity: ResolvedConversationIdentityV2;
  [verifiedConversationBoundaryBrand]: true;
}>;

export type VerifiedQueuedConversationBoundaryV2 =
  VerifiedConversationBoundaryV2 &
    Readonly<{
      [verifiedQueuedConversationBoundaryBrand]: true;
    }>;

export type ConversationBoundaryScopeV2 = Readonly<{
  tenantKey: TenantKeyV2;
  bindingKey: BindingKeyV2;
}>;

type ParsedSubjectFields = Readonly<{
  version: 2;
  keyId: ConversationScopeKeyId;
  workspaceId: WorkspaceId;
  channel: "messenger" | "whatsapp";
  channelConnectionId: ChannelConnectionId;
  tenantKey: TenantKeyV2;
  tenantDigest: Buffer;
  bindingKey: BindingKeyV2;
  bindingDigest: Buffer;
  userKey: ConversationUserKeyV2;
  userDigest: Buffer;
}>;

function invalidEnvelope(): never {
  throw new ConversationBoundaryEnvelopeError("invalid_envelope");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactEnvelopeKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === ENVELOPE_KEYS.length &&
    keys.every((key, index) => key === ENVELOPE_KEYS[index])
  );
}

function parseDatabaseId(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_DATABASE_ID
  ) {
    invalidEnvelope();
  }
  return value;
}

function parseKeyId(value: unknown): ConversationScopeKeyId {
  if (typeof value !== "string" || !KEY_ID_PATTERN.test(value)) {
    invalidEnvelope();
  }
  return value as ConversationScopeKeyId;
}

function parsePayloadKind(
  value: unknown,
  channel: "messenger" | "whatsapp"
): ConversationBoundaryPayloadKindV2 {
  if (
    (channel === "messenger" && value !== "meta_messenger_event") ||
    (channel === "whatsapp" && value !== "meta_whatsapp_message")
  ) {
    invalidEnvelope();
  }
  return value as ConversationBoundaryPayloadKindV2;
}

function parseOpaqueKey(
  value: unknown,
  prefix: "t2" | "b2" | "u2" | "e2",
  keyId: ConversationScopeKeyId
): Readonly<{ value: string; digest: Buffer }> {
  if (typeof value !== "string") {
    invalidEnvelope();
  }
  const expectedPrefix = `${prefix}.${keyId}.`;
  if (!value.startsWith(expectedPrefix)) {
    invalidEnvelope();
  }
  const digestHex = value.slice(expectedPrefix.length);
  if (!SHA256_HEX_PATTERN.test(digestHex)) {
    invalidEnvelope();
  }
  return Object.freeze({
    value,
    digest: Buffer.from(digestHex, "hex"),
  });
}

function parseSubjectFields(
  value: Record<string, unknown>
): ParsedSubjectFields {
  if (value.version !== BOUNDARY_VERSION) {
    invalidEnvelope();
  }
  const keyId = parseKeyId(value.keyId);
  const workspaceId = parseDatabaseId(value.workspaceId) as WorkspaceId;
  const channelConnectionId = parseDatabaseId(
    value.channelConnectionId
  ) as ChannelConnectionId;
  if (value.channel !== "messenger" && value.channel !== "whatsapp") {
    invalidEnvelope();
  }
  const tenant = parseOpaqueKey(value.tenantKey, "t2", keyId);
  const binding = parseOpaqueKey(value.bindingKey, "b2", keyId);
  const user = parseOpaqueKey(value.userKey, "u2", keyId);

  return Object.freeze({
    version: BOUNDARY_VERSION,
    keyId,
    workspaceId,
    channel: value.channel,
    channelConnectionId,
    tenantKey: tenant.value as TenantKeyV2,
    tenantDigest: tenant.digest,
    bindingKey: binding.value as BindingKeyV2,
    bindingDigest: binding.digest,
    userKey: user.value as ConversationUserKeyV2,
    userDigest: user.digest,
  });
}

function parseAuthenticationTag(
  value: unknown,
  keyId: ConversationScopeKeyId
): Readonly<{
  value: ConversationBoundaryAuthenticationTagV2;
  digest: Buffer;
}> {
  const parsed = parseOpaqueKey(value, "e2", keyId);
  return Object.freeze({
    value: parsed.value as ConversationBoundaryAuthenticationTagV2,
    digest: parsed.digest,
  });
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

function encodeField(tag: number, value: Uint8Array): Buffer[] {
  const bytes = Buffer.from(value);
  return [Buffer.from([tag]), encodeLength(bytes.length), bytes];
}

function encodeBoundaryAuthenticationInput(
  subject: ParsedSubjectFields,
  payloadKind: ConversationBoundaryPayloadKindV2,
  payload: Uint8Array
): Buffer {
  const keyIdBytes = Buffer.from(subject.keyId, "utf8");
  const payloadDigest = createHash("sha256").update(payload).digest();
  return Buffer.concat([
    BOUNDARY_MAGIC,
    Buffer.from([BOUNDARY_VERSION]),
    encodeLength(keyIdBytes.length),
    keyIdBytes,
    ...encodeField(
      1,
      Buffer.from([payloadKind === "meta_messenger_event" ? 1 : 2])
    ),
    ...encodeField(2, encodeUint64(subject.workspaceId)),
    ...encodeField(3, Buffer.from([subject.channel === "messenger" ? 1 : 2])),
    ...encodeField(4, encodeUint64(subject.channelConnectionId)),
    ...encodeField(5, subject.tenantDigest),
    ...encodeField(6, subject.bindingDigest),
    ...encodeField(7, subject.userDigest),
    ...encodeField(8, payloadDigest),
  ]);
}

function signBoundary(
  subject: ParsedSubjectFields,
  payloadKind: ConversationBoundaryPayloadKindV2,
  payload: Uint8Array,
  key: ConversationIdentityKey
): Buffer {
  const digest = key.sign(
    encodeBoundaryAuthenticationInput(
      subject,
      payloadKind,
      Buffer.from(payload)
    )
  );
  if (!Buffer.isBuffer(digest) || digest.length !== 32) {
    invalidEnvelope();
  }
  return digest;
}

function parsePayload(value: unknown): Buffer {
  if (!(value instanceof Uint8Array)) {
    invalidEnvelope();
  }
  return Buffer.from(value);
}

function parseTrustedSubject(
  subject: ConversationSubjectV2
): ParsedSubjectFields {
  if (!isRecord(subject)) {
    invalidEnvelope();
  }
  return parseSubjectFields(subject);
}

function formatAuthenticationTag(
  keyId: ConversationScopeKeyId,
  digest: Buffer
): ConversationBoundaryAuthenticationTagV2 {
  return `e2.${keyId}.${digest.toString("hex")}` as ConversationBoundaryAuthenticationTagV2;
}

export function createConversationBoundaryEnvelopeV2WithKey(input: {
  subject: ConversationSubjectV2;
  payloadKind: ConversationBoundaryPayloadKindV2;
  endpoint: ConversationEndpoint;
  senderId: unknown;
  payload: Uint8Array;
  key: ConversationIdentityKey;
}): ConversationBoundaryEnvelopeV2 {
  const subject = parseTrustedSubject(input.subject);
  if (subject.keyId !== input.key.keyId) {
    invalidEnvelope();
  }
  const payloadKind = parsePayloadKind(input.payloadKind, subject.channel);
  let derivedSubject: ParsedSubjectFields;
  try {
    derivedSubject = parseTrustedSubject(
      deriveConversationSubjectV2({
        workspaceId: subject.workspaceId,
        channelConnectionId: subject.channelConnectionId,
        endpoint: revalidateConversationEndpoint(input.endpoint),
        senderId: resolveConversationSenderId(input.senderId),
        key: input.key,
      })
    );
  } catch {
    invalidEnvelope();
  }
  if (!subjectsMatch(subject, derivedSubject)) {
    invalidEnvelope();
  }
  const payload = parsePayload(input.payload);
  const authenticationTag = formatAuthenticationTag(
    subject.keyId,
    signBoundary(subject, payloadKind, payload, input.key)
  );

  return Object.freeze({
    version: subject.version,
    keyId: subject.keyId,
    payloadKind,
    workspaceId: subject.workspaceId,
    channel: subject.channel,
    channelConnectionId: subject.channelConnectionId,
    tenantKey: subject.tenantKey,
    bindingKey: subject.bindingKey,
    userKey: subject.userKey,
    authenticationTag,
  });
}

export function createConversationBoundaryEnvelopeV2(input: {
  subject: ConversationSubjectV2;
  payloadKind: ConversationBoundaryPayloadKindV2;
  endpoint: ConversationEndpoint;
  senderId: unknown;
  payload: Uint8Array;
}): ConversationBoundaryEnvelopeV2 {
  return createConversationBoundaryEnvelopeV2WithKey({
    ...input,
    key: getConversationIdentityKey(),
  });
}

function parseConversationBoundaryEnvelopeV2Internal(
  value: unknown
): ConversationBoundaryEnvelopeV2 {
  if (!isRecord(value) || !hasExactEnvelopeKeys(value)) {
    invalidEnvelope();
  }
  const subject = parseSubjectFields(value);
  const payloadKind = parsePayloadKind(value.payloadKind, subject.channel);
  const authenticationTag = parseAuthenticationTag(
    value.authenticationTag,
    subject.keyId
  );

  return Object.freeze({
    version: subject.version,
    keyId: subject.keyId,
    payloadKind,
    workspaceId: subject.workspaceId,
    channel: subject.channel,
    channelConnectionId: subject.channelConnectionId,
    tenantKey: subject.tenantKey,
    bindingKey: subject.bindingKey,
    userKey: subject.userKey,
    authenticationTag: authenticationTag.value,
  });
}

export function parseConversationBoundaryEnvelopeV2(
  value: unknown
): ConversationBoundaryEnvelopeV2 {
  try {
    return parseConversationBoundaryEnvelopeV2Internal(value);
  } catch (error) {
    if (error instanceof ConversationBoundaryEnvelopeError) {
      throw error;
    }
    invalidEnvelope();
  }
}

function authenticationTagDigest(
  envelope: ConversationBoundaryEnvelopeV2
): Buffer {
  return parseAuthenticationTag(envelope.authenticationTag, envelope.keyId)
    .digest;
}

function subjectFieldsFromEnvelope(
  envelope: ConversationBoundaryEnvelopeV2
): ParsedSubjectFields {
  if (!isRecord(envelope)) {
    invalidEnvelope();
  }
  return parseSubjectFields(envelope);
}

function safeDigestEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function subjectsMatch(
  envelope: ParsedSubjectFields,
  current: ParsedSubjectFields
): boolean {
  const tenantMatches = safeDigestEqual(
    envelope.tenantDigest,
    current.tenantDigest
  );
  const bindingMatches = safeDigestEqual(
    envelope.bindingDigest,
    current.bindingDigest
  );
  const userMatches = safeDigestEqual(envelope.userDigest, current.userDigest);
  return (
    envelope.version === current.version &&
    envelope.keyId === current.keyId &&
    envelope.workspaceId === current.workspaceId &&
    envelope.channel === current.channel &&
    envelope.channelConnectionId === current.channelConnectionId &&
    tenantMatches &&
    bindingMatches &&
    userMatches
  );
}

function assertExpectedScope(
  subject: ParsedSubjectFields,
  expectedScope: ConversationBoundaryScopeV2 | undefined
): void {
  if (!expectedScope) {
    return;
  }
  let tenant: Readonly<{ digest: Buffer }>;
  let binding: Readonly<{ digest: Buffer }>;
  try {
    tenant = parseOpaqueKey(expectedScope.tenantKey, "t2", subject.keyId);
    binding = parseOpaqueKey(expectedScope.bindingKey, "b2", subject.keyId);
  } catch {
    throw new ConversationBoundaryEnvelopeError("scope_mismatch");
  }
  const tenantMatches = safeDigestEqual(subject.tenantDigest, tenant.digest);
  const bindingMatches = safeDigestEqual(subject.bindingDigest, binding.digest);
  if (!tenantMatches || !bindingMatches) {
    throw new ConversationBoundaryEnvelopeError("scope_mismatch");
  }
}

function resolveActiveKey(
  deps: ConversationBoundaryVerifierDeps,
  keyId: ConversationScopeKeyId
): ConversationIdentityKey {
  let key: ConversationIdentityKey;
  try {
    key = deps.getIdentityKey();
  } catch {
    throw new ConversationBoundaryEnvelopeError(
      "key_configuration_unavailable",
      true
    );
  }
  if (key.keyId !== keyId) {
    throw new ConversationBoundaryEnvelopeError("key_id_unknown");
  }
  return key;
}

async function resolveCurrentIdentity(
  deps: ConversationBoundaryVerifierDeps,
  endpoint: ConversationEndpoint,
  senderId: ConversationSenderId
): Promise<ResolvedConversationIdentityV2> {
  try {
    return await deps.resolveIdentity(endpoint, senderId);
  } catch (error) {
    if (error instanceof ConversationIdentityError) {
      if (error.code === "binding_not_found") {
        throw new ConversationBoundaryEnvelopeError("binding_stale");
      }
      if (error.code === "binding_ambiguous") {
        throw new ConversationBoundaryEnvelopeError("binding_ambiguous");
      }
      if (error.code === "binding_inactive") {
        throw new ConversationBoundaryEnvelopeError("binding_inactive");
      }
      if (error.code === "binding_lookup_failed") {
        throw new ConversationBoundaryEnvelopeError(
          "identity_unavailable",
          error.retryable
        );
      }
    }
    throw new ConversationBoundaryEnvelopeError("identity_mismatch");
  }
}

export async function verifyConversationBoundaryEnvelopeV2WithDeps(input: {
  envelope: unknown;
  expectedPayloadKind: ConversationBoundaryPayloadKindV2;
  endpoint: ConversationEndpoint;
  senderId: unknown;
  payload: Uint8Array;
  expectedScope?: ConversationBoundaryScopeV2;
  deps: ConversationBoundaryVerifierDeps;
}): Promise<VerifiedConversationBoundaryV2> {
  const envelope = parseConversationBoundaryEnvelopeV2(input.envelope);
  const subject = subjectFieldsFromEnvelope(envelope);
  const key = resolveActiveKey(input.deps, envelope.keyId);
  const payload = parsePayload(input.payload);
  let expectedTag: Buffer;
  try {
    expectedTag = signBoundary(subject, envelope.payloadKind, payload, key);
  } catch {
    throw new ConversationBoundaryEnvelopeError(
      "key_configuration_unavailable",
      true
    );
  }
  if (!safeDigestEqual(authenticationTagDigest(envelope), expectedTag)) {
    throw new ConversationBoundaryEnvelopeError("authentication_failed");
  }
  if (envelope.payloadKind !== input.expectedPayloadKind) {
    throw new ConversationBoundaryEnvelopeError("payload_kind_mismatch");
  }
  assertExpectedScope(subject, input.expectedScope);

  let endpoint: ConversationEndpoint;
  let senderId: ConversationSenderId;
  try {
    endpoint = revalidateConversationEndpoint(input.endpoint);
    senderId = resolveConversationSenderId(input.senderId);
  } catch {
    throw new ConversationBoundaryEnvelopeError("identity_mismatch");
  }

  const identity = await resolveCurrentIdentity(input.deps, endpoint, senderId);
  let currentSubject: ParsedSubjectFields;
  try {
    currentSubject = parseTrustedSubject(identity.subject);
  } catch {
    throw new ConversationBoundaryEnvelopeError("identity_mismatch");
  }
  if (subject.workspaceId !== currentSubject.workspaceId) {
    throw new ConversationBoundaryEnvelopeError("binding_reassigned");
  }
  if (
    subject.channel !== currentSubject.channel ||
    subject.channelConnectionId !== currentSubject.channelConnectionId
  ) {
    throw new ConversationBoundaryEnvelopeError("binding_stale");
  }
  if (!subjectsMatch(subject, currentSubject)) {
    throw new ConversationBoundaryEnvelopeError("identity_mismatch");
  }

  const verified = {
    envelope,
    identity,
  } as VerifiedConversationBoundaryV2;
  Object.defineProperty(verified, verifiedConversationBoundaryBrand, {
    value: true,
  });
  Object.freeze(verified);
  verifiedConversationBoundaries.add(verified);
  return verified;
}

export async function verifyQueuedConversationBoundaryEnvelopeV2WithDeps(input: {
  envelope: unknown;
  expectedPayloadKind: ConversationBoundaryPayloadKindV2;
  endpoint: ConversationEndpoint;
  senderId: unknown;
  payload: Uint8Array;
  expectedScope: ConversationBoundaryScopeV2;
  deps: ConversationBoundaryVerifierDeps;
}): Promise<VerifiedQueuedConversationBoundaryV2> {
  if (!input.expectedScope) {
    throw new ConversationBoundaryEnvelopeError("scope_mismatch");
  }
  const verified = await verifyConversationBoundaryEnvelopeV2WithDeps(input);
  const queued = {
    envelope: verified.envelope,
    identity: verified.identity,
  } as VerifiedQueuedConversationBoundaryV2;
  Object.defineProperty(queued, verifiedConversationBoundaryBrand, {
    value: true,
  });
  Object.defineProperty(queued, verifiedQueuedConversationBoundaryBrand, {
    value: true,
  });
  Object.freeze(queued);
  verifiedConversationBoundaries.add(queued);
  verifiedQueuedConversationBoundaries.add(queued);
  return queued;
}

const runtimeVerifierDeps: ConversationBoundaryVerifierDeps = {
  getIdentityKey: getConversationIdentityKey,
  resolveIdentity: resolveConversationIdentityV2,
};

export async function verifyConversationBoundaryEnvelopeV2(input: {
  envelope: unknown;
  expectedPayloadKind: ConversationBoundaryPayloadKindV2;
  endpoint: ConversationEndpoint;
  senderId: unknown;
  payload: Uint8Array;
  expectedScope?: ConversationBoundaryScopeV2;
}): Promise<VerifiedConversationBoundaryV2> {
  return await verifyConversationBoundaryEnvelopeV2WithDeps({
    ...input,
    deps: runtimeVerifierDeps,
  });
}

export async function verifyQueuedConversationBoundaryEnvelopeV2(input: {
  envelope: unknown;
  expectedPayloadKind: ConversationBoundaryPayloadKindV2;
  endpoint: ConversationEndpoint;
  senderId: unknown;
  payload: Uint8Array;
  expectedScope: ConversationBoundaryScopeV2;
}): Promise<VerifiedQueuedConversationBoundaryV2> {
  return await verifyQueuedConversationBoundaryEnvelopeV2WithDeps({
    ...input,
    deps: runtimeVerifierDeps,
  });
}

function assertVerifiedConversationBoundaryV2(
  verified: unknown
): asserts verified is VerifiedConversationBoundaryV2 {
  if (
    typeof verified !== "object" ||
    verified === null ||
    !verifiedConversationBoundaries.has(verified) ||
    !(verifiedConversationBoundaryBrand in verified) ||
    verified[verifiedConversationBoundaryBrand] !== true
  ) {
    throw new ConversationBoundaryEnvelopeError("invalid_envelope");
  }
}

function assertVerifiedQueuedConversationBoundaryV2(
  verified: unknown
): asserts verified is VerifiedQueuedConversationBoundaryV2 {
  assertVerifiedConversationBoundaryV2(verified);
  if (
    !verifiedQueuedConversationBoundaries.has(verified) ||
    !(verifiedQueuedConversationBoundaryBrand in verified) ||
    verified[verifiedQueuedConversationBoundaryBrand] !== true
  ) {
    throw new ConversationBoundaryEnvelopeError("scope_mismatch");
  }
}

export function requireConnectedConversationDeliveryV2(
  verified: VerifiedConversationBoundaryV2
): ConversationDeliveryTarget {
  assertVerifiedConversationBoundaryV2(verified);
  if (
    verified.identity.connectionStatus !== "connected" ||
    verified.identity.delivery === null
  ) {
    throw new ConversationBoundaryEnvelopeError("delivery_unavailable");
  }
  return verified.identity.delivery;
}

export function requireVerifiedConversationSubjectV2(
  verified: unknown
): ConversationSubjectV2 {
  assertVerifiedConversationBoundaryV2(verified);
  return verified.identity.subject;
}

export function requireVerifiedQueuedConversationSubjectV2(
  verified: unknown
): ConversationSubjectV2 {
  assertVerifiedQueuedConversationBoundaryV2(verified);
  return verified.identity.subject;
}
