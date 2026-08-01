import { and, eq, gte, ne, sql } from "drizzle-orm";
import {
  billingCustomers,
  billingInvoiceSequences,
  billingIntents,
  billingOutbox,
  billingSubscriptions,
  paymentLedger,
  webhookDeliveries,
  workspaceEntitlements,
} from "../../../drizzle/schema";
import { getDatabaseOrThrow } from "../../db";
import { addPlanInterval, formatAmountMinor } from "./catalog";
import { deterministicIdempotencyKey } from "./ids";
import { parseEurValueMinor, sumAmountsMinor } from "./amounts";
import { assertMollieId, type MolliePayment } from "./mollieClient";
import { createPaymentSnapshot } from "./paymentSnapshot";
import { metadataIntentId } from "./providerMetadata";

const GRACE_PERIOD_DAYS = 7;

type PaymentContext = {
  workspaceId: number;
  intent: typeof billingIntents.$inferSelect;
  customer: typeof billingCustomers.$inferSelect;
  subscription: typeof billingSubscriptions.$inferSelect | null;
};

export type PaymentProcessingResult =
  | { result: "processed" | "mismatch" | "duplicate"; workspaceId: number }
  | { result: "unknown" };

export async function applyMolliePaymentSnapshot(
  payment: MolliePayment,
  expectedWorkspaceId: number
): Promise<PaymentProcessingResult> {
  if (!Number.isSafeInteger(expectedWorkspaceId) || expectedWorkspaceId <= 0) {
    throw new Error("invalid billing payment workspace");
  }
  const database = await getDatabaseOrThrow();
  const observed = createPaymentSnapshot(payment);

  try {
    return await database.transaction(async tx => {
      const context = await resolvePaymentContext(
        tx,
        payment,
        expectedWorkspaceId
      );
      if (!context) {
        return { result: "unknown" as const };
      }

      await tx.insert(webhookDeliveries).values({
        workspaceId: context.workspaceId,
        mode: payment.mode,
        mollieResourceId: payment.id,
        snapshotHash: observed.snapshotHash,
        processingResult: "processing",
      });

      const occurredAt = resolvePaymentOccurredAt(payment);
      if (!occurredAt) {
        await enqueueOutbox(tx, {
          workspaceId: context.workspaceId,
          mode: context.intent.mode,
          eventType: "manual_review",
          deduplicationKey: `invalid_provider_timestamp:${payment.id}:${observed.snapshotHash}`,
          payload: {
            reason: "invalid_provider_timestamp",
            paymentId: payment.id,
          },
        });
        await finishDelivery(
          tx,
          context.workspaceId,
          payment.mode,
          payment.id,
          observed.snapshotHash,
          "invalid_provider_timestamp"
        );
        return {
          result: "mismatch" as const,
          workspaceId: context.workspaceId,
        };
      }

      const paidEffectAlreadyApplied = await upsertLedger(tx, {
        payment,
        workspaceId: context.workspaceId,
        snapshotHash: observed.snapshotHash,
        refunds: observed.refunds,
        chargebacks: observed.chargebacks,
        occurredAt,
      });

      const supersededReplacement = isSupersededPaymentMethodChangeIntent(
        context.intent
      );
      const plan = getIntentPlanSnapshot(context.intent);
      const mismatch =
        !plan ||
        payment.amount.currency !== context.intent.currency ||
        payment.amount.value !== context.intent.expectedAmount ||
        !hasMatchingMollieCustomerId(
          payment.customerId,
          context.customer.mollieCustomerId
        ) ||
        !metadataMatchesIntent(payment.metadata, context.intent.intentId) ||
        (Boolean(payment.subscriptionId) && !context.subscription);

      if (mismatch || !plan) {
        if (!payment.subscriptionId && !supersededReplacement) {
          await tx
            .update(billingIntents)
            .set({ status: "mismatch" })
            .where(
              and(
                eq(billingIntents.intentId, context.intent.intentId),
                eq(billingIntents.workspaceId, context.workspaceId),
                eq(billingIntents.mode, context.intent.mode)
              )
            );
        }
        if (!context.subscription) {
          await tx
            .insert(workspaceEntitlements)
            .values({
              workspaceId: context.workspaceId,
              mode: context.intent.mode,
              planCode: context.intent.planCode,
              status: "manual_review",
              quota: plan?.entitlements ?? {},
              validUntil: null,
              sourceSubscriptionId: null,
            })
            .onDuplicateKeyUpdate({
              set: { status: "manual_review" },
            });
        }
        await enqueueOutbox(tx, {
          workspaceId: context.workspaceId,
          mode: context.intent.mode,
          eventType: "manual_review",
          deduplicationKey: `payment_mismatch:${payment.id}:${observed.snapshotHash}`,
          payload: { reason: "payment_mismatch", paymentId: payment.id },
        });
        await finishDelivery(
          tx,
          context.workspaceId,
          payment.mode,
          payment.id,
          observed.snapshotHash,
          "mismatch"
        );
        return {
          result: "mismatch" as const,
          workspaceId: context.workspaceId,
        };
      }

      if (!payment.subscriptionId && !context.intent.molliePaymentId) {
        await tx
          .update(billingIntents)
          .set(
            supersededReplacement
              ? { molliePaymentId: payment.id }
              : { molliePaymentId: payment.id, status: "open" }
          )
          .where(
            and(
              eq(billingIntents.intentId, context.intent.intentId),
              eq(billingIntents.workspaceId, context.workspaceId),
              eq(billingIntents.mode, payment.mode)
            )
          );
      }

      const targetsReplacedSubscription = Boolean(
        (payment.subscriptionId &&
          context.subscription &&
          payment.subscriptionId !==
            context.subscription.mollieSubscriptionId) ||
        (!payment.subscriptionId &&
          paidEffectAlreadyApplied &&
          context.subscription &&
          context.subscription.sourceIntentId !== context.intent.intentId)
      );

      if (supersededReplacement) {
        if (payment.status === "paid") {
          await enqueueOutbox(tx, {
            workspaceId: context.workspaceId,
            mode: context.intent.mode,
            eventType: "manual_review",
            deduplicationKey: `late_paid_superseded_replacement:${payment.id}`,
            payload: {
              reason: "late_paid_superseded_replacement",
              paymentId: payment.id,
            },
          });
        }
        await finishDelivery(
          tx,
          context.workspaceId,
          payment.mode,
          payment.id,
          observed.snapshotHash,
          "superseded_replacement"
        );
        return {
          result: "processed" as const,
          workspaceId: context.workspaceId,
        };
      }

      if (targetsReplacedSubscription) {
        await enqueueOutbox(tx, {
          workspaceId: context.workspaceId,
          mode: context.intent.mode,
          eventType: "manual_review",
          deduplicationKey: `historical_payment_update:${payment.id}:${observed.snapshotHash}`,
          payload: {
            reason: "historical_payment_update",
            paymentId: payment.id,
          },
        });
        await finishDelivery(
          tx,
          context.workspaceId,
          payment.mode,
          payment.id,
          observed.snapshotHash,
          "historical_manual_review"
        );
        return {
          result: "processed" as const,
          workspaceId: context.workspaceId,
        };
      }

      const completedRefundTotal = sumAmountsMinor(
        observed.refunds
          .filter(refund => refund.status === "refunded")
          .map(refund => refund.amount)
      );
      const pendingRefundTotal = sumAmountsMinor(
        observed.refunds
          .filter(refund => isPendingRefundStatus(refund.status))
          .map(refund => refund.amount)
      );
      const grossMinor = plan.amountMinor;
      const hasChargeback = observed.chargebacks.some(
        chargeback => !chargeback.reversedAt
      );
      const hasLaterPaidPeriod =
        (hasChargeback || completedRefundTotal > 0 || pendingRefundTotal > 0) &&
        (await hasLaterPaidLedger(
          tx,
          context.workspaceId,
          context.intent.mode,
          payment.id,
          occurredAt
        ));

      if (hasChargeback) {
        if (!hasLaterPaidPeriod) {
          await applyAccessReview(tx, context, plan.entitlements, "blocked");
        }
        await enqueueOutbox(tx, {
          workspaceId: context.workspaceId,
          mode: context.intent.mode,
          eventType: "cancel_subscription",
          deduplicationKey: `chargeback_cancel:${payment.id}`,
          payload: cancellationTargetPayload(context, "chargeback"),
        });
        await enqueueOutbox(tx, {
          workspaceId: context.workspaceId,
          mode: context.intent.mode,
          eventType: "manual_review",
          deduplicationKey: `chargeback_review:${payment.id}:${observed.snapshotHash}`,
          payload: { reason: "chargeback", paymentId: payment.id },
        });
      } else if (completedRefundTotal >= grossMinor && grossMinor > 0) {
        if (!hasLaterPaidPeriod) {
          await applyAccessReview(tx, context, plan.entitlements, "inactive");
        }
        await enqueueOutbox(tx, {
          workspaceId: context.workspaceId,
          mode: context.intent.mode,
          eventType: "cancel_subscription",
          deduplicationKey: `full_refund_cancel:${payment.id}`,
          payload: cancellationTargetPayload(context, "full_refund"),
        });
        if (hasLaterPaidPeriod) {
          await enqueueOutbox(tx, {
            workspaceId: context.workspaceId,
            mode: context.intent.mode,
            eventType: "manual_review",
            deduplicationKey: `historical_full_refund:${payment.id}:${observed.snapshotHash}`,
            payload: {
              reason: "historical_full_refund",
              paymentId: payment.id,
            },
          });
        }
      } else if (completedRefundTotal > 0) {
        if (!hasLaterPaidPeriod) {
          await applyAccessReview(
            tx,
            context,
            plan.entitlements,
            "manual_review"
          );
        }
        await enqueueOutbox(tx, {
          workspaceId: context.workspaceId,
          mode: context.intent.mode,
          eventType: "manual_review",
          deduplicationKey: `partial_refund:${payment.id}:${observed.snapshotHash}`,
          payload: { reason: "partial_refund", paymentId: payment.id },
        });
      } else if (pendingRefundTotal > 0) {
        if (!hasLaterPaidPeriod) {
          await applyAccessReview(
            tx,
            context,
            plan.entitlements,
            "manual_review"
          );
        }
        await enqueueOutbox(tx, {
          workspaceId: context.workspaceId,
          mode: context.intent.mode,
          eventType: "manual_review",
          deduplicationKey: `pending_refund:${payment.id}:${observed.snapshotHash}`,
          payload: { reason: "pending_refund", paymentId: payment.id },
        });
      } else if (payment.status === "paid" && paidEffectAlreadyApplied) {
        await reviewPaidSnapshotWithoutReapplying(
          tx,
          context,
          plan,
          payment.id
        );
      } else {
        const paidEffectApplied = payment.subscriptionId
          ? await applyRecurringPaymentStatus(tx, context, plan, payment)
          : await applyFirstPaymentStatus(tx, context, plan, payment);
        if (paidEffectApplied) {
          await tx
            .update(paymentLedger)
            .set({ paidEffectApplied: 1 })
            .where(
              and(
                eq(paymentLedger.workspaceId, context.workspaceId),
                eq(paymentLedger.mode, payment.mode),
                eq(paymentLedger.molliePaymentId, payment.id)
              )
            );
        }
      }

      await finishDelivery(
        tx,
        context.workspaceId,
        payment.mode,
        payment.id,
        observed.snapshotHash,
        "processed"
      );
      return { result: "processed" as const, workspaceId: context.workspaceId };
    });
  } catch (error) {
    if (isDuplicateDeliverySnapshot(error)) {
      const context = await findPaymentContextOutsideTransaction(
        payment,
        expectedWorkspaceId
      );
      return context
        ? { result: "duplicate", workspaceId: context.workspaceId }
        : { result: "unknown" };
    }
    throw error;
  }
}

