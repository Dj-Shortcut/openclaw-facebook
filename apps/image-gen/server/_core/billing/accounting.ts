import { parseAmountMinor } from "./amounts";
import { formatAmountMinor } from "./catalog";

export function sumCompletedRefunds(value: unknown): string {
  return sumFilteredAmounts(value, item => item.status === "refunded");
}

export function sumActiveChargebacks(value: unknown): string {
  return sumFilteredAmounts(
    value,
    item => item.reversedAt === null || item.reversedAt === undefined
  );
}

function sumFilteredAmounts(
  value: unknown,
  include: (item: Record<string, unknown>) => boolean
): string {
  if (!Array.isArray(value)) return "0.00";
  const minor = value.reduce<number>((total, item) => {
    if (!isRecord(item) || !include(item) || !isRecord(item.amount)) {
      return total;
    }
    const { currency, value: amountValue } = item.amount;
    if (typeof currency !== "string" || typeof amountValue !== "string") {
      return total;
    }
    let amountMinor: number;
    try {
      amountMinor = parseAmountMinor({ currency, value: amountValue });
    } catch {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
