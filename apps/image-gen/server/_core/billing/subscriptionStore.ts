import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import {
  billingIntents,
  billingOutbox,
  billingSubscriptions,
  paymentLedger,
  workspaceEntitlements,
  workspaces,
  type BillingSubscription,
} from "../../../drizzle/schema";
import { getDatabaseOrThrow } from "../../db";
import type { MollieMode } from "./config";

export async function getWorkspaceBillingSubscription(
  workspaceId: number,
  mode: MollieMode
): Promise<BillingSubscription | null> {
  const database = await getDatabaseOrThrow();
  const result = await database
    .select()
    .from(billingSubscriptions)
    .where(
      and(
        eq(billingSubscriptions.workspaceId, workspaceId),
        eq(billingSubscriptions.mode, mode)
      )
    )
    .limit(1);
  return result[0] ?? null;
}

export async function requestWorkspaceSubscriptionCancellation(
  workspaceId: number,
  mode: MollieMode
): Promise<{ canceled: true; accessUntil: Date | null }> {
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const workspaceRows = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1)
      .for("update");
    if (!workspaceRows[0]) {
      throw new Error("workspace not found");
    }
    const supersededReplacementIntents = await tx
      .select({ intentId: billingIntents.intentId })
      .from(billingIntents)
      .where(
        and(
          eq(billingIntents.workspaceId, workspaceId),
          eq(billingIntents.mode, mode),
          eq(billingIntents.kind, "payment_method_change"),
          inArray(billingIntents.status, [
            "created",
            "creating_payment",
            "open",
            "api_unknown",
          ])
        )
      )
      .for("update");
    const subscriptions = await tx
      .select()
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.workspaceId, workspaceId),
          eq(billingSubscriptions.mode, mode)
        )
      )
      .limit(1)
      .for("update");
    const subscription = subscriptions[0];
    if (!subscription) {
      throw new Error("billing subscription not found");
    }

    if (supersededReplacementIntents.length > 0) {
      await tx
        .update(billingIntents)
        .set({ status: "canceled" })
        .where(
          and(
            eq(billingIntents.workspaceId, workspaceId),
            eq(billingIntents.mode, mode),
            eq(billingIntents.kind, "payment_method_change"),
            inArray(billingIntents.status, [
              "created",
              "creating_payment",
              "open",
              "api_unknown",
            ])
          )
        );
    }

    const canceledAt = new Date();
    await tx
      .update(billingSubscriptions)
      .set({
        status: "canceled",
        cancelAtPeriodEnd: 1,
        canceledAt: subscription.canceledAt ?? canceledAt,
      })
      .where(
        and(
          eq(billingSubscriptions.workspaceId, workspaceId),
          eq(billingSubscriptions.mode, mode),
          eq(billingSubscriptions.sourceIntentId, subscription.sourceIntentId)
        )
      );

    const entitlementScope = and(
      eq(workspaceEntitlements.workspaceId, workspaceId),
      eq(workspaceEntitlements.mode, mode)
    );
    await tx
      .update(workspaceEntitlements)
      .set(canceledEntitlementState(subscription.paidThrough, canceledAt))
      .where(
        subscription.paidThrough
          ? and(
              entitlementScope,
              or(
                eq(workspaceEntitlements.status, "active"),
                eq(workspaceEntitlements.status, "grace")
              )
            )
          : entitlementScope
      );

    if (subscription.mollieSubscriptionId) {
      const deduplicationKey = `user_cancel:${subscription.sourceIntentId}:${subscription.mollieSubscriptionId}`;
      await tx
        .insert(billingOutbox)
        .values({
          workspaceId,
          mode,
          eventType: "cancel_subscription",
          deduplicationKey,
          payload: {
            reason: "user_cancel",
            expectedSourceIntentId: subscription.sourceIntentId,
            targetCustomerId: subscription.mollieCustomerId,
            targetSubscriptionId: subscription.mollieSubscriptionId,
          },
          status: "pending",
        })
        .onDuplicateKeyUpdate({
          set: { deduplicationKey: sql`deduplication_key` },
        });
      await tx
        .update(billingOutbox)
        .set({
          status: "pending",
          attemptCount: 0,
          availableAt: new Date(),
          lockedAt: null,
          leaseToken: null,
          lastErrorCode: null,
        })
        .where(
          and(
            eq(billingOutbox.workspaceId, workspaceId),
            eq(billingOutbox.mode, mode),
            eq(billingOutbox.eventType, "cancel_subscription"),
            eq(billingOutbox.deduplicationKey, deduplicationKey),
            eq(billingOutbox.status, "failed")
          )
        );
    }

    return { canceled: true as const, accessUntil: subscription.paidThrough };
  });
}

export function canceledEntitlementState(
  paidThrough: Date | null,
  canceledAt: Date
): { status: "active" | "inactive"; validUntil: Date } {
  if (!paidThrough) {
    return { status: "inactive", validUntil: canceledAt };
  }
  return {
    status:
      paidThrough.getTime() > canceledAt.getTime() ? "active" : "inactive",
    validUntil: paidThrough,
  };
}

export async function markWorkspaceSubscriptionStoppedIfMatches(
  workspaceId: number,
  mode: MollieMode,
  mollieSubscriptionId: string
): Promise<void> {
  const database = await getDatabaseOrThrow();
  await database
    .update(billingSubscriptions)
    .set({
      status: "canceled",
      cancelAtPeriodEnd: 1,
      canceledAt: sql`COALESCE(${billingSubscriptions.canceledAt}, ${new Date()})`,
    })
    .where(
      and(
        eq(billingSubscriptions.workspaceId, workspaceId),
        eq(billingSubscriptions.mode, mode),
        eq(billingSubscriptions.mollieSubscriptionId, mollieSubscriptionId)
      )
    );
}

