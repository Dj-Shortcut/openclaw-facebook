import { createHash, createHmac } from "node:crypto";

import { and, asc, eq, inArray, or, sql } from "drizzle-orm";

import {
  auditLog,
  billingExecutionControls,
  billingOutbox,
  channelConnections,
  creditLedger,
  creditReservations,
  creditWallets,
  messengerPrivacySubjects,
  users,
} from "../../../drizzle/schema";
import { getDatabaseOrThrow, type ImageGenTransaction } from "../../db";
import {
  deriveCreditReservationCommitRecovery,
  deriveCreditReservationOutputNotDeliveredRecovery,
  deriveCreditReservationProviderRejectedRecovery,
} from "./creditGenerationAdmission";
import type { MollieMode } from "./config";
import {
  commitCreditReservation,
  markCreditReservationProviderAccepted,
  releaseCreditReservationOutputNotDelivered,
  releaseCreditReservationAfterProviderRejection,
  type CreditWalletScope,
} from "./creditWalletStore";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVIDENCE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,255}$/;
const REQUESTED_EVENT = "credit_reservation.operator_resolution_requested";
const COMPLETED_EVENT = "credit_reservation.operator_resolution_completed";
const TRANSPORT_REVIEW_REASON = "credit_reservation_transport_ambiguous";

export type CreditReservationOperatorDecision =
  "delivered_output" | "output_not_delivered" | "provider_rejected";

export type CreditReservationOperatorResolutionInput = Readonly<{
  requestId: string;
  workspaceId: number;
  mode: MollieMode;
  reservationId: string;
  walletId: string;
  actorUserId: number;
  decision: CreditReservationOperatorDecision;
  providerStatus?: number;
  evidenceReference: string;
}>;

export type CreditReservationOperatorResolutionResult = Readonly<{
  result: "applied" | "already_applied";
  reservationId: string;
  decision: CreditReservationOperatorDecision;
}>;

export type OpenCreditReservationTransportReview = Readonly<{
  caseRef: string;
  mode: MollieMode;
  reservationId: string;
  walletId: string;
  reason: typeof TRANSPORT_REVIEW_REASON;
}>;

type LockedResolutionScope = CreditWalletScope &
  Readonly<{
    reservationId: string;
    generationRequestKeyHash: string;
    ownerTokenHash: string;
  }>;

type AuditMaterial = Readonly<{
  evidenceReferenceHash: string;
  requestFingerprint: string;
  legacyV1?: Readonly<{
    decision: "provider_accepted" | "provider_rejected";
    requestFingerprint: string;
  }>;
}>;

type PreparedResolution = Readonly<{
  replayed: boolean;
  scope?: LockedResolutionScope;
  scopeFingerprint?: string;
}>;

export class CreditReservationOperatorResolutionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CreditReservationOperatorResolutionError";
  }
}

export type CreditReservationOperatorResolutionDependencies = Readonly<{
  database: typeof getDatabaseOrThrow;
  markProviderAccepted: typeof markCreditReservationProviderAccepted;
  commit: typeof commitCreditReservation;
  releaseProviderRejected: typeof releaseCreditReservationAfterProviderRejection;
  releaseOutputNotDelivered: typeof releaseCreditReservationOutputNotDelivered;
  deriveCommit: typeof deriveCreditReservationCommitRecovery;
  deriveOutputNotDelivered: typeof deriveCreditReservationOutputNotDeliveredRecovery;
  deriveProviderRejected: typeof deriveCreditReservationProviderRejectedRecovery;
}>;

const defaultDependencies: CreditReservationOperatorResolutionDependencies =
  Object.freeze({
    database: getDatabaseOrThrow,
    markProviderAccepted: markCreditReservationProviderAccepted,
    commit: commitCreditReservation,
    releaseProviderRejected: releaseCreditReservationAfterProviderRejection,
    releaseOutputNotDelivered: releaseCreditReservationOutputNotDelivered,
    deriveCommit: deriveCreditReservationCommitRecovery,
    deriveOutputNotDelivered: deriveCreditReservationOutputNotDeliveredRecovery,
    deriveProviderRejected: deriveCreditReservationProviderRejectedRecovery,
  });

