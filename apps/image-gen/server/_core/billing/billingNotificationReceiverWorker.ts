import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import {
  billingNotificationInbox,
  billingNotificationReceiverOutbox,
  billingNotificationSchedulerTenants,
} from "../../../drizzle/schema";
import { getDatabaseOrThrow } from "../../db";
import { safeLog } from "../logger";
import { getConfiguredBillingMode } from "./config";
import { recordBillingSchedulerPoll } from "./billingSchedulerStore";

const LEASE_MS = 30_000;
const POLL_MS = 2_000;

export async function runBillingNotificationReceiverOnce(
  now = new Date()
): Promise<boolean> {
  const mode = getConfiguredBillingMode();
  await recordBillingSchedulerPoll(mode, "notification_receiver", now);
  const database = await getDatabaseOrThrow();
  const claim = await database.transaction(async tx => {
    const schedulers = await tx
      .select()
      .from(billingNotificationSchedulerTenants)
      .where(
        and(
          eq(billingNotificationSchedulerTenants.mode, mode),
          lte(billingNotificationSchedulerTenants.nextDueAt, now),
          or(
            isNull(billingNotificationSchedulerTenants.leaseToken),
            lte(billingNotificationSchedulerTenants.leaseUntil, now)
          )
        )
      )
      .orderBy(
        asc(billingNotificationSchedulerTenants.lastServedAt),
        asc(billingNotificationSchedulerTenants.nextDueAt),
        asc(billingNotificationSchedulerTenants.workspaceId)
      )
      .limit(1)
      .for("update", { skipLocked: true });
    const scheduler = schedulers[0];
    if (!scheduler) return null;
    const tenantLeaseToken = randomUUID();
    const tenantClaim = await tx
      .update(billingNotificationSchedulerTenants)
      .set({
        leaseToken: tenantLeaseToken,
        leaseUntil: new Date(now.getTime() + LEASE_MS),
      })
      .where(
        and(
          eq(
            billingNotificationSchedulerTenants.workspaceId,
            scheduler.workspaceId
          ),
          eq(billingNotificationSchedulerTenants.mode, mode),
          or(
            isNull(billingNotificationSchedulerTenants.leaseToken),
            lte(billingNotificationSchedulerTenants.leaseUntil, now)
          )
        )
      );
    if (affectedRows(tenantClaim) !== 1) return null;
    await tx
      .update(billingNotificationReceiverOutbox)
      .set({ status: "pending", lockedAt: null, leaseToken: null })
      .where(
        and(
          eq(billingNotificationReceiverOutbox.status, "processing"),
          eq(
            billingNotificationReceiverOutbox.workspaceId,
            scheduler.workspaceId
          ),
          eq(billingNotificationReceiverOutbox.mode, mode),
          lte(
            billingNotificationReceiverOutbox.lockedAt,
            new Date(now.getTime() - LEASE_MS)
          )
        )
      );
    const rows = await tx
      .select()
      .from(billingNotificationReceiverOutbox)
      .where(
        and(
          eq(billingNotificationReceiverOutbox.status, "pending"),
          eq(
            billingNotificationReceiverOutbox.workspaceId,
            scheduler.workspaceId
          ),
          eq(billingNotificationReceiverOutbox.mode, mode),
          lte(billingNotificationReceiverOutbox.availableAt, now),
          or(
            isNull(billingNotificationReceiverOutbox.leaseToken),
            lte(billingNotificationReceiverOutbox.lockedAt, now)
          )
        )
      )
      .orderBy(
        asc(billingNotificationReceiverOutbox.availableAt),
        asc(billingNotificationReceiverOutbox.id)
      )
      .limit(1)
      .for("update", { skipLocked: true });
    const row = rows[0];
    if (!row) {
      await tx
        .update(billingNotificationSchedulerTenants)
        .set({
          leaseToken: null,
          leaseUntil: null,
          lastServedAt: now,
          nextDueAt: new Date(now.getTime() + 24 * 60 * 60_000),
        })
        .where(
          and(
            eq(
              billingNotificationSchedulerTenants.workspaceId,
              scheduler.workspaceId
            ),
            eq(billingNotificationSchedulerTenants.mode, mode),
            eq(billingNotificationSchedulerTenants.leaseToken, tenantLeaseToken)
          )
        );
      return null;
    }
    const leaseToken = randomUUID();
    const attemptCount = row.attemptCount + 1;
    const result = await tx
      .update(billingNotificationReceiverOutbox)
      .set({
        status: "processing",
        lockedAt: now,
        leaseToken,
        attemptCount,
      })
      .where(
        and(
          eq(billingNotificationReceiverOutbox.id, row.id),
          eq(billingNotificationReceiverOutbox.status, "pending")
        )
      );
    if (affectedRows(result) !== 1) return null;
    return {
      ...row,
      status: "processing" as const,
      leaseToken,
      attemptCount,
      tenantLeaseToken,
    };
  });
  if (!claim) return false;

  try {
    await database.transaction(async tx => {
      const active = await tx
        .select({ id: billingNotificationReceiverOutbox.id })
        .from(billingNotificationReceiverOutbox)
        .where(
          and(
            eq(billingNotificationReceiverOutbox.id, claim.id),
            eq(billingNotificationReceiverOutbox.status, "processing"),
            eq(billingNotificationReceiverOutbox.leaseToken, claim.leaseToken)
          )
        )
        .limit(1)
        .for("update");
      if (!active[0]) throw new Error("notification receiver lease lost");
      await tx
        .insert(billingNotificationInbox)
        .values({
          receiptId: claim.receiptId,
          workspaceId: claim.workspaceId,
          audience: claim.audience,
          eventType: claim.eventType,
          reason: claim.reason,
          occurredAt: claim.createdAt,
        })
        .onDuplicateKeyUpdate({ set: { receiptId: claim.receiptId } });
      const completed = await tx
        .update(billingNotificationReceiverOutbox)
        .set({
          status: "delivered",
          deliveredAt: now,
          lockedAt: null,
          leaseToken: null,
          lastErrorCode: null,
        })
        .where(
          and(
            eq(billingNotificationReceiverOutbox.id, claim.id),
            eq(billingNotificationReceiverOutbox.status, "processing"),
            eq(billingNotificationReceiverOutbox.leaseToken, claim.leaseToken)
          )
        );
      if (affectedRows(completed) !== 1) {
        throw new Error("notification receiver completion lease lost");
      }
      await releaseNotificationSchedulerTenant(tx, claim, now, {
        completed: true,
        deadLetter: false,
      });
    });
  } catch (error) {
    const exhausted = claim.attemptCount >= claim.maxAttempts;
    await database.transaction(async tx => {
      const failed = await tx
        .update(billingNotificationReceiverOutbox)
        .set({
          status: exhausted ? "dead_letter" : "pending",
          availableAt: new Date(
            now.getTime() + Math.min(300, 2 ** claim.attemptCount) * 1_000
          ),
          lockedAt: null,
          leaseToken: null,
          lastErrorCode:
            error instanceof Error ? error.constructor.name : "UnknownError",
        })
        .where(
          and(
            eq(billingNotificationReceiverOutbox.id, claim.id),
            eq(billingNotificationReceiverOutbox.leaseToken, claim.leaseToken)
          )
        );
      if (affectedRows(failed) !== 1) {
        throw new Error("notification receiver failure lease lost");
      }
      await releaseNotificationSchedulerTenant(tx, claim, now, {
        completed: false,
        deadLetter: exhausted,
      });
    });
    safeLog("billing_notification_receiver_delivery_failed", {
      level: "error",
      audience: claim.audience,
      deadLetter: exhausted,
      errorCode:
        error instanceof Error ? error.constructor.name : "UnknownError",
    });
  }
  return true;
}

