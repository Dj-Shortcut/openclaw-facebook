export const ACTIVE_WORKSPACE_STORAGE_KEY = "leaderbot.activeWorkspaceId";
export const PENDING_HANDOFF_TOKEN_STORAGE_KEY = "leaderbot.pendingPortalHandoffToken";

function parseWorkspaceId(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function getWorkspaceIdFromLocation(): number | null {
  if (typeof window === "undefined") return null;
  return parseWorkspaceId(new URLSearchParams(window.location.search).get("workspaceId"));
}

export function readActiveWorkspaceId(): number | null {
  if (typeof window === "undefined") return null;
  try {
    return parseWorkspaceId(window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeActiveWorkspaceId(workspaceId: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, String(workspaceId));
  } catch {
    return;
  }
}

export function clearActiveWorkspaceId(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(ACTIVE_WORKSPACE_STORAGE_KEY);
  } catch {
    return;
  }
}

export function readPendingHandoffToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(PENDING_HANDOFF_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writePendingHandoffToken(token: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(PENDING_HANDOFF_TOKEN_STORAGE_KEY, token);
  } catch {
    return;
  }
}

export function clearPendingHandoffToken(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(PENDING_HANDOFF_TOKEN_STORAGE_KEY);
  } catch {
    return;
  }
}
