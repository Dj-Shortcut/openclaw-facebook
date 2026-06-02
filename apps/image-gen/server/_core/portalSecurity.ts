import crypto from "node:crypto";

const FACEBOOK_CONNECT_STATE_TTL_MS = 10 * 60 * 1000;

export type WorkspaceMembership = {
  workspaceId: number;
  userId: number;
};

export type FacebookConnectState = {
  state: string;
  workspaceId: number;
  userId: number;
  createdAt: number;
};

export function assertWorkspaceMembership(
  membership: WorkspaceMembership | null | undefined,
  expected: WorkspaceMembership
) {
  if (
    !membership ||
    membership.workspaceId !== expected.workspaceId ||
    membership.userId !== expected.userId
  ) {
    throw new Error("workspace access denied");
  }
}

export function createFacebookConnectState(input: {
  workspaceId: number;
  userId: number;
  now?: number;
}): FacebookConnectState {
  return {
    state: crypto.randomBytes(24).toString("base64url"),
    workspaceId: input.workspaceId,
    userId: input.userId,
    createdAt: input.now ?? Date.now(),
  };
}

export function validateFacebookConnectState(
  stored: FacebookConnectState | null | undefined,
  expected: {
    state: string;
    workspaceId: number;
    userId: number;
    now?: number;
  }
): FacebookConnectState {
  if (!stored || stored.state !== expected.state) {
    throw new Error("invalid facebook connect state");
  }

  if (
    stored.workspaceId !== expected.workspaceId ||
    stored.userId !== expected.userId
  ) {
    throw new Error("facebook connect state does not match workspace");
  }

  const now = expected.now ?? Date.now();
  if (now - stored.createdAt > FACEBOOK_CONNECT_STATE_TTL_MS) {
    throw new Error("facebook connect state expired");
  }

  return stored;
}
