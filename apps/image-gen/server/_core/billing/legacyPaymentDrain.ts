import { and, asc, eq, isNull, lte, ne, or, sql } from "drizzle-orm";

import {
  billingCustomers,
  billingIntents,
  billingInvoiceSequences,
  billingOutbox,
  billingWebhookRoutes,
  paymentLedger,
  webhookDeliveries,
} from "../../../drizzle/schema";
import { getDatabaseOrThrow, type ImageGenTransaction } from "../../db";
import { safeLog } from "../logger";
import {
  assertBillingTenantLeaseOwned,
  assertBillingTenantLeaseOwnedInTransaction,
  type BillingTenantLease,
} from "./billingSchedulerStore";
import { getMollieConfig, type MollieMode } from "./config";
import { MollieClient, type MolliePayment } from "./mollieClient";
import {
  createPaymentSnapshot,
  mergePaymentFinancialSnapshot,
} from "./paymentSnapshot";
import { metadataIntentId } from "./providerMetadata";

const RECHECK_MS = 60 * 60_000;
const BATCH_LIMIT = 25;
const TERMINAL = new Set(["paid", "failed", "canceled", "expired"]);

type Input = Readonly<{
  webhookPaymentId: string;
  expectedMode: MollieMode;
  payment: MolliePayment;
}>;
type Result = "unknown" | "duplicate" | "mismatch" | "processed";

/**
 * Financial drain only: a trusted route or an existing ledger entry may still
 * receive late refunds/chargebacks after its product has been retired.
 * This code never grants access, reopens an intent, or creates provider work.
 */
