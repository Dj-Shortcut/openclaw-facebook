import { and, eq } from "drizzle-orm";

import { creditReservations, creditWallets } from "../../../drizzle/schema";
import { getDatabaseOrThrow } from "../../db";
import type { CreditWalletScope } from "./creditWalletStore";

export type SpendableCreditWallet = Readonly<{
  creditBalance: number;
  reservedCredits: number;
}>;

export type CreditGenerationReservationState = Readonly<{
  status: "initializing" | "reserved" | "committed" | "released" | "expired";
}>;

/**
 * Reads only one exact current wallet. The stored reservation procedure repeats
 * every ownership/privacy predicate under lock before it changes a balance.
 */
export async function readSpendableCreditWallet(
  scope: CreditWalletScope
): Promise<SpendableCreditWallet | null> {
  const database = await getDatabaseOrThrow();
  const rows = await database
    .select({
      creditBalance: creditWallets.creditBalance,
      reservedCredits: creditWallets.reservedCredits,
    })
    .from(creditWallets)
    .where(
      and(
        eq(creditWallets.walletId, scope.walletId),
        eq(creditWallets.workspaceId, scope.workspaceId),
        eq(creditWallets.mode, scope.mode),
        eq(creditWallets.channelConnectionId, scope.channelConnectionId),
        eq(creditWallets.bindingEpoch, scope.bindingEpoch),
        eq(creditWallets.privacyEpoch, scope.privacyEpoch),
        eq(creditWallets.currentUserKeyHash, scope.userKey),
        eq(creditWallets.financialSubjectRef, scope.financialSubjectRef),
        eq(creditWallets.status, "active")
      )
    )
    .limit(2);
  return rows.length === 1 ? rows[0] : null;
}

/** Reads only the deterministic reservation for one exact wallet request. */
export async function readCreditGenerationReservation(input: {
  scope: CreditWalletScope;
  reservationId: string;
  generationRequestKeyHash: string;
  ownerTokenHash: string;
  reservedCreditCount: 1;
}): Promise<CreditGenerationReservationState | null> {
  const database = await getDatabaseOrThrow();
  const rows = await database
    .select({ status: creditReservations.status })
    .from(creditReservations)
    .where(
      and(
        eq(creditReservations.reservationId, input.reservationId),
        eq(creditReservations.walletId, input.scope.walletId),
        eq(creditReservations.workspaceId, input.scope.workspaceId),
        eq(creditReservations.mode, input.scope.mode),
        eq(
          creditReservations.channelConnectionId,
          input.scope.channelConnectionId
        ),
        eq(creditReservations.bindingEpoch, input.scope.bindingEpoch),
        eq(creditReservations.privacyEpoch, input.scope.privacyEpoch),
        eq(
          creditReservations.financialSubjectRef,
          input.scope.financialSubjectRef
        ),
        eq(
          creditReservations.generationRequestKeyHash,
          input.generationRequestKeyHash
        ),
        eq(creditReservations.ownerTokenHash, input.ownerTokenHash),
        eq(creditReservations.reservedCreditCount, input.reservedCreditCount)
      )
    )
    .limit(2);
  return rows.length === 1 ? rows[0] : null;
}
