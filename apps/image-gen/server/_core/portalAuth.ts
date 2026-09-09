import type { Request, Response } from "express";
import * as db from "../db";
import { isFacebookLoginMethod } from "./portalAuthPolicy";
import { sdk } from "./sdk";

type PortalUser = {
  id: number;
  name: string | null;
  loginMethod?: string | null;
};

export async function authenticatePortalRequest(req: Request, res: Response) {
  try {
    const user = await sdk.authenticateRequest(req);
    if (!isFacebookLoginMethod(user.loginMethod)) {
      res.status(403).json({ error: "facebook_login_required" });
      return null;
    }
    return user;
  } catch {
    res.status(401).json({ error: "unauthenticated" });
    return null;
  }
}

export async function requirePortalWorkspace(
  user: PortalUser,
  res: Response,
  workspaceId?: number
) {
  const workspace = workspaceId
    ? { id: workspaceId }
    : await db.getOrCreateUserWorkspace(user);
  const membership = await db.getWorkspaceMembership(workspace.id, user.id);

  if (!membership) {
    res.status(403).json({ error: "workspace access denied" });
    return null;
  }

  return workspaceId ? workspace : db.getOrCreateUserWorkspace(user);
}
