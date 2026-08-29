import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  assertCreditCheckoutBrowserNonce,
  assertCreditCheckoutCapabilityToken,
  assertCreditCheckoutStorageHash,
  createCreditCheckoutBrowserSession,
  CreditCheckoutCapabilityError,
  deriveCreditCheckoutCapability,
  hashCreditCheckoutBrowserNonce,
  hashCreditCheckoutCapability,
  verifyCreditCheckoutBrowserNonce,
  verifyCreditCheckoutCapability,
} from "./creditCheckoutCapability";

const INTENT_ID = "6be308ee-7360-48fd-84fb-537f6f05457b";
const OTHER_INTENT_ID = "b14e6955-7764-468d-87f3-b98128198637";
const METADATA_HASH = createHash("sha256")
  .update("immutable-credit-offer-snapshot", "utf8")
  .digest("hex");
const OTHER_METADATA_HASH = createHash("sha256")
  .update("different-credit-offer-snapshot", "utf8")
  .digest("hex");

function derive(
  overrides: {
    dedicatedSecret?: Uint8Array;
    intentId?: string;
    metadataHash?: string;
  } = {}
) {
  return deriveCreditCheckoutCapability({
    dedicatedSecret: overrides.dedicatedSecret ?? Buffer.alloc(32, 0x41),
    intentId: overrides.intentId ?? INTENT_ID,
    metadataHash: overrides.metadataHash ?? METADATA_HASH,
  });
}

function tamperCanonicalToken(token: string): string {
  const replacement = token[0] === "A" ? "B" : "A";
  return `${replacement}${token.slice(1)}`;
}

