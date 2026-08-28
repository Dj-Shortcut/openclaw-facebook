import { and, eq, inArray, isNull } from "drizzle-orm";

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

export type CurrentCreditWalletIdentity = Readonly<{
  walletId: string;
  financialSubjectRef: string;
  checkoutAvailable: boolean;
}>;

/**
 * Resolves the one non-erased wallet for the exact current Messenger privacy
 * subject without deriving a secret-bound identifier first. The database's
 * active-subject unique key makes this lookup an unambiguous rotation bridge.
 */
export async function readCurrentCreditWalletIdentity(input: {
  workspaceId: number;
  mode: CreditWalletScope["mode"];
  channelConnectionId: number;
  bindingEpoch: number;
  privacyEpoch: number;
  userKey: string;
}): Promise<CurrentCreditWalletIdentity | null> {
  const database = await getDatabaseOrThrow();
  const rows = await database
    .select({
      walletId: creditWallets.walletId,
      financialSubjectRef: creditWallets.financialSubjectRef,
      status: creditWallets.status,
      refundAdjustmentEntryId: creditWallets.refundAdjustmentEntryId,
    })
    .from(creditWallets)
    .where(
      and(
        eq(creditWallets.workspaceId, input.workspaceId),
        eq(creditWallets.mode, input.mode),
        eq(creditWallets.channelConnectionId, input.channelConnectionId),
        eq(creditWallets.bindingEpoch, input.bindingEpoch),
        eq(creditWallets.privacyEpoch, input.privacyEpoch),
        eq(creditWallets.currentUserKeyHash, input.userKey),
        inArray(creditWallets.status, ["active", "frozen"])
      )
    )
    .limit(2);
  if (rows.length > 1) {
    throw new Error("Credit wallet identity is ambiguous");
  }
  const row = rows[0];
  if (!row) return null;
  return Object.freeze({
    walletId: row.walletId,
    financialSubjectRef: row.financialSubjectRef,
    checkoutAvailable:
      row.status === "active" && row.refundAdjustmentEntryId === null,
  });
}

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
        eq(creditWallets.status, "active"),
        isNull(creditWallets.refundAdjustmentEntryId)
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
