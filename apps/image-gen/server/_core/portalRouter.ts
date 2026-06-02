import { TRPCError } from "@trpc/server";
import { z } from "zod";
import * as db from "../db";
import {
  createFacebookConnectState,
  validateFacebookConnectState,
  type FacebookConnectState,
} from "./portalSecurity";
import { protectedProcedure, publicProcedure, router } from "./trpc";

const REQUIRED_FACEBOOK_SCOPES = [
  "pages_show_list",
  "pages_manage_metadata",
  "pages_messaging",
] as const;

const facebookConnectStates = new Map<string, FacebookConnectState>();

const workspaceInput = z.object({
  workspaceId: z.number().int().positive(),
});

const aiIdentityUpdateInput = workspaceInput.extend({
  name: z.string().trim().min(1).max(120),
  instructions: z.string().trim().max(8000).nullable(),
  tone: z.string().trim().min(1).max(80),
  language: z.string().trim().min(2).max(16),
  modelDefault: z.string().trim().min(1).max(80),
});

async function requireWorkspace(ctx: { user: { id: number; name: string | null } }, workspaceId?: number) {
  const workspace = workspaceId
    ? { id: workspaceId }
    : await db.getOrCreateUserWorkspace(ctx.user);
  const membership = await db.getWorkspaceMembership(workspace.id, ctx.user.id);

  if (!membership) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "workspace access denied",
    });
  }

  return workspaceId
    ? { id: workspaceId }
    : db.getOrCreateUserWorkspace(ctx.user);
}

function getPortalBaseUrl() {
  return (process.env.PORTAL_BASE_URL ?? process.env.APP_BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");
}

function getFacebookOAuthUrl(state: string) {
  const appId = process.env.FB_APP_ID;
  const redirectUri = `${getPortalBaseUrl()}/api/facebook/connect/callback`;

  if (!appId) {
    return null;
  }

  const url = new URL("https://www.facebook.com/v21.0/dialog/oauth");
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", REQUIRED_FACEBOOK_SCOPES.join(","));
  return url.toString();
}

export const portalRouter = router({
  workspace: router({
    current: protectedProcedure.query(async ({ ctx }) => {
      return db.getOrCreateUserWorkspace(ctx.user);
    }),
  }),

  aiIdentity: router({
    get: protectedProcedure.input(workspaceInput).query(async ({ ctx, input }) => {
      await requireWorkspace(ctx, input.workspaceId);
      return db.getOrCreateAiIdentity(input.workspaceId);
    }),

    update: protectedProcedure
      .input(aiIdentityUpdateInput)
      .mutation(async ({ ctx, input }) => {
        await requireWorkspace(ctx, input.workspaceId);
        const updated = await db.updateAiIdentity(input.workspaceId, {
          name: input.name,
          instructions: input.instructions,
          tone: input.tone,
          language: input.language,
          modelDefault: input.modelDefault,
        });
        await db.insertAuditLog({
          workspaceId: input.workspaceId,
          userId: ctx.user.id,
          event: "ai_identity.updated",
          metadata: { fields: ["name", "instructions", "tone", "language", "modelDefault"] },
        });
        return updated;
      }),
  }),

  channels: router({
    list: protectedProcedure.input(workspaceInput).query(async ({ ctx, input }) => {
      await requireWorkspace(ctx, input.workspaceId);
      const connections = await db.listChannelConnections(input.workspaceId);
      return connections.map(({ encryptedAccessToken: _token, ...connection }) => connection);
    }),

    status: protectedProcedure.input(workspaceInput).query(async ({ ctx, input }) => {
      await requireWorkspace(ctx, input.workspaceId);
      const connections = await db.listChannelConnections(input.workspaceId);
      const facebook = connections.find(
        connection => connection.channel === "facebook_messenger"
      );
      return {
        facebook: facebook
          ? {
              channel: facebook.channel,
              status: facebook.status,
              pageId: facebook.externalId,
              pageName: facebook.displayName,
              lastCheckedAt: facebook.lastCheckedAt,
            }
          : {
              channel: "facebook_messenger" as const,
              status: "disconnected" as const,
              pageId: null,
              pageName: null,
              lastCheckedAt: null,
            },
      };
    }),
  }),

  facebook: router({
    startConnect: protectedProcedure
      .input(workspaceInput)
      .mutation(async ({ ctx, input }) => {
        await requireWorkspace(ctx, input.workspaceId);
        const state = createFacebookConnectState({
          workspaceId: input.workspaceId,
          userId: ctx.user.id,
        });
        facebookConnectStates.set(state.state, state);
        await db.insertAuditLog({
          workspaceId: input.workspaceId,
          userId: ctx.user.id,
          event: "facebook_connect.started",
          metadata: { scopes: REQUIRED_FACEBOOK_SCOPES },
        });

        return {
          state: state.state,
          authorizationUrl: getFacebookOAuthUrl(state.state),
          requiredScopes: REQUIRED_FACEBOOK_SCOPES,
          callbackMode: "hosted" as const,
        };
      }),

    completeConnect: protectedProcedure
      .input(
        workspaceInput.extend({
          state: z.string().min(16),
          code: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireWorkspace(ctx, input.workspaceId);
        const stored = validateFacebookConnectState(
          facebookConnectStates.get(input.state),
          {
            state: input.state,
            workspaceId: input.workspaceId,
            userId: ctx.user.id,
          }
        );
        facebookConnectStates.delete(stored.state);
        await db.insertAuditLog({
          workspaceId: input.workspaceId,
          userId: ctx.user.id,
          event: "facebook_connect.completed",
          metadata: { codeReceived: Boolean(input.code) },
        });

        return {
          pages: [
            {
              id: "pending-meta-exchange",
              name: "Select after Meta token exchange",
              grantedScopes: REQUIRED_FACEBOOK_SCOPES,
            },
          ],
        };
      }),

    selectPage: protectedProcedure
      .input(
        workspaceInput.extend({
          pageId: z.string().min(1).max(160),
          pageName: z.string().min(1).max(255),
          grantedScopes: z.array(z.enum(REQUIRED_FACEBOOK_SCOPES)).min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireWorkspace(ctx, input.workspaceId);
        await db.upsertChannelConnection({
          workspaceId: input.workspaceId,
          channel: "facebook_messenger",
          status:
            input.grantedScopes.length === REQUIRED_FACEBOOK_SCOPES.length
              ? "connected"
              : "missing_permissions",
          externalId: input.pageId,
          displayName: input.pageName,
          grantedScopes: input.grantedScopes,
          encryptedAccessToken: null,
          lastCheckedAt: new Date(),
        });
        await db.insertAuditLog({
          workspaceId: input.workspaceId,
          userId: ctx.user.id,
          event: "facebook_page.selected",
          metadata: { pageId: input.pageId, pageName: input.pageName },
        });
        return { success: true } as const;
      }),
  }),

  usage: router({
    summary: protectedProcedure.input(workspaceInput).query(async ({ ctx, input }) => {
      await requireWorkspace(ctx, input.workspaceId);
      return db.getWorkspaceUsageSummary(input.workspaceId);
    }),
  }),

  privacy: router({
    links: publicProcedure.query(() => ({
      privacy: "/privacy",
      terms: "/terms",
      dataDeletion: "/data-deletion",
      exportRequest: "mailto:privacy@leaderbot.live?subject=Leaderbot data export",
      deletionRequest: "mailto:privacy@leaderbot.live?subject=Leaderbot data deletion",
    })),
  }),
});
