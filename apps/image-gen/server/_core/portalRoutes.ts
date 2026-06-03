import type { Express, Request, Response } from "express";
import { z } from "zod";
import * as db from "../db";
import {
  getFacebookOAuthUrl,
  REQUIRED_FACEBOOK_SCOPES,
  startFacebookConnect,
  storeFacebookAuthorizationCode,
} from "./facebookConnectStore";
import { sdk } from "./sdk";

const aiIdentityUpdateSchema = z.object({
  workspaceId: z.number().int().positive(),
  name: z.string().trim().min(1).max(120),
  instructions: z.string().trim().max(8000).nullable(),
  tone: z.string().trim().min(1).max(80),
  language: z.string().trim().min(2).max(16),
  modelDefault: z.string().trim().min(1).max(80),
});

const facebookStartSchema = z.object({
  workspaceId: z.number().int().positive(),
});

const facebookCallbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(16),
});

async function getAuthenticatedUser(req: Request, res: Response) {
  try {
    return await sdk.authenticateRequest(req);
  } catch {
    res.status(401).json({ error: "unauthenticated" });
    return null;
  }
}

async function requireWorkspace(
  user: { id: number; name: string | null },
  workspaceId?: number
) {
  const workspace = workspaceId
    ? { id: workspaceId }
    : await db.getOrCreateUserWorkspace(user);
  const membership = await db.getWorkspaceMembership(workspace.id, user.id);
  if (!membership) {
    return null;
  }
  return workspaceId ? workspace : await db.getOrCreateUserWorkspace(user);
}

export function registerPortalRoutes(app: Express) {
  app.get("/api/facebook/connect/callback", (req, res) => {
    const parsed = facebookCallbackSchema.safeParse({
      code: typeof req.query.code === "string" ? req.query.code : undefined,
      state: typeof req.query.state === "string" ? req.query.state : undefined,
    });

    if (
      !parsed.success ||
      !storeFacebookAuthorizationCode({
        state: parsed.data.state,
        code: parsed.data.code,
      })
    ) {
      res.status(400).type("html").send("<h1>Invalid Facebook authorization</h1>");
      return;
    }

    res
      .status(200)
      .type("html")
      .send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Facebook authorization received</title>
  </head>
  <body>
    <h1>Facebook authorization received</h1>
    <p>You can return to Leaderbot to finish selecting the Page.</p>
  </body>
</html>`);
  });

  app.get("/api/portal/snapshot", async (req, res) => {
    const user = await getAuthenticatedUser(req, res);
    if (!user) return;

    const workspace = await requireWorkspace(user);
    if (!workspace) {
      res.status(403).json({ error: "workspace access denied" });
      return;
    }

    const [identity, channels, usage, knowledge, privacySettings] = await Promise.all([
      db.getOrCreateAiIdentity(workspace.id),
      db.listChannelConnections(workspace.id),
      db.getWorkspaceUsageSummary(workspace.id),
      db.getWorkspaceKnowledgeSummary(workspace.id),
      db.getWorkspacePrivacySettings(workspace.id),
    ]);

    res.status(200).json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
      workspace,
      aiIdentity: identity,
      channels: channels.map(({ encryptedAccessToken: _token, ...channel }) => channel),
      usage,
      knowledgeStore: {
        ...knowledge,
      },
      privacy: {
        privacy: "/privacy",
        terms: "/terms",
        dataDeletion: "/data-deletion",
        exportRequest: "mailto:privacy@leaderbot.live?subject=Leaderbot data export",
        deletionRequest: "mailto:privacy@leaderbot.live?subject=Leaderbot data deletion",
        controls: privacySettings,
      },
    });
  });

  app.post("/api/portal/ai-identity", async (req, res) => {
    const user = await getAuthenticatedUser(req, res);
    if (!user) return;

    const parsed = aiIdentityUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid request" });
      return;
    }

    const workspace = await requireWorkspace(user, parsed.data.workspaceId);
    if (!workspace) {
      res.status(403).json({ error: "workspace access denied" });
      return;
    }

    const updated = await db.updateAiIdentity(parsed.data.workspaceId, {
      name: parsed.data.name,
      instructions: parsed.data.instructions,
      tone: parsed.data.tone,
      language: parsed.data.language,
      modelDefault: parsed.data.modelDefault,
    });
    await db.insertAuditLog({
      workspaceId: parsed.data.workspaceId,
      userId: user.id,
      event: "ai_identity.updated",
      metadata: { source: "customer_app" },
    });

    res.status(200).json(updated);
  });

  app.post("/api/portal/facebook/start", async (req, res) => {
    const user = await getAuthenticatedUser(req, res);
    if (!user) return;

    const parsed = facebookStartSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid request" });
      return;
    }

    const workspace = await requireWorkspace(user, parsed.data.workspaceId);
    if (!workspace) {
      res.status(403).json({ error: "workspace access denied" });
      return;
    }

    const state = startFacebookConnect({
      workspaceId: parsed.data.workspaceId,
      userId: user.id,
    });
    await db.insertAuditLog({
      workspaceId: parsed.data.workspaceId,
      userId: user.id,
      event: "facebook_connect.started",
      metadata: { source: "customer_app", scopes: REQUIRED_FACEBOOK_SCOPES },
    });

    res.status(200).json({
      state: state.state,
      authorizationUrl: getFacebookOAuthUrl(state.state),
      requiredScopes: REQUIRED_FACEBOOK_SCOPES,
    });
  });
}
