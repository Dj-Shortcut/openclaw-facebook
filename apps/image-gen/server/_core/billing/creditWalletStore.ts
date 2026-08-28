import { sql, type SQL } from "drizzle-orm";

import { getDatabaseOrThrow } from "../../db";
import type { MollieMode } from "./config";

const MAX_DATABASE_ID = 2_147_483_647;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CONVERSATION_USER_KEY_PATTERN = /^u2[.]k[1-9][0-9]{0,5}[.][0-9a-f]{64}$/;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

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

export type AppliedResult = Readonly<{
  result: "applied" | "already_applied";
}>;

export type WalletCreationResult = AppliedResult &
  Readonly<{ walletId: string }>;
export type CapabilityConsumptionResult = AppliedResult &
  Readonly<{ intentId: string }>;
export type PurchaseGrantResult = AppliedResult & Readonly<{ entryId: string }>;
export type ReservationResult = AppliedResult &
  Readonly<{ reservationId: string }>;
export type WalletErasureResult = Readonly<{
  result:
    "already_applied" | "erased" | "erased_pending_provider" | "pending_holds";
  walletId: string;
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

function assertUserKey(value: string): void {
  if (typeof value !== "string" || !CONVERSATION_USER_KEY_PATTERN.test(value)) {
    invalid("user key");
  }
}

function assertProviderId(value: string, field: string): void {
  if (typeof value !== "string" || !PROVIDER_ID_PATTERN.test(value)) {
    invalid(field);
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

export async function createCreditWallet(input: {
  walletId: string;
  workspaceId: number;
  mode: MollieMode;
  channelConnectionId: number;
  bindingEpoch: number;
  privacyEpoch: number;
  userKey: string;
  financialSubjectRef: string;
}): Promise<WalletCreationResult> {
  assertCurrentScope(input);
  const row = await executeProcedure(
    sql`CALL \`credit_create_wallet\`(${input.walletId}, ${input.workspaceId}, ${input.mode}, ${input.channelConnectionId}, ${input.bindingEpoch}, ${input.privacyEpoch}, ${input.userKey}, ${input.financialSubjectRef})`,
    contract(["applied", "already_applied"], "wallet_id", input.walletId)
  );
  return {
    result: row.result as AppliedResult["result"],
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

function validateReservationTerminalInput(
  input: ReservationTerminalInput
): void {
  assertCurrentScope(input);
  assertUuid(input.reservationId, "reservation ID");
  assertSha256(input.ownerTokenHash, "owner token hash");
  assertUuid(input.entryId, "entry ID");
  assertSha256(input.evidenceHash, "evidence hash");
}

async function executeReservationTerminal(
  procedure:
    | "credit_commit_reservation"
    | "credit_release_reservation"
    | "credit_expire_reservation",
  input: ReservationTerminalInput
): Promise<ReservationResult> {
  validateReservationTerminalInput(input);
  const query =
    procedure === "credit_commit_reservation"
      ? sql`CALL \`credit_commit_reservation\`(${input.workspaceId}, ${input.mode}, ${input.channelConnectionId}, ${input.bindingEpoch}, ${input.privacyEpoch}, ${input.userKey}, ${input.walletId}, ${input.financialSubjectRef}, ${input.reservationId}, ${input.ownerTokenHash}, ${input.entryId}, ${input.evidenceHash})`
      : procedure === "credit_release_reservation"
        ? sql`CALL \`credit_release_reservation\`(${input.workspaceId}, ${input.mode}, ${input.channelConnectionId}, ${input.bindingEpoch}, ${input.privacyEpoch}, ${input.userKey}, ${input.walletId}, ${input.financialSubjectRef}, ${input.reservationId}, ${input.ownerTokenHash}, ${input.entryId}, ${input.evidenceHash})`
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
  input: CreditWalletScope
): Promise<WalletErasureResult> {
  assertCurrentScope(input);
  const statuses = [
    "already_applied",
    "erased",
    "erased_pending_provider",
    "pending_holds",
  ] as const;
  const row = await executeProcedure(
    sql`CALL \`credit_erase_wallet\`(${input.workspaceId}, ${input.mode}, ${input.channelConnectionId}, ${input.bindingEpoch}, ${input.privacyEpoch}, ${input.userKey}, ${input.walletId}, ${input.financialSubjectRef})`,
    contract(statuses, "wallet_id", input.walletId)
  );
  return {
    result: row.result as WalletErasureResult["result"],
    walletId: input.walletId,
  };
}

type CreditAdjustmentInput = CreditWalletFinancialScope & {
  rootGrantEntryId: string;
  providerEffectId: string;
  entryId: string;
  evidenceHash: string;
};

function validateAdjustmentInput(input: CreditAdjustmentInput): void {
  assertFinancialScope(input);
  assertUuid(input.rootGrantEntryId, "root grant entry ID");
  assertProviderId(input.providerEffectId, "provider effect ID");
  assertUuid(input.entryId, "entry ID");
  assertSha256(input.evidenceHash, "evidence hash");
}

async function executeCreditDebit(
  procedure: "credit_apply_refund_debit" | "credit_apply_chargeback_debit",
  input: CreditAdjustmentInput
): Promise<CreditDebitResult> {
  validateAdjustmentInput(input);
  const query =
    procedure === "credit_apply_refund_debit"
      ? sql`CALL \`credit_apply_refund_debit\`(${input.workspaceId}, ${input.mode}, ${input.channelConnectionId}, ${input.bindingEpoch}, ${input.privacyEpoch}, ${input.walletId}, ${input.financialSubjectRef}, ${input.rootGrantEntryId}, ${input.providerEffectId}, ${input.entryId}, ${input.evidenceHash})`
      : sql`CALL \`credit_apply_chargeback_debit\`(${input.workspaceId}, ${input.mode}, ${input.channelConnectionId}, ${input.bindingEpoch}, ${input.privacyEpoch}, ${input.walletId}, ${input.financialSubjectRef}, ${input.rootGrantEntryId}, ${input.providerEffectId}, ${input.entryId}, ${input.evidenceHash})`;
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

export function applyCreditRefundDebit(
  input: CreditAdjustmentInput
): Promise<CreditDebitResult> {
  return executeCreditDebit("credit_apply_refund_debit", input);
}

export function applyCreditChargebackDebit(
  input: CreditAdjustmentInput
): Promise<CreditDebitResult> {
  return executeCreditDebit("credit_apply_chargeback_debit", input);
}

export async function applyCreditChargebackRestore(
  input: CreditAdjustmentInput
): Promise<ChargebackRestoreResult> {
  validateAdjustmentInput(input);
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