export async function resolveAmbiguousPaidCreditReservation(
  rawInput: CreditReservationOperatorResolutionInput,
  dependencies: CreditReservationOperatorResolutionDependencies = defaultDependencies
): Promise<CreditReservationOperatorResolutionResult> {
  const input = validateInput(rawInput);
  const mode = input.mode;
  const auditMaterial = deriveAuditMaterial(input);
  const database = await dependencies.database();
  const prepared = await database.transaction(tx =>
    prepareResolution(tx, mode, input, auditMaterial)
  );
  if (prepared.replayed) {
    return Object.freeze({
      result: "already_applied",
      reservationId: input.reservationId,
      decision: input.decision,
    });
  }
  const scope = prepared.scope;
  const scopeFingerprint = prepared.scopeFingerprint;
  if (!scope || !scopeFingerprint) {
    throw new CreditReservationOperatorResolutionError(
      "credit_reservation_operator_scope_unavailable"
    );
  }

  let result: "applied" | "already_applied";
  let terminalEntryId: string;
  if (input.decision === "delivered_output") {
    const terminal = dependencies.deriveCommit(scope);
    if (!terminal) {
      throw new CreditReservationOperatorResolutionError(
        "credit_reservation_operator_proof_unavailable"
      );
    }
    await dependencies.markProviderAccepted(scope);
    const committed = await dependencies.commit({ ...scope, ...terminal });
    result = committed.result;
    terminalEntryId = terminal.entryId;
  } else if (input.decision === "output_not_delivered") {
    const terminal = dependencies.deriveOutputNotDelivered(scope);
    if (!terminal) {
      throw new CreditReservationOperatorResolutionError(
        "credit_reservation_operator_proof_unavailable"
      );
    }
    const released = await dependencies.releaseOutputNotDelivered({
      ...scope,
      ...terminal,
    });
    result = released.result;
    terminalEntryId = terminal.entryId;
  } else {
    const rejectionStatus = input.providerStatus;
    if (rejectionStatus === undefined) {
      throw new CreditReservationOperatorResolutionError(
        "credit_reservation_operator_provider_proof_invalid"
      );
    }
    const terminal = dependencies.deriveProviderRejected({
      ...scope,
      rejectionStatus,
    });
    if (!terminal) {
      throw new CreditReservationOperatorResolutionError(
        "credit_reservation_operator_proof_unavailable"
      );
    }
    const released = await dependencies.releaseProviderRejected({
      ...scope,
      rejectionStatus,
      ...terminal,
    });
    result = released.result;
    terminalEntryId = terminal.entryId;
  }

  await database.transaction(tx =>
    completeResolutionAudit(tx, input, mode, auditMaterial, {
      result,
      scopeFingerprint,
      terminalEntryId,
    })
  );
  return Object.freeze({
    result,
    reservationId: input.reservationId,
    decision: input.decision,
  });
}

/**
 * Lists only the opaque identifiers an administrator needs to resolve an open
 * paid-credit transport review. The notification transport deliberately stays
 * metadata-only; exact reservation scope remains behind this admin boundary.
 */
export async function listOpenCreditReservationTransportReviews(
  input: Readonly<{
    workspaceId: number;
    mode: MollieMode;
    limit?: number;
  }>,
  databaseProvider: typeof getDatabaseOrThrow = getDatabaseOrThrow
): Promise<readonly OpenCreditReservationTransportReview[]> {
  const limit = input.limit ?? 25;
  if (
    !Number.isSafeInteger(input.workspaceId) ||
    input.workspaceId < 1 ||
    (input.mode !== "test" && input.mode !== "live") ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50
  ) {
    throw new CreditReservationOperatorResolutionError(
      "credit_reservation_operator_list_input_invalid"
    );
  }

  const database = await databaseProvider();
  const rows = await database
    .select({
      caseRef: billingOutbox.deliveryId,
      mode: billingOutbox.mode,
      deduplicationKey: billingOutbox.deduplicationKey,
      payload: billingOutbox.payload,
    })
    .from(billingOutbox)
    .where(
      and(
        eq(billingOutbox.workspaceId, input.workspaceId),
        eq(billingOutbox.mode, input.mode),
        eq(billingOutbox.eventType, "manual_review"),
        sql`JSON_UNQUOTE(JSON_EXTRACT(${billingOutbox.payload}, '$.reason')) = ${TRANSPORT_REVIEW_REASON}`,
        sql`NOT EXISTS (
          SELECT 1
          FROM ${auditLog} AS completed_review
          WHERE completed_review.\`workspaceId\` = ${billingOutbox.workspaceId}
            AND completed_review.\`event\` = ${COMPLETED_EVENT}
            AND JSON_UNQUOTE(JSON_EXTRACT(completed_review.\`metadata\`, '$.mode')) = ${billingOutbox.mode}
            AND JSON_UNQUOTE(JSON_EXTRACT(completed_review.\`metadata\`, '$.reservationId')) =
              JSON_UNQUOTE(JSON_EXTRACT(${billingOutbox.payload}, '$.reservationId'))
            AND JSON_UNQUOTE(JSON_EXTRACT(completed_review.\`metadata\`, '$.walletId')) =
              JSON_UNQUOTE(JSON_EXTRACT(${billingOutbox.payload}, '$.walletId'))
        )`
      )
    )
    .orderBy(asc(billingOutbox.id))
    .limit(limit);

  return Object.freeze(rows.map(parseOpenTransportReview));
}

