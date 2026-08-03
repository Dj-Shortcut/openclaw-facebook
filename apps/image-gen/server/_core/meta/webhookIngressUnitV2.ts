import { createHash, timingSafeEqual } from "node:crypto";
import {
  ConversationBoundaryEnvelopeError,
  createConversationBoundaryEnvelopeV2WithKey,
  parseConversationBoundaryEnvelopeV2,
  verifyQueuedConversationBoundaryEnvelopeV2WithDeps,
  type ConversationBoundaryEnvelopeV2,
  type ConversationBoundaryPayloadKindV2,
  type ConversationBoundaryScopeV2,
  type ConversationBoundaryVerifierDeps,
  type VerifiedQueuedConversationBoundaryV2,
} from "../conversationBoundaryEnvelope";
import type {
  ConversationIdentityKey,
  ConversationScopeKeyId,
} from "../conversationIdentityConfig";
import { ConversationIdentityError } from "../conversationEndpoint";
import type { ResolvedConversationIdentityV2 } from "../conversationIdentityResolver";
import {
  WebhookReplayV2Error,
  parseWebhookReplayClaimIdV2,
  type WebhookReplayClaimIdV2,
  type WebhookReplayEventIdentityV2,
} from "../webhookReplayProtectionV2";
import {
  MetaConversationIngressV2Error,
  decodeMetaConversationPayloadV2,
  extractMetaConversationBatchV2,
  type IgnoredMetaEventCountsV2,
  type MetaConversationIngressPayloadV2,
  type VerifiedMetaWebhookBodyV2,
} from "./webhookIngressPayloadV2";

const INGRESS_UNIT_MAGIC = Buffer.from(
  "leaderbot.conversation.ingress-unit\0",
  "ascii"
);
const INGRESS_UNIT_VERSION = 2;
const INGRESS_UNIT_PURPOSE = 1;
const MAX_CANONICAL_PAYLOAD_BYTES = 256 * 1_024;
const MAX_BASE64URL_PAYLOAD_CHARS = Math.ceil(
  (MAX_CANONICAL_PAYLOAD_BYTES * 4) / 3
);
const KEY_ID_PATTERN = /^k[1-9][0-9]{0,5}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const UNIT_KEYS = Object.freeze([
  "authenticationTag",
  "boundary",
  "payloadBytes",
  "payloadEncoding",
  "payloadKind",
  "replayClaimId",
  "version",
] as const);

declare const ingressUnitAuthenticationTagBrand: unique symbol;
const verifiedIngressUnitBrand: unique symbol = Symbol(
  "verifiedMetaConversationIngressUnitV2"
);
const verifiedIngressUnits = new WeakSet<object>();

export type IngressUnitAuthenticationTagV2 = string & {
  readonly [ingressUnitAuthenticationTagBrand]: true;
};

export type MetaConversationIngressUnitV2 = Readonly<{
  version: 2;
  payloadKind: ConversationBoundaryPayloadKindV2;
  payloadEncoding: "base64url";
  payloadBytes: string;
  replayClaimId: WebhookReplayClaimIdV2;
  boundary: ConversationBoundaryEnvelopeV2;
  authenticationTag: IngressUnitAuthenticationTagV2;
}>;

export type SealedMetaConversationIngressBatchV2 = Readonly<{
  kind: "sealed" | "empty";
  units: readonly MetaConversationIngressUnitV2[];
  ignored: IgnoredMetaEventCountsV2;
}>;

export type MetaConversationIngressSealerDepsV2 = Readonly<{
  getIdentityKey: () => ConversationIdentityKey;
  resolveIdentity: (
    endpoint: Parameters<
      ConversationBoundaryVerifierDeps["resolveIdentity"]
    >[0],
    senderId: Parameters<ConversationBoundaryVerifierDeps["resolveIdentity"]>[1]
  ) => Promise<ResolvedConversationIdentityV2>;
  createReplayClaimId: () => WebhookReplayClaimIdV2;
}>;

