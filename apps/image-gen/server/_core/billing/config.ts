const MOLLIE_WEBHOOK_PATH = "/api/webhooks/mollie/payments";
const MOLLIE_BILLING_ENABLED_VALUE = "true";
const MOLLIE_ENTITLEMENT_ENFORCEMENT_ENABLED_VALUE = "true";

export type MollieMode = "test" | "live";

export type MollieConfig = Readonly<{
  apiKey: string;
  mode: MollieMode;
  paymentWebhookUrl: string;
  appBaseUrl: string;
  billingSupportEmail: string;
  liveBillingEnabled: boolean;
}>;

function assertPortalBaseUrl(mode: MollieMode): void {
  const rawPortalBaseUrl =
    process.env.PORTAL_BASE_URL?.trim() ||
    process.env.APP_BASE_URL?.trim() ||
    "https://leaderbot.live";
  const portalBaseUrl = parseAbsoluteHttpUrl(
    rawPortalBaseUrl,
    "PORTAL_BASE_URL"
  );
  if (
    portalBaseUrl.pathname !== "/" ||
    portalBaseUrl.search ||
    portalBaseUrl.hash
  ) {
    throw new Error(
      "PORTAL_BASE_URL must be an origin without a path, query, or fragment"
    );
  }
  if (process.env.NODE_ENV === "production" || mode === "live") {
    requireHttps(portalBaseUrl, "PORTAL_BASE_URL");
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value) {
    throw new Error(`${name} is missing`);
  }
  return value;
}

function parseAbsoluteHttpUrl(value: string, name: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid absolute URL`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must use HTTP or HTTPS`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${name} must not contain credentials`);
  }
  return parsed;
}

function requireHttps(url: URL, name: string): void {
  if (url.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS for production or live billing`);
  }
}

export function getMollieConfig(): MollieConfig {
  const apiKey = required("MOLLIE_API_KEY");
  const rawMode = required("MOLLIE_MODE");
  if (rawMode !== "test" && rawMode !== "live") {
    throw new Error("MOLLIE_MODE must be test or live");
  }
  const mode: MollieMode = rawMode;

  const expectedPrefix = mode === "test" ? "test_" : "live_";
  if (!apiKey.startsWith(expectedPrefix)) {
    throw new Error(`MOLLIE_API_KEY does not match MOLLIE_MODE=${mode}`);
  }
  if (!/^(?:test|live)_[A-Za-z0-9]+$/.test(apiKey)) {
    throw new Error("MOLLIE_API_KEY has an invalid format");
  }

  const appBase = parseAbsoluteHttpUrl(
    required("APP_BASE_URL"),
    "APP_BASE_URL"
  );
  const webhook = parseAbsoluteHttpUrl(
    required("MOLLIE_PAYMENT_WEBHOOK_URL"),
    "MOLLIE_PAYMENT_WEBHOOK_URL"
  );
  if (
    webhook.pathname !== MOLLIE_WEBHOOK_PATH ||
    webhook.search ||
    webhook.hash
  ) {
    throw new Error(
      `MOLLIE_PAYMENT_WEBHOOK_URL must use the exact path ${MOLLIE_WEBHOOK_PATH}`
    );
  }

  const billingSupportEmail = required("BILLING_SUPPORT_EMAIL");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(billingSupportEmail)) {
    throw new Error("BILLING_SUPPORT_EMAIL must be a valid email address");
  }

  const liveBillingEnabled = process.env.MOLLIE_LIVE_BILLING_ENABLED === "true";
  const requireSecureUrls =
    process.env.NODE_ENV === "production" || mode === "live";
  if (requireSecureUrls) {
    requireHttps(appBase, "APP_BASE_URL");
    requireHttps(webhook, "MOLLIE_PAYMENT_WEBHOOK_URL");
  }
  assertPortalBaseUrl(mode);
  if (mode === "test" && liveBillingEnabled) {
    throw new Error("MOLLIE_LIVE_BILLING_ENABLED cannot be true in test mode");
  }

  return Object.freeze({
    apiKey,
    mode,
    paymentWebhookUrl: webhook.toString(),
    appBaseUrl: appBase.toString().replace(/\/$/, ""),
    billingSupportEmail,
    liveBillingEnabled,
  });
}

export function assertMollieConfig(): void {
  void getMollieConfig();
}

export function isMollieBillingEnabled(): boolean {
  return process.env.MOLLIE_BILLING_ENABLED === MOLLIE_BILLING_ENABLED_VALUE;
}

export function isMollieEntitlementEnforcementEnabled(): boolean {
  return (
    process.env.MOLLIE_ENTITLEMENT_ENFORCEMENT_ENABLED ===
    MOLLIE_ENTITLEMENT_ENFORCEMENT_ENABLED_VALUE
  );
}

export function assertMollieBillingEnabled(): void {
  if (!isMollieBillingEnabled()) {
    throw new Error(
      "Mollie billing is disabled; enable it only after the billing launch gates are approved"
    );
  }
  if (!isMollieEntitlementEnforcementEnabled()) {
    throw new Error(
      "Mollie entitlement enforcement is disabled; migrate and verify paid quota enforcement before enabling checkout"
    );
  }
  const handoffSecret = process.env.PORTAL_HANDOFF_TOKEN_SECRET?.trim() ?? "";
  if (handoffSecret.length < 32) {
    throw new Error(
      "PORTAL_HANDOFF_TOKEN_SECRET must be set and at least 32 characters before billing handoff delivery"
    );
  }
  const config = getMollieConfig();
  if (config.mode === "live" && !config.liveBillingEnabled) {
    throw new Error(
      "Mollie live billing is disabled; set MOLLIE_LIVE_BILLING_ENABLED=true only after launch approval"
    );
  }
}

export function getMollieWebhookPath(): string {
  return MOLLIE_WEBHOOK_PATH;
}

export function getTenantBillingWorkerWorkspaceId(): number | null {
  const raw = process.env.MOLLIE_BILLING_WORKER_WORKSPACE_ID?.trim();
  if (!raw) return null;
  const workspaceId = Number(raw);
  if (!Number.isSafeInteger(workspaceId) || workspaceId <= 0) {
    throw new Error(
      "MOLLIE_BILLING_WORKER_WORKSPACE_ID must be a positive integer"
    );
  }
  return workspaceId;
}

export function assertTenantBillingWorkerWorkspace(workspaceId: number): void {
  const configuredWorkspaceId = getTenantBillingWorkerWorkspaceId();
  if (!configuredWorkspaceId || configuredWorkspaceId !== workspaceId) {
    throw new Error(
      "Mollie billing is unavailable for this workspace until a tenant-scoped worker is configured"
    );
  }
}

export function assertTenantBillingWorkerConfigured(): number {
  const configuredWorkspaceId = getTenantBillingWorkerWorkspaceId();
  if (!configuredWorkspaceId) {
    throw new Error(
      "MOLLIE_BILLING_WORKER_WORKSPACE_ID is required while Mollie billing is enabled"
    );
  }
  return configuredWorkspaceId;
}