describe("credit checkout cryptographic capability", () => {
  it("reconstructs one deterministic 256-bit fragment after a retry", () => {
    const first = derive();
    const retry = derive();
    const token = first.toUrlFragment();

    expect(retry.toUrlFragment()).toBe(token);
    expect(retry.capabilityHash).toBe(first.capabilityHash);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(first.capabilityHash).toBe(
      createHash("sha256").update(Buffer.from(token, "base64url")).digest("hex")
    );
    expect(() => assertCreditCheckoutCapabilityToken(token)).not.toThrow();
    expect(first.capabilityHash).toBe(hashCreditCheckoutCapability(token));
    expect(verifyCreditCheckoutCapability(token, first.capabilityHash)).toBe(
      true
    );
  });

  it("domain-binds the opaque result to the secret, intent and metadata", () => {
    const base = derive().toUrlFragment();
    const tokens = new Set([
      base,
      derive({ dedicatedSecret: Buffer.alloc(32, 0x42) }).toUrlFragment(),
      derive({ intentId: OTHER_INTENT_ID }).toUrlFragment(),
      derive({ metadataHash: OTHER_METADATA_HASH }).toUrlFragment(),
    ]);

    expect(tokens).toHaveLength(4);
    expect(base).not.toContain(INTENT_ID.replaceAll("-", ""));
    expect(base).not.toContain(METADATA_HASH);
  });

  it("rejects tampered proofs through a constant-time boolean API", () => {
    const material = derive();
    const token = material.toUrlFragment();
    const tamperedToken = tamperCanonicalToken(token);
    const tamperedHash = `${material.capabilityHash.slice(0, -1)}${
      material.capabilityHash.endsWith("0") ? "1" : "0"
    }`;

    expect(verifyCreditCheckoutCapability(token, material.capabilityHash)).toBe(
      true
    );
    expect(
      verifyCreditCheckoutCapability(tamperedToken, material.capabilityHash)
    ).toBe(false);
    expect(verifyCreditCheckoutCapability(token, tamperedHash)).toBe(false);
    expect(verifyCreditCheckoutCapability("not-a-token", "not-a-hash")).toBe(
      false
    );
    expect(verifyCreditCheckoutCapability(null, null)).toBe(false);
  });

  it.each([
    "",
    "A".repeat(42),
    "A".repeat(44),
    `${"A".repeat(42)}=`,
    `${"A".repeat(42)}+`,
    `${"A".repeat(42)}/`,
    `${"A".repeat(42)}B`,
  ])("rejects malformed or noncanonical capability %j", value => {
    expect(() => assertCreditCheckoutCapabilityToken(value)).toThrow(
      CreditCheckoutCapabilityError
    );
    expect(() => hashCreditCheckoutCapability(value)).toThrow(
      CreditCheckoutCapabilityError
    );
  });

  it.each([
    "",
    "0".repeat(63),
    "0".repeat(65),
    "A".repeat(64),
    "g".repeat(64),
    null,
  ])("rejects a malformed SHA-256 storage hash %j", value => {
    expect(() => assertCreditCheckoutStorageHash(value)).toThrow(
      CreditCheckoutCapabilityError
    );
  });

  it.each([
    {
      dedicatedSecret: Buffer.alloc(31),
      intentId: INTENT_ID,
      metadataHash: METADATA_HASH,
      code: "invalid_secret",
    },
    {
      dedicatedSecret: "a".repeat(32) as never,
      intentId: INTENT_ID,
      metadataHash: METADATA_HASH,
      code: "invalid_secret",
    },
    {
      dedicatedSecret: Buffer.alloc(32),
      intentId: INTENT_ID.toUpperCase(),
      metadataHash: METADATA_HASH,
      code: "invalid_intent_id",
    },
    {
      dedicatedSecret: Buffer.alloc(32),
      intentId: "not-a-uuid",
      metadataHash: METADATA_HASH,
      code: "invalid_intent_id",
    },
    {
      dedicatedSecret: Buffer.alloc(32),
      intentId: INTENT_ID,
      metadataHash: METADATA_HASH.toUpperCase(),
      code: "invalid_metadata_hash",
    },
    {
      dedicatedSecret: Buffer.alloc(32),
      intentId: INTENT_ID,
      metadataHash: "0".repeat(63),
      code: "invalid_metadata_hash",
    },
  ])("rejects exact invalid derivation input $code", input => {
    expect(() => deriveCreditCheckoutCapability(input)).toThrowError(
      expect.objectContaining({ code: input.code })
    );
  });

  it("keeps the dedicated secret and raw token out of serialization", () => {
    const dedicatedSecret = randomBytes(32);
    const material = derive({ dedicatedSecret });
    const token = material.toUrlFragment();
    const serialized = JSON.stringify(material);

    expect(serialized).toBe(
      JSON.stringify({ capabilityHash: material.capabilityHash })
    );
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(dedicatedSecret.toString("hex"));
    expect(serialized).not.toContain(INTENT_ID);
    expect(serialized).not.toContain(METADATA_HASH);
    expect(Object.keys(material)).not.toContain("dedicatedSecret");
  });
});

describe("credit checkout browser session nonce", () => {
  it("creates a fresh canonical 256-bit nonce and storage-only hash", () => {
    const first = createCreditCheckoutBrowserSession();
    const second = createCreditCheckoutBrowserSession();
    const nonce = first.revealSessionNonce();

    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(nonce, "base64url")).toHaveLength(32);
    expect(second.revealSessionNonce()).not.toBe(nonce);
    expect(first.sessionNonceHash).toBe(
      createHash("sha256").update(Buffer.from(nonce, "base64url")).digest("hex")
    );
    expect(first.sessionNonceHash).toBe(hashCreditCheckoutBrowserNonce(nonce));
    expect(
      verifyCreditCheckoutBrowserNonce(nonce, first.sessionNonceHash)
    ).toBe(true);
    expect(
      verifyCreditCheckoutBrowserNonce(
        tamperCanonicalToken(nonce),
        first.sessionNonceHash
      )
    ).toBe(false);
  });

  it("validates canonical nonce input and redacts raw nonce serialization", () => {
    const material = createCreditCheckoutBrowserSession();
    const nonce = material.revealSessionNonce();

    expect(() => assertCreditCheckoutBrowserNonce(nonce)).not.toThrow();
    expect(() => assertCreditCheckoutBrowserNonce(`${nonce}=`)).toThrow(
      CreditCheckoutCapabilityError
    );
    expect(JSON.stringify(material)).toBe(
      JSON.stringify({ sessionNonceHash: material.sessionNonceHash })
    );
    expect(JSON.stringify(material)).not.toContain(nonce);
  });
});