export async function applyLegacyPaymentDrainSnapshot(
  input: Input,
  schedulerLease?: BillingTenantLease
): Promise<Result> {
  const { payment, expectedMode, webhookPaymentId } = input;
  if (payment.id !== webhookPaymentId || payment.mode !== expectedMode)
    return "unknown";
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const [recordedRoute] = await tx
      .select()
      .from(billingWebhookRoutes)
      .where(
        and(
          eq(billingWebhookRoutes.mode, expectedMode),
          eq(billingWebhookRoutes.molliePaymentId, webhookPaymentId)
        )
      )
      .limit(1);
    const route = recordedRoute ?? (await recoverLegacyLedgerScope(tx, input));
    if (!route) return "unknown";
    const [intent] = await tx
      .select({
        intentId: billingIntents.intentId,
        workspaceId: billingIntents.workspaceId,
        mode: billingIntents.mode,
        kind: billingIntents.kind,
        expectedAmount: billingIntents.expectedAmount,
        currency: billingIntents.currency,
        molliePaymentId: billingIntents.molliePaymentId,
      })
      .from(billingIntents)
      .where(
        and(
          eq(billingIntents.intentId, route.intentId),
          eq(billingIntents.workspaceId, route.workspaceId),
          eq(billingIntents.mode, route.mode)
        )
      )
      .limit(1)
      .for("update");
    if (!intent || intent.kind === "credit_purchase") return "unknown";
    if (schedulerLease) {
      if (
        schedulerLease.workspaceId !== route.workspaceId ||
        schedulerLease.mode !== route.mode ||
        schedulerLease.kind !== "reconciliation"
      ) {
        throw new Error("legacy payment drain lease scope mismatch");
      }
      await assertBillingTenantLeaseOwnedInTransaction(tx, schedulerLease);
    }
    const [customer] = await tx
      .select({ id: billingCustomers.mollieCustomerId })
      .from(billingCustomers)
      .where(
        and(
          eq(billingCustomers.workspaceId, route.workspaceId),
          eq(billingCustomers.mode, route.mode)
        )
      )
      .limit(1);
    const [existing] = await tx
      .select({
        id: paymentLedger.id,
        workspaceId: paymentLedger.workspaceId,
        grossAmount: paymentLedger.grossAmount,
        currency: paymentLedger.currency,
        status: paymentLedger.status,
        refunds: paymentLedger.refunds,
        chargebacks: paymentLedger.chargebacks,
        occurredAt: paymentLedger.occurredAt,
        invoiceNumber: paymentLedger.invoiceNumber,
        settlementAmount: paymentLedger.settlementAmount,
      })
      .from(paymentLedger)
      .where(
        and(
          eq(paymentLedger.mode, route.mode),
          eq(paymentLedger.molliePaymentId, webhookPaymentId)
        )
      )
      .limit(1)
      .for("update");
    if (existing && existing.workspaceId !== route.workspaceId) {
      throw new Error("legacy payment drain ledger scope mismatch");
    }
    // The missing-route bridge can update retained evidence only, never create
    // a ledger from provider metadata. Recheck after taking the intent lock.
    if (!recordedRoute && !existing) return "unknown";
    const observed = createPaymentSnapshot(payment);
    const deliveryWhere = and(
      eq(webhookDeliveries.workspaceId, route.workspaceId),
      eq(webhookDeliveries.mode, route.mode),
      eq(webhookDeliveries.mollieResourceId, payment.id),
      eq(webhookDeliveries.snapshotHash, observed.snapshotHash)
    );
    const [delivery] = await tx
      .select({ processedAt: webhookDeliveries.processedAt })
      .from(webhookDeliveries)
      .where(deliveryWhere)
      .limit(1);
    if (delivery?.processedAt) return "duplicate";
    if (!delivery)
      await tx.insert(webhookDeliveries).values({
        workspaceId: route.workspaceId,
        mode: route.mode,
        mollieResourceId: payment.id,
        snapshotHash: observed.snapshotHash,
        processingResult: "legacy_financial_processing",
      });

    const occurredAt = paymentOccurredAt(payment);
    const mismatch =
      !occurredAt ||
      metadataIntentId(payment.metadata) !== route.intentId ||
      !customer?.id ||
      payment.customerId !== customer.id ||
      (!payment.subscriptionId && intent.molliePaymentId !== payment.id) ||
      payment.amount.currency !== (existing?.currency ?? intent.currency) ||
      payment.amount.value !==
        (existing?.grossAmount ?? intent.expectedAmount) ||
      !hasValidSettlementAmount(payment);
    if (mismatch || !occurredAt) {
      await enqueueReview(
        tx,
        route,
        payment.id,
        observed.snapshotHash,
        "legacy_payment_snapshot_mismatch"
      );
      await tx
        .update(webhookDeliveries)
        .set({
          processingResult: "legacy_financial_mismatch",
          processedAt: new Date(),
        })
        .where(deliveryWhere);
      return "mismatch";
    }
    const financial = mergePaymentFinancialSnapshot({
      existingRefunds: existing?.refunds ?? [],
      existingChargebacks: existing?.chargebacks ?? [],
      observedRefunds: observed.refunds,
      observedChargebacks: observed.chargebacks,
    });
    const stale =
      existing &&
      (occurredAt < existing.occurredAt ||
        (TERMINAL.has(existing.status) && payment.status !== existing.status));
    if (stale && financial.changedFromExisting)
      throw new Error("legacy payment financial snapshot conflict");
    if (!stale) {
      const fields = {
        grossAmount: payment.amount.value,
        currency: payment.amount.currency,
        status: payment.status,
        paymentMethod: payment.method ?? null,
        refunds: financial.refunds,
        chargebacks: financial.chargebacks,
        observedSnapshotHash: observed.snapshotHash,
        occurredAt,
        // A later paid snapshot may supply settlement evidence for the first
        // time. Never erase or replace a value already reconciled by finance.
        ...(existing?.settlementAmount == null && payment.settlementAmount
          ? { settlementAmount: payment.settlementAmount.value }
          : {}),
      };
      if (existing) {
        await tx
          .update(paymentLedger)
          .set(fields)
          .where(
            and(
              eq(paymentLedger.id, existing.id),
              eq(paymentLedger.workspaceId, route.workspaceId),
              eq(paymentLedger.mode, route.mode)
            )
          );
      } else {
        await tx.insert(paymentLedger).values({
          ...fields,
          workspaceId: route.workspaceId,
          mode: route.mode,
          molliePaymentId: payment.id,
          settlementAmount: payment.settlementAmount?.value ?? null,
        });
      }
      if (payment.status === "paid" && !existing?.invoiceNumber) {
        await allocateInvoice(
          tx,
          route.workspaceId,
          route.mode,
          payment.id,
          occurredAt
        );
      }
      // Retired products can only produce operator review, never new access or
      // recurring work. The existing invoice/fees/settlement and paid-effect
      // ownership are preserved by the narrow update above.
      await enqueueReview(
        tx,
        route,
        payment.id,
        observed.snapshotHash,
        "retained_legacy_payment_financial_update"
      );
    }
    await tx
      .update(webhookDeliveries)
      .set({
        processingResult: stale
          ? "legacy_stale_snapshot_ignored"
          : "legacy_financial_recorded",
        processedAt: new Date(),
      })
      .where(deliveryWhere);
    return "processed";
  });
}

