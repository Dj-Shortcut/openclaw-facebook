import { hashCanonicalSnapshot } from "./ids";
import type {
  MollieAmount,
  MollieChargeback,
  MolliePayment,
  MollieRefund,
} from "./mollieClient";

export type PaymentRefundSnapshot = Readonly<{
  id: string;
  status:
    "queued" | "pending" | "processing" | "refunded" | "failed" | "canceled";
  amount: MollieAmount;
  createdAt: string | null;
}>;

export type PaymentChargebackSnapshot = Readonly<{
  id: string;
  amount: MollieAmount;
  createdAt: string | null;
  reversedAt: string | null;
}>;

const REFUND_STATUS_RANK: Readonly<
  Record<PaymentRefundSnapshot["status"], number>
> = Object.freeze({
  queued: 0,
  pending: 1,
  processing: 2,
  refunded: 3,
  failed: 3,
  canceled: 3,
});
const TERMINAL_REFUND_STATUSES = new Set<PaymentRefundSnapshot["status"]>([
  "refunded",
  "failed",
  "canceled",
]);

function normalizeRefund(refund: MollieRefund): PaymentRefundSnapshot {
  return {
    id: refund.id,
    status: parseRefundStatus(refund.status),
    amount: refund.amount,
    createdAt: refund.createdAt ?? null,
  };
}

function normalizeChargeback(
  chargeback: MollieChargeback
): PaymentChargebackSnapshot {
  return {
    id: chargeback.id,
    amount: chargeback.amount,
    createdAt: chargeback.createdAt ?? null,
    reversedAt: chargeback.reversedAt ?? null,
  };
}

function compareIds(left: { id: string }, right: { id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function mergePaymentFinancialSnapshot(input: {
  existingRefunds: unknown;
  existingChargebacks: unknown;
  observedRefunds: unknown;
  observedChargebacks: unknown;
}): Readonly<{
  refunds: PaymentRefundSnapshot[];
  chargebacks: PaymentChargebackSnapshot[];
  changedFromExisting: boolean;
}> {
  const existingRefunds = parseRefunds(input.existingRefunds).sort(compareIds);
  const observedRefunds = parseRefunds(input.observedRefunds);
  const existingChargebacks = parseChargebacks(input.existingChargebacks).sort(
    compareIds
  );
  const observedChargebacks = parseChargebacks(input.observedChargebacks);

  const refunds = new Map(existingRefunds.map(refund => [refund.id, refund]));
  for (const observed of observedRefunds) {
    const existing = refunds.get(observed.id);
    refunds.set(
      observed.id,
      existing ? mergeRefund(existing, observed) : observed
    );
  }

  const chargebacks = new Map(
    existingChargebacks.map(chargeback => [chargeback.id, chargeback])
  );
  for (const observed of observedChargebacks) {
    const existing = chargebacks.get(observed.id);
    chargebacks.set(
      observed.id,
      existing ? mergeChargeback(existing, observed) : observed
    );
  }

  const mergedRefunds = [...refunds.values()].sort(compareIds);
  const mergedChargebacks = [...chargebacks.values()].sort(compareIds);
  return Object.freeze({
    refunds: mergedRefunds,
    chargebacks: mergedChargebacks,
    changedFromExisting:
      !financialArraysEqual(existingRefunds, mergedRefunds) ||
      !financialArraysEqual(existingChargebacks, mergedChargebacks),
  });
}

export function createPaymentSnapshot(payment: MolliePayment) {
  const financial = mergePaymentFinancialSnapshot({
    existingRefunds: [],
    existingChargebacks: [],
    observedRefunds: [...(payment._embedded?.refunds ?? [])].map(
      normalizeRefund
    ),
    observedChargebacks: [...(payment._embedded?.chargebacks ?? [])].map(
      normalizeChargeback
    ),
  });
  const { refunds, chargebacks } = financial;
  const snapshot = {
    paymentId: payment.id,
    mode: payment.mode,
    status: payment.status,
    amount: payment.amount,
    amountRefunded: payment.amountRefunded ?? null,
    settlementAmount: payment.settlementAmount ?? null,
    customerId: payment.customerId ?? null,
    mandateId: payment.mandateId ?? null,
    subscriptionId: payment.subscriptionId ?? null,
    metadata: payment.metadata ?? null,
    method: payment.method ?? null,
    createdAt: payment.createdAt,
    paidAt: payment.paidAt ?? null,
    canceledAt: payment.canceledAt ?? null,
    expiredAt: payment.expiredAt ?? null,
    failedAt: payment.failedAt ?? null,
    refunds,
    chargebacks,
  };

  return {
    snapshot,
    snapshotHash: hashCanonicalSnapshot(snapshot),
    refunds,
    chargebacks,
  };
}

function mergeRefund(
  existing: PaymentRefundSnapshot,
  observed: PaymentRefundSnapshot
): PaymentRefundSnapshot {
  assertSameAmount(existing.amount, observed.amount);
  const createdAt = mergeTimestamp(existing.createdAt, observed.createdAt);
  const existingTerminal = TERMINAL_REFUND_STATUSES.has(existing.status);
  const observedTerminal = TERMINAL_REFUND_STATUSES.has(observed.status);
  if (
    existingTerminal &&
    observedTerminal &&
    existing.status !== observed.status
  ) {
    throw new Error("billing_payment_financial_snapshot_conflict");
  }
  let status = existing.status;
  if (
    !existingTerminal &&
    (observedTerminal ||
      REFUND_STATUS_RANK[observed.status] >=
        REFUND_STATUS_RANK[existing.status])
  ) {
    status = observed.status;
  }
  return { ...existing, status, createdAt };
}

function mergeChargeback(
  existing: PaymentChargebackSnapshot,
  observed: PaymentChargebackSnapshot
): PaymentChargebackSnapshot {
  assertSameAmount(existing.amount, observed.amount);
  return {
    ...existing,
    createdAt: mergeTimestamp(existing.createdAt, observed.createdAt),
    reversedAt: mergeTimestamp(existing.reversedAt, observed.reversedAt),
  };
}

function parseRefunds(value: unknown): PaymentRefundSnapshot[] {
  if (!Array.isArray(value)) {
    throw new Error("billing_payment_financial_snapshot_invalid");
  }
  const parsed = value.map(parseRefund);
  assertUniqueIds(parsed);
  return parsed;
}

function parseChargebacks(value: unknown): PaymentChargebackSnapshot[] {
  if (!Array.isArray(value)) {
    throw new Error("billing_payment_financial_snapshot_invalid");
  }
  const parsed = value.map(parseChargeback);
  assertUniqueIds(parsed);
  return parsed;
}

function parseRefund(value: unknown): PaymentRefundSnapshot {
  const record = parseRecord(value);
  return {
    id: parseResourceId(record.id),
    status: parseRefundStatus(record.status),
    amount: parseAmount(record.amount),
    createdAt: parseTimestamp(record.createdAt),
  };
}

function parseChargeback(value: unknown): PaymentChargebackSnapshot {
  const record = parseRecord(value);
  return {
    id: parseResourceId(record.id),
    amount: parseAmount(record.amount),
    createdAt: parseTimestamp(record.createdAt),
    reversedAt: parseTimestamp(record.reversedAt),
  };
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("billing_payment_financial_snapshot_invalid");
  }
  return value as Record<string, unknown>;
}

function parseResourceId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 64 ||
    !/^[A-Za-z0-9_]+$/.test(value)
  ) {
    throw new Error("billing_payment_financial_snapshot_invalid");
  }
  return value;
}

