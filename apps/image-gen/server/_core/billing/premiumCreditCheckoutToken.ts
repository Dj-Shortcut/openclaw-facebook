import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

import { PREMIUM_IMAGE_CREDITS_PLAN_CODE } from "./catalog";

const TOKEN_VERSION = "pc1";
const TOKEN_TTL_MS = 10 * 60_000;
const MAX_CLOCK_SKEW_MS = 30_000;

export type PremiumCreditCheckoutIdentity = Readonly<{
  workspaceId: number;
  channelConnectionId: number;
  bindingEpoch: number;
  privacyEpoch: number;
  userKey: string;
  pageId: string;
}>;

type TokenPayload = PremiumCreditCheckoutIdentity & {
  offer: typeof PREMIUM_IMAGE_CREDITS_PLAN_CODE;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
};

export function isPremiumCreditCheckoutEnabled(): boolean {
  return (
    process.env.PREMIUM_CREDIT_CHECKOUT_ENABLED === "true" &&
    process.env.PREMIUM_CREDIT_ENFORCEMENT_ENABLED === "true"
  );
}

export function createPremiumCreditCheckoutUrl(
  identity: PremiumCreditCheckoutIdentity,
  now = Date.now()
): string | undefined {
  if (!isPremiumCreditCheckoutEnabled()) return undefined;
  assertIdentity(identity);
  const base = safeAppBaseUrl();
  if (!base) return undefined;
  const payload: TokenPayload = {
    ...identity,
    offer: PREMIUM_IMAGE_CREDITS_PLAN_CODE,
    nonce: randomBytes(18).toString("base64url"),
    issuedAt: now,
    expiresAt: now + TOKEN_TTL_MS,
  };
  const token = encryptPayload(payload);
  const url = new URL("/credits", base);
  url.searchParams.set("token", token);
  return url.toString();
}

export function readPremiumCreditCheckoutToken(
  token: string,
  now = Date.now()
): TokenPayload & { checkoutScopeKey: string } {
  if (!isPremiumCreditCheckoutEnabled()) {
    throw new Error("premium credit checkout is disabled");
  }
  if (!/^[A-Za-z0-9_-]{40,4096}$/.test(token)) {
    throw new Error("premium credit checkout token is invalid");
  }
  const payload = decryptPayload(token);
  assertIdentity(payload);
  if (
    payload.offer !== PREMIUM_IMAGE_CREDITS_PLAN_CODE ||
    !/^[A-Za-z0-9_-]{16,64}$/.test(payload.nonce) ||
    !Number.isSafeInteger(payload.issuedAt) ||
    !Number.isSafeInteger(payload.expiresAt) ||
    payload.expiresAt <= payload.issuedAt ||
    payload.expiresAt - payload.issuedAt !== TOKEN_TTL_MS ||
    payload.issuedAt > now + MAX_CLOCK_SKEW_MS ||
    payload.expiresAt <= now
  ) {
    throw new Error("premium credit checkout token is invalid or expired");
  }
  return {
    ...payload,
    checkoutScopeKey: `premium:${createHash("sha256")
      .update(payload.nonce)
      .digest("hex")}`,
  };
}

function encryptPayload(payload: TokenPayload): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", tokenKey(), iv);
  cipher.setAAD(Buffer.from(TOKEN_VERSION));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
    "base64url"
  );
}

function decryptPayload(token: string): TokenPayload {
  try {
    const raw = Buffer.from(token, "base64url");
    if (raw.length < 29) throw new Error("short token");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      tokenKey(),
      raw.subarray(0, 12)
    );
    decipher.setAAD(Buffer.from(TOKEN_VERSION));
    decipher.setAuthTag(raw.subarray(12, 28));
    const plaintext = Buffer.concat([
      decipher.update(raw.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
    const parsed: unknown = JSON.parse(plaintext);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid payload");
    }
    return parsed as TokenPayload;
  } catch {
    throw new Error("premium credit checkout token is invalid");
  }
}

function tokenKey(): Buffer {
  const secret = process.env.PREMIUM_CREDIT_CHECKOUT_TOKEN_SECRET?.trim() ?? "";
  if (secret.length < 32) {
    throw new Error(
      "PREMIUM_CREDIT_CHECKOUT_TOKEN_SECRET must contain at least 32 characters"
    );
  }
  return createHash("sha256").update(secret).digest();
}

function safeAppBaseUrl(): URL | undefined {
  const raw = process.env.APP_BASE_URL?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const local =
      process.env.NODE_ENV !== "production" &&
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if (
      url.username ||
      url.password ||
      (url.protocol !== "https:" && !local) ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function assertIdentity(identity: PremiumCreditCheckoutIdentity): void {
  if (
    !Number.isSafeInteger(identity.workspaceId) ||
    identity.workspaceId <= 0 ||
    !Number.isSafeInteger(identity.channelConnectionId) ||
    identity.channelConnectionId <= 0 ||
    !Number.isSafeInteger(identity.bindingEpoch) ||
    identity.bindingEpoch <= 0 ||
    !Number.isSafeInteger(identity.privacyEpoch) ||
    identity.privacyEpoch <= 0 ||
    !/^[a-f0-9]{64}$/i.test(identity.userKey) ||
    !/^[A-Za-z0-9._:-]{1,160}$/.test(identity.pageId)
  ) {
    throw new Error("premium credit checkout identity is invalid");
  }
}
