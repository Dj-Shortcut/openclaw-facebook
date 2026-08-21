import { createHash } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import {
  billingSchedulerTenants,
  channelConnections,
  workspaceEntitlementUsageReservations,
} from "../../drizzle/schema";
import { getDatabaseOrThrow } from "../db";
import {
  assertTenantBillingWorkerWorkspace,
  getConfiguredBillingMode,
  isMollieEntitlementEnforcementEnabled,
} from "./billing/config";
import { assertAiAnswerFinalizationReadiness } from "./billing/billingReadiness";
import {
  commitStartpilotAiAnswerUsage,
  releaseStartpilotAiAnswerUsage,
  reserveStartpilotAiAnswerUsage,
} from "./billing/entitlementUsageStore";
import {
  assertMessengerGenerationOwnership,
  resolveMessengerGenerationOwnership,
  resolveWorkspaceRuntimePolicy,
} from "./workspaceEntitlementRuntime";

export type InternalAiAnswerQuotaReserveResult =
  | { status: "not_applicable" }
  | { status: "reserved"; reservationId: string }
  | { status: "duplicate" }
  | { status: "exhausted" };

type InternalAiAnswerQuotaErrorCode =
  | "database_unavailable"
  | "enforcement_disabled"
  | "finalization_store_failure"
  | "quota_store_failure"
  | "reservation_lookup_failed"
  | "reservation_not_finalized"
  | "reservation_scope_unavailable";

export class InternalAiAnswerQuotaError extends Error {
  constructor(
    readonly code: InternalAiAnswerQuotaErrorCode,
    options?: ErrorOptions
  ) {
    super("AI answer quota is unavailable", options);
    this.name = "InternalAiAnswerQuotaError";
  }
}

export const INTERNAL_AI_ANSWER_QUOTA_PROTOCOL = "leaderbot-ai-answer-quota-v1";

export async function getInternalAiAnswerQuotaReadiness(): Promise<{
  protocol: typeof INTERNAL_AI_ANSWER_QUOTA_PROTOCOL;
  preflightReady: true;
  admissionEnabled: boolean;
  drainEnabled: boolean;
}> {
  await assertAiAnswerFinalizationReadiness(getConfiguredBillingMode());
  return {
    protocol: INTERNAL_AI_ANSWER_QUOTA_PROTOCOL,
    preflightReady: true,
    admissionEnabled: isMollieEntitlementEnforcementEnabled(),
    drainEnabled: process.env.AI_ANSWER_FINALIZATION_DRAIN_ENABLED === "true",
  };
}

export function safeInternalAiAnswerQuotaErrorCode(error: unknown): string {
  if (error instanceof InternalAiAnswerQuotaError) return error.code;
  const name = error instanceof Error ? error.name : "UnknownError";
  return name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "UnknownError";
}

function assertAiAnswerEnforcementConfigured(): void {
  if (!isMollieEntitlementEnforcementEnabled()) {
    throw new InternalAiAnswerQuotaError("enforcement_disabled");
  }
  assertAiAnswerDatabaseConfigured();
}

function assertAiAnswerDatabaseConfigured(): void {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new InternalAiAnswerQuotaError("database_unavailable");
  }
}

export async function reserveInternalAiAnswerQuota(input: {
  pageId: string;
  idempotencyKey: string;
  ownerToken: string;
}): Promise<InternalAiAnswerQuotaReserveResult> {
  assertAiAnswerEnforcementConfigured();
  const policy = await resolveWorkspaceRuntimePolicy(input.pageId);
  if (policy.kind === "free") return { status: "not_applicable" };
  const ownership = await resolveMessengerGenerationOwnership(input.pageId);
  if (!ownership || ownership.workspaceId !== policy.workspaceId) {
    throw new InternalAiAnswerQuotaError("reservation_scope_unavailable");
  }

  let result: Awaited<ReturnType<typeof reserveStartpilotAiAnswerUsage>>;
  try {
    result = await reserveStartpilotAiAnswerUsage({
      workspaceId: policy.workspaceId,
      entitlementId: policy.entitlementId,
      channelConnectionId: ownership.channelConnectionId,
      bindingEpoch: ownership.bindingEpoch,
      mode: policy.mode,
      idempotencyKey: input.idempotencyKey,
      ownerToken: input.ownerToken,
    });
  } catch (cause) {
    throw new InternalAiAnswerQuotaError("quota_store_failure", { cause });
  }
  if (!result.allowed) {
    return result.reason === "idempotency_reused"
      ? { status: "duplicate" }
      : { status: "exhausted" };
  }
  if (result.alreadyReserved) {
    return { status: "reserved", reservationId: result.reservationId };
  }
  return { status: "reserved", reservationId: result.reservationId };
}

