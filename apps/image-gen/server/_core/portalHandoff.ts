import crypto from "node:crypto";
import * as db from "../db";
import { toUserKey } from "./privacy";

const DEFAULT_HANDOFF_TTL_MS = 24 * 60 * 60 * 1000;
const TOKEN_BYTES = 32;

export type PortalHandoffPurpose = "workspace_onboarding";

export type CreatePortalHandoffInput = {
  workspaceId: number;
  purpose?: PortalHandoffPurpose;
  messengerSenderUserKey?: string | null;
  createdByUserId?: number | null;
  now?: Date;
  ttlMs?: number;
};

export type PortalHandoffTokenResult = {
  token: string;
  tokenHash: string;
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

export function hashPortalHandoffToken(token: string): string {
  return `sha256:${crypto.createHash("sha256").update(token).digest("hex")}`;
}

export function hashMessengerSenderForHandoff(senderId: string): string {
  return toUserKey(senderId);
}

function createOpaqueToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

export async function createPortalHandoffToken(
  input: CreatePortalHandoffInput
): Promise<PortalHandoffTokenResult> {
  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? DEFAULT_HANDOFF_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error("portal handoff ttl must be positive");
  }

  const token = createOpaqueToken();
  const tokenHash = hashPortalHandoffToken(token);
  const expiresAt = new Date(now.getTime() + ttlMs);

  await db.createPortalHandoffToken({
    workspaceId: input.workspaceId,
    tokenHash,
    messengerSenderUserKey: input.messengerSenderUserKey ?? null,
    purpose: input.purpose ?? "workspace_onboarding",
    status: "pending",
    expiresAt,
    createdByUserId: input.createdByUserId ?? null,
  });

  if (input.createdByUserId) {
    await db.insertAuditLog({
      workspaceId: input.workspaceId,
      userId: input.createdByUserId,
      event: "portal_handoff.created",
      metadata: {
        purpose: input.purpose ?? "workspace_onboarding",
        hasMessengerSenderUserKey: Boolean(input.messengerSenderUserKey),
        expiresAt: expiresAt.toISOString(),
      },
    });
  }

  return {
    token,
    tokenHash,
    expiresAt,
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
