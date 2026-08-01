import { parseAmountMinor } from "./amounts";
import { formatAmountMinor } from "./catalog";
import { safeLog } from "../logger";

export function sumCompletedRefunds(value: unknown): string {
  return sumFilteredAmounts(
    value,
    item => item.status === "refunded",
    "refund"
  );
}

export function sumActiveChargebacks(value: unknown): string {
  return sumFilteredAmounts(
    value,
    item => item.reversedAt === null || item.reversedAt === undefined,
    "chargeback"
  );
}

function sumFilteredAmounts(
  value: unknown,
  include: (item: Record<string, unknown>) => boolean,
  entryType: "refund" | "chargeback"
): string {
  if (!Array.isArray(value)) return "0.00";
  const minor = value.reduce<number>((total, item, entryIndex) => {
    if (!isRecord(item) || !include(item)) {
      return total;
    }
    if (!isRecord(item.amount)) {
      logSkippedAmount(entryType, entryIndex);
      return total;
    }
    const { currency, value: amountValue } = item.amount;
    if (typeof currency !== "string" || typeof amountValue !== "string") {
      logSkippedAmount(entryType, entryIndex);
      return total;
    }
    let amountMinor: number;
    try {
      amountMinor = parseAmountMinor({ currency, value: amountValue });
    } catch {
      logSkippedAmount(entryType, entryIndex);
      return total;
    }
    const next = total + amountMinor;
    if (!Number.isSafeInteger(next)) {
      throw new Error("billing accounting total is out of range");
    }
    return next;
  }, 0);
  return formatAmountMinor(minor);
}

function logSkippedAmount(
  entryType: "refund" | "chargeback",
  entryIndex: number
): void {
  safeLog("billing_accounting_amount_skipped", {
    level: "warn",
    reason: "invalid_amount",
    entryType,
    entryIndex,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