export type VerifiedMetaConversationIngressUnitV2 = Readonly<{
  unit: MetaConversationIngressUnitV2;
  payload: MetaConversationIngressPayloadV2;
  eventIdentity: WebhookReplayEventIdentityV2;
  verifiedBoundary: VerifiedQueuedConversationBoundaryV2;
  replayClaimId: WebhookReplayClaimIdV2;
  [verifiedIngressUnitBrand]: true;
}>;

type ParsedAuthenticationTag = Readonly<{
  value: IngressUnitAuthenticationTagV2;
  digest: Buffer;
}>;

function unitError(
  code:
    | "invalid_unit"
    | "unit_authentication_failed"
    | "key_unavailable"
    | "identity_rejected"
    | "identity_unavailable"
    | "claim_id_unavailable",
  retryable = false
): never {
  throw new MetaConversationIngressV2Error(code, retryable);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactUnitKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === UNIT_KEYS.length &&
    keys.every((key, index) => key === UNIT_KEYS[index])
  );
}

function encodeLength(length: number): Buffer {
  const encoded = Buffer.alloc(4);
  encoded.writeUInt32BE(length);
  return encoded;
}

function encodeUint64(value: number): Buffer {
  const encoded = Buffer.alloc(8);
  encoded.writeBigUInt64BE(BigInt(value));
  return encoded;
}

function encodeField(tag: number, value: Uint8Array): Buffer[] {
  const bytes = Buffer.from(value);
  return [Buffer.from([tag]), encodeLength(bytes.length), bytes];
}

function parseKeyId(value: unknown): ConversationScopeKeyId {
  if (typeof value !== "string" || !KEY_ID_PATTERN.test(value)) {
    unitError("invalid_unit");
  }
  return value as ConversationScopeKeyId;
}

function opaqueDigest(
  value: unknown,
  prefix: "t2" | "b2" | "u2" | "e2",
  keyId: ConversationScopeKeyId
): Buffer {
  if (typeof value !== "string") {
    unitError("invalid_unit");
  }
  const expectedPrefix = `${prefix}.${keyId}.`;
  if (!value.startsWith(expectedPrefix)) {
    unitError("invalid_unit");
  }
  const digestHex = value.slice(expectedPrefix.length);
  if (!SHA256_HEX_PATTERN.test(digestHex)) {
    unitError("invalid_unit");
  }
  return Buffer.from(digestHex, "hex");
}

function parseAuthenticationTag(
  value: unknown,
  keyId: ConversationScopeKeyId
): ParsedAuthenticationTag {
  if (typeof value !== "string") {
    unitError("invalid_unit");
  }
  const prefix = `i2.${keyId}.`;
  if (!value.startsWith(prefix)) {
    unitError("invalid_unit");
  }
  const digestHex = value.slice(prefix.length);
  if (!SHA256_HEX_PATTERN.test(digestHex)) {
    unitError("invalid_unit");
  }
  return Object.freeze({
    value: value as IngressUnitAuthenticationTagV2,
    digest: Buffer.from(digestHex, "hex"),
  });
}

function parsePayloadBytes(value: unknown): Readonly<{
  encoded: string;
  bytes: Buffer;
}> {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_BASE64URL_PAYLOAD_CHARS ||
    !BASE64URL_PATTERN.test(value)
  ) {
    unitError("invalid_unit");
  }
  const bytes = Buffer.from(value, "base64url");
  if (
    bytes.length === 0 ||
    bytes.length > MAX_CANONICAL_PAYLOAD_BYTES ||
    bytes.toString("base64url") !== value
  ) {
    unitError("invalid_unit");
  }
  return Object.freeze({ encoded: value, bytes });
}

function parseReplayClaimId(value: unknown): WebhookReplayClaimIdV2 {
  try {
    return parseWebhookReplayClaimIdV2(value);
  } catch (error) {
    if (error instanceof WebhookReplayV2Error) {
      unitError("invalid_unit");
    }
    throw error;
  }
}