function validateInput(
  input: CreditReservationOperatorResolutionInput
): CreditReservationOperatorResolutionInput {
  const evidenceReference = input.evidenceReference?.trim();
  if (
    !input ||
    typeof input !== "object" ||
    !UUID_PATTERN.test(input.requestId) ||
    !Number.isSafeInteger(input.workspaceId) ||
    input.workspaceId < 1 ||
    (input.mode !== "test" && input.mode !== "live") ||
    !UUID_PATTERN.test(input.reservationId) ||
    !UUID_PATTERN.test(input.walletId) ||
    !Number.isSafeInteger(input.actorUserId) ||
    input.actorUserId < 1 ||
    !EVIDENCE_REFERENCE_PATTERN.test(evidenceReference)
  ) {
    throw new CreditReservationOperatorResolutionError(
      "credit_reservation_operator_input_invalid"
    );
  }
  const delivered =
    input.decision === "delivered_output" &&
    typeof input.providerStatus === "number" &&
    Number.isSafeInteger(input.providerStatus) &&
    input.providerStatus >= 200 &&
    input.providerStatus <= 299;
  const outputNotDelivered =
    input.decision === "output_not_delivered" &&
    (input.providerStatus === undefined ||
      (Number.isSafeInteger(input.providerStatus) &&
        typeof input.providerStatus === "number" &&
        input.providerStatus >= 200 &&
        input.providerStatus <= 299));
  const rejected =
    input.decision === "provider_rejected" &&
    typeof input.providerStatus === "number" &&
    Number.isSafeInteger(input.providerStatus) &&
    input.providerStatus >= 400 &&
    input.providerStatus <= 499 &&
    input.providerStatus !== 408 &&
    input.providerStatus !== 429;
  if (!delivered && !outputNotDelivered && !rejected) {
    throw new CreditReservationOperatorResolutionError(
      "credit_reservation_operator_provider_proof_invalid"
    );
  }
  return Object.freeze({ ...input, evidenceReference });
}

function deriveAuditMaterial(
  input: CreditReservationOperatorResolutionInput
): AuditMaterial {
  const secret = getEvidenceSecret();
  const evidenceReferenceHash = `hmac-sha256:${createHmac("sha256", secret)
    .update("leaderbot.credit-reservation-operator-evidence.v1\0", "utf8")
    .update(input.evidenceReference, "utf8")
    .digest("hex")}`;
  const requestFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        requestId: input.requestId,
        workspaceId: input.workspaceId,
        mode: input.mode,
        reservationId: input.reservationId,
        walletId: input.walletId,
        actorUserId: input.actorUserId,
        decision: input.decision,
        providerStatus: input.providerStatus ?? null,
        evidenceReferenceHash,
      })
    )
    .digest("hex");
  const legacyDecision =
    input.decision === "delivered_output"
      ? "provider_accepted"
      : input.decision === "provider_rejected"
        ? "provider_rejected"
        : null;
  const legacyV1 = legacyDecision
    ? Object.freeze({
        decision: legacyDecision,
        requestFingerprint: createHash("sha256")
          .update(
            JSON.stringify({
              requestId: input.requestId,
              workspaceId: input.workspaceId,
              reservationId: input.reservationId,
              walletId: input.walletId,
              actorUserId: input.actorUserId,
              decision: legacyDecision,
              providerStatus: input.providerStatus,
              evidenceReferenceHash,
            })
          )
          .digest("hex"),
      })
    : undefined;
  return Object.freeze({
    evidenceReferenceHash,
    requestFingerprint,
    ...(legacyV1 ? { legacyV1 } : {}),
  });
}