export async function syncWorkspaceSubscriptionScheduleIfMatches(
  workspaceId: number,
  mode: MollieMode,
  mollieSubscriptionId: string,
  nextPaymentDate: Date | null
): Promise<void> {
  const database = await getDatabaseOrThrow();
  await database
    .update(billingSubscriptions)
    .set({ nextPaymentDate })
    .where(
      and(
        eq(billingSubscriptions.workspaceId, workspaceId),
        eq(billingSubscriptions.mode, mode),
        eq(billingSubscriptions.mollieSubscriptionId, mollieSubscriptionId)
      )
    );
}

export async function getWorkspaceBillingSummary(
  workspaceId: number,
  mode: MollieMode,
  options: { includePayments?: boolean } = {}
) {
  const database = await getDatabaseOrThrow();
  const includePayments = options.includePayments === true;
  const [subscriptions, entitlements, payments] = await Promise.all([
    database
      .select()
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.workspaceId, workspaceId),
          eq(billingSubscriptions.mode, mode)
        )
      )
      .limit(1),
    database
      .select()
      .from(workspaceEntitlements)
      .where(
        and(
          eq(workspaceEntitlements.workspaceId, workspaceId),
          eq(workspaceEntitlements.mode, mode)
        )
      )
      .limit(1),
    includePayments
      ? database
          .select({
            molliePaymentId: paymentLedger.molliePaymentId,
            grossAmount: paymentLedger.grossAmount,
            currency: paymentLedger.currency,
            status: paymentLedger.status,
            invoiceNumber: paymentLedger.invoiceNumber,
            occurredAt: paymentLedger.occurredAt,
          })
          .from(paymentLedger)
          .where(
            and(
              eq(paymentLedger.workspaceId, workspaceId),
              eq(paymentLedger.mode, mode),
              isNotNull(paymentLedger.invoiceNumber)
            )
          )
          .orderBy(desc(paymentLedger.occurredAt))
          .limit(100)
      : Promise.resolve([]),
  ]);

  const subscription = subscriptions[0] ?? null;
  return {
    mode,
    subscription: subscription
      ? {
          planCode: subscription.planCode,
          status: subscription.status,
          interval: subscription.interval,
          currentPeriodStart: subscription.currentPeriodStart,
          paidThrough: subscription.paidThrough,
          nextBillingDate:
            subscription.cancelAtPeriodEnd === 1
              ? null
              : subscription.nextPaymentDate,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd === 1,
        }
      : null,
    entitlement: entitlements[0]
      ? {
          planCode: entitlements[0].planCode,
          status: entitlements[0].status,
          quota: entitlements[0].quota,
          validUntil: entitlements[0].validUntil,
        }
      : null,
    payments: payments.map(payment => ({
      ...payment,
      receiptPath: `/api/portal/billing/receipts/${encodeURIComponent(payment.molliePaymentId)}?workspaceId=${workspaceId}`,
    })),
  };
}

export async function getWorkspaceLedgerPayment(
  workspaceId: number,
  mode: MollieMode,
  molliePaymentId: string
) {
  const database = await getDatabaseOrThrow();
  const result = await database
    .select()
    .from(paymentLedger)
    .where(
      and(
        eq(paymentLedger.workspaceId, workspaceId),
        eq(paymentLedger.mode, mode),
        eq(paymentLedger.molliePaymentId, molliePaymentId),
        isNotNull(paymentLedger.invoiceNumber)
      )
    )
    .limit(1);
  const payment = result[0];
  return payment?.invoiceNumber
    ? { ...payment, invoiceNumber: payment.invoiceNumber }
    : null;
}

export type AccountingCursor = Readonly<{ occurredAt: Date; id: number }>;

export async function getWorkspaceAccountingHighWaterId(input: {
  workspaceId: number;
  mode: MollieMode;
  from: Date;
  until: Date;
}): Promise<number> {
  const database = await getDatabaseOrThrow();
  const rows = await database
    .select({ highWaterId: sql<number | null>`MAX(${paymentLedger.id})` })
    .from(paymentLedger)
    .where(
      and(
        eq(paymentLedger.workspaceId, input.workspaceId),
        eq(paymentLedger.mode, input.mode),
        isNotNull(paymentLedger.invoiceNumber),
        gte(paymentLedger.occurredAt, input.from),
        lt(paymentLedger.occurredAt, input.until)
      )
    );
  const value = Number(rows[0]?.highWaterId ?? 0);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("billing accounting high-water is invalid");
  }
  return value;
}

export async function listWorkspaceAccountingEntryBatch(input: {
  workspaceId: number;
  mode: MollieMode;
  from: Date;
  until: Date;
  highWaterId: number;
  cursor?: AccountingCursor;
  limit?: number;
}) {
  const limit = Math.max(1, Math.min(500, input.limit ?? 500));
  const database = await getDatabaseOrThrow();
  return database
    .select()
    .from(paymentLedger)
    .where(
      and(
        eq(paymentLedger.workspaceId, input.workspaceId),
        eq(paymentLedger.mode, input.mode),
        isNotNull(paymentLedger.invoiceNumber),
        gte(paymentLedger.occurredAt, input.from),
        lt(paymentLedger.occurredAt, input.until),
        lte(paymentLedger.id, input.highWaterId),
        ...(input.cursor
          ? [
              or(
                gt(paymentLedger.occurredAt, input.cursor.occurredAt),
                and(
                  eq(paymentLedger.occurredAt, input.cursor.occurredAt),
                  gt(paymentLedger.id, input.cursor.id)
                )
              ),
            ]
          : [])
      )
    )
    .orderBy(asc(paymentLedger.occurredAt), asc(paymentLedger.id))
    .limit(limit);
}
