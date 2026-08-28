import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";

import {
  billingIntents,
  billingOutbox,
  billingProviderOperations,
  billingSubscriptions,
  billingWebhookRoutes,
  creditLedger,
  creditReservations,
  creditWallets,
  paymentLedger,
  workspaceEntitlements,
  workspaceEntitlementUsage,
} from "../../../drizzle/schema";
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

export type DueCreditReservationResolution = ExpiredCreditReservation &
  Readonly<{
    transportState: "transport_started" | "known_accepted";
    generationRequestKeyHash: string;
  }>;

export type ExpiredPristineCreditCheckout = Readonly<{
  intentId: string;
  walletId: string;
  workspaceId: number;
  mode: MollieMode;
  channelConnectionId: number;
  bindingEpoch: number;
  privacyEpoch: number;
  userKey: string;
  financialSubjectRef: string;
}>;

export type TerminalCreditReservationForScrub = Readonly<{
  reservationId: string;
  walletId: string;
  workspaceId: number;
  mode: MollieMode;
  channelConnectionId: number;
  bindingEpoch: number;
  privacyEpoch: number;
  financialSubjectRef: string;
}>;

/**
 * Finds a bounded oldest-first set of expired checkout records that never
 * crossed a provider, delivery, or financial boundary. A browser may already
 * have consumed the short-lived capability; once it expires, an unconfirmed
 * session can no longer create a payment and must not retain its identity
 * forever. The terminal definer routine repeats every predicate under locks,
 * so this read is only candidate discovery and cannot authorize deletion.
 */
