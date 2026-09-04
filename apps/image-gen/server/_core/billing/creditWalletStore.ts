import { and, eq, sql, type SQL } from "drizzle-orm";

import { creditWallets } from "../../../drizzle/schema";
import { getDatabaseOrThrow, type ImageGenTransaction } from "../../db";
import type { MollieMode } from "./config";
import {
  type CreditOffer,
  getCreditOffer,
  PREMIUM_IMAGE_CREDIT_OFFER_ID,
  PREMIUM_IMAGE_CREDIT_OFFER_VERSION,
} from "./creditCatalog";

const MAX_DATABASE_ID = 2_147_483_647;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PRIVACY_SUBJECT_USER_KEY_PATTERN =
  /^(?:[0-9a-f]{64}|u2[.]k[1-9][0-9]{0,5}[.][0-9a-f]{64})$/;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const PAYMENT_ID_PATTERN = /^tr_[A-Za-z0-9]{1,60}$/;
const CHECKOUT_SCOPE_KEY_PATTERN = /^credit-checkout:v1:[0-9a-f]{64}$/;

export class CreditWalletStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreditWalletStoreError";
  }
}

export type CreditWalletScope = Readonly<{
  workspaceId: number;
  mode: MollieMode;
  channelConnectionId: number;
  bindingEpoch: number;
  privacyEpoch: number;
  userKey: string;
  walletId: string;
  financialSubjectRef: string;
}>;

export type CreditWalletFinancialScope = Readonly<
  Omit<CreditWalletScope, "userKey">
>;

export type CreditWalletReviewScope = CreditWalletFinancialScope &
  Readonly<{
    intentId: string;
    paymentLedgerId: number;
    providerPaymentId: string;
    snapshotHash: string;
  }>;

export type AppliedResult = Readonly<{
  result: "applied" | "already_applied";
}>;

export type CreditCheckoutReservationResult = AppliedResult &
  Readonly<{ intentId: string; walletId: string }>;
export type CapabilityConsumptionResult = AppliedResult &
  Readonly<{ intentId: string }>;
export type PristineCheckoutExpiryResult = Readonly<{
  result: "applied" | "already_applied" | "skipped";
  intentId: string;
}>;
export type PurchaseGrantResult = AppliedResult & Readonly<{ entryId: string }>;
export type ReservationResult = AppliedResult &
  Readonly<{ reservationId: string }>;
export type WalletErasureResult = Readonly<{
  result:
    | "already_applied"
    | "erased"
    | "pending_adjustment"
    | "pending_holds"
    | "pending_provider";
  walletId: string;
}>;
export type PrivacySubjectWalletErasureResult = Readonly<{
  result: "erased" | "pending";
  walletCount: number;
}>;
export type CreditDebitResult =
  | (AppliedResult & Readonly<{ entryId: string }>)
  | Readonly<{
      result: "manual_review" | "pending_holds";
      rootGrantEntryId: string;
    }>;
export type ChargebackRestoreResult = Readonly<{
  result: "already_applied" | "applied_review_required";
  entryId: string;
}>;
export type CreditWalletFreezeResult = AppliedResult &
  Readonly<{ walletId: string }>;

type ResultContract = Readonly<{
  allowed: ReadonlySet<string>;
  identifiers: Readonly<
    Record<string, Readonly<{ column: string; value: string }>>
  >;
}>;

function invalid(field: string): never {
  throw new CreditWalletStoreError(`Invalid credit wallet ${field}`);
}

function assertDatabaseId(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DATABASE_ID) {
    invalid(field);
  }
}

function assertMode(value: MollieMode): void {
  if (value !== "test" && value !== "live") invalid("mode");
}

function assertUuid(value: string, field: string): void {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) invalid(field);
}

function assertSha256(value: string, field: string): void {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) invalid(field);
}

function assertCheckoutScopeKey(value: string): void {
  if (typeof value !== "string" || !CHECKOUT_SCOPE_KEY_PATTERN.test(value)) {
    invalid("checkout scope key");
  }
}

function assertValidDate(value: Date, field: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    invalid(field);
  }
}

