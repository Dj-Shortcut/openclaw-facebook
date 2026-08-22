import { createHash, randomUUID } from "node:crypto";

import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  billingSchedulerTenants,
  workspaceEntitlements,
  workspaceEntitlementUsage,
  workspaceEntitlementUsageReservations,
} from "../../../drizzle/schema";
import { getDatabaseOrThrow } from "../../db";
import { STARTPILOT_PLAN_CODE } from "./catalog";
import { assertTenantBillingWorkerWorkspace, type MollieMode } from "./config";

const AI_RESERVATION_TTL_MS = 5 * 60 * 1_000;
const AI_RESERVATION_OWNER_LEASE_MS = AI_RESERVATION_TTL_MS - 30_000;

type BillingTransaction = Parameters<
  Parameters<Awaited<ReturnType<typeof getDatabaseOrThrow>>["transaction"]>[0]
>[0];

function extractAffectedRows(result: unknown): number {
  const metadata: unknown = Array.isArray(result)
    ? (result as unknown[])[0]
    : result;
  return Number((metadata as { affectedRows?: number })?.affectedRows ?? 0);
}

export type ActiveWorkspaceEntitlement = {
  entitlementId: number;
  workspaceId: number;
  mode: MollieMode;
  planCode: string;
  status: "active" | "grace";
  quota: unknown;
  validUntil: Date | null;
};

export type StartpilotQuota = {
  aiAnswersTotal: 300;
  imagesTotal: 20;
  imagesPerDay: 5;
  workspaces: 1;
  facebookPages: 1;
  imageQuality: "images_2";
};

export async function resolveActiveWorkspaceEntitlement(
  workspaceId: number,
  now = new Date()
): Promise<ActiveWorkspaceEntitlement | null> {
  assertPositiveId(workspaceId, "workspace");
  const mode = readEntitlementMode();
  const database = await getDatabaseOrThrow();
  const rows = await database
    .select()
    .from(workspaceEntitlements)
    .where(
      and(
        eq(workspaceEntitlements.workspaceId, workspaceId),
        eq(workspaceEntitlements.mode, mode)
      )
    )
    .limit(1);
  const entitlement = rows[0];
  if (
    !entitlement ||
    (entitlement.status !== "active" && entitlement.status !== "grace") ||
    (entitlement.validUntil &&
      entitlement.validUntil.getTime() <= now.getTime())
  ) {
    return null;
  }
  return {
    entitlementId: entitlement.id,
    workspaceId: entitlement.workspaceId,
    mode: entitlement.mode,
    planCode: entitlement.planCode,
    status: entitlement.status,
    quota: entitlement.quota,
    validUntil: entitlement.validUntil,
  };
}

export async function reserveStartpilotImageUsage(input: {
  workspaceId: number;
  entitlementId: number;
  mode: MollieMode;
  now?: Date;
}): Promise<
  | { allowed: true; imagesUsed: number; imagesUsedToday: number }
  | { allowed: false; reason: "total_exhausted" | "daily_exhausted" }
> {
  assertPositiveId(input.workspaceId, "workspace");
  assertPositiveId(input.entitlementId, "entitlement");
  const now = input.now ?? new Date();
  const usageDate = utcDateKey(now);
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const { usage, quota } = await lockStartpilotUsage(tx, input, now);
    const imagesUsedToday =
      usage.imageUsageDate === usageDate ? usage.imagesUsedToday : 0;
    if (usage.imagesUsed >= quota.imagesTotal) {
      return { allowed: false as const, reason: "total_exhausted" as const };
    }
    if (imagesUsedToday >= quota.imagesPerDay) {
      return { allowed: false as const, reason: "daily_exhausted" as const };
    }
    const nextImagesUsed = usage.imagesUsed + 1;
    const nextImagesUsedToday = imagesUsedToday + 1;
    await tx
      .update(workspaceEntitlementUsage)
      .set({
        imagesUsed: nextImagesUsed,
        imageUsageDate: usageDate,
        imagesUsedToday: nextImagesUsedToday,
      })
      .where(
        and(
          eq(workspaceEntitlementUsage.id, usage.id),
          eq(workspaceEntitlementUsage.workspaceId, input.workspaceId),
          eq(workspaceEntitlementUsage.mode, input.mode),
          eq(workspaceEntitlementUsage.entitlementId, input.entitlementId)
        )
      );
    return {
      allowed: true as const,
      imagesUsed: nextImagesUsed,
      imagesUsedToday: nextImagesUsedToday,
    };
  });
}