export function isSupersededPaymentMethodChangeIntent(
  intent: Pick<typeof billingIntents.$inferSelect, "kind" | "status">
): boolean {
  return (
    intent.kind === "payment_method_change" && intent.status === "canceled"
  );
}

export function resolveFirstPaymentPeriodStart(
  paidAt: Date,
  existingPaidThrough: Date | null | undefined
): Date {
  return existingPaidThrough && existingPaidThrough.getTime() > paidAt.getTime()
    ? existingPaidThrough
    : paidAt;
}

export function canTransitionToRecurringGrace(
  status: (typeof billingSubscriptions.$inferSelect)["status"],
  cancelAtPeriodEnd: number
): boolean {
  return (
    cancelAtPeriodEnd !== 1 && (status === "active" || status === "past_due")
  );
}

export function isPendingRefundStatus(status: string): boolean {
  return status === "queued" || status === "pending" || status === "processing";
}

export function hasMatchingMollieCustomerId(
  paymentCustomerId: string | null | undefined,
  storedCustomerId: string | null | undefined
): boolean {
  if (
    !storedCustomerId ||
    storedCustomerId.length <= "cst_".length ||
    paymentCustomerId !== storedCustomerId
  ) {
    return false;
  }
  try {
    assertMollieId(storedCustomerId, "cst_");
    return true;
  } catch {
    return false;
  }
}