function parseRefundStatus(value: unknown): PaymentRefundSnapshot["status"] {
  if (
    value !== "queued" &&
    value !== "pending" &&
    value !== "processing" &&
    value !== "refunded" &&
    value !== "failed" &&
    value !== "canceled"
  ) {
    throw new Error("billing_payment_financial_snapshot_invalid");
  }
  return value;
}

function parseAmount(value: unknown): MollieAmount {
  const amount = parseRecord(value);
  if (
    typeof amount.currency !== "string" ||
    !/^[A-Z]{3}$/.test(amount.currency) ||
    typeof amount.value !== "string" ||
    !/^\d+\.\d{2}$/.test(amount.value)
  ) {
    throw new Error("billing_payment_financial_snapshot_invalid");
  }
  return { currency: amount.currency, value: amount.value };
}

function parseTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error("billing_payment_financial_snapshot_invalid");
  }
  return value;
}

function mergeTimestamp(
  existing: string | null,
  observed: string | null
): string | null {
  if (!existing) return observed;
  if (!observed) return existing;
  if (Date.parse(existing) !== Date.parse(observed)) {
    throw new Error("billing_payment_financial_snapshot_conflict");
  }
  return existing;
}

function assertSameAmount(left: MollieAmount, right: MollieAmount): void {
  if (left.currency !== right.currency || left.value !== right.value) {
    throw new Error("billing_payment_financial_snapshot_conflict");
  }
}

function assertUniqueIds(values: ReadonlyArray<{ id: string }>): void {
  if (new Set(values.map(value => value.id)).size !== values.length) {
    throw new Error("billing_payment_financial_snapshot_invalid");
  }
}

function financialArraysEqual(
  left: ReadonlyArray<PaymentRefundSnapshot | PaymentChargebackSnapshot>,
  right: ReadonlyArray<PaymentRefundSnapshot | PaymentChargebackSnapshot>
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