export async function reserveStartpilotAiAnswerUsage(input: {
  workspaceId: number;
  entitlementId: number;
  channelConnectionId?: number | null;
  bindingEpoch?: number | null;
  mode: MollieMode;
  idempotencyKey: string;
  ownerToken: string;
  now?: Date;
}): Promise<
  | { allowed: true; reservationId: string; alreadyReserved: boolean }
  | { allowed: false; reason: "total_exhausted" | "idempotency_reused" }
> {
  assertPositiveId(input.workspaceId, "workspace");
  assertPositiveId(input.entitlementId, "entitlement");
  assertOpaqueIdempotencyKey(input.idempotencyKey);
  if (!/^[0-9a-f-]{36}$/i.test(input.ownerToken)) {
    throw new Error("invalid AI answer reservation owner");
  }
  const now = input.now ?? new Date();
  assertTenantBillingWorkerWorkspace(input.workspaceId);
  const ownerTokenHash = createHash("sha256")
    .update(input.ownerToken)
    .digest("hex");
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const { usage, quota } = await lockStartpilotUsage(tx, input, now);
    const nextResolutionDue = new Date(now.getTime() + AI_RESERVATION_TTL_MS);
    const scheduler = await tx
      .select({ enabled: billingSchedulerTenants.enabled })
      .from(billingSchedulerTenants)
      .where(
        and(
          eq(billingSchedulerTenants.workspaceId, input.workspaceId),
          eq(billingSchedulerTenants.mode, input.mode),
          eq(billingSchedulerTenants.kind, "ai_finalization")
        )
      )
      .limit(1)
      .for("update");
    if (!scheduler[0]?.enabled) {
      throw new Error("billing scheduler tenant is disabled");
    }
    const schedulerWake = await tx
      .update(billingSchedulerTenants)
      .set({
        nextDueAt: sql`LEAST(${billingSchedulerTenants.nextDueAt}, ${nextResolutionDue})`,
      })
      .where(
        and(
          eq(billingSchedulerTenants.workspaceId, input.workspaceId),
          eq(billingSchedulerTenants.mode, input.mode),
          eq(billingSchedulerTenants.kind, "ai_finalization"),
          eq(billingSchedulerTenants.enabled, true)
        )
      );
    if (extractAffectedRows(schedulerWake) !== 1) {
      throw new Error("billing scheduler tenant lease is unavailable");
    }
    const existing = await tx
      .select()
      .from(workspaceEntitlementUsageReservations)
      .where(
        and(
          eq(
            workspaceEntitlementUsageReservations.workspaceId,
            input.workspaceId
          ),
          eq(workspaceEntitlementUsageReservations.mode, input.mode),
          eq(
            workspaceEntitlementUsageReservations.idempotencyKey,
            input.idempotencyKey
          )
        )
      )
      .limit(1)
      .for("update");
    if (existing[0] && existing[0].entitlementId !== input.entitlementId) {
      return { allowed: false as const, reason: "idempotency_reused" as const };
    }
    if (
      existing[0] &&
      ((existing[0].channelConnectionId ?? null) !==
        (input.channelConnectionId ?? null) ||
        (existing[0].bindingEpoch ?? null) !== (input.bindingEpoch ?? null))
    ) {
      return { allowed: false as const, reason: "idempotency_reused" as const };
    }
    if (existing[0]?.status === "reserved") {
      if (
        existing[0].ownerTokenHash !== ownerTokenHash &&
        (existing[0].ownerLeaseUntil > now || existing[0].deliveryStartedAt)
      ) {
        return {
          allowed: false as const,
          reason: "idempotency_reused" as const,
        };
      }
      if (existing[0].ownerLeaseUntil <= now) {
        if (existing[0].deliveryStartedAt) {
          return {
            allowed: false as const,
            reason: "idempotency_reused" as const,
          };
        }
        await tx
          .update(workspaceEntitlementUsageReservations)
          .set({
            ownerTokenHash,
            ownerLeaseUntil: new Date(
              now.getTime() + AI_RESERVATION_OWNER_LEASE_MS
            ),
            resolutionDueAt: nextResolutionDue,
          })
          .where(
            and(
              eq(
                workspaceEntitlementUsageReservations.reservationId,
                existing[0].reservationId
              ),
              eq(workspaceEntitlementUsageReservations.status, "reserved"),
              lte(workspaceEntitlementUsageReservations.ownerLeaseUntil, now),
              isNull(workspaceEntitlementUsageReservations.deliveryStartedAt)
            )
          );
        const resumed = await tx
          .select({
            ownerTokenHash:
              workspaceEntitlementUsageReservations.ownerTokenHash,
            ownerLeaseUntil:
              workspaceEntitlementUsageReservations.ownerLeaseUntil,
          })
          .from(workspaceEntitlementUsageReservations)
          .where(
            eq(
              workspaceEntitlementUsageReservations.reservationId,
              existing[0].reservationId
            )
          )
          .limit(1)
          .for("update");
        if (
          resumed[0]?.ownerTokenHash !== ownerTokenHash ||
          !resumed[0].ownerLeaseUntil ||
          resumed[0].ownerLeaseUntil <= now
        ) {
          throw new Error("AI answer reservation ownership takeover failed");
        }
      }
      return {
        allowed: true as const,
        reservationId: existing[0].reservationId,
        alreadyReserved: true,
      };
    }
    if (existing[0]) {
      return { allowed: false as const, reason: "idempotency_reused" as const };
    }
    await resolveStaleAiReservationsConservatively(tx, input, usage.id, now);
    const refreshedUsage = await selectUsageForUpdate(tx, input);
    if (
      refreshedUsage.aiAnswersCommitted + refreshedUsage.aiAnswersReserved >=
      quota.aiAnswersTotal
    ) {
      return { allowed: false as const, reason: "total_exhausted" as const };
    }
    const reservationId = randomUUID();
    await tx.insert(workspaceEntitlementUsageReservations).values({
      reservationId,
      workspaceId: input.workspaceId,
      mode: input.mode,
      entitlementId: input.entitlementId,
      channelConnectionId: input.channelConnectionId ?? null,
      bindingEpoch: input.bindingEpoch ?? null,
      kind: "ai_answer",
      status: "reserved",
      idempotencyKey: input.idempotencyKey,
      ownerTokenHash,
      ownerLeaseUntil: new Date(now.getTime() + AI_RESERVATION_OWNER_LEASE_MS),
      expiresAt: new Date(now.getTime() + AI_RESERVATION_TTL_MS),
      resolutionDueAt: nextResolutionDue,
    });
    await tx
      .update(workspaceEntitlementUsage)
      .set({ aiAnswersReserved: refreshedUsage.aiAnswersReserved + 1 })
      .where(
        and(
          eq(workspaceEntitlementUsage.id, refreshedUsage.id),
          eq(workspaceEntitlementUsage.workspaceId, input.workspaceId),
          eq(workspaceEntitlementUsage.mode, input.mode)
        )
      );
    return { allowed: true as const, reservationId, alreadyReserved: false };
  });
}