export function resolvePaymentOccurredAt(
  payment: Pick<
    MolliePayment,
    "createdAt" | "paidAt" | "failedAt" | "canceledAt" | "expiredAt"
  >
): Date | null {
  const timestamps = [
    payment.createdAt,
    payment.paidAt,
    payment.failedAt,
    payment.canceledAt,
    payment.expiredAt,
  ].filter((value): value is string => value !== undefined);
  try {
    for (const timestamp of timestamps) parseProviderDate(timestamp);
    return parseProviderDate(
      payment.paidAt ??
        payment.failedAt ??
        payment.canceledAt ??
        payment.expiredAt ??
        payment.createdAt
    );
  } catch {
    return null;
  }
}

export function isDuplicateRecurringCycle(
  providerCreatedAt: Date,
  currentPeriodStart: Date | null | undefined
): boolean {
  return Boolean(
    currentPeriodStart &&
    providerCreatedAt.getTime() <= currentPeriodStart.getTime()
  );
}

async function resolvePaymentContext(
  tx: Parameters<
    Parameters<Awaited<ReturnType<typeof getDatabaseOrThrow>>["transaction"]>[0]
  >[0],
  payment: MolliePayment,
  expectedWorkspaceId: number
): Promise<PaymentContext | null> {
  const paymentIntentId = metadataIntentId(payment.metadata);
  if (!paymentIntentId) {
    return null;
  }
  const intents = await tx
    .select()
    .from(billingIntents)
    .where(
      and(
        eq(billingIntents.intentId, paymentIntentId),
        eq(billingIntents.workspaceId, expectedWorkspaceId),
        eq(billingIntents.mode, payment.mode)
      )
    )
    .limit(1)
    .for("update");
  const intent = intents[0];
  if (!intent) {
    return null;
  }
  const customers = await tx
    .select()
    .from(billingCustomers)
    .where(
      and(
        eq(billingCustomers.workspaceId, intent.workspaceId),
        eq(billingCustomers.mode, payment.mode)
      )
    )
    .limit(1);
  const customer = customers[0];
  if (!customer) {
    return null;
  }
  const subscriptions = await tx
    .select()
    .from(billingSubscriptions)
    .where(
      and(
        eq(billingSubscriptions.workspaceId, intent.workspaceId),
        eq(billingSubscriptions.mode, payment.mode)
      )
    )
    .limit(1)
    .for("update");
  const subscription = subscriptions[0] ?? null;

  if (!payment.subscriptionId) {
    if (intent.molliePaymentId && intent.molliePaymentId !== payment.id) {
      return null;
    }
  }
  return { workspaceId: intent.workspaceId, intent, customer, subscription };
}

