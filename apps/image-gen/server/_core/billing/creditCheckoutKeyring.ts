import type { CreditCheckoutHmacKey } from "./creditCheckoutConfig";
import {
  deriveCreditWalletIdentity,
  type CreditCheckoutMessengerScope,
  type CreditWalletIdentity,
} from "./creditCheckoutIdentity";

export type PersistedCreditWalletIdentity = Readonly<{
  walletId: string;
  financialSubjectRef: string;
}>;

export class CreditCheckoutKeyringError extends Error {
  constructor() {
    super("Credit checkout keyring cannot resolve the wallet identity");
    this.name = "CreditCheckoutKeyringError";
  }
}

/**
 * Selects the active key for a new subject, or the one retained key that
 * exactly derives an already-persisted wallet. The secret is exposed only to
 * the synchronous callback owned by withCreditCheckoutHmacKeyring.
 */
export function withSelectedCreditCheckoutHmacKey<T>(input: {
  keys: readonly CreditCheckoutHmacKey[];
  scope: CreditCheckoutMessengerScope;
  persistedIdentity: PersistedCreditWalletIdentity | null;
  callback: (input: {
    key: CreditCheckoutHmacKey;
    identity: CreditWalletIdentity;
  }) => T;
}): T {
  if (input.keys.length < 1) throw new CreditCheckoutKeyringError();
  const candidates = input.keys.map(key => ({
    key,
    identity: deriveCreditWalletIdentity({
      dedicatedSecret: key.secret,
      scope: input.scope,
    }),
  }));
  const matches = input.persistedIdentity
    ? candidates.filter(
        candidate =>
          candidate.identity.walletId === input.persistedIdentity?.walletId &&
          candidate.identity.financialSubjectRef ===
            input.persistedIdentity.financialSubjectRef
      )
    : [candidates[0]];
  if (matches.length !== 1) throw new CreditCheckoutKeyringError();
  return input.callback(matches[0]);
}