async function prepareResolution(
  tx: ImageGenTransaction,
  mode: MollieMode,
  input: CreditReservationOperatorResolutionInput,
  auditMaterial: AuditMaterial
): Promise<PreparedResolution> {
  await lockAdminActor(tx, input.actorUserId);
  const existingAudits = await findResolutionAudits(tx, input);
  assertMatchingAudits(existingAudits, input, auditMaterial);
  if (existingAudits.some(row => row.event === COMPLETED_EVENT)) {
    return Object.freeze({ replayed: true });
  }
  const existingRequest = existingAudits.find(
    row => row.event === REQUESTED_EVENT
  );
  if (
    existingRequest &&
    (await completeRecoveredTerminalResolution(
      tx,
      input,
      mode,
      auditMaterial,
      existingRequest
    ))
  ) {
    return Object.freeze({ replayed: true });
  }

  const discovery = await tx
    .select({
      channelConnectionId: creditReservations.channelConnectionId,
      bindingEpoch: creditReservations.bindingEpoch,
      privacyEpoch: creditReservations.privacyEpoch,
      financialSubjectRef: creditReservations.financialSubjectRef,
      generationRequestKeyHash: creditReservations.generationRequestKeyHash,
      ownerTokenHash: creditReservations.ownerTokenHash,
      userKey: creditWallets.currentUserKeyHash,
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
        eq(creditReservations.workspaceId, input.workspaceId),
        eq(creditReservations.mode, mode),
        eq(creditReservations.reservationId, input.reservationId),
        eq(creditReservations.walletId, input.walletId)
      )
    )
    .limit(2);
  const discoveredRow = discovery[0];
  if (
    discovery.length !== 1 ||
    !discoveredRow?.userKey ||
    !discoveredRow.generationRequestKeyHash ||
    !discoveredRow.ownerTokenHash
  ) {
    throw new CreditReservationOperatorResolutionError(
      "credit_reservation_operator_scope_unavailable"
    );
  }
  const discovered = Object.freeze({
    ...discoveredRow,
    userKey: discoveredRow.userKey,
    generationRequestKeyHash: discoveredRow.generationRequestKeyHash,
    ownerTokenHash: discoveredRow.ownerTokenHash,
  });

  const controls = await tx
    .select({ workspaceId: billingExecutionControls.workspaceId })
    .from(billingExecutionControls)
    .where(
      and(
        eq(billingExecutionControls.workspaceId, input.workspaceId),
        eq(billingExecutionControls.mode, mode)
      )
    )
    .limit(1)
    .for("update");
  const connections = await tx
    .select({ id: channelConnections.id })
    .from(channelConnections)
    .where(
      and(
        eq(channelConnections.id, discovered.channelConnectionId),
        eq(channelConnections.workspaceId, input.workspaceId),
        eq(channelConnections.channel, "facebook_messenger"),
        eq(channelConnections.bindingEpoch, discovered.bindingEpoch)
      )
    )
    .limit(1)
    .for("update");
  const privacySubjects = await tx
    .select({ id: messengerPrivacySubjects.id })
    .from(messengerPrivacySubjects)
    .where(
      and(
        eq(messengerPrivacySubjects.workspaceId, input.workspaceId),
        eq(
          messengerPrivacySubjects.channelConnectionId,
          discovered.channelConnectionId
        ),
        eq(messengerPrivacySubjects.userKey, discovered.userKey),
        or(
          and(
            eq(messengerPrivacySubjects.privacyEpoch, discovered.privacyEpoch),
            eq(messengerPrivacySubjects.status, "active")
          ),
          and(
            eq(
              messengerPrivacySubjects.privacyEpoch,
              discovered.privacyEpoch + 1
            ),
            inArray(messengerPrivacySubjects.status, ["erasing", "erased"])
          )
        )
      )
    )
    .limit(1)
    .for("update");
  const wallets = await tx
    .select({ walletId: creditWallets.walletId })
    .from(creditWallets)
    .where(
      and(
        eq(creditWallets.walletId, input.walletId),
        eq(creditWallets.workspaceId, input.workspaceId),
        eq(creditWallets.mode, mode),
        eq(creditWallets.channelConnectionId, discovered.channelConnectionId),
        eq(creditWallets.bindingEpoch, discovered.bindingEpoch),
        eq(creditWallets.privacyEpoch, discovered.privacyEpoch),
        eq(creditWallets.currentUserKeyHash, discovered.userKey),
        eq(creditWallets.financialSubjectRef, discovered.financialSubjectRef),
        inArray(creditWallets.status, ["active", "frozen"])
      )
    )
    .limit(1)
    .for("update");
  const reservations = await tx
    .select({
      status: creditReservations.status,
      transportState: creditReservations.transportState,
      providerRejectedStatus: creditReservations.providerRejectedStatus,
      generationRequestKeyHash: creditReservations.generationRequestKeyHash,
      ownerTokenHash: creditReservations.ownerTokenHash,
    })
    .from(creditReservations)
    .where(
      and(
        eq(creditReservations.reservationId, input.reservationId),
        eq(creditReservations.walletId, input.walletId),
        eq(creditReservations.workspaceId, input.workspaceId),
        eq(creditReservations.mode, mode),
        eq(
          creditReservations.channelConnectionId,
          discovered.channelConnectionId
        ),
        eq(creditReservations.bindingEpoch, discovered.bindingEpoch),
        eq(creditReservations.privacyEpoch, discovered.privacyEpoch),
        eq(
          creditReservations.financialSubjectRef,
          discovered.financialSubjectRef
        ),
        eq(
          creditReservations.generationRequestKeyHash,
          discovered.generationRequestKeyHash
        ),
        eq(creditReservations.ownerTokenHash, discovered.ownerTokenHash)
      )
    )
    .limit(1)
    .for("update");
  if (
    controls.length !== 1 ||
    connections.length !== 1 ||
    privacySubjects.length !== 1 ||
    wallets.length !== 1 ||
    reservations.length !== 1 ||
    !matchesDecisionState(reservations[0], input)
  ) {
    throw new CreditReservationOperatorResolutionError(
      "credit_reservation_operator_scope_conflict"
    );
  }

  const reviews = await tx
    .select({ payload: billingOutbox.payload })
    .from(billingOutbox)
    .where(
      and(
        eq(billingOutbox.workspaceId, input.workspaceId),
        eq(billingOutbox.mode, mode),
        eq(billingOutbox.eventType, "manual_review"),
        eq(
          billingOutbox.deduplicationKey,
          `credit_reservation_transport_review:${input.reservationId}`
        )
      )
    )
    .limit(2)
    .for("update");
  if (reviews.length !== 1 || !matchesManualReview(reviews[0].payload, input)) {
    throw new CreditReservationOperatorResolutionError(
      "credit_reservation_operator_review_required"
    );
  }

  const scope: LockedResolutionScope = Object.freeze({
    workspaceId: input.workspaceId,
    mode,
    channelConnectionId: discovered.channelConnectionId,
    bindingEpoch: discovered.bindingEpoch,
    privacyEpoch: discovered.privacyEpoch,
    userKey: discovered.userKey,
    walletId: input.walletId,
    financialSubjectRef: discovered.financialSubjectRef,
    reservationId: input.reservationId,
    generationRequestKeyHash: discovered.generationRequestKeyHash,
    ownerTokenHash: discovered.ownerTokenHash,
  });
  const scopeFingerprint = deriveScopeFingerprint(scope);
  // A second admin can pass the initial audit read while waiting on the exact
  // financial locks above. Re-read after acquiring those locks so only the
  // first matching request can establish the durable resolution intent.
  const currentAudits = await findResolutionAudits(tx, input);
  assertMatchingAudits(currentAudits, input, auditMaterial);
  if (currentAudits.some(row => row.event === COMPLETED_EVENT)) {
    return Object.freeze({ replayed: true });
  }
  const priorRequest = currentAudits.find(row => row.event === REQUESTED_EVENT);
  if (priorRequest) {
    const metadata = readMetadata(priorRequest.metadata);
    if (metadata.scopeFingerprint !== scopeFingerprint) {
      throw new CreditReservationOperatorResolutionError(
        "credit_reservation_operator_request_conflict"
      );
    }
  } else {
    await tx.insert(auditLog).values({
      workspaceId: input.workspaceId,
      userId: input.actorUserId,
      event: REQUESTED_EVENT,
      metadata: auditMetadata(input, auditMaterial, scopeFingerprint),
    });
  }
  return Object.freeze({ replayed: false, scope, scopeFingerprint });
}