async function findPaymentContextOutsideTransaction(
  payment: MolliePayment,
  expectedWorkspaceId: number
) {
  const database = await getDatabaseOrThrow();
  const intentId = metadataIntentId(payment.metadata);
  if (!intentId) return null;
  const intents = await database
    .select({ workspaceId: billingIntents.workspaceId })
    .from(billingIntents)
    .where(
      and(
        eq(billingIntents.intentId, intentId),
        eq(billingIntents.workspaceId, expectedWorkspaceId),
        eq(billingIntents.mode, payment.mode)
      )
    )
    .limit(1);
  return intents[0] ?? null;
}

async function applyFirstPaymentStatus(
  tx: Parameters<
    Parameters<Awaited<ReturnType<typeof getDatabaseOrThrow>>["transaction"]>[0]
  >[0],
  context: PaymentContext,
  plan: NonNullable<ReturnType<typeof getIntentPlanSnapshot>>,
  payment: MolliePayment
) {
  if (payment.status !== "paid") {
    if (["failed", "canceled", "expired"].includes(payment.status)) {
      await tx
        .update(billingIntents)
        .set({ status: payment.status as "failed" | "canceled" | "expired" })
        .where(
          and(
            eq(billingIntents.intentId, context.intent.intentId),
            eq(billingIntents.workspaceId, context.workspaceId),
            eq(billingIntents.mode, context.intent.mode)
          )
        );
    }
    return false;
  }

  const paidAt = parseProviderDate(payment.paidAt ?? payment.createdAt);
  const existingPaidThrough = context.subscription?.paidThrough;
  const periodStart = resolveFirstPaymentPeriodStart(
    paidAt,
    existingPaidThrough
  );
  const paidThrough = addPlanInterval(periodStart, plan.interval);
  const subscriptionIdempotencyKey = deterministicIdempotencyKey(
    "subscription",
    context.intent.intentId
  );

  await tx
    .update(billingIntents)
    .set({ status: "paid", paidAt })
    .where(
      and(
        eq(billingIntents.intentId, context.intent.intentId),
        eq(billingIntents.workspaceId, context.workspaceId),
        eq(billingIntents.mode, context.intent.mode)
      )
    );
  await tx
    .insert(billingSubscriptions)
    .values({
      workspaceId: context.workspaceId,
      mode: context.intent.mode,
      planCode: plan.code,
      mollieCustomerId: context.customer.mollieCustomerId ?? "",
      mollieSubscriptionId: null,
      mollieMandateId: payment.mandateId ?? null,
      sourceIntentId: context.intent.intentId,
      idempotencyKey: subscriptionIdempotencyKey,
      status: "provisioning",
      interval: plan.interval,
      recurringAmount: formatAmountMinor(plan.amountMinor),
      currency: plan.currency,
      entitlements: plan.entitlements,
      mollieDescription: plan.mollieDescription,
      currentPeriodStart: periodStart,
      paidThrough,
      nextPaymentDate: null,
      graceUntil: null,
      cancelAtPeriodEnd: 0,
      canceledAt: null,
    })
    .onDuplicateKeyUpdate({
      set: {
        planCode: plan.code,
        mollieCustomerId: context.customer.mollieCustomerId ?? "",
        mollieSubscriptionId: null,
        mollieMandateId: payment.mandateId ?? null,
        sourceIntentId: context.intent.intentId,
        idempotencyKey: subscriptionIdempotencyKey,
        status: "provisioning",
        interval: plan.interval,
        recurringAmount: formatAmountMinor(plan.amountMinor),
        currency: plan.currency,
        entitlements: plan.entitlements,
        mollieDescription: plan.mollieDescription,
        currentPeriodStart: periodStart,
        paidThrough,
        nextPaymentDate: null,
        graceUntil: null,
        cancelAtPeriodEnd: 0,
        canceledAt: null,
      },
    });

  let cancellationPrerequisite: string | null = null;
  if (
    context.intent.kind === "payment_method_change" &&
    context.subscription?.mollieSubscriptionId
  ) {
    cancellationPrerequisite = `payment_method_change_cancel:${context.intent.intentId}`;
    await enqueueOutbox(tx, {
      workspaceId: context.workspaceId,
      mode: context.intent.mode,
      eventType: "cancel_subscription",
      deduplicationKey: cancellationPrerequisite,
      payload: cancellationTargetPayload(
        context,
        "payment_method_change_replacement"
      ),
    });
  }

  if (!context.subscription) {
    await tx
      .insert(workspaceEntitlements)
      .values({
        workspaceId: context.workspaceId,
        mode: context.intent.mode,
        planCode: plan.code,
        status: "inactive",
        quota: plan.entitlements,
        validUntil: null,
        sourceSubscriptionId: null,
      })
      .onDuplicateKeyUpdate({
        set: { planCode: plan.code, quota: plan.entitlements },
      });
  }
  await enqueueOutbox(tx, {
    workspaceId: context.workspaceId,
    mode: context.intent.mode,
    eventType: "ensure_subscription",
    deduplicationKey: `ensure_subscription:${context.intent.intentId}`,
    payload: {
      intentId: context.intent.intentId,
      cancellationPrerequisite,
    },
  });
  return true;
}

