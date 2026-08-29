import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const TOKEN_BYTES = 32;
const MINIMUM_SECRET_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CAPABILITY_DERIVATION_DOMAIN = Buffer.from(
  "leaderbot.credit-checkout-capability.v1\0",
  "ascii"
);
const INVALID_TOKEN_BYTES = Buffer.alloc(TOKEN_BYTES);

declare const creditCheckoutCapabilityTokenBrand: unique symbol;
declare const creditCheckoutBrowserNonceBrand: unique symbol;
declare const creditCheckoutSha256Brand: unique symbol;

export type CreditCheckoutCapabilityToken = string & {
  readonly [creditCheckoutCapabilityTokenBrand]: true;
};

export type CreditCheckoutBrowserNonce = string & {
  readonly [creditCheckoutBrowserNonceBrand]: true;
};

export type CreditCheckoutSha256 = string & {
  readonly [creditCheckoutSha256Brand]: true;
};

export type CreditCheckoutCapabilityErrorCode =
  | "invalid_secret"
  | "invalid_intent_id"
  | "invalid_metadata_hash"
  | "invalid_capability"
  | "invalid_session_nonce"
  | "invalid_storage_hash";

export class CreditCheckoutCapabilityError extends Error {
  readonly code: CreditCheckoutCapabilityErrorCode;

  constructor(code: CreditCheckoutCapabilityErrorCode) {
    super("Credit checkout cryptographic material is invalid");
    this.name = "CreditCheckoutCapabilityError";
    this.code = code;
  }
}

export type CreditCheckoutCapabilityMaterial = Readonly<{
  capabilityHash: CreditCheckoutSha256;
  toUrlFragment: () => CreditCheckoutCapabilityToken;
  toJSON: () => Readonly<{ capabilityHash: CreditCheckoutSha256 }>;
}>;

export type CreditCheckoutBrowserSessionMaterial = Readonly<{
  sessionNonceHash: CreditCheckoutSha256;
  revealSessionNonce: () => CreditCheckoutBrowserNonce;
  toJSON: () => Readonly<{ sessionNonceHash: CreditCheckoutSha256 }>;
}>;

type DeriveCreditCheckoutCapabilityInput = Readonly<{
  dedicatedSecret: Uint8Array;
  intentId: string;
  metadataHash: string;
}>;

function fail(code: CreditCheckoutCapabilityErrorCode): never {
  throw new CreditCheckoutCapabilityError(code);
}

function assertDedicatedSecret(secret: unknown): asserts secret is Uint8Array {
  if (
    !(secret instanceof Uint8Array) ||
    secret.byteLength < MINIMUM_SECRET_BYTES
  ) {
    fail("invalid_secret");
  }
}

function intentIdBytes(intentId: unknown): Buffer {
  if (typeof intentId !== "string" || !UUID_PATTERN.test(intentId)) {
    fail("invalid_intent_id");
  }
  return Buffer.from(intentId.replaceAll("-", ""), "hex");
}

function metadataHashBytes(metadataHash: unknown): Buffer {
  if (
    typeof metadataHash !== "string" ||
    !SHA256_HEX_PATTERN.test(metadataHash)
  ) {
    fail("invalid_metadata_hash");
  }
  return Buffer.from(metadataHash, "hex");
}

function isCanonicalToken(value: unknown): value is string {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, "base64url");
  return (
    decoded.byteLength === TOKEN_BYTES &&
    decoded.toString("base64url") === value
  );
}

function decodeCanonicalToken(
  value: unknown,
  code: "invalid_capability" | "invalid_session_nonce"
): Buffer {
  if (!isCanonicalToken(value)) {
    fail(code);
  }
  return Buffer.from(value, "base64url");
}

function parseStorageHash(value: unknown): CreditCheckoutSha256 {
  if (typeof value !== "string" || !SHA256_HEX_PATTERN.test(value)) {
    fail("invalid_storage_hash");
  }
  return value as CreditCheckoutSha256;
}

function hashTokenBytes(bytes: Uint8Array): CreditCheckoutSha256 {
  return createHash("sha256")
    .update(bytes)
    .digest("hex") as CreditCheckoutSha256;
}