export async function finalizeInternalAiAnswerQuota(input: {
  pageId: string;
  reservationId: string;
  ownerToken: string;
  outcome: "committed" | "released";
}): Promise<{ status: "finalized" }> {
  // Existing reservations must remain finalizable if the launch flag or active
  // entitlement changes after reservation. Only the database is required here.
  assertAiAnswerDatabaseConfigured();
  const reservation = await findOwnedAiAnswerReservation(input);
  await assertReservationPageBinding(input.pageId, reservation);
  const scope = {
    workspaceId: reservation.workspaceId,
    entitlementId: reservation.entitlementId,
    mode: reservation.mode,
    reservationId: input.reservationId,
    ownerTokenHash: createHash("sha256").update(input.ownerToken).digest("hex"),
  };
  let result:
    | Awaited<ReturnType<typeof commitStartpilotAiAnswerUsage>>
    | Awaited<ReturnType<typeof releaseStartpilotAiAnswerUsage>>;
  try {
    result =
      input.outcome === "committed"
        ? await commitStartpilotAiAnswerUsage(scope)
        : await releaseStartpilotAiAnswerUsage(scope);
  } catch (cause) {
    throw new InternalAiAnswerQuotaError("finalization_store_failure", {
      cause,
    });
  }
  const finalized = "committed" in result ? result.committed : result.released;
  if (!finalized) {
    throw new InternalAiAnswerQuotaError("reservation_not_finalized");
  }
  return { status: "finalized" };
}

