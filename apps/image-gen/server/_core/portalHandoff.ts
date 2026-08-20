import crypto from "node:crypto";
import * as db from "../db";
import { toUserKey } from "./privacy";

const DEFAULT_HANDOFF_TTL_MS = 24 * 60 * 60 * 1000;
const TOKEN_BYTES = 32;

export type PortalHandoffPurpose = "workspace_onboarding";

export type CreatePortalHandoffInput = {
  workspaceId: number;
  facebookPageId: string;
  purpose?: PortalHandoffPurpose;
  messengerSenderUserKey?: string | null;
  createdByUserId?: number | null;
  now?: Date;
  ttlMs?: number;
  deliveryIdempotencyKey?: string | null;
};

export type PortalHandoffTokenResult = {
  token: string;
  tokenHash: string;
  expiresAt: Date;
};

export type PortalHandoffContext = {
  workspaceId: number;
  facebookPageId: string | null;
  messengerSenderUserKey: string | null;
  claimedByUserId: number | null;
  status: "pending" | "consumed" | "expired" | "revoked";
  expiresAt: Date;
};

export type ConsumePortalHandoffResult =
  | {
      ok: true;
      workspaceId: number;
      purpose: PortalHandoffPurpose;
      messengerSenderUserKey: string | null;
    }
  | {
      ok: false;
      reason: "invalid" | "expired" | "already_used";
    };

export type ClaimPortalHandoffResult = Awaited<
  ReturnType<typeof db.claimPortalHandoffTokenForUser>
>;

export function hashPortalHandoffToken(token: string): string {
  return `sha256:${crypto.createHash("sha256").update(token).digest("hex")}`;
}

function hashDeliveryIdempotencyKey(key: string): string {
  return `sha256:${crypto.createHash("sha256").update(key).digest("hex")}`;
}

export function hashMessengerSenderForHandoff(senderId: string): string {
  return toUserKey(senderId);
}

function createOpaqueToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

function createDeliveryToken(deliveryIdempotencyKey?: string | null): string {
  if (!deliveryIdempotencyKey) return createOpaqueToken();
  const secret = process.env.PORTAL_HANDOFF_TOKEN_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error("PORTAL_HANDOFF_TOKEN_SECRET must be set for idempotent delivery");
  }
  return crypto
    .createHmac("sha256", secret)
    .update(`portal-handoff-v1:${deliveryIdempotencyKey}`)
    .digest("base64url");
}

export async function createPortalHandoffToken(
  input: CreatePortalHandoffInput
): Promise<PortalHandoffTokenResult> {
  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? DEFAULT_HANDOFF_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error("portal handoff ttl must be positive");
  }

  const token = createDeliveryToken(input.deliveryIdempotencyKey);
  const tokenHash = hashPortalHandoffToken(token);
  const expiresAt = new Date(now.getTime() + ttlMs);

  const tokenRecord = {
    workspaceId: input.workspaceId,
    tokenHash,
    deliveryIdempotencyKeyHash: input.deliveryIdempotencyKey
      ? hashDeliveryIdempotencyKey(input.deliveryIdempotencyKey)
      : null,
    messengerSenderUserKey: input.messengerSenderUserKey ?? null,
    facebookPageId: input.facebookPageId,
    purpose: input.purpose ?? "workspace_onboarding",
    status: "pending" as const,
    expiresAt,
    createdByUserId: input.createdByUserId ?? null,
  };
  const stored = input.deliveryIdempotencyKey
    ? await db.createOrGetPortalHandoffToken(tokenRecord)
    : await db.createPortalHandoffToken(tokenRecord);
  if (stored.tokenHash !== tokenHash) {
    throw new Error("portal handoff delivery token secret mismatch");
  }
  if (stored.status !== "pending") {
    throw new Error("portal handoff delivery is no longer active");
  }
  if (stored.expiresAt.getTime() <= now.getTime()) {
    throw new Error("portal handoff delivery has expired");
  }

  if (input.createdByUserId) {
    await db.insertAuditLog({
      workspaceId: input.workspaceId,
      userId: input.createdByUserId,
      event: "portal_handoff.created",
      metadata: {
        purpose: input.purpose ?? "workspace_onboarding",
        hasMessengerSenderUserKey: Boolean(input.messengerSenderUserKey),
        expiresAt: stored.expiresAt.toISOString(),
      },
    });
  }

  return {
    token,
    tokenHash,
    expiresAt: stored.expiresAt,
  };
}

export async function consumePortalHandoffToken(
  token: string,
  now = new Date()
): Promise<ConsumePortalHandoffResult> {
  const tokenHash = hashPortalHandoffToken(token);
  const stored = await db.getPortalHandoffTokenByHash(tokenHash);
  if (!stored) {
    return { ok: false, reason: "invalid" };
  }

  if (stored.status !== "pending") {
    return { ok: false, reason: "already_used" };
  }

  if (stored.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: "expired" };
  }

  const consumed = await db.markPortalHandoffTokenConsumed(tokenHash);
  if (!consumed) {
    return { ok: false, reason: "already_used" };
  }

  return {
    ok: true,
    workspaceId: stored.workspaceId,
    purpose: stored.purpose,
    messengerSenderUserKey: stored.messengerSenderUserKey,
  };
}

export async function getPortalHandoffContext(
  token: string,
  now = new Date()
): Promise<PortalHandoffContext | null> {
  const stored = await db.getPortalHandoffTokenByHash(hashPortalHandoffToken(token));
  if (!stored) return null;

  const status =
    stored.status === "pending" && stored.expiresAt.getTime() <= now.getTime()
      ? "expired"
      : stored.status;

  return {
    workspaceId: stored.workspaceId,
    facebookPageId: stored.facebookPageId ?? null,
    messengerSenderUserKey: stored.messengerSenderUserKey ?? null,
    claimedByUserId: stored.claimedByUserId ?? null,
    status,
    expiresAt: stored.expiresAt,
  };
}

export async function claimPortalHandoffToken(
  token: string,
  userId: number,
  now = new Date()
): Promise<ClaimPortalHandoffResult> {
  return db.claimPortalHandoffTokenForUser({
    tokenHash: hashPortalHandoffToken(token),
    userId,
    role: "owner",
    now,
  });
}