async function completeRecoveredTerminalResolution(
  tx: ImageGenTransaction,
  input: CreditReservationOperatorResolutionInput,
  mode: MollieMode,
  auditMaterial: AuditMaterial,
  requestedAudit: Awaited<ReturnType<typeof findResolutionAudits>>[number]
): Promise<boolean> {
  const requestedMetadata = readMetadata(requestedAudit.metadata);
  const scopeFingerprint = requestedMetadata.scopeFingerprint;
  if (
    typeof scopeFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(scopeFingerprint)
  ) {
    throw new CreditReservationOperatorResolutionError(
      "credit_reservation_operator_audit_malformed"
    );
  }

  const reservations = await tx
    .select({
      channelConnectionId: creditReservations.channelConnectionId,
      bindingEpoch: creditReservations.bindingEpoch,
      privacyEpoch: creditReservations.privacyEpoch,
      financialSubjectRef: creditReservations.financialSubjectRef,
      reservedCreditCount: creditReservations.reservedCreditCount,
      status: creditReservations.status,
      transportState: creditReservations.transportState,
      providerRejectedStatus: creditReservations.providerRejectedStatus,
      terminalLedgerEntryId: creditReservations.terminalLedgerEntryId,
      terminalEvidenceHash: creditReservations.terminalEvidenceHash,
    })
    .from(creditReservations)
    .where(
      and(
        eq(creditReservations.workspaceId, input.workspaceId),
        eq(creditReservations.mode, mode),
        eq(creditReservations.reservationId, input.reservationId),
        eq(creditReservations.walletId, input.walletId)
      )
    )
    .limit(2)
    .for("update");
  if (reservations.length !== 1) {
    throw new CreditReservationOperatorResolutionError(
      "credit_reservation_operator_request_conflict"
    );
  }
  const reservation = reservations[0];
  if (
    reservation.status === "initializing" ||
    reservation.status === "reserved"
  ) {
    return false;
  }
  if (!matchesTerminalDecisionState(reservation, input)) {
    throw new CreditReservationOperatorResolutionError(
      "credit_reservation_operator_request_conflict"
    );
  }

  const terminalEntries = await tx
    .select({
      entryId: creditLedger.entryId,
      entryKind: creditLedger.entryKind,
      terminalStatus: creditLedger.reservationTerminalStatus,
      evidenceHash: creditLedger.evidenceHash,
    })
    .from(creditLedger)
    .where(
      and(
        eq(creditLedger.workspaceId, input.workspaceId),
        eq(creditLedger.mode, mode),
        eq(creditLedger.walletId, input.walletId),
        eq(creditLedger.reservationId, input.reservationId),
        eq(creditLedger.channelConnectionId, reservation.channelConnectionId),
        eq(creditLedger.bindingEpoch, reservation.bindingEpoch),
        eq(creditLedger.privacyEpoch, reservation.privacyEpoch),
        eq(creditLedger.financialSubjectRef, reservation.financialSubjectRef),
        eq(
          creditLedger.reservationCreditCount,
          reservation.reservedCreditCount
        ),
        eq(creditLedger.reservationTerminalSlot, 1)
      )
    )
    .limit(2)
    .for("update");
  const terminalEntry = terminalEntries[0];
  if (
    terminalEntries.length !== 1 ||
    !terminalEntry ||
    !UUID_PATTERN.test(terminalEntry.entryId) ||
    terminalEntry.entryId !== reservation.terminalLedgerEntryId ||
    terminalEntry.evidenceHash !== reservation.terminalEvidenceHash ||
    !matchesTerminalLedgerEntry(terminalEntry, input.decision)
  ) {
    throw new CreditReservationOperatorResolutionError(
      "credit_reservation_operator_request_conflict"
    );
  }

  await insertCompletedResolutionAudit(tx, input, mode, auditMaterial, {
    result: "already_applied",
    scopeFingerprint,
    terminalEntryId: terminalEntry.entryId,
  });
  return true;
}

