import type { MollieConfig } from "./config";
import { parseAmountMinor } from "./amounts";

export type MollieAmount = {
  currency: string;
  value: string;
};

export type MollieLink = {
  href: string;
  type?: string;
};

export type MollieRefund = {
  id: string;
  status: string;
  amount: MollieAmount;
  createdAt?: string;
};

export type MollieChargeback = {
  id: string;
  amount: MollieAmount;
  createdAt?: string;
  reversedAt?: string;
};

export type MolliePayment = {
  resource: "payment";
  id: string;
  mode: "test" | "live";
  status: string;
  amount: MollieAmount;
  amountRefunded?: MollieAmount;
  amountRemaining?: MollieAmount;
  settlementAmount?: MollieAmount;
  description: string;
  method?: string | null;
  sequenceType?: "oneoff" | "first" | "recurring";
  customerId?: string | null;
  mandateId?: string | null;
  subscriptionId?: string | null;
  metadata?: unknown;
  createdAt: string;
  paidAt?: string;
  canceledAt?: string;
  expiredAt?: string;
  failedAt?: string;
  _links?: Record<string, MollieLink | undefined>;
  _embedded?: {
    refunds?: MollieRefund[];
    chargebacks?: MollieChargeback[];
  };
};

export type MollieMandate = {
  resource: "mandate";
  id: string;
  mode: "test" | "live";
  status: "pending" | "valid" | "invalid";
  method: string;
  createdAt: string;
};

export type MollieSubscription = {
  resource: "subscription";
  id: string;
  mode: "test" | "live";
  status: "pending" | "active" | "canceled" | "suspended" | "completed";
  amount: MollieAmount;
  interval: string;
  startDate: string;
  nextPaymentDate?: string | null;
  mandateId?: string | null;
  metadata?: unknown;
};

export type MollieMethod = {
  resource: "method";
  id: string;
  status?: string;
};

type MollieList<T> = {
  _embedded?: Record<string, T[] | undefined>;
  _links?: {
    next?: MollieLink | null;
  };
};

export class MollieApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(`Mollie API request failed (${status})`);
    this.name = "MollieApiError";
    this.status = status;
    this.code = code;
  }
}

type FetchLike = typeof fetch;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CREDIT_PAYMENT_RETURN_PATH = "/credits/checkout/return";
const MOLLIE_LIST_PAGE_SIZE = 250;
const PAYMENT_RECONCILIATION_MAX_PAGES = 4;
const PAYMENT_RECONCILIATION_MAX_RESULTS =
  MOLLIE_LIST_PAGE_SIZE * PAYMENT_RECONCILIATION_MAX_PAGES;

export class MollieClient {
  private readonly apiBaseUrl: string;

  constructor(
    private readonly config: MollieConfig,
    private readonly fetchImpl: FetchLike = fetch,
    apiBaseUrl = "https://api.mollie.com/v2"
  ) {
    const parsedApiBaseUrl = parseSecureUrl(apiBaseUrl, "Mollie API base URL");
    if (parsedApiBaseUrl.search || parsedApiBaseUrl.hash) {
      throw new Error("Mollie API base URL must not contain query or fragment");
    }
    this.apiBaseUrl = parsedApiBaseUrl.toString().replace(/\/$/, "");
  }

  async createCreditPayment(input: {
    amount: MollieAmount;
    description: string;
    billingIntentId: string;
    metadataHash: string;
    redirectUrl: string;
    webhookUrl: string;
    idempotencyKey: string;
  }): Promise<MolliePayment> {
    assertCreditPaymentInput(this.config, input);
    return this.request<MolliePayment>("/payments", {
      method: "POST",
      idempotencyKey: input.idempotencyKey,
      body: {
        amount: { currency: "EUR", value: input.amount.value },
        sequenceType: "oneoff",
        method: "bancontact",
        locale: "nl_BE",
        description: input.description,
        redirectUrl: input.redirectUrl,
        webhookUrl: input.webhookUrl,
        metadata: {
          billingIntentId: input.billingIntentId,
          purpose: "premium_image_credits",
          version: 1,
          metadataHash: input.metadataHash,
        },
      },
    });
  }

  async getPayment(paymentId: string): Promise<MolliePayment> {
    assertMollieId(paymentId, "tr_");
    return this.request<MolliePayment>(
      `/payments/${encodeURIComponent(paymentId)}?embed=refunds%2Cchargebacks`,
      { method: "GET" }
    );
  }

