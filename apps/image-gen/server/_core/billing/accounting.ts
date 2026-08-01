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
    const currency = item.amount.currency;
    const amountValue = item.amount.value;
    if (
      currency !== "EUR" ||
      typeof amountValue !== "string" ||
      !/^\d+\.\d{2}$/.test(amountValue)
    ) {
      return total;
    }
    const [euros, cents] = amountValue.split(".");
    return total + Number(euros) * 100 + Number(cents);
  }, 0);
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
