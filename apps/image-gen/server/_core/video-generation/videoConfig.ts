const INITIAL_VIDEO_PROVIDER = "openai";
const INITIAL_VIDEO_MODEL = "sora-2";
const INITIAL_VIDEO_SIZE = "1280x720";
const INITIAL_VIDEO_SECONDS = "8";
const INITIAL_VIDEO_MAX_RETRIES = "0";
const INITIAL_VIDEO_DAILY_LIMIT = "1";
const INITIAL_VIDEO_MAX_OUTPUT_BYTES = "25165824";
const INITIAL_VIDEO_MAX_REFERENCE_IMAGE_BYTES = "12582912";
const USER_KEY_PATTERN = /^[a-f0-9]{64}$/u;
const PAGE_BINDING_PATTERN = /^([1-9]\d*):([1-9]\d*):([1-9]\d*):([1-9]\d*)$/u;

export type MessengerVideoPageBinding = Readonly<{
  workspaceId: number;
  channelConnectionId: number;
  bindingEpoch: number;
  pageId: string;
}>;

export function isMessengerVideoGenerationEnabled(): boolean {
  return process.env.MESSENGER_VIDEO_GENERATION_ENABLED === "true";
}

function getAllowedVideoUserKeys(): string[] {
  return (process.env.MESSENGER_VIDEO_ALLOWED_USER_KEYS ?? "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
}

export function isMessengerVideoUserAllowed(userKey: string): boolean {
  const allowedUserKeys = getAllowedVideoUserKeys();
  if (allowedUserKeys.length === 0) {
    return process.env.NODE_ENV !== "production";
  }
  return allowedUserKeys.includes(userKey);
}

function getAllowedVideoPageBindings(): MessengerVideoPageBinding[] | null {
  const values = (process.env.MESSENGER_VIDEO_ALLOWED_PAGE_BINDINGS ?? "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
  const bindings: MessengerVideoPageBinding[] = [];
  for (const value of values) {
    const match = PAGE_BINDING_PATTERN.exec(value);
    if (!match) return null;
    const workspaceId = Number(match[1]);
    const channelConnectionId = Number(match[2]);
    const bindingEpoch = Number(match[3]);
    if (
      !Number.isSafeInteger(workspaceId) ||
      !Number.isSafeInteger(channelConnectionId) ||
      !Number.isSafeInteger(bindingEpoch)
    ) {
      return null;
    }
    bindings.push({
      workspaceId,
      channelConnectionId,
      bindingEpoch,
      pageId: match[4],
    });
  }
  return bindings;
}

export function isMessengerVideoPageBindingAllowed(
  binding: MessengerVideoPageBinding | null
): boolean {
  const allowedBindings = getAllowedVideoPageBindings();
  if (!allowedBindings?.length) {
    return process.env.NODE_ENV !== "production";
  }
  if (!binding) return false;
  return allowedBindings.some(
    allowed =>
      allowed.workspaceId === binding.workspaceId &&
      allowed.channelConnectionId === binding.channelConnectionId &&
      allowed.bindingEpoch === binding.bindingEpoch &&
      allowed.pageId === binding.pageId
  );
}

function requireExact(name: string, expected: string): void {
  if (process.env[name]?.trim() !== expected) {
    throw new Error(`${name} must be explicitly set to ${expected}`);
  }
}

function requirePositiveNumber(name: string): number {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be explicitly set to a positive number`);
  }
  return value;
}

function requirePositiveInteger(name: string): number {
  const value = requirePositiveNumber(name);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be explicitly set to a positive integer`);
  }
  return value;
}

/**
 * Keeps the first owner-operated video rollout fail closed. The browser and
 * Messenger payload never choose provider, model, duration, retries, or cost.
 */