export async function markInternalAiAnswerDeliveryStarted(input: {
  pageId: string;
  reservationId: string;
  ownerToken: string;
  deliveryAttemptToken: string;
  now?: Date;
}): Promise<{ status: "delivery_started" }> {
  assertAiAnswerDatabaseConfigured();
  const database = await getDatabaseOrThrow();
  const now = input.now ?? new Date();
  const ownerTokenHash = createHash("sha256")
    .update(input.ownerToken)
    .digest("hex");
  const attemptTokenHash = createHash("sha256")
    .update(input.deliveryAttemptToken)
    .digest("hex");
  const resolutionDueAt = new Date(now.getTime() + 30_000);
  return database.transaction(async tx => {
    const rows = await tx
      .select()
      .from(workspaceEntitlementUsageReservations)
      .where(
        and(
          eq(
            workspaceEntitlementUsageReservations.reservationId,
            input.reservationId
          ),
          eq(workspaceEntitlementUsageReservations.kind, "ai_answer"),
          eq(workspaceEntitlementUsageReservations.status, "reserved")
        )
      )
      .limit(1)
      .for("update");
    const reservation = rows[0];
    if (
      !reservation ||
      reservation.ownerTokenHash !== ownerTokenHash ||
      reservation.ownerLeaseUntil <= now
    ) {
      throw new InternalAiAnswerQuotaError("reservation_scope_unavailable");
    }
    if (
      reservation.channelConnectionId == null ||
      reservation.bindingEpoch == null
    ) {
      if (process.env.NODE_ENV === "production") {
        throw new InternalAiAnswerQuotaError("reservation_scope_unavailable");
      }
    } else {
      const bindings = await tx
        .select({ id: channelConnections.id })
        .from(channelConnections)
        .where(
          and(
            eq(channelConnections.id, reservation.channelConnectionId),
            eq(channelConnections.workspaceId, reservation.workspaceId),
            eq(channelConnections.bindingEpoch, reservation.bindingEpoch),
            eq(channelConnections.externalId, input.pageId),
            eq(channelConnections.channel, "facebook_messenger"),
            eq(channelConnections.status, "connected")
          )
        )
        .limit(1)
        .for("update");
      if (!bindings[0]) {
        throw new InternalAiAnswerQuotaError("reservation_scope_unavailable");
      }
    }
    assertTenantBillingWorkerWorkspace(reservation.workspaceId);
    const scheduler = await tx
      .select({ enabled: billingSchedulerTenants.enabled })
      .from(billingSchedulerTenants)
      .where(
        and(
          eq(billingSchedulerTenants.workspaceId, reservation.workspaceId),
          eq(billingSchedulerTenants.mode, reservation.mode),
          eq(billingSchedulerTenants.kind, "ai_finalization")
        )
      )
      .limit(1)
      .for("update");
    if (!scheduler[0]?.enabled) {
      throw new InternalAiAnswerQuotaError("reservation_scope_unavailable");
    }
    if (reservation.deliveryStartedAt) {
      if (reservation.deliveryAttemptTokenHash !== attemptTokenHash) {
        throw new InternalAiAnswerQuotaError("reservation_not_finalized");
      }
      return { status: "delivery_started" as const };
    }
    const updateResult = await tx
      .update(workspaceEntitlementUsageReservations)
      .set({
        deliveryStartedAt: now,
        deliveryAttemptTokenHash: attemptTokenHash,
        resolutionDueAt,
      })
      .where(
        and(
          eq(
            workspaceEntitlementUsageReservations.reservationId,
            input.reservationId
          ),
          eq(workspaceEntitlementUsageReservations.status, "reserved"),
          isNull(workspaceEntitlementUsageReservations.deliveryStartedAt),
          gt(workspaceEntitlementUsageReservations.ownerLeaseUntil, now),
          eq(
            workspaceEntitlementUsageReservations.ownerTokenHash,
            ownerTokenHash
          )
        )
      );
    if (affectedRows(updateResult) !== 1) {
      throw new InternalAiAnswerQuotaError("reservation_not_finalized");
    }
    await tx
      .update(billingSchedulerTenants)
      .set({
        nextDueAt: sql`LEAST(${billingSchedulerTenants.nextDueAt}, ${resolutionDueAt})`,
      })
      .where(
        and(
          eq(billingSchedulerTenants.workspaceId, reservation.workspaceId),
          eq(billingSchedulerTenants.mode, reservation.mode),
          eq(billingSchedulerTenants.kind, "ai_finalization"),
          eq(billingSchedulerTenants.enabled, true)
        )
      );
    return { status: "delivery_started" as const };
  });
}

export async function markInternalAiAnswerDeliveryKnownRejected(input: {
  pageId: string;
  reservationId: string;
  ownerToken: string;
  deliveryAttemptToken: string;
  now?: Date;
}): Promise<{ status: "delivery_known_rejected" }> {
  assertAiAnswerDatabaseConfigured();
  const reservation = await findOwnedAiAnswerReservation(input);
  await assertReservationPageBinding(input.pageId, reservation);
  const database = await getDatabaseOrThrow();
  const now = input.now ?? new Date();
  const result = await database
    .update(workspaceEntitlementUsageReservations)
    .set({
      deliveryKnownRejectedAt: now,
      resolutionDueAt: now,
    })
    .where(
      and(
        eq(
          workspaceEntitlementUsageReservations.reservationId,
          input.reservationId
        ),
        eq(workspaceEntitlementUsageReservations.status, "reserved"),
        eq(
          workspaceEntitlementUsageReservations.ownerTokenHash,
          createHash("sha256").update(input.ownerToken).digest("hex")
        ),
        eq(
          workspaceEntitlementUsageReservations.deliveryAttemptTokenHash,
          createHash("sha256").update(input.deliveryAttemptToken).digest("hex")
        ),
        isNull(workspaceEntitlementUsageReservations.deliveryKnownRejectedAt)
      )
    );
  if (affectedRows(result) !== 1) {
    throw new InternalAiAnswerQuotaError("reservation_not_finalized");
  }
  return { status: "delivery_known_rejected" };
}