function assertUserKey(value: string): void {
  if (
    typeof value !== "string" ||
    !PRIVACY_SUBJECT_USER_KEY_PATTERN.test(value)
  ) {
    invalid("user key");
  }
}

function assertProviderId(value: string, field: string): void {
  if (typeof value !== "string" || !PROVIDER_ID_PATTERN.test(value)) {
    invalid(field);
  }
}

function assertPaymentId(value: string): void {
  if (typeof value !== "string" || !PAYMENT_ID_PATTERN.test(value)) {
    invalid("provider payment ID");
  }
}

function assertFinancialScope(scope: CreditWalletFinancialScope): void {
  assertDatabaseId(scope.workspaceId, "workspace ID");
  assertMode(scope.mode);
  assertDatabaseId(scope.channelConnectionId, "channel connection ID");
  assertDatabaseId(scope.bindingEpoch, "binding epoch");
  assertDatabaseId(scope.privacyEpoch, "privacy epoch");
  assertUuid(scope.walletId, "wallet ID");
  assertSha256(scope.financialSubjectRef, "financial subject reference");
}

function assertCurrentScope(scope: CreditWalletScope): void {
  assertFinancialScope(scope);
  assertUserKey(scope.userKey);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function parseProcedureResult(
  execution: unknown,
  contract: ResultContract
): Record<string, string> {
  if (!Array.isArray(execution) || execution.length !== 2) {
    throw new CreditWalletStoreError(
      "Credit wallet procedure returned a malformed result"
    );
  }
  const executionTuple: readonly unknown[] = execution;
  const rows = executionTuple[0];
  if (!Array.isArray(rows) || rows.length !== 2) {
    throw new CreditWalletStoreError(
      "Credit wallet procedure returned a malformed result"
    );
  }
  const procedureRows: readonly unknown[] = rows;
  const resultSet = procedureRows[0];
  const terminalHeader = procedureRows[1];
  if (
    !Array.isArray(resultSet) ||
    resultSet.length !== 1 ||
    Array.isArray(terminalHeader) ||
    typeof terminalHeader !== "object" ||
    terminalHeader === null
  ) {
    throw new CreditWalletStoreError(
      "Credit wallet procedure returned a malformed result"
    );
  }
  const resultRows: readonly unknown[] = resultSet;
  const row = resultRows[0];
  if (!isPlainRecord(row) || typeof row.result !== "string") {
    throw new CreditWalletStoreError(
      "Credit wallet procedure returned a malformed result"
    );
  }
  const expectedIdentifier = contract.identifiers[row.result];
  if (!contract.allowed.has(row.result) || expectedIdentifier === undefined) {
    throw new CreditWalletStoreError(
      "Credit wallet procedure returned an unknown status"
    );
  }
  const keys = Object.keys(row).sort();
  const expectedKeys = ["result", expectedIdentifier.column].sort();
  if (
    keys.length !== 2 ||
    keys[0] !== expectedKeys[0] ||
    keys[1] !== expectedKeys[1] ||
    row[expectedIdentifier.column] !== expectedIdentifier.value
  ) {
    throw new CreditWalletStoreError(
      "Credit wallet procedure returned a malformed result"
    );
  }
  return {
    result: row.result,
    [expectedIdentifier.column]: expectedIdentifier.value,
  };
}

async function executeProcedure(
  query: SQL,
  contract: ResultContract
): Promise<Record<string, string>> {
  const database = await getDatabaseOrThrow();
  const execution = await database.execute(query);
  return parseProcedureResult(execution, contract);
}

export async function freezeCreditWalletForReview(
  tx: ImageGenTransaction,
  input: CreditWalletReviewScope
): Promise<CreditWalletFreezeResult> {
  assertFinancialScope(input);
  assertUuid(input.intentId, "intent ID");
  assertDatabaseId(input.paymentLedgerId, "payment ledger ID");
  assertPaymentId(input.providerPaymentId);
  assertSha256(input.snapshotHash, "payment snapshot hash");
  const execution = await tx.execute(
    sql`CALL \`credit_freeze_wallet_for_review\`(${input.workspaceId}, ${input.mode}, ${input.channelConnectionId}, ${input.bindingEpoch}, ${input.privacyEpoch}, ${input.walletId}, ${input.financialSubjectRef}, ${input.intentId}, ${input.paymentLedgerId}, ${input.providerPaymentId}, ${input.snapshotHash})`
  );
  const row = parseProcedureResult(
    execution,
    contract(["applied", "already_applied"], "wallet_id", input.walletId)
  );
  return {
    result: row.result as CreditWalletFreezeResult["result"],
    walletId: input.walletId,
  };
}

function contract(
  statuses: readonly string[],
  identifierColumn: string,
  identifierValue: string
): ResultContract {
  return {
    allowed: new Set(statuses),
    identifiers: Object.fromEntries(
      statuses.map(status => [
        status,
        { column: identifierColumn, value: identifierValue },
      ])
    ),
  };
}

function splitContract(
  entryStatuses: readonly string[],
  entryId: string,
  reviewStatuses: readonly string[],
  rootGrantEntryId: string
): ResultContract {
  return {
    allowed: new Set([...entryStatuses, ...reviewStatuses]),
    identifiers: {
      ...Object.fromEntries(
        entryStatuses.map(status => [
          status,
          { column: "entry_id", value: entryId },
        ])
      ),
      ...Object.fromEntries(
        reviewStatuses.map(status => [
          status,
          { column: "root_grant_entry_id", value: rootGrantEntryId },
        ])
      ),
    },
  };
}

export async function reserveCreditCheckoutIntent(input: {
  intentId: string;
  walletId: string;
  workspaceId: number;
  mode: MollieMode;
  channelConnectionId: number;
  bindingEpoch: number;
  privacyEpoch: number;
  userKey: string;
  financialSubjectRef: string;
  authorizationEpoch: number;
  offerSnapshotCode: CreditOffer["offerId"];
  expectedAmount: CreditOffer["amount"]["value"];
  creditCount: CreditOffer["creditCount"];
  description: string;
  metadataHash: string;
  idempotencyKey: string;
  checkoutScopeKey: string;
  capabilityHash: string;
  capabilityExpiresAt: Date;
}): Promise<CreditCheckoutReservationResult> {
  assertCurrentScope(input);
  assertUuid(input.intentId, "intent ID");
  assertDatabaseId(input.authorizationEpoch, "authorization epoch");
  const offer = getCreditOffer(
    PREMIUM_IMAGE_CREDIT_OFFER_ID,
    PREMIUM_IMAGE_CREDIT_OFFER_VERSION
  );
  if (!offer || input.offerSnapshotCode !== offer.offerId) {
    invalid("offer snapshot code");
  }
  if (input.expectedAmount !== offer.amount.value) {
    invalid("expected amount");
  }
  if (input.creditCount !== offer.creditCount) {
    invalid("credit count");
  }
  if (input.description !== offer.mollieDescription) {
    invalid("description");
  }
  assertSha256(input.metadataHash, "metadata hash");
  if (input.idempotencyKey !== `credit-payment:${input.intentId}`) {
    invalid("idempotency key");
  }
  assertCheckoutScopeKey(input.checkoutScopeKey);
  assertSha256(input.capabilityHash, "capability hash");
  assertValidDate(input.capabilityExpiresAt, "capability expiry");

  const database = await getDatabaseOrThrow();
  const execution = await database.execute(
    sql`CALL \`credit_reserve_checkout_intent\`(${input.intentId}, ${input.walletId}, ${input.workspaceId}, ${input.mode}, ${input.channelConnectionId}, ${input.bindingEpoch}, ${input.privacyEpoch}, ${input.userKey}, ${input.financialSubjectRef}, ${input.authorizationEpoch}, ${input.offerSnapshotCode}, ${input.expectedAmount}, ${input.creditCount}, ${input.description}, ${input.metadataHash}, ${input.idempotencyKey}, ${input.checkoutScopeKey}, ${input.capabilityHash}, ${input.capabilityExpiresAt})`
  );
  if (!Array.isArray(execution) || execution.length !== 2) {
    throw new CreditWalletStoreError(
      "Credit wallet procedure returned a malformed result"
    );
  }
  const executionTuple: readonly unknown[] = execution;
  const rows = executionTuple[0];
  if (!Array.isArray(rows) || rows.length !== 2) {
    throw new CreditWalletStoreError(
      "Credit wallet procedure returned a malformed result"
    );
  }
  const procedureRows: readonly unknown[] = rows;
  const resultSet = procedureRows[0];
  const terminalHeader = procedureRows[1];
  if (
    !Array.isArray(resultSet) ||
    resultSet.length !== 1 ||
    Array.isArray(terminalHeader) ||
    typeof terminalHeader !== "object" ||
    terminalHeader === null ||
    !isPlainRecord(resultSet[0])
  ) {
    throw new CreditWalletStoreError(
      "Credit wallet procedure returned a malformed result"
    );
  }
  const row = resultSet[0];
  const keys = Object.keys(row).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "intent_id" ||
    keys[1] !== "result" ||
    keys[2] !== "wallet_id" ||
    (row.result !== "applied" && row.result !== "already_applied") ||
    row.intent_id !== input.intentId ||
    row.wallet_id !== input.walletId
  ) {
    throw new CreditWalletStoreError(
      "Credit wallet procedure returned a malformed result"
    );
  }
  return {
    result: row.result,
    intentId: input.intentId,
    walletId: input.walletId,
  };
}