type NotificationTransaction = Parameters<
  Parameters<Awaited<ReturnType<typeof getDatabaseOrThrow>>["transaction"]>[0]
>[0];

async function releaseNotificationSchedulerTenant(
  tx: NotificationTransaction,
  claim: {
    workspaceId: number;
    mode: "test" | "live";
    tenantLeaseToken: string;
    attemptCount: number;
  },
  now: Date,
  _outcome: { completed: boolean; deadLetter: boolean }
): Promise<void> {
  const next = await tx
    .select({
      nextAt: sql<Date | null>`MIN(CASE WHEN ${billingNotificationReceiverOutbox.status} = 'pending' THEN ${billingNotificationReceiverOutbox.availableAt} ELSE NULL END)`,
      pendingCount: sql<number>`SUM(CASE WHEN ${billingNotificationReceiverOutbox.status} = 'pending' THEN 1 ELSE 0 END)`,
      deadLetterCount: sql<number>`SUM(CASE WHEN ${billingNotificationReceiverOutbox.status} = 'dead_letter' THEN 1 ELSE 0 END)`,
    })
    .from(billingNotificationReceiverOutbox)
    .where(
      and(
        eq(billingNotificationReceiverOutbox.workspaceId, claim.workspaceId),
        eq(billingNotificationReceiverOutbox.mode, claim.mode)
      )
    );
  const released = await tx
    .update(billingNotificationSchedulerTenants)
    .set({
      leaseToken: null,
      leaseUntil: null,
      lastServedAt: now,
      nextDueAt:
        next[0]?.nextAt instanceof Date
          ? next[0].nextAt
          : new Date(now.getTime() + 24 * 60 * 60_000),
      pendingWorkCount: sql`GREATEST(0, ${Number(next[0]?.pendingCount ?? 0)})`,
      deadLetterCount: sql`GREATEST(0, ${Number(next[0]?.deadLetterCount ?? 0)})`,
    })
    .where(
      and(
        eq(billingNotificationSchedulerTenants.workspaceId, claim.workspaceId),
        eq(billingNotificationSchedulerTenants.mode, claim.mode),
        eq(
          billingNotificationSchedulerTenants.leaseToken,
          claim.tenantLeaseToken
        ),
        sql`${billingNotificationSchedulerTenants.leaseUntil} > ${now}`
      )
    );
  if (affectedRows(released) !== 1) {
    throw new Error("notification scheduler tenant lease lost");
  }
}