async function applyRecurringPaymentStatus(
  tx: Parameters<
    Parameters<Awaited<ReturnType<typeof getDatabaseOrThrow>>["transaction"]>[0]
  >[0],
  context: PaymentContext,
  plan: NonNullable<ReturnType<typeof getIntentPlanSnapshot>>,
  payment: MolliePayment
) {
  const subscription = context.subscription;
  if (!subscription) return false;

  if (payment.status === "paid") {
    const paidAt = parseProviderDate(payment.paidAt ?? payment.createdAt);
    const providerCreatedAt = parseProviderDate(payment.createdAt);
    if (
      isDuplicateRecurringCycle(
        providerCreatedAt,
        subscription.currentPeriodStart
      )
    ) {
      await enqueueOutbox(tx, {
        workspaceId: context.workspaceId,
        mode: context.intent.mode,
        eventType: "manual_review",
        deduplicationKey: `duplicate_recurring_cycle:${payment.id}`,
        payload: { reason: "duplicate_recurring_cycle", paymentId: payment.id },
      });
      return false;
    }
    const currentPaidThrough = subscription.paidThrough;
    const periodStart =
      currentPaidThrough && currentPaidThrough.getTime() > paidAt.getTime()
        ? currentPaidThrough
        : paidAt;
    const paidThrough = addPlanInterval(periodStart, plan.interval);
    if (
      !canTransitionToRecurringGrace(
        subscription.status,
        subscription.cancelAtPeriodEnd
      )
    ) {
      await tx
        .update(billingSubscriptions)
        .set({
          currentPeriodStart: periodStart,
          paidThrough,
          graceUntil: null,
        })
        .where(
          and(
            eq(billingSubscriptions.workspaceId, context.workspaceId),
            eq(billingSubscriptions.mode, context.intent.mode)
          )
        );
      if (
        subscription.status === "canceled" ||
        subscription.status === "completed"
      ) {
        await tx
          .insert(workspaceEntitlements)
          .values({
            workspaceId: context.workspaceId,
            mode: context.intent.mode,
            planCode: plan.code,
            status: "active",
            quota: plan.entitlements,
            validUntil: paidThrough,
            sourceSubscriptionId: subscription.mollieSubscriptionId,
          })
          .onDuplicateKeyUpdate({
            set: {
              planCode: plan.code,
              status: "active",
              quota: plan.entitlements,
              validUntil: paidThrough,
              sourceSubscriptionId: subscription.mollieSubscriptionId,
            },
          });
      }
      await enqueueOutbox(tx, {
        workspaceId: context.workspaceId,
        mode: context.intent.mode,
        eventType: "manual_review",
        deduplicationKey: `paid_after_terminal_subscription:${payment.id}`,
        payload: {
          reason: "paid_after_terminal_subscription",
          paymentId: payment.id,
        },
      });
      if (subscription.mollieSubscriptionId) {
        await enqueueOutbox(tx, {
          workspaceId: context.workspaceId,
          mode: context.intent.mode,
          eventType: "cancel_subscription",
          deduplicationKey: `paid_after_terminal_cancel:${payment.id}`,
          payload: cancellationTargetPayload(
            context,
            "paid_after_terminal_subscription"
          ),
        });
      }
      return true;
    }
    await tx
      .update(billingSubscriptions)
      .set({
        status: "active",
        currentPeriodStart: periodStart,
        paidThrough,
        graceUntil: null,
      })
      .where(
        and(
          eq(billingSubscriptions.workspaceId, context.workspaceId),
          eq(billingSubscriptions.mode, context.intent.mode)
        )
      );
    await tx
      .insert(workspaceEntitlements)
      .values({
        workspaceId: context.workspaceId,
        mode: context.intent.mode,
        planCode: plan.code,
        status: "active",
        quota: plan.entitlements,
        validUntil: paidThrough,
        sourceSubscriptionId: subscription.mollieSubscriptionId,
      })
      .onDuplicateKeyUpdate({
        set: {
          planCode: plan.code,
          status: "active",
          quota: plan.entitlements,
          validUntil: paidThrough,
          sourceSubscriptionId: subscription.mollieSubscriptionId,
        },
      });
    return true;
  }

  if (["failed", "canceled", "expired"].includes(payment.status)) {
    if (
      !canTransitionToRecurringGrace(
        subscription.status,
        subscription.cancelAtPeriodEnd
      )
    ) {
      return false;
    }
    const paymentCreatedAt = parseProviderDate(payment.createdAt);
    const newerPaid = await tx
      .select({ id: paymentLedger.id })
      .from(paymentLedger)
      .where(
        and(
          eq(paymentLedger.workspaceId, context.workspaceId),
          eq(paymentLedger.mode, context.intent.mode),
          eq(paymentLedger.paidEffectApplied, 1),
          ne(paymentLedger.molliePaymentId, payment.id),
          gte(paymentLedger.occurredAt, paymentCreatedAt)
        )
      )
      .limit(1);
    if (newerPaid[0]) {
      return false;
    }
    const now = new Date();
    const graceUntil =
      subscription.status === "past_due" && subscription.graceUntil
        ? subscription.graceUntil
        : new Date(
            (subscription.paidThrough &&
            subscription.paidThrough.getTime() > now.getTime()
              ? subscription.paidThrough
              : now
            ).getTime() +
              GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1_000
          );
    await tx
      .update(billingSubscriptions)
      .set({ status: "past_due", graceUntil })
      .where(
        and(
          eq(billingSubscriptions.workspaceId, context.workspaceId),
          eq(billingSubscriptions.mode, context.intent.mode)
        )
      );
    await tx
      .insert(workspaceEntitlements)
      .values({
        workspaceId: context.workspaceId,
        mode: context.intent.mode,
        planCode: plan.code,
        status: "grace",
        quota: plan.entitlements,
        validUntil: graceUntil,
        sourceSubscriptionId: subscription.mollieSubscriptionId,
      })
      .onDuplicateKeyUpdate({
        set: { status: "grace", validUntil: graceUntil },
      });
    await enqueueOutbox(tx, {
      workspaceId: context.workspaceId,
      mode: context.intent.mode,
      eventType: "payment_warning",
      deduplicationKey: `payment_warning:${payment.id}`,
      payload: { reason: "recurring_payment_failed" },
    });
  }
  return false;
}