async function recoverLegacyLedgerScope(
  tx: ImageGenTransaction,
  { payment, expectedMode, webhookPaymentId }: Input
) {
  const intentId = metadataIntentId(payment.metadata);
  if (!intentId) return null;
  // Older reconciliation stored recurring Payments without creating a webhook
  // route. The immutable payment/mode ledger identity supplies ownership, not
  // the provider metadata. Intent and customer are verified in that scope.
  const [ledger] = await tx
    .select({ workspaceId: paymentLedger.workspaceId })
    .from(paymentLedger)
    .where(
      and(
        eq(paymentLedger.mode, expectedMode),
        eq(paymentLedger.molliePaymentId, webhookPaymentId)
      )
    )
    .limit(1);
  return ledger
    ? { workspaceId: ledger.workspaceId, mode: expectedMode, intentId }
    : null;
}

function hasValidSettlementAmount(payment: MolliePayment): boolean {
  const amount = payment.settlementAmount;
  return (
    amount == null ||
    (amount.currency === payment.amount.currency &&
      typeof amount.value === "string" &&
      /^(?:0|[1-9]\d{0,7})\.\d{2}$/.test(amount.value))
  );
}

function paymentOccurredAt(payment: MolliePayment): Date | null {
  const timestamps = [
    payment.createdAt,
    payment.paidAt,
    payment.failedAt,
    payment.canceledAt,
    payment.expiredAt,
  ].filter((value): value is string => value !== undefined);
  if (timestamps.some(value => !Number.isFinite(Date.parse(value))))
    return null;
  const result = new Date(
    payment.paidAt ??
      payment.failedAt ??
      payment.canceledAt ??
      payment.expiredAt ??
      payment.createdAt
  );
  return Number.isFinite(result.getTime()) ? result : null;
}

async function enqueueReview(
  tx: ImageGenTransaction,
  scope: { workspaceId: number; mode: MollieMode },
  paymentId: string,
  hash: string,
  reason: string
) {
  const deduplicationKey = `legacy_financial:${paymentId}:${hash}`;
  await tx
    .insert(billingOutbox)
    .values({
      workspaceId: scope.workspaceId,
      mode: scope.mode,
      eventType: "manual_review",
      deduplicationKey,
      payload: { reason, paymentId },
      status: "pending",
    })
    .onDuplicateKeyUpdate({
      set: { deduplicationKey: sql`deduplication_key` },
    });
}