export async function consumeCreditCheckoutCapability(
  input: CreditWalletScope & {
    intentId: string;
    capabilityHash: string;
    sessionNonceHash: string;
  }
): Promise<CapabilityConsumptionResult> {
  assertCurrentScope(input);
  assertUuid(input.intentId, "intent ID");
  assertSha256(input.capabilityHash, "capability hash");
  assertSha256(input.sessionNonceHash, "session nonce hash");
  const row = await executeProcedure(
    sql`CALL \`credit_consume_checkout_capability\`(${input.workspaceId}, ${input.mode}, ${input.channelConnectionId}, ${input.bindingEpoch}, ${input.privacyEpoch}, ${input.userKey}, ${input.walletId}, ${input.financialSubjectRef}, ${input.intentId}, ${input.capabilityHash}, ${input.sessionNonceHash})`,
    contract(["applied", "already_applied"], "intent_id", input.intentId)
  );
  return {
    result: row.result as AppliedResult["result"],
    intentId: input.intentId,
  };
}

/**
 * Removes only an expired checkout that never crossed the browser/provider
 * boundary. The definer routine rechecks every identity and evidence fence
 * under the canonical database lock order before deleting the pristine intent
 * and its otherwise unused zero-balance wallet atomically.
 */
export async function expirePristineCreditCheckout(
  input: CreditWalletScope & { intentId: string }
): Promise<PristineCheckoutExpiryResult> {
  assertCurrentScope(input);
  assertUuid(input.intentId, "intent ID");
  const row = await executeProcedure(
    sql`CALL \`credit_expire_pristine_checkout\`(${input.workspaceId}, ${input.mode}, ${input.channelConnectionId}, ${input.bindingEpoch}, ${input.privacyEpoch}, ${input.userKey}, ${input.walletId}, ${input.financialSubjectRef}, ${input.intentId})`,
    contract(
      ["applied", "already_applied", "skipped"],
      "intent_id",
      input.intentId
    )
  );
  return {
    result: row.result as PristineCheckoutExpiryResult["result"],
    intentId: input.intentId,
  };
}