async function hasLaterPaidLedger(
  tx: Parameters<
    Parameters<Awaited<ReturnType<typeof getDatabaseOrThrow>>["transaction"]>[0]
  >[0],
  workspaceId: number,
  mode: MolliePayment["mode"],
  paymentId: string,
  occurredAt: Date
): Promise<boolean> {
  const rows = await tx
    .select({ id: paymentLedger.id })
    .from(paymentLedger)
    .where(
      and(
        eq(paymentLedger.workspaceId, workspaceId),
        eq(paymentLedger.mode, mode),
        eq(paymentLedger.paidEffectApplied, 1),
        ne(paymentLedger.molliePaymentId, paymentId),
        gte(paymentLedger.occurredAt, occurredAt)
      )
    )
    .limit(1);
  return Boolean(rows[0]);
}

async function reviewPaidSnapshotWithoutReapplying(
  tx: Parameters<
    Parameters<Awaited<ReturnType<typeof getDatabaseOrThrow>>["transaction"]>[0]
  >[0],
  context: PaymentContext,
  plan: NonNullable<ReturnType<typeof getIntentPlanSnapshot>>,
  paymentId: string
) {
  const entitlements = await tx
    .select({ status: workspaceEntitlements.status })
    .from(workspaceEntitlements)
    .where(
      and(
        eq(workspaceEntitlements.workspaceId, context.workspaceId),
        eq(workspaceEntitlements.mode, context.intent.mode)
      )
    )
    .limit(1)
    .for("update");
  if (entitlements[0]?.status === "active") {
    return;
  }

  if (!context.subscription?.paidThrough) {
    await enqueueOutbox(tx, {
      workspaceId: context.workspaceId,
      mode: context.intent.mode,
      eventType: "manual_review",
      deduplicationKey: `paid_period_missing:${paymentId}`,
      payload: { reason: "paid_period_missing", paymentId },
    });
    return;
  }
  await enqueueOutbox(tx, {
    workspaceId: context.workspaceId,
    mode: context.intent.mode,
    eventType: "manual_review",
    deduplicationKey: `paid_snapshot_state_review:${paymentId}`,
    payload: {
      reason: "paid_snapshot_state_review",
      paymentId,
      planCode: plan.code,
    },
  });
}