  async cancelPayment(paymentId: string): Promise<void> {
    assertMollieId(paymentId, "tr_");
    await this.request<null>(`/payments/${encodeURIComponent(paymentId)}`, {
      method: "DELETE",
    });
  }

  async listCustomerPayments(customerId: string): Promise<MolliePayment[]> {
    assertMollieId(customerId, "cst_");
    return this.requestAllPages<MolliePayment>(
      `/customers/${encodeURIComponent(customerId)}/payments?limit=250`,
      "payments"
    );
  }

  async listPayments(): Promise<MolliePayment[]> {
    return this.requestAllPages<MolliePayment>(
      `/payments?limit=${MOLLIE_LIST_PAGE_SIZE}`,
      "payments",
      {
        maxPages: PAYMENT_RECONCILIATION_MAX_PAGES,
        maxResults: PAYMENT_RECONCILIATION_MAX_RESULTS,
        validateNextUrl: assertProfilePaymentPaginationUrl,
      }
    );
  }

  async listMandates(customerId: string): Promise<MollieMandate[]> {
    assertMollieId(customerId, "cst_");
    return this.requestAllPages<MollieMandate>(
      `/customers/${encodeURIComponent(customerId)}/mandates?limit=250&scopes%5B%5D=customer-not-present`,
      "mandates"
    );
  }

  async createSubscription(input: {
    customerId: string;
    mandateId: string;
    amount: MollieAmount;
    interval: string;
    startDate: string;
    description: string;
    intentId: string;
    webhookUrl: string;
    idempotencyKey: string;
  }): Promise<MollieSubscription> {
    assertMollieId(input.customerId, "cst_");
    assertMollieId(input.mandateId, "mdt_");
    return this.request<MollieSubscription>(
      `/customers/${encodeURIComponent(input.customerId)}/subscriptions`,
      {
        method: "POST",
        idempotencyKey: input.idempotencyKey,
        body: {
          amount: input.amount,
          mandateId: input.mandateId,
          method: "directdebit",
          interval: input.interval,
          startDate: input.startDate,
          description: input.description,
          webhookUrl: input.webhookUrl,
          metadata: { billingIntentId: input.intentId },
        },
      }
    );
  }

  async getSubscription(
    customerId: string,
    subscriptionId: string
  ): Promise<MollieSubscription> {
    assertMollieId(customerId, "cst_");
    assertMollieId(subscriptionId, "sub_");
    return this.request<MollieSubscription>(
      `/customers/${encodeURIComponent(customerId)}/subscriptions/${encodeURIComponent(subscriptionId)}`,
      { method: "GET" }
    );
  }

  async listCustomerSubscriptions(
    customerId: string
  ): Promise<MollieSubscription[]> {
    assertMollieId(customerId, "cst_");
    return this.requestAllPages<MollieSubscription>(
      `/customers/${encodeURIComponent(customerId)}/subscriptions?limit=250`,
      "subscriptions"
    );
  }

  async cancelSubscription(
    customerId: string,
    subscriptionId: string
  ): Promise<void> {
    assertMollieId(customerId, "cst_");
    assertMollieId(subscriptionId, "sub_");
    await this.request<null>(
      `/customers/${encodeURIComponent(customerId)}/subscriptions/${encodeURIComponent(subscriptionId)}`,
      { method: "DELETE" }
    );
  }

  async listMethods(
    sequenceType: "oneoff" | "first" | "recurring"
  ): Promise<MollieMethod[]> {
    const response = await this.request<MollieList<MollieMethod>>(
      `/methods?sequenceType=${sequenceType}&locale=nl_BE`,
      { method: "GET" }
    );
    return response._embedded?.methods ?? [];
  }

  getHostedCheckoutUrl(payment: MolliePayment): string {
    const checkoutUrl = payment._links?.checkout?.href;
    if (!checkoutUrl) {
      throw new Error("Mollie payment has no hosted checkout URL");
    }
    const parsed = new URL(checkoutUrl);
    if (
      parsed.protocol !== "https:" ||
      !(
        parsed.hostname === "mollie.com" ||
        parsed.hostname.endsWith(".mollie.com")
      )
    ) {
      throw new Error("Mollie returned an unexpected checkout host");
    }
    return parsed.toString();
  }