async function completeResolutionAudit(
  tx: ImageGenTransaction,
  input: CreditReservationOperatorResolutionInput,
  mode: MollieMode,
  auditMaterial: AuditMaterial,
  terminal: Readonly<{
    result: "applied" | "already_applied";
    scopeFingerprint: string;
    terminalEntryId: string;
  }>
): Promise<void> {
  await lockAdminActor(tx, input.actorUserId);
  const audits = await findResolutionAudits(tx, input);
  assertMatchingAudits(audits, input, auditMaterial);
  const requested = audits.find(row => row.event === REQUESTED_EVENT);
  if (!requested) {
    throw new CreditReservationOperatorResolutionError(
      "credit_reservation_operator_request_missing"
    );
  }
  if (
    readMetadata(requested.metadata).scopeFingerprint !==
    terminal.scopeFingerprint
  ) {
    throw new CreditReservationOperatorResolutionError(
      "credit_reservation_operator_request_conflict"
    );
  }
  if (audits.some(row => row.event === COMPLETED_EVENT)) return;
  await insertCompletedResolutionAudit(
    tx,
    input,
    mode,
    auditMaterial,
    terminal
  );
}

async function insertCompletedResolutionAudit(
  tx: ImageGenTransaction,
  input: CreditReservationOperatorResolutionInput,
  mode: MollieMode,
  auditMaterial: AuditMaterial,
  terminal: Readonly<{
    result: "applied" | "already_applied";
    scopeFingerprint: string;
    terminalEntryId: string;
  }>
): Promise<void> {
  await tx.insert(auditLog).values({
    workspaceId: input.workspaceId,
    userId: input.actorUserId,
    event: COMPLETED_EVENT,
    metadata: {
      ...auditMetadata(input, auditMaterial, terminal.scopeFingerprint),
      mode,
      result: terminal.result,
      terminalEntryId: terminal.terminalEntryId,
    },
  });
}