function constantTimeTokenHashVerification(
  token: unknown,
  expectedHash: unknown
): boolean {
  const tokenIsValid = isCanonicalToken(token);
  const hashIsValid =
    typeof expectedHash === "string" && SHA256_HEX_PATTERN.test(expectedHash);
  const tokenBytes = tokenIsValid
    ? Buffer.from(token, "base64url")
    : Buffer.from(INVALID_TOKEN_BYTES);
  const expectedDigest = hashIsValid
    ? Buffer.from(expectedHash, "hex")
    : Buffer.alloc(TOKEN_BYTES);
  const actualDigest = createHash("sha256").update(tokenBytes).digest();

  const matches = timingSafeEqual(actualDigest, expectedDigest);
  tokenBytes.fill(0);
  expectedDigest.fill(0);
  actualDigest.fill(0);
  return tokenIsValid && hashIsValid && matches;
}

function createCapabilityMaterial(
  tokenBytes: Buffer
): CreditCheckoutCapabilityMaterial {
  const token = tokenBytes.toString(
    "base64url"
  ) as CreditCheckoutCapabilityToken;
  const capabilityHash = hashTokenBytes(tokenBytes);
  tokenBytes.fill(0);

  return Object.freeze({
    capabilityHash,
    toUrlFragment: () => token,
    toJSON: () => Object.freeze({ capabilityHash }),
  });
}

function createBrowserSessionMaterial(
  tokenBytes: Buffer
): CreditCheckoutBrowserSessionMaterial {
  const token = tokenBytes.toString("base64url") as CreditCheckoutBrowserNonce;
  const sessionNonceHash = hashTokenBytes(tokenBytes);
  tokenBytes.fill(0);

  return Object.freeze({
    sessionNonceHash,
    revealSessionNonce: () => token,
    toJSON: () => Object.freeze({ sessionNonceHash }),
  });
}

/**
 * Derives the same opaque capability for an immutable checkout intent snapshot.
 * The caller may persist only `capabilityHash`; the raw fragment remains behind
 * the explicit `toUrlFragment()` disclosure boundary and is JSON-redacted.
 */
export function deriveCreditCheckoutCapability(
  input: DeriveCreditCheckoutCapabilityInput
): CreditCheckoutCapabilityMaterial {
  assertDedicatedSecret(input.dedicatedSecret);
  const intentBytes = intentIdBytes(input.intentId);
  const immutableMetadataBytes = metadataHashBytes(input.metadataHash);
  const secretCopy = Buffer.from(input.dedicatedSecret);

  try {
    const capabilityBytes = createHmac("sha256", secretCopy)
      .update(CAPABILITY_DERIVATION_DOMAIN)
      .update(intentBytes)
      .update(immutableMetadataBytes)
      .digest();
    return createCapabilityMaterial(capabilityBytes);
  } finally {
    secretCopy.fill(0);
    intentBytes.fill(0);
    immutableMetadataBytes.fill(0);
  }
}

/** Creates a fresh 256-bit browser-session nonce and its storage-only hash. */
export function createCreditCheckoutBrowserSession(): CreditCheckoutBrowserSessionMaterial {
  return createBrowserSessionMaterial(randomBytes(TOKEN_BYTES));
}

export function assertCreditCheckoutCapabilityToken(
  value: unknown
): asserts value is CreditCheckoutCapabilityToken {
  const bytes = decodeCanonicalToken(value, "invalid_capability");
  bytes.fill(0);
}

export function assertCreditCheckoutBrowserNonce(
  value: unknown
): asserts value is CreditCheckoutBrowserNonce {
  const bytes = decodeCanonicalToken(value, "invalid_session_nonce");
  bytes.fill(0);
}

export function assertCreditCheckoutStorageHash(
  value: unknown
): asserts value is CreditCheckoutSha256 {
  parseStorageHash(value);
}

export function hashCreditCheckoutCapability(
  capability: unknown
): CreditCheckoutSha256 {
  const bytes = decodeCanonicalToken(capability, "invalid_capability");
  try {
    return hashTokenBytes(bytes);
  } finally {
    bytes.fill(0);
  }
}

export function hashCreditCheckoutBrowserNonce(
  sessionNonce: unknown
): CreditCheckoutSha256 {
  const bytes = decodeCanonicalToken(sessionNonce, "invalid_session_nonce");
  try {
    return hashTokenBytes(bytes);
  } finally {
    bytes.fill(0);
  }
}

/**
 * Verifies both well-formed and malformed public input through one boolean API.
 * The 32-byte digest comparison always uses Node's constant-time primitive.
 */
export function verifyCreditCheckoutCapability(
  capability: unknown,
  expectedHash: unknown
): boolean {
  return constantTimeTokenHashVerification(capability, expectedHash);
}

export function verifyCreditCheckoutBrowserNonce(
  sessionNonce: unknown,
  expectedHash: unknown
): boolean {
  return constantTimeTokenHashVerification(sessionNonce, expectedHash);
}