export async function heartbeatInternalAiAnswerReservation(input: {
  reservationId: string;
  ownerToken: string;
  now?: Date;
}): Promise<{ status: "lease_renewed" }> {
  const reservation = await findOwnedAiAnswerReservation(input);
  const database = await getDatabaseOrThrow();
  const now = input.now ?? new Date();
  const updateResult = await database
    .update(workspaceEntitlementUsageReservations)
    .set({
      ownerLeaseUntil: new Date(now.getTime() + 4.5 * 60_000),
      resolutionDueAt: new Date(now.getTime() + 5 * 60_000),
    })
    .where(
      and(
        eq(
          workspaceEntitlementUsageReservations.reservationId,
          input.reservationId
        ),
        eq(
          workspaceEntitlementUsageReservations.workspaceId,
          reservation.workspaceId
        ),
        eq(
          workspaceEntitlementUsageReservations.ownerTokenHash,
          createHash("sha256").update(input.ownerToken).digest("hex")
        ),
        eq(workspaceEntitlementUsageReservations.status, "reserved"),
        gt(workspaceEntitlementUsageReservations.ownerLeaseUntil, now),
        isNull(workspaceEntitlementUsageReservations.deliveryStartedAt)
      )
    );
  if (affectedRows(updateResult) !== 1) {
    throw new InternalAiAnswerQuotaError("reservation_scope_unavailable");
  }
  return { status: "lease_renewed" };
}

async function findOwnedAiAnswerReservation(input: {
  reservationId: string;
  ownerToken: string;
  now?: Date;
}): Promise<{
  workspaceId: number;
  entitlementId: number;
  mode: "test" | "live";
  channelConnectionId: number | null;
  bindingEpoch: number | null;
}> {
  const now = input.now ?? new Date();
  const database = await getDatabaseOrThrow();
  const rows = await database
    .select({
      workspaceId: workspaceEntitlementUsageReservations.workspaceId,
      entitlementId: workspaceEntitlementUsageReservations.entitlementId,
      mode: workspaceEntitlementUsageReservations.mode,
      channelConnectionId:
        workspaceEntitlementUsageReservations.channelConnectionId,
      bindingEpoch: workspaceEntitlementUsageReservations.bindingEpoch,
    })
    .from(workspaceEntitlementUsageReservations)
    .where(
      and(
        eq(
          workspaceEntitlementUsageReservations.reservationId,
          input.reservationId
        ),
        eq(
          workspaceEntitlementUsageReservations.ownerTokenHash,
          createHash("sha256").update(input.ownerToken).digest("hex")
        ),
        eq(workspaceEntitlementUsageReservations.kind, "ai_answer"),
        eq(workspaceEntitlementUsageReservations.status, "reserved"),
        gt(workspaceEntitlementUsageReservations.ownerLeaseUntil, now)
      )
    )
    .limit(1);
  if (!rows[0]) {
    throw new InternalAiAnswerQuotaError("reservation_scope_unavailable");
  }
  return rows[0];
}

async function assertReservationPageBinding(
  pageId: string,
  reservation: {
    workspaceId: number;
    channelConnectionId: number | null;
    bindingEpoch: number | null;
  }
): Promise<void> {
  if (
    reservation.channelConnectionId == null ||
    reservation.bindingEpoch == null
  ) {
    if (process.env.NODE_ENV === "production") {
      throw new InternalAiAnswerQuotaError("reservation_scope_unavailable");
    }
    return;
  }
  try {
    await assertMessengerGenerationOwnership({
      pageId,
      workspaceId: reservation.workspaceId,
      channelConnectionId: reservation.channelConnectionId,
      bindingEpoch: reservation.bindingEpoch,
    });
  } catch (cause) {
    throw new InternalAiAnswerQuotaError("reservation_scope_unavailable", {
      cause,
    });
  }
}

function affectedRows(result: unknown): number {
  const metadata: unknown = Array.isArray(result) ? result[0] : result;
  return Number(
    (metadata as { affectedRows?: number } | undefined)?.affectedRows ?? 0
  );
}
