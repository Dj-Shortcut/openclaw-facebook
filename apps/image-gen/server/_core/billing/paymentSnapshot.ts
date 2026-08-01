import { hashCanonicalSnapshot } from "./ids";
import type {
  MollieChargeback,
  MolliePayment,
  MollieRefund,
} from "./mollieClient";

function normalizeRefund(refund: MollieRefund) {
  return {
    id: refund.id,
    status: refund.status,
    amount: refund.amount,
    createdAt: refund.createdAt ?? null,
  };
}

function normalizeChargeback(chargeback: MollieChargeback) {
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

export function createPaymentSnapshot(payment: MolliePayment) {
  const refunds = [...(payment._embedded?.refunds ?? [])]
    .map(normalizeRefund)
    .sort(compareIds);
  const chargebacks = [...(payment._embedded?.chargebacks ?? [])]
    .map(normalizeChargeback)
    .sort(compareIds);
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