async function applyAccessReview(
  tx: Parameters<
    Parameters<Awaited<ReturnType<typeof getDatabaseOrThrow>>["transaction"]>[0]
  >[0],
  context: PaymentContext,
  quota: unknown,
  entitlementStatus: "inactive" | "blocked" | "manual_review"
) {
  if (context.subscription) {
    await tx
      .update(billingSubscriptions)
      .set({
        status:
          entitlementStatus === "manual_review" ? "manual_review" : "suspended",
      })
      .where(
        and(
          eq(billingSubscriptions.workspaceId, context.workspaceId),
          eq(billingSubscriptions.mode, context.intent.mode)
        )
      );
  }
  await tx
    .insert(workspaceEntitlements)
    .values({
      workspaceId: context.workspaceId,
      mode: context.intent.mode,
      planCode: context.intent.planCode,
      status: entitlementStatus,
      quota,
      validUntil: new Date(),
      sourceSubscriptionId: context.subscription?.mollieSubscriptionId ?? null,
    })
    .onDuplicateKeyUpdate({
      set: { status: entitlementStatus, validUntil: new Date() },
    });
}

async function upsertLedger(
  tx: Parameters<
    Parameters<Awaited<ReturnType<typeof getDatabaseOrThrow>>["transaction"]>[0]
  >[0],
  input: {
    payment: MolliePayment;
    workspaceId: number;
    snapshotHash: string;
    refunds: unknown;
    chargebacks: unknown;
    occurredAt: Date;
  }
) {
  const settlementAmount = input.payment.settlementAmount?.value ?? null;
  await tx
    .insert(paymentLedger)
    .values({
      molliePaymentId: input.payment.id,
      workspaceId: input.workspaceId,
      mode: input.payment.mode,
      grossAmount: input.payment.amount.value,
      currency: input.payment.amount.currency,
      status: input.payment.status,
      paymentMethod: input.payment.method ?? null,
      refunds: input.refunds,
      chargebacks: input.chargebacks,
      observedSnapshotHash: input.snapshotHash,
      settlementId: null,
      settlementAmount,
      mollieFees: null,
      invoiceNumber: null,
      occurredAt: input.occurredAt,
    })
    .onDuplicateKeyUpdate({
      set: {
        grossAmount: input.payment.amount.value,
        currency: input.payment.amount.currency,
        status: input.payment.status,
        paymentMethod: input.payment.method ?? null,
        refunds: input.refunds,
        chargebacks: input.chargebacks,
        observedSnapshotHash: input.snapshotHash,
        settlementAmount,
        occurredAt: input.occurredAt,
      },
    });
  const ledgerRows = await tx
    .select({
      id: paymentLedger.id,
      invoiceNumber: paymentLedger.invoiceNumber,
      occurredAt: paymentLedger.occurredAt,
      paidEffectApplied: paymentLedger.paidEffectApplied,
    })
    .from(paymentLedger)
    .where(
      and(
        eq(paymentLedger.workspaceId, input.workspaceId),
        eq(paymentLedger.mode, input.payment.mode),
        eq(paymentLedger.molliePaymentId, input.payment.id)
      )
    )
    .limit(1);
  const ledger = ledgerRows[0];
  if (ledger && input.payment.status === "paid" && !ledger.invoiceNumber) {
    await allocateInvoiceNumber(
      tx,
      ledger.id,
      input.workspaceId,
      input.payment.mode,
      ledger.occurredAt
    );
  }
  return ledger?.paidEffectApplied === 1;
}