export async function grantCreditPurchase(
  input: CreditWalletScope & {
    intentId: string;
    providerPaymentId: string;
    entryId: string;
    evidenceHash: string;
  }
): Promise<PurchaseGrantResult> {
  assertCurrentScope(input);
  assertUuid(input.intentId, "intent ID");
  assertProviderId(input.providerPaymentId, "provider payment ID");
  assertUuid(input.entryId, "entry ID");
  assertSha256(input.evidenceHash, "evidence hash");
  const row = await executeProcedure(
    sql`CALL \`credit_grant_purchase\`(${input.workspaceId}, ${input.mode}, ${input.channelConnectionId}, ${input.bindingEpoch}, ${input.privacyEpoch}, ${input.userKey}, ${input.walletId}, ${input.financialSubjectRef}, ${input.intentId}, ${input.providerPaymentId}, ${input.entryId}, ${input.evidenceHash})`,
    contract(["applied", "already_applied"], "entry_id", input.entryId)
  );
  return {
    result: row.result as AppliedResult["result"],
    entryId: input.entryId,
  };
}

export async function createCreditReservationHold(
  input: CreditWalletScope & {
    reservationId: string;
    generationRequestKeyHash: string;
    ownerTokenHash: string;
    reservedCreditCount: number;
    entryId: string;
    evidenceHash: string;
  }
): Promise<ReservationResult> {
  assertCurrentScope(input);
  assertUuid(input.reservationId, "reservation ID");
  assertSha256(input.generationRequestKeyHash, "generation request hash");
  assertSha256(input.ownerTokenHash, "owner token hash");
  assertDatabaseId(input.reservedCreditCount, "reserved credit count");
  assertUuid(input.entryId, "entry ID");
  assertSha256(input.evidenceHash, "evidence hash");
  const row = await executeProcedure(
    sql`CALL \`credit_create_reservation_hold\`(${input.workspaceId}, ${input.mode}, ${input.channelConnectionId}, ${input.bindingEpoch}, ${input.privacyEpoch}, ${input.userKey}, ${input.walletId}, ${input.financialSubjectRef}, ${input.reservationId}, ${input.generationRequestKeyHash}, ${input.ownerTokenHash}, ${input.reservedCreditCount}, ${input.entryId}, ${input.evidenceHash})`,
    contract(
      ["applied", "already_applied"],
      "reservation_id",
      input.reservationId
    )
  );
  return {
    result: row.result as AppliedResult["result"],
    reservationId: input.reservationId,
  };
}