async function lockAdminActor(
  tx: ImageGenTransaction,
  actorUserId: number
): Promise<void> {
  const actors = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, actorUserId), eq(users.role, "admin")))
    .limit(1)
    .for("update");
  if (actors.length !== 1) {
    throw new CreditReservationOperatorResolutionError(
      "credit_reservation_operator_forbidden"
    );
  }
}

async function findResolutionAudits(
  tx: ImageGenTransaction,
  input: CreditReservationOperatorResolutionInput
) {
  return tx
    .select({
      event: auditLog.event,
      userId: auditLog.userId,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.workspaceId, input.workspaceId),
        inArray(auditLog.event, [REQUESTED_EVENT, COMPLETED_EVENT]),
        sql`JSON_UNQUOTE(JSON_EXTRACT(${auditLog.metadata}, '$.requestId')) = ${input.requestId}`
      )
    )
    .limit(3);
}

function assertMatchingAudits(
  audits: Awaited<ReturnType<typeof findResolutionAudits>>,
  input: CreditReservationOperatorResolutionInput,
  auditMaterial: AuditMaterial
): void {
  if (audits.length > 2) {
    throw new CreditReservationOperatorResolutionError(
      "credit_reservation_operator_request_conflict"
    );
  }
  for (const audit of audits) {
    const metadata = readMetadata(audit.metadata);
    const currentAuditMatches =
      audit.userId === input.actorUserId &&
      metadata.requestFingerprint === auditMaterial.requestFingerprint &&
      metadata.evidenceReferenceHash === auditMaterial.evidenceReferenceHash &&
      metadata.decision === input.decision &&
      metadata.providerStatus === (input.providerStatus ?? null) &&
      metadata.mode === input.mode &&
      metadata.reservationId === input.reservationId &&
      metadata.walletId === input.walletId;
    const legacy = auditMaterial.legacyV1;
    // V1 did not authenticate a mode and named a delivered output
    // `provider_accepted`. Accept that shape only for the pre-effect request:
    // terminal recovery below re-locks the exact mode/reservation/ledger case,
    // while a legacy completed row cannot be replayed without mode evidence.
    const legacyRequestedAuditMatches =
      audit.event === REQUESTED_EVENT &&
      legacy !== undefined &&
      audit.userId === input.actorUserId &&
      metadata.requestFingerprint === legacy.requestFingerprint &&
      metadata.evidenceReferenceHash === auditMaterial.evidenceReferenceHash &&
      metadata.decision === legacy.decision &&
      metadata.providerStatus === input.providerStatus &&
      metadata.mode === undefined &&
      metadata.reservationId === input.reservationId &&
      metadata.walletId === input.walletId;
    if (!currentAuditMatches && !legacyRequestedAuditMatches) {
      throw new CreditReservationOperatorResolutionError(
        "credit_reservation_operator_request_conflict"
      );
    }
  }
}

function matchesDecisionState(
  reservation: Readonly<{
    status: string;
    transportState: string;
    providerRejectedStatus: number | null;
  }>,
  input: CreditReservationOperatorResolutionInput
): boolean {
  if (input.decision === "delivered_output") {
    return (
      (reservation.status === "reserved" &&
        (reservation.transportState === "transport_started" ||
          reservation.transportState === "known_accepted")) ||
      (reservation.status === "committed" &&
        reservation.transportState === "known_accepted")
    );
  }
  if (input.decision === "output_not_delivered") {
    return (
      (reservation.status === "reserved" &&
        (reservation.transportState === "transport_started" ||
          reservation.transportState === "known_accepted")) ||
      (reservation.status === "released" &&
        reservation.transportState === "output_not_delivered")
    );
  }
  return (
    (reservation.status === "reserved" &&
      reservation.transportState === "transport_started" &&
      reservation.providerRejectedStatus === null) ||
    (reservation.status === "released" &&
      reservation.transportState === "known_rejected" &&
      reservation.providerRejectedStatus === input.providerStatus)
  );
}