async function allocateInvoice(
  tx: ImageGenTransaction,
  workspaceId: number,
  mode: MollieMode,
  paymentId: string,
  occurredAt: Date
) {
  const invoiceYear = occurredAt.getUTCFullYear();
  await tx
    .insert(billingInvoiceSequences)
    .values({ mode, invoiceYear, nextNumber: 1 })
    .onDuplicateKeyUpdate({ set: { invoiceYear: sql`invoice_year` } });
  const [sequence] = await tx
    .select({ nextNumber: billingInvoiceSequences.nextNumber })
    .from(billingInvoiceSequences)
    .where(
      and(
        eq(billingInvoiceSequences.mode, mode),
        eq(billingInvoiceSequences.invoiceYear, invoiceYear)
      )
    )
    .limit(1)
    .for("update");
  if (
    !sequence ||
    !Number.isSafeInteger(sequence.nextNumber) ||
    sequence.nextNumber < 1
  )
    throw new Error("legacy invoice sequence invalid");
  const invoiceNumber = `${mode === "test" ? "LB-TEST" : "LB"}-${invoiceYear}-${String(sequence.nextNumber).padStart(8, "0")}`;
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
        eq(paymentLedger.workspaceId, workspaceId),
        eq(paymentLedger.mode, mode),
        eq(paymentLedger.molliePaymentId, paymentId)
      )
    );
}