type ReservationTerminalInput = CreditWalletScope & {
  reservationId: string;
  ownerTokenHash: string;
  entryId: string;
  evidenceHash: string;
};

type ReservationProviderRejectedInput = ReservationTerminalInput & {
  rejectionStatus: number;
};

type ReservationTransportInput = CreditWalletScope & {
  reservationId: string;
  ownerTokenHash: string;
};

async function executeReservationTransport(
  procedure:
    | "credit_mark_reservation_transport_started"
    | "credit_mark_reservation_provider_accepted",
  input: ReservationTransportInput
): Promise<ReservationResult> {
  assertCurrentScope(input);
  assertUuid(input.reservationId, "reservation ID");
  assertSha256(input.ownerTokenHash, "owner token hash");
  const query =
    procedure === "credit_mark_reservation_transport_started"
      ? sql`CALL \`credit_mark_reservation_transport_started\`(${input.workspaceId}, ${input.mode}, ${input.channelConnectionId}, ${input.bindingEpoch}, ${input.privacyEpoch}, ${input.userKey}, ${input.walletId}, ${input.financialSubjectRef}, ${input.reservationId}, ${input.ownerTokenHash})`
      : sql`CALL \`credit_mark_reservation_provider_accepted\`(${input.workspaceId}, ${input.mode}, ${input.channelConnectionId}, ${input.bindingEpoch}, ${input.privacyEpoch}, ${input.userKey}, ${input.walletId}, ${input.financialSubjectRef}, ${input.reservationId}, ${input.ownerTokenHash})`;
  const row = await executeProcedure(
    query,
    contract(
      ["applied", "already_applied"],
      "reservation_id",
      input.reservationId
    )
  );
  return {
    result: row.result as AppliedResult["result"],
    reservationId: input.reservationId,
  };
}

export function markCreditReservationTransportStarted(
  input: ReservationTransportInput
): Promise<ReservationResult> {
  return executeReservationTransport(
    "credit_mark_reservation_transport_started",
    input
  );
}

export function markCreditReservationProviderAccepted(
  input: ReservationTransportInput
): Promise<ReservationResult> {
  return executeReservationTransport(
    "credit_mark_reservation_provider_accepted",
    input
  );
}