function matchesTerminalDecisionState(
  reservation: Readonly<{
    status: string;
    transportState: string;
    providerRejectedStatus: number | null;
  }>,
  input: CreditReservationOperatorResolutionInput
): boolean {
  if (input.decision === "delivered_output") {
    return (
      reservation.status === "committed" &&
      reservation.transportState === "known_accepted" &&
      reservation.providerRejectedStatus === null
    );
  }
  if (input.decision === "output_not_delivered") {
    return (
      reservation.status === "released" &&
      reservation.transportState === "output_not_delivered" &&
      reservation.providerRejectedStatus === null
    );
  }
  return (
    reservation.status === "released" &&
    reservation.transportState === "known_rejected" &&
    reservation.providerRejectedStatus === input.providerStatus
  );
}

function matchesTerminalLedgerEntry(
  entry: Readonly<{
    entryKind: string;
    terminalStatus: string | null;
  }>,
  decision: CreditReservationOperatorDecision
): boolean {
  return decision === "delivered_output"
    ? entry.entryKind === "generation_spend" &&
        entry.terminalStatus === "committed"
    : entry.entryKind === "reservation_release" &&
        entry.terminalStatus === "released";
}

function matchesManualReview(
  value: unknown,
  input: CreditReservationOperatorResolutionInput
): boolean {
  if (!isPlainRecord(value)) return false;
  return (
    value.reason === "credit_reservation_transport_ambiguous" &&
    value.reservationId === input.reservationId &&
    value.walletId === input.walletId &&
    value.creditPurpose === "premium_image_credits"
  );
}

function parseOpenTransportReview(row: {
  caseRef: string;
  mode: MollieMode;
  deduplicationKey: string;
  payload: unknown;
}): OpenCreditReservationTransportReview {
  if (!isPlainRecord(row.payload)) {
    throw new CreditReservationOperatorResolutionError(
      "credit_reservation_operator_review_malformed"
    );
  }
  const reason = row.payload.reason;
  const reservationId = row.payload.reservationId;
  const walletId = row.payload.walletId;
  if (
    !UUID_PATTERN.test(row.caseRef) ||
    (row.mode !== "test" && row.mode !== "live") ||
    reason !== TRANSPORT_REVIEW_REASON ||
    typeof reservationId !== "string" ||
    !UUID_PATTERN.test(reservationId) ||
    typeof walletId !== "string" ||
    !UUID_PATTERN.test(walletId) ||
    row.payload.creditPurpose !== "premium_image_credits" ||
    row.deduplicationKey !==
      `credit_reservation_transport_review:${reservationId}`
  ) {
    throw new CreditReservationOperatorResolutionError(
      "credit_reservation_operator_review_malformed"
    );
  }
  return Object.freeze({
    caseRef: row.caseRef,
    mode: row.mode,
    reservationId,
    walletId,
    reason,
  });
}

function deriveScopeFingerprint(scope: LockedResolutionScope): string {
  return createHmac("sha256", getEvidenceSecret())
    .update("leaderbot.credit-reservation-operator-scope.v1\0", "utf8")
    .update(
      JSON.stringify({
        workspaceId: scope.workspaceId,
        mode: scope.mode,
        channelConnectionId: scope.channelConnectionId,
        bindingEpoch: scope.bindingEpoch,
        privacyEpoch: scope.privacyEpoch,
        userKey: scope.userKey,
        walletId: scope.walletId,
        financialSubjectRef: scope.financialSubjectRef,
        reservationId: scope.reservationId,
        generationRequestKeyHash: scope.generationRequestKeyHash,
        ownerTokenHash: scope.ownerTokenHash,
      })
    )
    .digest("hex");
}

function getEvidenceSecret(): string {
  const secret = process.env.BILLING_PROFILE_EVIDENCE_HMAC_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new CreditReservationOperatorResolutionError(
      "credit_reservation_operator_evidence_key_unavailable"
    );
  }
  return secret;
}

function auditMetadata(
  input: CreditReservationOperatorResolutionInput,
  auditMaterial: AuditMaterial,
  scopeFingerprint: string
) {
  return {
    requestId: input.requestId,
    requestFingerprint: auditMaterial.requestFingerprint,
    evidenceReferenceHash: auditMaterial.evidenceReferenceHash,
    evidenceStoredAsHash: true,
    decision: input.decision,
    providerStatus: input.providerStatus ?? null,
    mode: input.mode,
    reservationId: input.reservationId,
    walletId: input.walletId,
    scopeFingerprint,
  };
}

function readMetadata(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new CreditReservationOperatorResolutionError(
      "credit_reservation_operator_audit_malformed"
    );
  }
  return value;
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
