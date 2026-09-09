import { afterEach, describe, expect, it, vi } from "vitest";

import { createOAuthNonce } from "../client/src/const";

type MutableCrypto = Crypto & {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
};

const originalCrypto = globalThis.crypto;

function setCrypto(nextCrypto: MutableCrypto | undefined): void {
  Object.defineProperty(globalThis, "crypto", {
    value: nextCrypto,
    configurable: true,
  });
}

afterEach(() => {
  setCrypto(originalCrypto);
  vi.restoreAllMocks();
});

describe("createOAuthNonce", () => {
  it("uses crypto.randomUUID when available", () => {
    setCrypto({
      randomUUID: () => "nonce-from-random-uuid",
    } as MutableCrypto);

    expect(createOAuthNonce()).toBe("nonce-from-random-uuid");
  });

  it("uses crypto.getRandomValues when randomUUID is unavailable", () => {
    setCrypto({
      getRandomValues: (array: Uint8Array) => {
        array.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
        return array;
      },
    } as MutableCrypto);

    expect(createOAuthNonce()).toBe("000102030405060708090a0b0c0d0e0f");
  });

  it("throws when no secure random API is available", () => {
    setCrypto(undefined);

    expect(() => createOAuthNonce()).toThrow(
      "Secure random generator unavailable for OAuth state nonce",
    );
  });
});
