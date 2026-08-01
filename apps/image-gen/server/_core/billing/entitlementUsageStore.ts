import { randomUUID } from "node:crypto";

import { and, eq, lte } from "drizzle-orm";
import {
  workspaceEntitlements,
  workspaceEntitlementUsage,
  workspaceEntitlementUsageReservations,
} from "../../../drizzle/schema";
import { getDatabaseOrThrow } from "../../db";
import { STARTPILOT_PLAN_CODE } from "./catalog";
import type { MollieMode } from "./config";

const AI_RESERVATION_TTL_MS = 5 * 60 * 1_000;

type BillingTransaction = Parameters<
  Parameters<Awaited<ReturnType<typeof getDatabaseOrThrow>>["transaction"]>[0]
>[0];

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
  mode: MollieMode;
  idempotencyKey: string;
  now?: Date;
}): Promise<
  | { allowed: true; reservationId: string; alreadyReserved: boolean }
  | { allowed: false; reason: "total_exhausted" | "idempotency_reused" }
> {
  assertPositiveId(input.workspaceId, "workspace");
  assertPositiveId(input.entitlementId, "entitlement");
  assertOpaqueIdempotencyKey(input.idempotencyKey);
  const now = input.now ?? new Date();
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const { usage, quota } = await lockStartpilotUsage(tx, input, now);
    await expireStaleAiReservations(tx, input, usage.id, now);
    const refreshedUsage = await selectUsageForUpdate(tx, input);
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
    if (existing[0]?.status === "reserved") {
      return {
        allowed: true as const,
        reservationId: existing[0].reservationId,
        alreadyReserved: true,
      };
    }
    if (existing[0]) {
      return { allowed: false as const, reason: "idempotency_reused" as const };
    }
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
      kind: "ai_answer",
      status: "reserved",
      idempotencyKey: input.idempotencyKey,
      expiresAt: new Date(now.getTime() + AI_RESERVATION_TTL_MS),
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
  now?: Date;
}): Promise<{ committed: boolean }> {
  return finishAiReservation(input, "committed");
}

export async function releaseStartpilotAiAnswerUsage(input: {
  workspaceId: number;
  entitlementId: number;
  mode: MollieMode;
  reservationId: string;
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
          )
        )
      )
      .limit(1)
      .for("update");
    const reservation = reservations[0];
    if (!reservation) throw new Error("usage reservation not found");
    if (reservation.status === outcome) return { committed: true };
    if (
      reservation.status !== "reserved" ||
      reservation.expiresAt.getTime() <= now.getTime()
    ) {
      return { committed: false };
    }
    await tx
      .update(workspaceEntitlementUsageReservations)
      .set(
        outcome === "committed"
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
        aiAnswersReserved: Math.max(0, usage.aiAnswersReserved - 1),
        aiAnswersCommitted:
          usage.aiAnswersCommitted + (outcome === "committed" ? 1 : 0),
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

async function expireStaleAiReservations(
  tx: BillingTransaction,
  input: { workspaceId: number; entitlementId: number; mode: MollieMode },
  usageId: number,
  now: Date
) {
  const stale = await tx
    .select({
      reservationId: workspaceEntitlementUsageReservations.reservationId,
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
        lte(workspaceEntitlementUsageReservations.expiresAt, now)
      )
    )
    .for("update");
  if (stale.length === 0) return;
  await tx
    .update(workspaceEntitlementUsageReservations)
    .set({ status: "expired", releasedAt: now })
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
        eq(workspaceEntitlementUsageReservations.status, "reserved"),
        lte(workspaceEntitlementUsageReservations.expiresAt, now)
      )
    );
  const usage = await selectUsageForUpdate(tx, input);
  await tx
    .update(workspaceEntitlementUsage)
    .set({
      aiAnswersReserved: Math.max(0, usage.aiAnswersReserved - stale.length),
    })
    .where(eq(workspaceEntitlementUsage.id, usageId));
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