function parseBoundary(value: unknown): ConversationBoundaryEnvelopeV2 {
  try {
    return parseConversationBoundaryEnvelopeV2(value);
  } catch (error) {
    if (error instanceof ConversationBoundaryEnvelopeError) {
      unitError("invalid_unit");
    }
    throw error;
  }
}

export function parseMetaConversationIngressUnitV2(
  value: unknown
): MetaConversationIngressUnitV2 {
  if (!isRecord(value) || !exactUnitKeys(value)) {
    unitError("invalid_unit");
  }
  if (
    value.version !== INGRESS_UNIT_VERSION ||
    value.payloadEncoding !== "base64url" ||
    (value.payloadKind !== "meta_messenger_event" &&
      value.payloadKind !== "meta_whatsapp_message")
  ) {
    unitError("invalid_unit");
  }
  const boundary = parseBoundary(value.boundary);
  if (boundary.payloadKind !== value.payloadKind) {
    unitError("invalid_unit");
  }
  const replayClaimId = parseReplayClaimId(value.replayClaimId);
  const payload = parsePayloadBytes(value.payloadBytes);
  const authenticationTag = parseAuthenticationTag(
    value.authenticationTag,
    boundary.keyId
  );
  return Object.freeze({
    version: INGRESS_UNIT_VERSION,
    payloadKind: value.payloadKind,
    payloadEncoding: "base64url",
    payloadBytes: payload.encoded,
    replayClaimId,
    boundary,
    authenticationTag: authenticationTag.value,
  });
}

function encodeUnitAuthenticationInput(input: {
  payloadKind: ConversationBoundaryPayloadKindV2;
  payloadBytes: Uint8Array;
  replayClaimId: WebhookReplayClaimIdV2;
  boundary: ConversationBoundaryEnvelopeV2;
}): Buffer {
  const boundary = input.boundary;
  const keyId = parseKeyId(boundary.keyId);
  const keyIdBytes = Buffer.from(keyId, "utf8");
  const replayClaimIdBytes = Buffer.from(
    input.replayClaimId.slice("rc2.".length),
    "hex"
  );
  if (replayClaimIdBytes.length !== 16) {
    unitError("invalid_unit");
  }
  const payloadDigest = createHash("sha256")
    .update(input.payloadBytes)
    .digest();
  return Buffer.concat([
    INGRESS_UNIT_MAGIC,
    Buffer.from([INGRESS_UNIT_VERSION, INGRESS_UNIT_PURPOSE]),
    encodeLength(keyIdBytes.length),
    keyIdBytes,
    ...encodeField(
      1,
      Buffer.from([input.payloadKind === "meta_messenger_event" ? 1 : 2])
    ),
    ...encodeField(2, replayClaimIdBytes),
    ...encodeField(3, payloadDigest),
    ...encodeField(4, Buffer.from([boundary.version])),
    ...encodeField(5, Buffer.from(boundary.keyId, "utf8")),
    ...encodeField(6, encodeUint64(boundary.workspaceId)),
    ...encodeField(7, Buffer.from([boundary.channel === "messenger" ? 1 : 2])),
    ...encodeField(8, encodeUint64(boundary.channelConnectionId)),
    ...encodeField(9, opaqueDigest(boundary.tenantKey, "t2", keyId)),
    ...encodeField(10, opaqueDigest(boundary.bindingKey, "b2", keyId)),
    ...encodeField(11, opaqueDigest(boundary.userKey, "u2", keyId)),
    ...encodeField(12, opaqueDigest(boundary.authenticationTag, "e2", keyId)),
  ]);
}

