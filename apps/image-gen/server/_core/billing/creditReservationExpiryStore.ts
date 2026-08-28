import { and, asc, eq, inArray, isNotNull, lte } from "drizzle-orm";

import { creditReservations, creditWallets } from "../../../drizzle/schema";
import { getDatabaseOrThrow } from "../../db";
import type { MollieMode } from "./config";

const MAX_BATCH_SIZE = 100;

export type ExpiredCreditReservation = Readonly<{
  reservationId: string;
  walletId: string;
  workspaceId: number;
  mode: MollieMode;
  channelConnectionId: number;
  bindingEpoch: number;
  privacyEpoch: number;
  userKey: string;
  financialSubjectRef: string;
  ownerTokenHash: string;
}>;

/**
 * Returns only expired, still-held reservations. The terminal stored
 * procedure rechecks every scope field and the database clock under locks.
 */
export async function listExpiredCreditReservations(
  mode: MollieMode,
  now: Date,
  limit = 25
): Promise<readonly ExpiredCreditReservation[]> {
  if (
    (mode !== "test" && mode !== "live") ||
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime()) ||
    !Number.isSafeInteger(limit) ||
    limit < 1
  ) {
    throw new Error("Credit reservation expiry input is invalid");
  }
  const boundedLimit = Math.min(MAX_BATCH_SIZE, limit);
  const database = await getDatabaseOrThrow();
  const rows = await database
    .select({
      reservationId: creditReservations.reservationId,
      walletId: creditReservations.walletId,
      workspaceId: creditReservations.workspaceId,
      mode: creditReservations.mode,
      channelConnectionId: creditReservations.channelConnectionId,
      bindingEpoch: creditReservations.bindingEpoch,
      privacyEpoch: creditReservations.privacyEpoch,
      userKey: creditWallets.currentUserKeyHash,
      financialSubjectRef: creditReservations.financialSubjectRef,
      ownerTokenHash: creditReservations.ownerTokenHash,
    })
    .from(creditReservations)
    .innerJoin(
      creditWallets,
      and(
        eq(creditWallets.walletId, creditReservations.walletId),
        eq(creditWallets.workspaceId, creditReservations.workspaceId),
        eq(creditWallets.mode, creditReservations.mode),
        eq(
          creditWallets.channelConnectionId,
          creditReservations.channelConnectionId
        ),
        eq(creditWallets.bindingEpoch, creditReservations.bindingEpoch),
        eq(creditWallets.privacyEpoch, creditReservations.privacyEpoch),
        eq(
          creditWallets.financialSubjectRef,
          creditReservations.financialSubjectRef
        )
      )
    )
    .where(
      and(
        eq(creditReservations.mode, mode),
        eq(creditReservations.status, "reserved"),
        eq(creditReservations.transportState, "pretransport"),
        lte(creditReservations.expiresAt, now),
        isNotNull(creditReservations.ownerTokenHash),
        isNotNull(creditWallets.currentUserKeyHash),
        inArray(creditWallets.status, ["active", "frozen"])
      )
    )
    .orderBy(
      asc(creditReservations.expiresAt),
      asc(creditReservations.reservationId)
    )
    .limit(boundedLimit);

  return rows.flatMap(row =>
    row.userKey && row.ownerTokenHash
      ? [
          Object.freeze({
            ...row,
            userKey: row.userKey,
            ownerTokenHash: row.ownerTokenHash,
          }),
        ]
      : []
  );
}