function validateReservationTerminalInput(
  input: ReservationTerminalInput
): void {
  assertCurrentScope(input);
  assertUuid(input.reservationId, "reservation ID");
  assertSha256(input.ownerTokenHash, "owner token hash");
  assertUuid(input.entryId, "entry ID");
  assertSha256(input.evidenceHash, "evidence hash");
}

function validateReservationProviderRejectedInput(
  input: ReservationProviderRejectedInput
): void {
  validateReservationTerminalInput(input);
  if (
    !Number.isSafeInteger(input.rejectionStatus) ||
    input.rejectionStatus < 400 ||
    input.rejectionStatus > 499 ||
    input.rejectionStatus === 408 ||
    input.rejectionStatus === 429
  ) {
    invalid("provider rejection status");
  }
}

async function executeReservationTerminal(
  procedure:
    | "credit_commit_reservation"
    | "credit_release_reservation"
    | "credit_expire_reservation",
  input: ReservationTerminalInput,
  releaseKind: "pretransport" | "output_not_delivered" = "pretransport"
): Promise<ReservationResult> {
  validateReservationTerminalInput(input);
  const query =
    procedure === "credit_commit_reservation"
      ? sql`CALL \`credit_commit_reservation\`(${input.workspaceId}, ${input.mode}, ${input.channelConnectionId}, ${input.bindingEpoch}, ${input.privacyEpoch}, ${input.userKey}, ${input.walletId}, ${input.financialSubjectRef}, ${input.reservationId}, ${input.ownerTokenHash}, ${input.entryId}, ${input.evidenceHash})`
      : procedure === "credit_release_reservation"
        ? sql`CALL \`credit_release_reservation\`(${input.workspaceId}, ${input.mode}, ${input.channelConnectionId}, ${input.bindingEpoch}, ${input.privacyEpoch}, ${input.userKey}, ${input.walletId}, ${input.financialSubjectRef}, ${input.reservationId}, ${input.ownerTokenHash}, ${releaseKind}, ${input.entryId}, ${input.evidenceHash})`
        : sql`CALL \`credit_expire_reservation\`(${input.workspaceId}, ${input.mode}, ${input.channelConnectionId}, ${input.bindingEpoch}, ${input.privacyEpoch}, ${input.userKey}, ${input.walletId}, ${input.financialSubjectRef}, ${input.reservationId}, ${input.ownerTokenHash}, ${input.entryId}, ${input.evidenceHash})`;
  const row = await executeProcedure(
    query,
    contract(
      ["applied", "already_applied"],
      "reservation_id",
      input.reservationId
    )
  );
  return {
    result: row.result as AppliedResult["result"],
    reservationId: input.reservationId,
  };
}

export function commitCreditReservation(
  input: ReservationTerminalInput
): Promise<ReservationResult> {
  return executeReservationTerminal("credit_commit_reservation", input);
}

export function releaseCreditReservation(
  input: ReservationTerminalInput
): Promise<ReservationResult> {
  return executeReservationTerminal("credit_release_reservation", input);
}

/** Releases started or accepted work only after proven non-delivery. */
export function releaseCreditReservationOutputNotDelivered(
  input: ReservationTerminalInput
): Promise<ReservationResult> {
  return executeReservationTerminal(
    "credit_release_reservation",
    input,
    "output_not_delivered"
  );
}

/** Releases an already-started hold only with an exact non-retryable 4xx. */
export async function releaseCreditReservationAfterProviderRejection(
  input: ReservationProviderRejectedInput
): Promise<ReservationResult> {
  validateReservationProviderRejectedInput(input);
  const row = await executeProcedure(
    sql`CALL \`credit_release_rejected_reservation\`(${input.workspaceId}, ${input.mode}, ${input.channelConnectionId}, ${input.bindingEpoch}, ${input.privacyEpoch}, ${input.userKey}, ${input.walletId}, ${input.financialSubjectRef}, ${input.reservationId}, ${input.ownerTokenHash}, ${input.rejectionStatus}, ${input.entryId}, ${input.evidenceHash})`,
    contract(
      ["applied", "already_applied"],
      "reservation_id",
      input.reservationId
    )
  );
  return {
    result: row.result as AppliedResult["result"],
    reservationId: input.reservationId,
  };
}