export async function listExpiredPristineCreditCheckouts(
  mode: MollieMode,
  now: Date,
  limit = 25
): Promise<readonly ExpiredPristineCreditCheckout[]> {
  if (
    (mode !== "test" && mode !== "live") ||
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime()) ||
    !Number.isSafeInteger(limit) ||
    limit < 1
  ) {
    throw new Error("Pristine credit checkout expiry input is invalid");
  }
  const boundedLimit = Math.min(MAX_BATCH_SIZE, limit);
  const database = await getDatabaseOrThrow();
  const rows = await database
    .select({
      intentId: billingIntents.intentId,
      walletId: billingIntents.creditWalletId,
      workspaceId: billingIntents.workspaceId,
      mode: billingIntents.mode,
      channelConnectionId: billingIntents.messengerChannelConnectionId,
      bindingEpoch: billingIntents.messengerBindingEpoch,
      privacyEpoch: billingIntents.messengerPrivacyEpoch,
      userKey: billingIntents.messengerSenderUserKey,
      financialSubjectRef: billingIntents.creditFinancialSubjectRef,
    })
    .from(billingIntents)
    .innerJoin(
      creditWallets,
      and(
        eq(creditWallets.walletId, billingIntents.creditWalletId),
        eq(creditWallets.workspaceId, billingIntents.workspaceId),
        eq(creditWallets.mode, billingIntents.mode),
        eq(
          creditWallets.channelConnectionId,
          billingIntents.messengerChannelConnectionId
        ),
        eq(creditWallets.bindingEpoch, billingIntents.messengerBindingEpoch),
        eq(creditWallets.privacyEpoch, billingIntents.messengerPrivacyEpoch),
        eq(
          creditWallets.financialSubjectRef,
          billingIntents.creditFinancialSubjectRef
        ),
        eq(
          creditWallets.currentUserKeyHash,
          billingIntents.messengerSenderUserKey
        )
      )
    )
    .where(
      and(
        eq(billingIntents.mode, mode),
        eq(billingIntents.kind, "credit_purchase"),
        eq(billingIntents.status, "created"),
        sql`UNIX_TIMESTAMP(${billingIntents.checkoutCapabilityExpiresAt}) < ${Math.floor(now.getTime() / 1_000)}`,
        isNull(billingIntents.molliePaymentId),
        isNull(billingIntents.urlExposedAt),
        isNull(billingIntents.paidAt),
        isNull(billingIntents.creditIdentityErasedAt),
        inArray(creditWallets.status, ["active", "frozen"]),
        isNull(creditWallets.privacyErasedAt),
        notExists(
          database
            .select({ value: sql`1` })
            .from(billingProviderOperations)
            .where(
              and(
                eq(
                  billingProviderOperations.workspaceId,
                  billingIntents.workspaceId
                ),
                eq(billingProviderOperations.mode, billingIntents.mode),
                or(
                  eq(
                    billingProviderOperations.intentId,
                    billingIntents.intentId
                  ),
                  eq(
                    billingProviderOperations.operationKey,
                    billingIntents.intentId
                  )
                )
              )
            )
        ),
        notExists(
          database
            .select({ value: sql`1` })
            .from(billingWebhookRoutes)
            .where(
              and(
                eq(
                  billingWebhookRoutes.workspaceId,
                  billingIntents.workspaceId
                ),
                eq(billingWebhookRoutes.mode, billingIntents.mode),
                eq(billingWebhookRoutes.intentId, billingIntents.intentId)
              )
            )
        ),
        notExists(
          database
            .select({ value: sql`1` })
            .from(paymentLedger)
            .where(
              and(
                eq(paymentLedger.workspaceId, billingIntents.workspaceId),
                eq(paymentLedger.mode, billingIntents.mode),
                or(
                  eq(paymentLedger.creditIntentId, billingIntents.intentId),
                  eq(
                    paymentLedger.paymentEffectOwnerRef,
                    billingIntents.intentId
                  )
                )
              )
            )
        ),
        notExists(
          database
            .select({ value: sql`1` })
            .from(creditLedger)
            .where(
              and(
                eq(creditLedger.workspaceId, billingIntents.workspaceId),
                eq(creditLedger.mode, billingIntents.mode),
                eq(creditLedger.sourceIntentId, billingIntents.intentId)
              )
            )
        ),
        notExists(
          database
            .select({ value: sql`1` })
            .from(billingSubscriptions)
            .where(
              and(
                eq(
                  billingSubscriptions.workspaceId,
                  billingIntents.workspaceId
                ),
                eq(billingSubscriptions.mode, billingIntents.mode),
                eq(billingSubscriptions.sourceIntentId, billingIntents.intentId)
              )
            )
        ),
        notExists(
          database
            .select({ value: sql`1` })
            .from(workspaceEntitlements)
            .where(
              and(
                eq(
                  workspaceEntitlements.workspaceId,
                  billingIntents.workspaceId
                ),
                eq(workspaceEntitlements.mode, billingIntents.mode),
                eq(
                  workspaceEntitlements.sourceIntentId,
                  billingIntents.intentId
                )
              )
            )
        ),
        notExists(
          database
            .select({ value: sql`1` })
            .from(workspaceEntitlementUsage)
            .where(
              and(
                eq(
                  workspaceEntitlementUsage.workspaceId,
                  billingIntents.workspaceId
                ),
                eq(workspaceEntitlementUsage.mode, billingIntents.mode),
                eq(
                  workspaceEntitlementUsage.sourceIntentId,
                  billingIntents.intentId
                )
              )
            )
        ),
        notExists(
          database
            .select({ value: sql`1` })
            .from(billingOutbox)
            .where(
              and(
                eq(billingOutbox.workspaceId, billingIntents.workspaceId),
                eq(billingOutbox.mode, billingIntents.mode),
                sql`JSON_SEARCH(${billingOutbox.payload}, 'one', ${billingIntents.intentId}) IS NOT NULL`
              )
            )
        )
      )
    )
    .orderBy(
      asc(billingIntents.checkoutCapabilityExpiresAt),
      asc(billingIntents.intentId)
    )
    .limit(boundedLimit);

  return rows.flatMap(row =>
    row.walletId &&
    row.channelConnectionId &&
    row.bindingEpoch &&
    row.privacyEpoch &&
    row.userKey &&
    row.financialSubjectRef
      ? [Object.freeze({ ...row } as ExpiredPristineCreditCheckout)]
      : []
  );
}

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

/**
 * Discovers terminal reservations whose short-lived request/owner hashes have
 * reached their retention boundary. The definer routine repeats the exact
 * financial scope and deadline checks under locks; this query only keeps the
 * operational scrub worker bounded and oldest-first.
 */