  private async requestAllPages<T>(
    initialPath: string,
    embeddedKey: string,
    options?: Readonly<{
      maxPages: number;
      maxResults: number;
      validateNextUrl?: (url: URL) => void;
    }>
  ): Promise<T[]> {
    const items: T[] = [];
    const visited = new Set<string>();
    const expectedPathname = new URL(`${this.apiBaseUrl}${initialPath}`)
      .pathname;
    let path: string | null = initialPath;
    let pageCount = 0;

    while (path) {
      if (options && pageCount >= options.maxPages) {
        throw new Error("Mollie pagination page limit exceeded");
      }
      if (visited.has(path)) {
        throw new Error("Mollie pagination cycle detected");
      }
      visited.add(path);
      pageCount += 1;
      const response: MollieList<T> = await this.request<MollieList<T>>(path, {
        method: "GET",
      });
      const pageItems = response._embedded?.[embeddedKey] ?? [];
      if (!Array.isArray(pageItems)) {
        throw new Error("Mollie returned an invalid paginated response");
      }
      if (options && items.length + pageItems.length > options.maxResults) {
        throw new Error("Mollie pagination result limit exceeded");
      }
      items.push(...pageItems);
      const nextLink: unknown = response._links?.next;
      if (nextLink == null) {
        path = null;
        continue;
      }
      if (
        typeof nextLink !== "object" ||
        Array.isArray(nextLink) ||
        typeof (nextLink as Record<string, unknown>).href !== "string"
      ) {
        throw new Error("Mollie returned an invalid pagination URL");
      }
      const nextHref = (nextLink as Record<string, string>).href;
      if (!nextHref || nextHref !== nextHref.trim()) {
        throw new Error("Mollie returned an invalid pagination URL");
      }
      path = this.resolvePaginationPath(
        nextHref,
        path,
        expectedPathname,
        options?.validateNextUrl
      );
    }

    return items;
  }

  private resolvePaginationPath(
    href: string,
    currentPath: string,
    expectedPathname: string,
    validateNextUrl?: (url: URL) => void
  ): string {
    if (href.length > 2_048) {
      throw new Error("Mollie returned an unexpected pagination URL");
    }
    const apiBase = new URL(this.apiBaseUrl);
    const current = new URL(`${this.apiBaseUrl}${currentPath}`);
    const next = new URL(href, current);
    const basePath = apiBase.pathname.replace(/\/$/, "");
    if (
      next.protocol !== "https:" ||
      next.origin !== apiBase.origin ||
      next.username ||
      next.password ||
      next.hash ||
      (next.pathname !== basePath &&
        !next.pathname.startsWith(`${basePath}/`)) ||
      next.pathname !== expectedPathname
    ) {
      throw new Error("Mollie returned an unexpected pagination URL");
    }
    validateNextUrl?.(next);
    const relativePath = next.pathname.slice(basePath.length) || "/";
    return `${relativePath}${next.search}`;
  }

  private async request<T>(
    path: string,
    options: {
      method: "GET" | "POST" | "DELETE";
      body?: Record<string, unknown>;
      idempotencyKey?: string;
    }
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      Accept: "application/hal+json",
    };
    if (options.body) {
      headers["Content-Type"] = "application/json";
    }
    if (options.idempotencyKey) {
      headers["Idempotency-Key"] = options.idempotencyKey;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
        method: options.method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      const code = error instanceof Error ? error.name : "NetworkError";
      throw new MollieApiError(0, code);
    }

    if (!response.ok) {
      let code = `http_${response.status}`;
      try {
        const payload = (await response.json()) as {
          status?: number;
          title?: string;
        };
        if (typeof payload.status === "number") {
          code = `mollie_${payload.status}`;
        }
      } catch {
        // Intentionally avoid retaining or logging provider response bodies.
      }
      throw new MollieApiError(response.status, code);
    }

    if (response.status === 204) {
      return null as T;
    }
    return (await response.json()) as T;
  }
}