export function expireCreditReservation(
  input: ReservationTerminalInput
): Promise<ReservationResult> {
  return executeReservationTerminal("credit_expire_reservation", input);
}

export async function scrubTerminalCreditReservation(
  input: CreditWalletFinancialScope & { reservationId: string }
): Promise<ReservationResult> {
  assertFinancialScope(input);
  assertUuid(input.reservationId, "reservation ID");
  const row = await executeProcedure(
    sql`CALL \`credit_scrub_terminal_reservation\`(${input.workspaceId}, ${input.mode}, ${input.channelConnectionId}, ${input.bindingEpoch}, ${input.privacyEpoch}, ${input.walletId}, ${input.financialSubjectRef}, ${input.reservationId})`,
    contract(
      ["applied", "already_applied"],
      "reservation_id",
      input.reservationId
    )
  );
  return {
    result: row.result as AppliedResult["result"],
    reservationId: input.reservationId,
  };
}

export async function eraseCreditWallet(
  input: CreditWalletScope & { erasurePrivacyEpoch: number }
): Promise<WalletErasureResult> {
  assertCurrentScope(input);
  assertDatabaseId(input.erasurePrivacyEpoch, "erasure privacy epoch");
  if (input.erasurePrivacyEpoch !== input.privacyEpoch + 1) {
    invalid("erasure privacy epoch");
  }
  const statuses = [
    "already_applied",
    "erased",
    "pending_adjustment",
    "pending_holds",
    "pending_provider",
  ] as const;
  const row = await executeProcedure(
    sql`CALL \`credit_erase_wallet\`(${input.workspaceId}, ${input.mode}, ${input.channelConnectionId}, ${input.bindingEpoch}, ${input.privacyEpoch}, ${input.erasurePrivacyEpoch}, ${input.userKey}, ${input.walletId}, ${input.financialSubjectRef})`,
    contract(statuses, "wallet_id", input.walletId)
  );
  return {
    result: row.result as WalletErasureResult["result"],
    walletId: input.walletId,
  };
}

/**
 * Erases only wallets linked to one exact Messenger privacy subject. The
 * privacy key remains the deletion/FK key; the financial reference is read
 * from the already-bound wallet and is never derived from or exposed to the
 * deletion caller.
 */
export async function eraseCreditWalletsForPrivacySubject(input: {
  workspaceId: number;
  channelConnectionId: number;
  bindingEpoch: number;
  dataPrivacyEpoch: number;
  erasurePrivacyEpoch: number;
  userKey: string;
}): Promise<PrivacySubjectWalletErasureResult> {
  assertDatabaseId(input.workspaceId, "workspace ID");
  assertDatabaseId(input.channelConnectionId, "channel connection ID");
  assertDatabaseId(input.bindingEpoch, "binding epoch");
  assertDatabaseId(input.dataPrivacyEpoch, "data privacy epoch");
  assertDatabaseId(input.erasurePrivacyEpoch, "erasure privacy epoch");
  assertUserKey(input.userKey);
  if (input.erasurePrivacyEpoch !== input.dataPrivacyEpoch + 1) {
    invalid("erasure privacy epoch");
  }

  const database = await getDatabaseOrThrow();
  const wallets = await database
    .select({
      financialSubjectRef: creditWallets.financialSubjectRef,
      mode: creditWallets.mode,
      walletId: creditWallets.walletId,
    })
    .from(creditWallets)
    .where(
      and(
        eq(creditWallets.workspaceId, input.workspaceId),
        eq(creditWallets.channelConnectionId, input.channelConnectionId),
        eq(creditWallets.bindingEpoch, input.bindingEpoch),
        eq(creditWallets.privacyEpoch, input.dataPrivacyEpoch),
        eq(creditWallets.currentUserKeyHash, input.userKey)
      )
    )
    .limit(3);
  if (wallets.length > 2) {
    throw new CreditWalletStoreError(
      "Credit wallet privacy scope returned too many wallets"
    );
  }

  let pending = false;
  for (const wallet of wallets) {
    const outcome = await eraseCreditWallet({
      workspaceId: input.workspaceId,
      mode: wallet.mode,
      channelConnectionId: input.channelConnectionId,
      bindingEpoch: input.bindingEpoch,
      privacyEpoch: input.dataPrivacyEpoch,
      erasurePrivacyEpoch: input.erasurePrivacyEpoch,
      userKey: input.userKey,
      walletId: wallet.walletId,
      financialSubjectRef: wallet.financialSubjectRef,
    });
    if (
      outcome.result === "pending_adjustment" ||
      outcome.result === "pending_holds" ||
      outcome.result === "pending_provider"
    ) {
      pending = true;
    }
  }
  return {
    result: pending ? "pending" : "erased",
    walletCount: wallets.length,
  };
}