function signUnit(
  input: Parameters<typeof encodeUnitAuthenticationInput>[0],
  key: ConversationIdentityKey
): Buffer {
  if (key.keyId !== input.boundary.keyId) {
    unitError("key_unavailable", true);
  }
  let digest: Buffer;
  try {
    digest = key.sign(encodeUnitAuthenticationInput(input));
  } catch {
    unitError("key_unavailable", true);
  }
  if (!Buffer.isBuffer(digest) || digest.length !== 32) {
    unitError("key_unavailable", true);
  }
  return digest;
}

function formatAuthenticationTag(
  keyId: ConversationScopeKeyId,
  digest: Buffer
): IngressUnitAuthenticationTagV2 {
  return `i2.${keyId}.${digest.toString("hex")}` as IngressUnitAuthenticationTagV2;
}

async function resolveIdentityForSeal(
  candidate: ReturnType<
    typeof extractMetaConversationBatchV2
  >["candidates"][number],
  deps: MetaConversationIngressSealerDepsV2
): Promise<ResolvedConversationIdentityV2> {
  try {
    return await deps.resolveIdentity(candidate.endpoint, candidate.senderId);
  } catch (error) {
    if (
      error instanceof ConversationIdentityError &&
      error.code === "binding_lookup_failed"
    ) {
      unitError("identity_unavailable", error.retryable);
    }
    if (error instanceof ConversationIdentityError) {
      unitError("identity_rejected");
    }
    unitError("identity_unavailable", true);
  }
}

function createReplayClaimId(
  deps: MetaConversationIngressSealerDepsV2
): WebhookReplayClaimIdV2 {
  try {
    return parseWebhookReplayClaimIdV2(deps.createReplayClaimId());
  } catch {
    unitError("claim_id_unavailable", true);
  }
}

export async function sealVerifiedMetaConversationIngressBatchV2WithDeps(
  verifiedBody: VerifiedMetaWebhookBodyV2,
  deps: MetaConversationIngressSealerDepsV2
): Promise<SealedMetaConversationIngressBatchV2> {
  const extracted = extractMetaConversationBatchV2(verifiedBody);
  if (extracted.candidates.length === 0) {
    return Object.freeze({
      kind: "empty",
      units: Object.freeze([]),
      ignored: extracted.ignored,
    });
  }

  let key: ConversationIdentityKey;
  try {
    key = deps.getIdentityKey();
  } catch {
    unitError("key_unavailable", true);
  }

  const claimIds = new Set<string>();
  const prepared = extracted.candidates.map(candidate => {
    const replayClaimId = createReplayClaimId(deps);
    if (claimIds.has(replayClaimId)) {
      unitError("claim_id_unavailable", true);
    }
    claimIds.add(replayClaimId);
    return Object.freeze({
      candidate,
      replayClaimId,
      payloadBytes: Buffer.from(candidate.canonicalPayload, "utf8"),
    });
  });
  const identities = await Promise.all(
    prepared.map(({ candidate }) => resolveIdentityForSeal(candidate, deps))
  );

  const units = prepared.map((item, index): MetaConversationIngressUnitV2 => {
    const identity = identities[index];
    if (!identity) {
      unitError("identity_unavailable", true);
    }
    let boundary: ConversationBoundaryEnvelopeV2;
    try {
      boundary = createConversationBoundaryEnvelopeV2WithKey({
        subject: identity.subject,
        payloadKind: item.candidate.payloadKind,
        endpoint: item.candidate.endpoint,
        senderId: item.candidate.senderId,
        payload: item.payloadBytes,
        key,
      });
    } catch (error) {
      if (error instanceof ConversationBoundaryEnvelopeError) {
        unitError("identity_rejected");
      }
      unitError("key_unavailable", true);
    }
    const authenticationTag = formatAuthenticationTag(
      key.keyId,
      signUnit(
        {
          payloadKind: item.candidate.payloadKind,
          payloadBytes: item.payloadBytes,
          replayClaimId: item.replayClaimId,
          boundary,
        },
        key
      )
    );
    return Object.freeze({
      version: INGRESS_UNIT_VERSION,
      payloadKind: item.candidate.payloadKind,
      payloadEncoding: "base64url",
      payloadBytes: item.payloadBytes.toString("base64url"),
      replayClaimId: item.replayClaimId,
      boundary,
      authenticationTag,
    });
  });

  return Object.freeze({
    kind: "sealed",
    units: Object.freeze(units),
    ignored: extracted.ignored,
  });
}