function assertProfilePaymentPaginationUrl(url: URL): void {
  const limits = url.searchParams.getAll("limit");
  const cursors = url.searchParams.getAll("from");
  if (
    limits.length !== 1 ||
    limits[0] !== String(MOLLIE_LIST_PAGE_SIZE) ||
    cursors.length !== 1 ||
    !/^tr_[A-Za-z0-9][A-Za-z0-9_]{0,60}$/.test(cursors[0] ?? "") ||
    [...url.searchParams.keys()].some(key => key !== "limit" && key !== "from")
  ) {
    throw new Error("Mollie returned an unexpected payment pagination query");
  }

  const encodedCursor = encodeURIComponent(cursors[0]);
  if (
    url.search !== `?from=${encodedCursor}&limit=${MOLLIE_LIST_PAGE_SIZE}` &&
    url.search !== `?limit=${MOLLIE_LIST_PAGE_SIZE}&from=${encodedCursor}`
  ) {
    throw new Error("Mollie returned an unexpected payment pagination query");
  }
}

function parseSecureUrl(value: string, name: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid absolute URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(`${name} must be an HTTPS URL without credentials`);
  }
  return parsed;
}

function assertCreditPaymentInput(
  config: MollieConfig,
  input: {
    amount: MollieAmount;
    description: string;
    billingIntentId: string;
    metadataHash: string;
    redirectUrl: string;
    webhookUrl: string;
    idempotencyKey: string;
  }
): void {
  if (parseAmountMinor(input.amount) <= 0) {
    throw new Error("invalid credit payment amount");
  }
  if (
    typeof input.description !== "string" ||
    input.description.length === 0 ||
    input.description.length > 255 ||
    input.description !== input.description.trim() ||
    /[\u0000-\u001f\u007f]/.test(input.description)
  ) {
    throw new Error("invalid credit payment description");
  }
  if (!UUID_PATTERN.test(input.billingIntentId)) {
    throw new Error("invalid credit payment billing intent ID");
  }
  if (!SHA256_PATTERN.test(input.metadataHash)) {
    throw new Error("invalid credit payment metadata hash");
  }
  if (input.idempotencyKey !== `credit-payment:${input.billingIntentId}`) {
    throw new Error("invalid credit payment idempotency key");
  }

  const redirectUrl = parseSecureUrl(
    input.redirectUrl,
    "credit payment return URL"
  );
  const appBaseUrl = parseSecureUrl(config.appBaseUrl, "APP_BASE_URL");
  const expectedReturnUrl = new URL(
    CREDIT_PAYMENT_RETURN_PATH,
    appBaseUrl
  ).toString();
  if (
    input.redirectUrl !== expectedReturnUrl ||
    redirectUrl.search ||
    redirectUrl.hash
  ) {
    throw new Error("invalid credit payment return URL");
  }

  const webhookUrl = parseSecureUrl(input.webhookUrl, "Mollie webhook URL");
  if (
    input.webhookUrl !== config.paymentWebhookUrl ||
    webhookUrl.search ||
    webhookUrl.hash
  ) {
    throw new Error("invalid credit payment webhook URL");
  }
}

function isEnabledMollieMethod(method: MollieMethod): boolean {
  return (
    !method.status ||
    method.status === "activated" ||
    method.status === "active"
  );
}

export async function checkMollieOneTimePaymentMethod(client: MollieClient) {
  const methods = await client.listMethods("oneoff");
  const bancontact = methods.some(
    method => method.id === "bancontact" && isEnabledMollieMethod(method)
  );
  return { bancontact, providerChecked: true as const };
}

export function assertMollieId(
  value: string,
  prefix: "tr_" | "cst_" | "mdt_" | "sub_"
): void {
  if (
    value.length > 64 ||
    !value.startsWith(prefix) ||
    !/^[A-Za-z0-9_]+$/.test(value)
  ) {
    throw new Error("invalid Mollie resource ID");
  }
}

export async function checkMolliePaymentMethods(
  client: MollieClient,
  mode: "test" | "live"
) {
  const [firstMethods, recurringMethods] = await Promise.all([
    client.listMethods("first"),
    client.listMethods("recurring"),
  ]);
  const bancontact = firstMethods.some(
    method => method.id === "bancontact" && isEnabledMollieMethod(method)
  );
  const sepaDirectDebit = recurringMethods.some(
    method => method.id === "directdebit" && isEnabledMollieMethod(method)
  );
  return {
    ok: mode === "live" && bancontact && sepaDirectDebit,
    bancontact,
    sepaDirectDebit,
    profileActivationConfirmed:
      mode === "live" && bancontact && sepaDirectDebit,
    evidence:
      mode === "live" ? "live_profile_enabled_methods" : "test_mode_not_proof",
  };
}