export async function listTerminalCreditReservationsForScrub(
  mode: MollieMode,
  now: Date,
  limit = 25
): Promise<readonly TerminalCreditReservationForScrub[]> {
  if (
    (mode !== "test" && mode !== "live") ||
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime()) ||
    !Number.isSafeInteger(limit) ||
    limit < 1
  ) {
    throw new Error("Terminal credit reservation scrub input is invalid");
  }
  const boundedLimit = Math.min(MAX_BATCH_SIZE, limit);
  const database = await getDatabaseOrThrow();
  return database
    .select({
      reservationId: creditReservations.reservationId,
      walletId: creditReservations.walletId,
      workspaceId: creditReservations.workspaceId,
      mode: creditReservations.mode,
      channelConnectionId: creditReservations.channelConnectionId,
      bindingEpoch: creditReservations.bindingEpoch,
      privacyEpoch: creditReservations.privacyEpoch,
      financialSubjectRef: creditReservations.financialSubjectRef,
    })
    .from(creditReservations)
    .where(
      and(
        eq(creditReservations.mode, mode),
        inArray(creditReservations.status, [
          "committed",
          "released",
          "expired",
        ]),
        lte(creditReservations.resolutionDueAt, now),
        isNull(creditReservations.operationalScrubbedAt),
        isNotNull(creditReservations.generationRequestKeyHash),
        isNotNull(creditReservations.ownerTokenHash)
      )
    )
    .orderBy(
      asc(creditReservations.resolutionDueAt),
      asc(creditReservations.reservationId)
    )
    .limit(boundedLimit);
}

/**
 * Finds holds whose provider boundary has already been crossed and whose
 * bounded resolution window elapsed. A known accepted response can be
 * settled from its immutable reservation proof; an unknown transport is kept
 * held and escalated through the key-free operator plane.
 */
export async function listDueCreditReservationResolutions(
  mode: MollieMode,
  now: Date,
  limit = 25
): Promise<readonly DueCreditReservationResolution[]> {
  if (
    (mode !== "test" && mode !== "live") ||
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime()) ||
    !Number.isSafeInteger(limit) ||
    limit < 1
  ) {
    throw new Error("Credit reservation resolution input is invalid");
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
      transportState: creditReservations.transportState,
      generationRequestKeyHash: creditReservations.generationRequestKeyHash,
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
        inArray(creditReservations.transportState, [
          "transport_started",
          "known_accepted",
        ]),
        lte(creditReservations.resolutionDueAt, now),
        isNotNull(creditReservations.ownerTokenHash),
        isNotNull(creditReservations.generationRequestKeyHash),
        isNotNull(creditWallets.currentUserKeyHash),
        inArray(creditWallets.status, ["active", "frozen"]),
        // Once an unresolved transport owns its durable operator item, leave
        // it held but remove it from future bounded batches. Without this
        // anti-join the oldest 25 ambiguous rows would starve every later
        // reservation indefinitely.
        sql`NOT EXISTS (
          SELECT 1 FROM \`billing_outbox\` AS \`credit_transport_reviews\`
          WHERE \`credit_transport_reviews\`.\`workspace_id\` = \`credit_reservations\`.\`workspace_id\`
            AND \`credit_transport_reviews\`.\`mode\` = \`credit_reservations\`.\`mode\`
            AND \`credit_transport_reviews\`.\`event_type\` = 'manual_review'
            AND \`credit_transport_reviews\`.\`deduplication_key\` = CONCAT('credit_reservation_transport_review:', \`credit_reservations\`.\`reservation_id\`)
        )`
      )
    )
    .orderBy(
      asc(creditReservations.resolutionDueAt),
      asc(creditReservations.reservationId)
    )
    .limit(boundedLimit);

  return rows.flatMap(row =>
    row.userKey &&
    row.ownerTokenHash &&
    row.generationRequestKeyHash &&
    (row.transportState === "transport_started" ||
      row.transportState === "known_accepted")
      ? [
          Object.freeze({
            ...row,
            userKey: row.userKey,
            ownerTokenHash: row.ownerTokenHash,
            generationRequestKeyHash: row.generationRequestKeyHash,
            transportState: row.transportState,
          }),
        ]
      : []
  );
}

/**
 * A started transport has no trusted success or failure evidence. Keep the
 * credit held and create one durable, metadata-only operator item instead of
 * guessing a debit or release.
 */
export async function enqueueCreditReservationTransportReview(
  row: DueCreditReservationResolution
): Promise<void> {
  const database = await getDatabaseOrThrow();
  await database
    .insert(billingOutbox)
    .values({
      workspaceId: row.workspaceId,
      mode: row.mode,
      eventType: "manual_review",
      deduplicationKey: `credit_reservation_transport_review:${row.reservationId}`,
      payload: {
        reason: "credit_reservation_transport_ambiguous",
        reservationId: row.reservationId,
        walletId: row.walletId,
        creditPurpose: "premium_image_credits",
      },
      status: "pending",
    })
    .onDuplicateKeyUpdate({
      set: { deduplicationKey: sql`deduplication_key` },
    });
}