type CreditAdjustmentInput = CreditWalletFinancialScope & {
  rootGrantEntryId: string;
  entryId: string;
  evidenceHash: string;
};

type CreditChargebackAdjustmentInput = CreditAdjustmentInput & {
  providerEffectId: string;
};

function validateAdjustmentInput(input: CreditAdjustmentInput): void {
  assertFinancialScope(input);
  assertUuid(input.rootGrantEntryId, "root grant entry ID");
  assertUuid(input.entryId, "entry ID");
  assertSha256(input.evidenceHash, "evidence hash");
}

function validateChargebackAdjustmentInput(
  input: CreditChargebackAdjustmentInput
): void {
  validateAdjustmentInput(input);
  assertProviderId(input.providerEffectId, "provider effect ID");
}

async function executeCreditDebit(
  query: SQL,
  input: CreditAdjustmentInput
): Promise<CreditDebitResult> {
  const row = await executeProcedure(
    query,
    splitContract(
      ["applied", "already_applied"],
      input.entryId,
      ["manual_review", "pending_holds"],
      input.rootGrantEntryId
    )
  );
  if (row.result === "applied" || row.result === "already_applied") {
    return { result: row.result, entryId: input.entryId };
  }
  return {
    result: row.result as "manual_review" | "pending_holds",
    rootGrantEntryId: input.rootGrantEntryId,
  };
}

export async function applyCreditRefundDebit(
  input: CreditAdjustmentInput
): Promise<CreditDebitResult> {
  validateAdjustmentInput(input);
  return executeCreditDebit(
    sql`CALL \`credit_apply_refund_debit\`(${input.workspaceId}, ${input.mode}, ${input.channelConnectionId}, ${input.bindingEpoch}, ${input.privacyEpoch}, ${input.walletId}, ${input.financialSubjectRef}, ${input.rootGrantEntryId}, ${input.entryId}, ${input.evidenceHash})`,
    input
  );
}

export async function applyCreditChargebackDebit(
  input: CreditChargebackAdjustmentInput
): Promise<CreditDebitResult> {
  validateChargebackAdjustmentInput(input);
  return executeCreditDebit(
    sql`CALL \`credit_apply_chargeback_debit\`(${input.workspaceId}, ${input.mode}, ${input.channelConnectionId}, ${input.bindingEpoch}, ${input.privacyEpoch}, ${input.walletId}, ${input.financialSubjectRef}, ${input.rootGrantEntryId}, ${input.providerEffectId}, ${input.entryId}, ${input.evidenceHash})`,
    input
  );
}

export async function applyCreditChargebackRestore(
  input: CreditChargebackAdjustmentInput
): Promise<ChargebackRestoreResult> {
  validateChargebackAdjustmentInput(input);
  const row = await executeProcedure(
    sql`CALL \`credit_apply_chargeback_restore\`(${input.workspaceId}, ${input.mode}, ${input.channelConnectionId}, ${input.bindingEpoch}, ${input.privacyEpoch}, ${input.walletId}, ${input.financialSubjectRef}, ${input.rootGrantEntryId}, ${input.providerEffectId}, ${input.entryId}, ${input.evidenceHash})`,
    contract(
      ["already_applied", "applied_review_required"],
      "entry_id",
      input.entryId
    )
  );
  return {
    result: row.result as ChargebackRestoreResult["result"],
    entryId: input.entryId,
  };
}