export async function commitStartpilotAiAnswerUsage(input: {
  workspaceId: number;
  entitlementId: number;
  mode: MollieMode;
  reservationId: string;
  ownerTokenHash: string;
  now?: Date;
}): Promise<{ committed: boolean }> {
  return finishAiReservation(input, "committed");
}

export async function releaseStartpilotAiAnswerUsage(input: {
  workspaceId: number;
  entitlementId: number;
  mode: MollieMode;
  reservationId: string;
  ownerTokenHash: string;
  now?: Date;
}): Promise<{ released: boolean }> {
  const result = await finishAiReservation(input, "released");
  return { released: result.committed };
}

async function finishAiReservation(
  input: {
    workspaceId: number;
    entitlementId: number;
    mode: MollieMode;
    reservationId: string;
    ownerTokenHash: string;
    now?: Date;
  },
  outcome: "committed" | "released"
): Promise<{ committed: boolean }> {
  assertPositiveId(input.workspaceId, "workspace");
  assertPositiveId(input.entitlementId, "entitlement");
  if (!/^[0-9a-f-]{36}$/i.test(input.reservationId)) {
    throw new Error("invalid usage reservation");
  }
  const now = input.now ?? new Date();
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const usage = await selectUsageForUpdate(tx, input);
    const reservations = await tx
      .select()
      .from(workspaceEntitlementUsageReservations)
      .where(
        and(
          eq(
            workspaceEntitlementUsageReservations.reservationId,
            input.reservationId
          ),
          eq(
            workspaceEntitlementUsageReservations.workspaceId,
            input.workspaceId
          ),
          eq(workspaceEntitlementUsageReservations.mode, input.mode),
          eq(
            workspaceEntitlementUsageReservations.entitlementId,
            input.entitlementId
          ),
          eq(workspaceEntitlementUsageReservations.kind, "ai_answer")
        )
      )
      .limit(1)
      .for("update");
    const reservation = reservations[0];
    if (!reservation) throw new Error("usage reservation not found");
    if (reservation.ownerTokenHash !== input.ownerTokenHash) {
      return { committed: false };
    }
    if (
      reservation.status === "reserved" &&
      !reservation.deliveryStartedAt &&
      reservation.ownerLeaseUntil <= now
    ) {
      return { committed: false };
    }
    const effectiveOutcome =
      reservation.deliveryStartedAt && !reservation.deliveryKnownRejectedAt
        ? "committed"
        : outcome;
    if (reservation.status === effectiveOutcome) return { committed: true };
    if (reservation.status !== "reserved") {
      return { committed: false };
    }
    if (reservation.expiresAt.getTime() <= now.getTime()) {
      await tx
        .update(workspaceEntitlementUsageReservations)
        .set(
          effectiveOutcome === "committed"
            ? { status: "committed", committedAt: now }
            : { status: "released", releasedAt: now }
        )
        .where(
          and(
            eq(
              workspaceEntitlementUsageReservations.reservationId,
              input.reservationId
            ),
            eq(
              workspaceEntitlementUsageReservations.workspaceId,
              input.workspaceId
            ),
            eq(workspaceEntitlementUsageReservations.mode, input.mode),
            eq(
              workspaceEntitlementUsageReservations.entitlementId,
              input.entitlementId
            ),
            eq(workspaceEntitlementUsageReservations.kind, "ai_answer"),
            eq(workspaceEntitlementUsageReservations.status, "reserved")
          )
        );
      await tx
        .update(workspaceEntitlementUsage)
        .set({
          aiAnswersReserved: requireReservedCapacity(
            usage.aiAnswersReserved,
            1
          ),
          aiAnswersCommitted:
            usage.aiAnswersCommitted +
            (effectiveOutcome === "committed" ? 1 : 0),
        })
        .where(
          and(
            eq(workspaceEntitlementUsage.id, usage.id),
            eq(workspaceEntitlementUsage.workspaceId, input.workspaceId),
            eq(workspaceEntitlementUsage.mode, input.mode),
            eq(workspaceEntitlementUsage.entitlementId, input.entitlementId)
          )
        );
      return { committed: true };
    }
    await tx
      .update(workspaceEntitlementUsageReservations)
      .set(
        effectiveOutcome === "committed"
          ? { status: "committed", committedAt: now }
          : { status: "released", releasedAt: now }
      )
      .where(
        and(
          eq(
            workspaceEntitlementUsageReservations.reservationId,
            input.reservationId
          ),
          eq(workspaceEntitlementUsageReservations.status, "reserved")
        )
      );
    await tx
      .update(workspaceEntitlementUsage)
      .set({
        aiAnswersReserved: requireReservedCapacity(usage.aiAnswersReserved, 1),
        aiAnswersCommitted:
          usage.aiAnswersCommitted + (effectiveOutcome === "committed" ? 1 : 0),
      })
      .where(
        and(
          eq(workspaceEntitlementUsage.id, usage.id),
          eq(workspaceEntitlementUsage.workspaceId, input.workspaceId),
          eq(workspaceEntitlementUsage.mode, input.mode)
        )
      );
    return { committed: true };
  });
}