export function startBillingNotificationReceiverWorker(): void {
  const timer = setInterval(() => {
    void runBillingNotificationReceiverOnce().catch(error => {
      safeLog("billing_notification_receiver_worker_failed", {
        level: "error",
        errorCode:
          error instanceof Error ? error.constructor.name : "UnknownError",
      });
    });
  }, POLL_MS);
  timer.unref();
}

export async function listWorkspaceBillingNotifications(input: {
  workspaceId: number;
  audience: "customer" | "operator";
  limit?: number;
}) {
  const database = await getDatabaseOrThrow();
  return database
    .select({
      id: billingNotificationInbox.id,
      eventType: billingNotificationInbox.eventType,
      reason: billingNotificationInbox.reason,
      occurredAt: billingNotificationInbox.occurredAt,
      readAt: billingNotificationInbox.readAt,
    })
    .from(billingNotificationInbox)
    .where(
      and(
        eq(billingNotificationInbox.workspaceId, input.workspaceId),
        eq(billingNotificationInbox.audience, input.audience)
      )
    )
    .orderBy(
      asc(billingNotificationInbox.readAt),
      asc(billingNotificationInbox.occurredAt),
      asc(billingNotificationInbox.id)
    )
    .limit(Math.min(50, Math.max(1, input.limit ?? 20)));
}

function affectedRows(result: unknown): number {
  const metadata: unknown = Array.isArray(result)
    ? (result as unknown[])[0]
    : result;
  return Number(
    (metadata as { affectedRows?: number } | undefined)?.affectedRows ?? 0
  );
}