function resolveVerificationKey(
  keyId: ConversationScopeKeyId,
  deps: ConversationBoundaryVerifierDeps
): ConversationIdentityKey {
  let key: ConversationIdentityKey;
  try {
    key = deps.getIdentityKey();
  } catch {
    unitError("key_unavailable", true);
  }
  if (key.keyId !== keyId) {
    unitError("unit_authentication_failed");
  }
  return key;
}

export async function verifyQueuedMetaConversationIngressUnitV2WithDeps(input: {
  unit: unknown;
  expectedScope: ConversationBoundaryScopeV2;
  deps: ConversationBoundaryVerifierDeps;
}): Promise<VerifiedMetaConversationIngressUnitV2> {
  if (!input.expectedScope) {
    unitError("invalid_unit");
  }
  const unit = parseMetaConversationIngressUnitV2(input.unit);
  const payload = parsePayloadBytes(unit.payloadBytes);
  const key = resolveVerificationKey(unit.boundary.keyId, input.deps);
  const expectedTag = signUnit(
    {
      payloadKind: unit.payloadKind,
      payloadBytes: payload.bytes,
      replayClaimId: unit.replayClaimId,
      boundary: unit.boundary,
    },
    key
  );
  const suppliedTag = parseAuthenticationTag(
    unit.authenticationTag,
    unit.boundary.keyId
  ).digest;
  if (
    suppliedTag.length !== expectedTag.length ||
    !timingSafeEqual(suppliedTag, expectedTag)
  ) {
    unitError("unit_authentication_failed");
  }

  const decoded = decodeMetaConversationPayloadV2(
    unit.payloadKind,
    payload.bytes
  );
  const verifierDeps: ConversationBoundaryVerifierDeps = {
    getIdentityKey: () => key,
    resolveIdentity: input.deps.resolveIdentity,
  };
  const verifiedBoundary =
    await verifyQueuedConversationBoundaryEnvelopeV2WithDeps({
      envelope: unit.boundary,
      expectedPayloadKind: unit.payloadKind,
      endpoint: decoded.endpoint,
      senderId: decoded.senderId,
      payload: payload.bytes,
      expectedScope: input.expectedScope,
      deps: verifierDeps,
    });

  const verified = {
    unit,
    payload: decoded.payload,
    eventIdentity: decoded.eventIdentity,
    verifiedBoundary,
    replayClaimId: unit.replayClaimId,
  } as VerifiedMetaConversationIngressUnitV2;
  Object.defineProperty(verified, verifiedIngressUnitBrand, {
    value: true,
  });
  Object.freeze(verified);
  verifiedIngressUnits.add(verified);
  return verified;
}

function assertVerifiedIngressUnit(
  value: unknown
): asserts value is VerifiedMetaConversationIngressUnitV2 {
  if (
    typeof value !== "object" ||
    value === null ||
    !verifiedIngressUnits.has(value) ||
    !(verifiedIngressUnitBrand in value) ||
    value[verifiedIngressUnitBrand] !== true
  ) {
    unitError("invalid_unit");
  }
}

export function requireVerifiedIngressReplayInputV2(
  verified: VerifiedMetaConversationIngressUnitV2
): Readonly<{
  verified: VerifiedQueuedConversationBoundaryV2;
  eventIdentity: WebhookReplayEventIdentityV2;
  replayClaimId: WebhookReplayClaimIdV2;
}> {
  assertVerifiedIngressUnit(verified);
  return Object.freeze({
    verified: verified.verifiedBoundary,
    eventIdentity: verified.eventIdentity,
    replayClaimId: verified.replayClaimId,
  });
}