async function allocateInvoiceNumber(
  tx: Parameters<
    Parameters<Awaited<ReturnType<typeof getDatabaseOrThrow>>["transaction"]>[0]
  >[0],
  ledgerId: number,
  workspaceId: number,
  mode: MolliePayment["mode"],
  occurredAt: Date
) {
  const invoiceYear = occurredAt.getUTCFullYear();
  await tx
    .insert(billingInvoiceSequences)
    .values({ mode, invoiceYear, nextNumber: 1 })
    .onDuplicateKeyUpdate({
      set: { invoiceYear: sql`invoice_year` },
    });
  const sequences = await tx
    .select()
    .from(billingInvoiceSequences)
    .where(
      and(
        eq(billingInvoiceSequences.mode, mode),
        eq(billingInvoiceSequences.invoiceYear, invoiceYear)
      )
    )
    .limit(1)
    .for("update");
  const sequence = sequences[0];
  if (
    !sequence ||
    !Number.isSafeInteger(sequence.nextNumber) ||
    sequence.nextNumber <= 0
  ) {
    throw new Error("billing invoice sequence is invalid");
  }
  const prefix = mode === "test" ? "LB-TEST" : "LB";
  const invoiceNumber = `${prefix}-${invoiceYear}-${String(sequence.nextNumber).padStart(8, "0")}`;
  await tx
    .update(billingInvoiceSequences)
    .set({ nextNumber: sequence.nextNumber + 1 })
    .where(
      and(
        eq(billingInvoiceSequences.mode, mode),
        eq(billingInvoiceSequences.invoiceYear, invoiceYear)
      )
    );
  await tx
    .update(paymentLedger)
    .set({ invoiceNumber })
    .where(
      and(
        eq(paymentLedger.id, ledgerId),
        eq(paymentLedger.workspaceId, workspaceId),
        eq(paymentLedger.mode, mode)
      )
    );
}

async function enqueueOutbox(
  tx: Parameters<
    Parameters<Awaited<ReturnType<typeof getDatabaseOrThrow>>["transaction"]>[0]
  >[0],
  input: {
    workspaceId: number;
    mode: MolliePayment["mode"];
    eventType:
      | "ensure_subscription"
      | "cancel_subscription"
      | "payment_warning"
      | "manual_review";
    deduplicationKey: string;
    payload: Record<string, unknown>;
  }
) {
  await tx
    .insert(billingOutbox)
    .values({
      workspaceId: input.workspaceId,
      mode: input.mode,
      eventType: input.eventType,
      deduplicationKey: input.deduplicationKey,
      payload: input.payload,
      status: "pending",
    })
    .onDuplicateKeyUpdate({
      set: { deduplicationKey: sql`deduplication_key` },
    });
}

async function finishDelivery(
  tx: Parameters<
    Parameters<Awaited<ReturnType<typeof getDatabaseOrThrow>>["transaction"]>[0]
  >[0],
  workspaceId: number,
  mode: MolliePayment["mode"],
  paymentId: string,
  snapshotHash: string,
  result: string
) {
  await tx
    .update(webhookDeliveries)
    .set({ processingResult: result, processedAt: new Date() })
    .where(
      and(
        eq(webhookDeliveries.workspaceId, workspaceId),
        eq(webhookDeliveries.mode, mode),
        eq(webhookDeliveries.mollieResourceId, paymentId),
        eq(webhookDeliveries.snapshotHash, snapshotHash)
      )
    );
}

function getIntentPlanSnapshot(intent: typeof billingIntents.$inferSelect) {
  if (
    intent.currency !== "EUR" ||
    intent.interval !== "1 month" ||
    !intent.entitlements ||
    typeof intent.entitlements !== "object"
  ) {
    return null;
  }
  const entitlements = intent.entitlements as Record<string, unknown>;
  if (
    !Number.isSafeInteger(entitlements.imagesPerDay) ||
    Number(entitlements.imagesPerDay) <= 0 ||
    !Number.isSafeInteger(entitlements.messagesPerMinute) ||
    Number(entitlements.messagesPerMinute) <= 0
  ) {
    return null;
  }
  try {
    return {
      code: intent.planCode,
      amountMinor: parseEurValueMinor(intent.expectedAmount),
      currency: "EUR" as const,
      interval: "1 month" as const,
      entitlements: {
        imagesPerDay: Number(entitlements.imagesPerDay),
        messagesPerMinute: Number(entitlements.messagesPerMinute),
      },
      mollieDescription: intent.mollieDescription,
    };
  } catch {
    return null;
  }
}

function metadataMatchesIntent(metadata: unknown, intentId: string): boolean {
  return metadataIntentId(metadata) === intentId;
}

function cancellationTargetPayload(context: PaymentContext, reason: string) {
  return {
    reason,
    sourceIntentId: context.intent.intentId,
    targetCustomerId: context.customer.mollieCustomerId,
    targetSubscriptionId: context.subscription?.mollieSubscriptionId ?? null,
  };
}

function parseProviderDate(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("invalid Mollie timestamp");
  }
  return parsed;
}

export function isDuplicateDeliverySnapshot(
  error: unknown,
  depth = 0
): boolean {
  if (depth > 8) return false;
  if (!error || typeof error !== "object") return false;
  const record = error as {
    code?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  if (
    record.code === "ER_DUP_ENTRY" &&
    typeof record.message === "string" &&
    record.message.includes("webhook_deliveries_resource_snapshot_mode_unique")
  ) {
    return true;
  }
  return isDuplicateDeliverySnapshot(record.cause, depth + 1);
}