async function lockStartpilotUsage(
  tx: BillingTransaction,
  input: { workspaceId: number; entitlementId: number; mode: MollieMode },
  now: Date
) {
  const entitlements = await tx
    .select()
    .from(workspaceEntitlements)
    .where(
      and(
        eq(workspaceEntitlements.id, input.entitlementId),
        eq(workspaceEntitlements.workspaceId, input.workspaceId),
        eq(workspaceEntitlements.mode, input.mode)
      )
    )
    .limit(1)
    .for("update");
  const entitlement = entitlements[0];
  const quota = parseStartpilotQuota(entitlement?.quota);
  if (
    !entitlement ||
    entitlement.planCode !== STARTPILOT_PLAN_CODE ||
    (entitlement.status !== "active" && entitlement.status !== "grace") ||
    !entitlement.validUntil ||
    entitlement.validUntil.getTime() <= now.getTime() ||
    !quota
  ) {
    throw new Error("Startpilot entitlement is unavailable");
  }
  const usage = await selectUsageForUpdate(tx, input);
  if (
    usage.planCode !== STARTPILOT_PLAN_CODE ||
    usage.periodEndsAt.getTime() !== entitlement.validUntil.getTime()
  ) {
    throw new Error("Startpilot usage scope mismatch");
  }
  return { entitlement, usage, quota };
}

