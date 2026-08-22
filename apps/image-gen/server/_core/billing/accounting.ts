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

export function assertCanonicalEurAmount(
  value: unknown,
  currency: unknown
): void {
  if (currency !== "EUR" || typeof value !== "string") {
    throw new Error("billing_accounting_data_quality");
  }
  try {
    const minor = parseAmountMinor({ currency, value });
    if (formatAmountMinor(minor) !== value) {
      throw new Error("noncanonical");
    }
  } catch {
    throw new Error("billing_accounting_data_quality");
  }
}

/** Accounting adjustments may be signed; payment amounts remain non-negative. */
export function assertCanonicalSignedEurAmount(
  value: unknown,
  currency: unknown
): void {
  if (
    currency !== "EUR" ||
    typeof value !== "string" ||
    !/^-?(?:0|[1-9]\d*)\.\d{2}$/.test(value) ||
    value === "-0.00"
  ) {
    throw new Error("billing_accounting_data_quality");
  }
  const digits = value.startsWith("-") ? value.slice(1) : value;
  const minor = BigInt(digits.replace(".", ""));
  if (minor > BigInt("999999999999")) {
    throw new Error("billing_accounting_data_quality");
  }
}

function sumFilteredAmounts(
  value: unknown,
  include: (item: Record<string, unknown>) => boolean,
  entryType: "refund" | "chargeback"
): string {
  if (!Array.isArray(value)) {
    throw new Error("billing_accounting_data_quality");
  }
  let dataQualityFailure = false;
  const minor = value.reduce<number>((total, item, entryIndex) => {
    if (!isRecord(item)) {
      logSkippedAmount(entryType, entryIndex);
      dataQualityFailure = true;
      return total;
    }
    if (!include(item)) {
      return total;
    }
    if (!isRecord(item.amount)) {
      logSkippedAmount(entryType, entryIndex);
      dataQualityFailure = true;
      return total;
    }
    const { currency, value: amountValue } = item.amount;
    if (currency !== "EUR" || typeof amountValue !== "string") {
      logSkippedAmount(entryType, entryIndex);
      dataQualityFailure = true;
      return total;
    }
    let amountMinor: number;
    try {
      amountMinor = parseAmountMinor({ currency, value: amountValue });
    } catch {
      logSkippedAmount(entryType, entryIndex);
      dataQualityFailure = true;
      return total;
    }
    const next = total + amountMinor;
    if (!Number.isSafeInteger(next)) {
      throw new Error("billing accounting total is out of range");
    }
    return next;
  }, 0);
  if (dataQualityFailure) {
    throw new Error("billing_accounting_data_quality");
  }
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
