import type {
  MollieAccountingEvent,
  MollieAccountingPage,
  MollieAccountingReader,
} from "./accountingImporter";
import type { MollieMode } from "./config";

type FetchLike = typeof fetch;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_ATTEMPTS = 3;

/**
 * Read-only adapter for Mollie's balance-transactions endpoint. The access
 * token is injected at runtime and is never placed in a URL or persisted.
 */
export class MollieBalanceAccountingReader implements MollieAccountingReader {
  constructor(
    private readonly accessToken: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly apiOrigin = "https://api.mollie.com",
    private readonly sleep: (
      milliseconds: number
    ) => Promise<void> = milliseconds =>
      new Promise(resolve => setTimeout(resolve, milliseconds)),
    private readonly balanceId = "primary"
  ) {
    if (accessToken.trim().length < 24) {
      throw new Error("Mollie accounting access token is missing or too short");
    }
    if (
      apiOrigin !== "https://api.mollie.com" &&
      process.env.NODE_ENV === "production"
    ) {
      throw new Error("Mollie accounting API origin is invalid");
    }
    if (balanceId !== "primary" && !/^bal_[A-Za-z0-9]{8,61}$/.test(balanceId)) {
      throw new Error("Mollie accounting balance ID is invalid");
    }
  }

  async listEvents(input: {
    mode: MollieMode;
    cursor: string | null;
  }): Promise<MollieAccountingPage> {
    const url = new URL(
      `/v2/balances/${encodeURIComponent(this.balanceId)}/transactions`,
      this.apiOrigin
    );
    url.searchParams.set("limit", "250");
    if (input.cursor) url.searchParams.set("from", input.cursor);
    if (input.mode === "test") url.searchParams.set("testmode", "true");
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await this.fetchImpl(url, {
          method: "GET",
          headers: {
            Accept: "application/hal+json",
            Authorization: `Bearer ${this.accessToken}`,
          },
          redirect: "error",
          signal: controller.signal,
        });
        if (response.ok) {
          return parseBalanceTransactionsPage(
            await readBoundedJson(response, MAX_RESPONSE_BYTES),
            this.balanceId
          );
        }
        const transient =
          response.status === 408 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500;
        if (!transient) {
          throw new Error("mollie_accounting_permanent_failure");
        }
        if (attempt === MAX_ATTEMPTS) {
          throw new Error("mollie_accounting_transient_failure");
        }
        await this.sleep(retryDelayMs(response, attempt));
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message === "mollie_accounting_permanent_failure" ||
            error.message === "billing_accounting_data_quality")
        ) {
          throw error;
        }
        if (attempt === MAX_ATTEMPTS) {
          throw new Error("mollie_accounting_transient_failure");
        }
        await this.sleep(
          100 * 2 ** (attempt - 1) + Math.floor(Math.random() * 50)
        );
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new Error("mollie_accounting_transient_failure");
  }
}

export function parseBalanceTransactionsPage(
  value: unknown,
  expectedBalanceId = "primary"
): MollieAccountingPage {
  if (!isRecord(value) || !isRecord(value._embedded)) {
    throw new Error("billing_accounting_data_quality");
  }
  const rows = value._embedded.balance_transactions;
  if (!Array.isArray(rows)) throw new Error("billing_accounting_data_quality");
  const events = rows.map(parseBalanceTransaction);
  return {
    events,
    nextCursor: parseNextCursor(value._links, expectedBalanceId),
  };
}

function parseBalanceTransaction(value: unknown): MollieAccountingEvent {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.type !== "string" ||
    typeof value.createdAt !== "string" ||
    !isRecord(value.initialAmount) ||
    !isRecord(value.resultAmount)
  ) {
    throw new Error("billing_accounting_data_quality");
  }
  const context = isRecord(value.context) ? value.context : {};
  const createdAt = new Date(value.createdAt);
  if (!Number.isFinite(createdAt.getTime())) {
    throw new Error("billing_accounting_data_quality");
  }
  const deduction =
    value.deductions === null || value.deductions === undefined
      ? undefined
      : parseAmount(value.deductions);
  return {
    id: value.id,
    providerType: value.type,
    type: normalizeProviderType(value.type),
    amount: parseAmount(value.initialAmount),
    netAmount: parseAmount(value.resultAmount),
    ...(deduction ? { deductionAmount: deduction } : {}),
    occurredAt: createdAt.toISOString(),
    ...(typeof context.paymentId === "string"
      ? { paymentId: context.paymentId }
      : {}),
    ...(typeof context.settlementId === "string"
      ? { settlementId: context.settlementId }
      : {}),
  };
}

function normalizeProviderType(value: string): MollieAccountingEvent["type"] {
  if (value === "payment" || value === "capture") return "payment";
  if (value === "refund") return "refund";
  if (value === "chargeback") return "chargeback";
  if (
    value === "outgoing-transfer" ||
    value === "outgoing-custom-amount-transfer" ||
    value === "incoming-transfer" ||
    value === "returned-transfer" ||
    value === "canceled-transfer"
  ) {
    return "settlement";
  }
  if (
    value === "fee" ||
    value === "payment-fee" ||
    value === "platform-fee" ||
    value === "refund-fee" ||
    value === "chargeback-fee"
  ) {
    return "fee";
  }
  return "unknown";
}

async function readBoundedJson(
  response: Response,
  maxBytes: number
): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error("billing_accounting_data_quality");
  }
  if (!response.body) throw new Error("billing_accounting_data_quality");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("billing_accounting_data_quality");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error("billing_accounting_data_quality");
  }
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(5_000, Math.floor(seconds * 1_000));
  }
  return 100 * 2 ** (attempt - 1) + Math.floor(Math.random() * 50);
}

function parseAmount(value: unknown): { currency: "EUR"; value: string } {
  if (
    !isRecord(value) ||
    value.currency !== "EUR" ||
    typeof value.value !== "string"
  ) {
    throw new Error("billing_accounting_data_quality");
  }
  return { currency: "EUR", value: value.value };
}

function parseNextCursor(
  value: unknown,
  expectedBalanceId: string
): string | null {
  if (!isRecord(value) || value.next === null || value.next === undefined) {
    return null;
  }
  if (!isRecord(value.next) || typeof value.next.href !== "string") {
    throw new Error("billing_accounting_data_quality");
  }
  let url: URL;
  try {
    url = new URL(value.next.href, "https://api.mollie.com");
  } catch {
    throw new Error("billing_accounting_data_quality");
  }
  if (
    url.origin !== "https://api.mollie.com" ||
    url.pathname !==
      `/v2/balances/${encodeURIComponent(expectedBalanceId)}/transactions`
  ) {
    throw new Error("billing_accounting_data_quality");
  }
  const cursor = url.searchParams.get("from");
  if (!cursor || cursor.length > 255) {
    throw new Error("billing_accounting_data_quality");
  }
  return cursor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