/** Bounded, read-only provider recovery for already-known retained Payments. */
export async function reconcileRetainedLegacyPayments(
  lease: BillingTenantLease,
  now = new Date(),
  clientOverride?: Pick<MollieClient, "getPayment">
): Promise<number> {
  if (lease.kind !== "reconciliation")
    throw new Error("legacy payment drain lease kind mismatch");
  const database = await getDatabaseOrThrow();
  const cutoff = new Date(now.getTime() - RECHECK_MS);
  const routedRows = await database
    .select({
      paymentId: billingWebhookRoutes.molliePaymentId,
      intentId: billingWebhookRoutes.intentId,
      ledgerId: paymentLedger.id,
    })
    .from(billingWebhookRoutes)
    .innerJoin(
      billingIntents,
      and(
        eq(billingIntents.intentId, billingWebhookRoutes.intentId),
        eq(billingIntents.workspaceId, billingWebhookRoutes.workspaceId),
        eq(billingIntents.mode, billingWebhookRoutes.mode)
      )
    )
    .leftJoin(
      paymentLedger,
      and(
        eq(paymentLedger.workspaceId, billingWebhookRoutes.workspaceId),
        eq(paymentLedger.mode, billingWebhookRoutes.mode),
        eq(paymentLedger.molliePaymentId, billingWebhookRoutes.molliePaymentId)
      )
    )
    .where(
      and(
        eq(billingWebhookRoutes.workspaceId, lease.workspaceId),
        eq(billingWebhookRoutes.mode, lease.mode),
        ne(billingIntents.kind, "credit_purchase"),
        or(
          lte(paymentLedger.updatedAt, cutoff),
          and(isNull(paymentLedger.id), lte(billingIntents.updatedAt, cutoff))
        )
      )
    )
    .orderBy(
      asc(
        sql`COALESCE(${paymentLedger.updatedAt}, ${billingIntents.updatedAt})`
      ),
      asc(billingWebhookRoutes.molliePaymentId)
    )
    .limit(BATCH_LIMIT);
  // The old customer-payment reconciliation wrote ledger rows directly. The
  // 0015 route backfill covered only intent.molliePaymentId, not those renewals.
  // Scan a separate bounded batch so they cannot starve behind routed Payments.
  // Exclude credit intents using only columns available in the 0016 schema.
  const unroutedRows = await database
    .select({
      paymentId: paymentLedger.molliePaymentId,
      ledgerId: paymentLedger.id,
    })
    .from(paymentLedger)
    .leftJoin(
      billingWebhookRoutes,
      and(
        eq(billingWebhookRoutes.mode, paymentLedger.mode),
        eq(billingWebhookRoutes.molliePaymentId, paymentLedger.molliePaymentId)
      )
    )
    .leftJoin(billingIntents, matchingCreditIntent())
    .where(
      and(
        eq(paymentLedger.workspaceId, lease.workspaceId),
        eq(paymentLedger.mode, lease.mode),
        lte(paymentLedger.updatedAt, cutoff),
        isNull(billingWebhookRoutes.molliePaymentId),
        isNull(billingIntents.intentId)
      )
    )
    .orderBy(asc(paymentLedger.updatedAt), asc(paymentLedger.id))
    .limit(BATCH_LIMIT);
  const rows = [
    ...routedRows,
    ...unroutedRows.map(row => ({ ...row, intentId: null })),
  ];
  if (rows.length === 0) return 0;
  const config = getMollieConfig();
  if (config.mode !== lease.mode)
    throw new Error("legacy payment drain mode mismatch");
  const client = clientOverride ?? new MollieClient(config);
  let processed = 0;
  for (const row of rows) {
    await assertBillingTenantLeaseOwned(lease);
    // Timestamp only, before transport: failed provider reads remain due next
    // hour without permanently starving later retained Payments in the batch.
    const prepared = await database.transaction(async tx => {
      if (row.intentId) {
        const [intent] = await tx
          .select({ id: billingIntents.intentId })
          .from(billingIntents)
          .where(
            and(
              eq(billingIntents.intentId, row.intentId),
              eq(billingIntents.workspaceId, lease.workspaceId),
              eq(billingIntents.mode, lease.mode),
              ne(billingIntents.kind, "credit_purchase")
            )
          )
          .limit(1)
          .for("update");
        if (!intent)
          throw new Error("legacy payment drain intent scope changed");
      } else {
        const [ledger] = await tx
          .select({ id: paymentLedger.id })
          .from(paymentLedger)
          .leftJoin(billingIntents, matchingCreditIntent())
          .where(
            and(
              eq(paymentLedger.id, row.ledgerId!),
              eq(paymentLedger.workspaceId, lease.workspaceId),
              eq(paymentLedger.mode, lease.mode),
              eq(paymentLedger.molliePaymentId, row.paymentId),
              isNull(billingIntents.intentId)
            )
          )
          .limit(1)
          .for("update");
        if (!ledger) return false;
      }
      await assertBillingTenantLeaseOwnedInTransaction(tx, lease);
      if (row.ledgerId)
        await tx
          .update(paymentLedger)
          .set({ updatedAt: now })
          .where(
            and(
              eq(paymentLedger.id, row.ledgerId),
              eq(paymentLedger.workspaceId, lease.workspaceId),
              eq(paymentLedger.mode, lease.mode),
              eq(paymentLedger.molliePaymentId, row.paymentId)
            )
          );
      else if (row.intentId)
        await tx
          .update(billingIntents)
          .set({ updatedAt: now })
          .where(
            and(
              eq(billingIntents.intentId, row.intentId),
              eq(billingIntents.workspaceId, lease.workspaceId),
              eq(billingIntents.mode, lease.mode),
              ne(billingIntents.kind, "credit_purchase")
            )
          );
      return true;
    });
    if (!prepared) continue;
    try {
      const payment = await client.getPayment(row.paymentId);
      await applyLegacyPaymentDrainSnapshot(
        { webhookPaymentId: row.paymentId, expectedMode: lease.mode, payment },
        lease
      );
      processed += 1;
    } catch (error) {
      safeLog("legacy_payment_financial_drain_retryable", {
        level: "warn",
        errorCode: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
  return processed;
}

function matchingCreditIntent() {
  return and(
    eq(billingIntents.workspaceId, paymentLedger.workspaceId),
    eq(billingIntents.mode, paymentLedger.mode),
    eq(billingIntents.molliePaymentId, paymentLedger.molliePaymentId),
    eq(billingIntents.kind, "credit_purchase")
  );
}
