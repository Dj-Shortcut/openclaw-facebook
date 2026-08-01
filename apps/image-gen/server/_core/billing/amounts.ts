import type { MollieAmount } from "./mollieClient";

export function parseAmountMinor(amount: MollieAmount): number {
  if (amount.currency !== "EUR" || !/^(?:0|[1-9]\d*)\.\d{2}$/.test(amount.value)) {
    throw new Error("invalid Mollie amount");
  }
  const [euros, cents] = amount.value.split(".");
  const minor = Number(euros) * 100 + Number(cents);
  if (!Number.isSafeInteger(minor)) {
    throw new Error("Mollie amount is out of range");
  }
  return minor;
}

export function parseEurValueMinor(value: string): number {
  return parseAmountMinor({ currency: "EUR", value });
}

export function sumAmountsMinor(amounts: MollieAmount[]): number {
  return amounts.reduce((total, amount) => {
    const next = total + parseAmountMinor(amount);
    if (!Number.isSafeInteger(next)) {
      throw new Error("Mollie amount total is out of range");
    }
    return next;
  }, 0);
}