async function selectUsageForUpdate(
  tx: BillingTransaction,
  input: { workspaceId: number; entitlementId: number; mode: MollieMode }
) {
  const rows = await tx
    .select()
    .from(workspaceEntitlementUsage)
    .where(
      and(
        eq(workspaceEntitlementUsage.workspaceId, input.workspaceId),
        eq(workspaceEntitlementUsage.entitlementId, input.entitlementId),
        eq(workspaceEntitlementUsage.mode, input.mode)
      )
    )
    .limit(1)
    .for("update");
  if (!rows[0]) throw new Error("Startpilot usage is unavailable");
  return rows[0];
}

async function resolveStaleAiReservationsConservatively(
  tx: BillingTransaction,
  input: { workspaceId: number; entitlementId: number; mode: MollieMode },
  usageId: number,
  now: Date
) {
  const stale = await tx
    .select({
      reservationId: workspaceEntitlementUsageReservations.reservationId,
      deliveryStartedAt:
        workspaceEntitlementUsageReservations.deliveryStartedAt,
    })
    .from(workspaceEntitlementUsageReservations)
    .where(
      and(
        eq(
          workspaceEntitlementUsageReservations.workspaceId,
          input.workspaceId
        ),
        eq(
          workspaceEntitlementUsageReservations.entitlementId,
          input.entitlementId
        ),
        eq(workspaceEntitlementUsageReservations.mode, input.mode),
        eq(workspaceEntitlementUsageReservations.kind, "ai_answer"),
        eq(workspaceEntitlementUsageReservations.status, "reserved"),
        lte(workspaceEntitlementUsageReservations.resolutionDueAt, now)
      )
    )
    .for("update");
  if (stale.length === 0) return;
  requireReservedCapacity(
    (await selectUsageForUpdate(tx, input)).aiAnswersReserved,
    stale.length
  );
  const committedIds = stale
    .filter(row => row.deliveryStartedAt)
    .map(row => row.reservationId);
  const releasedIds = stale
    .filter(row => !row.deliveryStartedAt)
    .map(row => row.reservationId);
  if (committedIds.length) {
    await tx
      .update(workspaceEntitlementUsageReservations)
      .set({ status: "committed", committedAt: now })
      .where(
        and(
          inArray(
            workspaceEntitlementUsageReservations.reservationId,
            committedIds
          ),
          eq(workspaceEntitlementUsageReservations.status, "reserved")
        )
      );
  }
  if (releasedIds.length) {
    await tx
      .update(workspaceEntitlementUsageReservations)
      .set({ status: "released", releasedAt: now })
      .where(
        and(
          inArray(
            workspaceEntitlementUsageReservations.reservationId,
            releasedIds
          ),
          eq(workspaceEntitlementUsageReservations.status, "reserved")
        )
      );
  }
  const usage = await selectUsageForUpdate(tx, input);
  await tx
    .update(workspaceEntitlementUsage)
    .set({
      aiAnswersReserved: requireReservedCapacity(
        usage.aiAnswersReserved,
        stale.length
      ),
      aiAnswersCommitted: usage.aiAnswersCommitted + committedIds.length,
    })
    .where(eq(workspaceEntitlementUsage.id, usageId));
}