export function assertProductionMessengerVideoConfig(): void {
  if (
    process.env.NODE_ENV !== "production" ||
    !isMessengerVideoGenerationEnabled()
  ) {
    return;
  }

  requireExact("MESSENGER_VIDEO_PROVIDER", INITIAL_VIDEO_PROVIDER);
  requireExact("OPENAI_VIDEO_MODEL", INITIAL_VIDEO_MODEL);
  requireExact("OPENAI_VIDEO_SIZE", INITIAL_VIDEO_SIZE);
  requireExact("OPENAI_VIDEO_SECONDS", INITIAL_VIDEO_SECONDS);
  requireExact("OPENAI_VIDEO_MAX_RETRIES", INITIAL_VIDEO_MAX_RETRIES);
  requireExact("OPENAI_VIDEO_MAX_OUTPUT_BYTES", INITIAL_VIDEO_MAX_OUTPUT_BYTES);
  requireExact(
    "OPENAI_VIDEO_MAX_REFERENCE_IMAGE_BYTES",
    INITIAL_VIDEO_MAX_REFERENCE_IMAGE_BYTES
  );
  requireExact("MESSENGER_TTS_ENABLED", "false");
  requireExact("MESSENGER_VIDEO_AMBIGUOUS_CREATE_RETENTION_APPROVED", "true");
  const allowedUserKeys = getAllowedVideoUserKeys();
  if (
    allowedUserKeys.length === 0 ||
    allowedUserKeys.some(userKey => !USER_KEY_PATTERN.test(userKey)) ||
    new Set(allowedUserKeys).size !== allowedUserKeys.length
  ) {
    throw new Error(
      "MESSENGER_VIDEO_ALLOWED_USER_KEYS must contain unique comma-separated pseudonymous user keys"
    );
  }
  const allowedPageBindings = getAllowedVideoPageBindings();
  const serializedBindings = (
    process.env.MESSENGER_VIDEO_ALLOWED_PAGE_BINDINGS ?? ""
  )
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
  if (
    !allowedPageBindings?.length ||
    new Set(serializedBindings).size !== serializedBindings.length
  ) {
    throw new Error(
      "MESSENGER_VIDEO_ALLOWED_PAGE_BINDINGS must contain unique workspace:connection:binding:page entries"
    );
  }
  requireExact(
    "MESSENGER_VIDEO_GENERATION_DAILY_LIMIT",
    INITIAL_VIDEO_DAILY_LIMIT
  );
  requirePositiveInteger("MESSENGER_GLOBAL_DAILY_VIDEO_CAP");
  requirePositiveNumber("OPENAI_VIDEO_GENERATION_ESTIMATED_COST_USD");
  requirePositiveNumber("MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD");
  requirePositiveNumber("MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD");
  requirePositiveNumber("MESSENGER_USER_DAILY_SPEND_CAP_USD");

  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new Error(
      "OPENAI_API_KEY must be configured when Messenger video generation is enabled"
    );
  }
  if (!process.env.REDIS_URL?.trim()) {
    throw new Error(
      "REDIS_URL must be configured when Messenger video generation is enabled"
    );
  }

  const providerTimeoutMs = requirePositiveInteger(
    "MESSENGER_VIDEO_GENERATION_TIMEOUT_MS"
  );
  const flowTimeoutMs = requirePositiveInteger(
    "MESSENGER_VIDEO_FLOW_TIMEOUT_MS"
  );
  if (flowTimeoutMs <= providerTimeoutMs) {
    throw new Error(
      "MESSENGER_VIDEO_FLOW_TIMEOUT_MS must exceed MESSENGER_VIDEO_GENERATION_TIMEOUT_MS"
    );
  }
}

export function getMessengerVideoTimeoutMs(): number {
  const configured = Number.parseInt(
    process.env.MESSENGER_VIDEO_GENERATION_TIMEOUT_MS ?? "",
    10
  );
  return Number.isFinite(configured) && configured > 0 ? configured : 240_000;
}

export function getMessengerVideoFlowTimeoutMs(): number {
  const configured = Number.parseInt(
    process.env.MESSENGER_VIDEO_FLOW_TIMEOUT_MS ?? "",
    10
  );
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }

  return getMessengerVideoTimeoutMs() + 60_000;
}
