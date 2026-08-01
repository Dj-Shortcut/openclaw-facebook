import { createHash, randomUUID } from "node:crypto";

export function createOpaqueBillingId(): string {
  return randomUUID();
}

export function deterministicIdempotencyKey(
  operation: "customer" | "payment" | "subscription",
  stableReference: string
): string {
  const digest = createHash("sha256")
    .update(`leaderbot:mollie:v1:${operation}:${stableReference}`)
    .digest("hex");
  return `lb_${operation}_${digest}`;
}

export function createExternalBillingReference(): string {
  return createHash("sha256")
    .update(`leaderbot:workspace:${randomUUID()}`)
    .digest("hex");
}

export function hashCanonicalSnapshot(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`);
  return `{${entries.join(",")}}`;
}