export async function finalizeStaleAiAnswerReservationsForWorkspace(input: {
  workspaceId: number;
  mode: MollieMode;
  now?: Date;
}): Promise<number> {
  assertPositiveId(input.workspaceId, "workspace");
  const now = input.now ?? new Date();
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const staleScopes = await tx
      .selectDistinct({
        entitlementId: workspaceEntitlementUsageReservations.entitlementId,
      })
      .from(workspaceEntitlementUsageReservations)
      .where(
        and(
          eq(
            workspaceEntitlementUsageReservations.workspaceId,
            input.workspaceId
          ),
          eq(workspaceEntitlementUsageReservations.mode, input.mode),
          eq(workspaceEntitlementUsageReservations.kind, "ai_answer"),
          eq(workspaceEntitlementUsageReservations.status, "reserved"),
          lte(workspaceEntitlementUsageReservations.resolutionDueAt, now)
        )
      )
      .limit(100);
    let finalized = 0;
    for (const scope of staleScopes) {
      const usage = await selectUsageForUpdate(tx, {
        workspaceId: input.workspaceId,
        entitlementId: scope.entitlementId,
        mode: input.mode,
      });
      const before = usage.aiAnswersReserved;
      await resolveStaleAiReservationsConservatively(
        tx,
        {
          workspaceId: input.workspaceId,
          entitlementId: scope.entitlementId,
          mode: input.mode,
        },
        usage.id,
        now
      );
      const after = await selectUsageForUpdate(tx, {
        workspaceId: input.workspaceId,
        entitlementId: scope.entitlementId,
        mode: input.mode,
      });
      if (after.aiAnswersReserved > before) {
        throw new Error(
          "AI answer reserved counter increased during finalization"
        );
      }
      finalized += before - after.aiAnswersReserved;
    }
    return finalized;
  });
}

export async function getNextAiAnswerFinalizationDue(input: {
  workspaceId: number;
  mode: MollieMode;
  now?: Date;
}): Promise<Date> {
  assertPositiveId(input.workspaceId, "workspace");
  const now = input.now ?? new Date();
  const database = await getDatabaseOrThrow();
  const rows = await database
    .select({
      nextAt: sql<Date | null>`MIN(${workspaceEntitlementUsageReservations.resolutionDueAt})`,
    })
    .from(workspaceEntitlementUsageReservations)
    .where(
      and(
        eq(
          workspaceEntitlementUsageReservations.workspaceId,
          input.workspaceId
        ),
        eq(workspaceEntitlementUsageReservations.mode, input.mode),
        eq(workspaceEntitlementUsageReservations.kind, "ai_answer"),
        eq(workspaceEntitlementUsageReservations.status, "reserved")
      )
    );
  return rows[0]?.nextAt instanceof Date
    ? rows[0].nextAt
    : new Date(now.getTime() + 24 * 60 * 60_000);
}

function requireReservedCapacity(current: number, decrement: number): number {
  if (current < decrement) {
    throw new Error("AI answer reserved counter invariant violated");
  }
  return current - decrement;
}

export function parseStartpilotQuota(value: unknown): StartpilotQuota | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const quota = value as Record<string, unknown>;
  return quota.aiAnswersTotal === 300 &&
    quota.imagesTotal === 20 &&
    quota.imagesPerDay === 5 &&
    quota.workspaces === 1 &&
    quota.facebookPages === 1 &&
    quota.imageQuality === "images_2"
    ? (quota as StartpilotQuota)
    : null;
}

export function utcDateKey(value: Date): string {
  if (Number.isNaN(value.getTime())) throw new Error("invalid usage date");
  return value.toISOString().slice(0, 10);
}

function readEntitlementMode(): MollieMode {
  const mode = process.env.MOLLIE_MODE?.trim();
  if (mode !== "test" && mode !== "live") {
    throw new Error("MOLLIE_MODE must be configured for paid entitlement use");
  }
  return mode;
}

function assertPositiveId(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid ${label} id`);
  }
}

function assertOpaqueIdempotencyKey(value: string): void {
  if (!/^[A-Za-z0-9:_-]{16,160}$/.test(value)) {
    throw new Error("invalid usage idempotency key");
  }
}
