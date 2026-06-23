import { TRPCError } from "@trpc/server";
import { z } from "zod";
import * as db from "../db";
import {
  consumeFacebookPage,
  exchangeFacebookCodeForPages,
  getFacebookOAuthUrl,
  getStoredFacebookState,
  REQUIRED_FACEBOOK_SCOPES,
  sealFacebookPageToken,
  startFacebookConnect,
  storeFacebookPages,
  validateStoredFacebookState,
} from "./facebookConnectStore";
import { protectedProcedure, publicProcedure, router } from "./trpc";

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

const privacyControlsUpdateInput = workspaceInput.extend({
  allowKnowledgeIndexing: z.boolean(),
  allowUsageAnalytics: z.boolean(),
  imageMemoryRetentionDays: z.number().int().min(0).max(365),
});

async function requireWorkspace(
  ctx: { user: { id: number; name: string | null } },
  workspaceId?: number
) {
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

  return workspaceId ? { id: workspaceId } : db.getOrCreateUserWorkspace(ctx.user);
}

function badRequest(error: unknown, fallback: string) {
  return new TRPCError({
    code: "BAD_REQUEST",
    message: error instanceof Error ? error.message : fallback,
  });
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
          metadata: {
            fields: ["name", "instructions", "tone", "language", "modelDefault"],
          },
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
        const state = startFacebookConnect({
          workspaceId: input.workspaceId,
          userId: ctx.user.id,
        });
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
          code: z.string().min(1).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireWorkspace(ctx, input.workspaceId);
        try {
          validateStoredFacebookState({
            state: input.state,
            workspaceId: input.workspaceId,
            userId: ctx.user.id,
          });
        } catch (error) {
          throw badRequest(error, "invalid facebook connect state");
        }

        const code = input.code ?? getStoredFacebookState(input.state)?.authorizationCode;
        if (!code || code !== getStoredFacebookState(input.state)?.authorizationCode) {
          throw badRequest(null, "facebook authorization code missing or mismatched");
        }

        let pages;
        try {
          pages = await exchangeFacebookCodeForPages(code);
        } catch (error) {
          throw badRequest(error, "facebook token exchange failed");
        }

        storeFacebookPages({ state: input.state, pages });
        await db.insertAuditLog({
          workspaceId: input.workspaceId,
          userId: ctx.user.id,
          event: "facebook_connect.completed",
          metadata: { pageCount: pages.length },
        });

        return {
          pages: pages.map(({ accessToken: _token, ...page }) => page),
        };
      }),

    selectPage: protectedProcedure
      .input(
        workspaceInput.extend({
          state: z.string().min(16),
          pageId: z.string().min(1).max(160),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireWorkspace(ctx, input.workspaceId);
        let page;
        try {
          page = consumeFacebookPage({
            state: input.state,
            workspaceId: input.workspaceId,
            userId: ctx.user.id,
            pageId: input.pageId,
          });
        } catch (error) {
          throw badRequest(error, "facebook page was not authorized");
        }

        const hasAllScopes = REQUIRED_FACEBOOK_SCOPES.every(scope =>
          page.grantedScopes.includes(scope)
        );
        await db.upsertChannelConnection({
          workspaceId: input.workspaceId,
          channel: "facebook_messenger",
          status: hasAllScopes ? "connected" : "missing_permissions",
          externalId: page.id,
          displayName: page.name,
          grantedScopes: page.grantedScopes,
          encryptedAccessToken: sealFacebookPageToken(page.accessToken),
          lastCheckedAt: new Date(),
        });
        await db.insertAuditLog({
          workspaceId: input.workspaceId,
          userId: ctx.user.id,
          event: "facebook_page.selected",
          metadata: {
            pageId: page.id,
            pageName: page.name,
            status: hasAllScopes ? "connected" : "missing_permissions",
          },
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

  knowledge: router({
    summary: protectedProcedure.input(workspaceInput).query(async ({ ctx, input }) => {
      await requireWorkspace(ctx, input.workspaceId);
      return db.getWorkspaceKnowledgeSummary(input.workspaceId);
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

    controls: protectedProcedure.input(workspaceInput).query(async ({ ctx, input }) => {
      await requireWorkspace(ctx, input.workspaceId);
      return db.getWorkspacePrivacySettings(input.workspaceId);
    }),

    updateControls: protectedProcedure
      .input(privacyControlsUpdateInput)
      .mutation(async ({ ctx, input }) => {
        await requireWorkspace(ctx, input.workspaceId);
        const updated = await db.updateWorkspacePrivacySettings(input.workspaceId, {
          allowKnowledgeIndexing: input.allowKnowledgeIndexing,
          allowUsageAnalytics: input.allowUsageAnalytics,
          imageMemoryRetentionDays: input.imageMemoryRetentionDays,
        });
        await db.insertAuditLog({
          workspaceId: input.workspaceId,
          userId: ctx.user.id,
          event: "privacy_controls.updated",
          metadata: {
            fields: [
              "allowKnowledgeIndexing",
              "allowUsageAnalytics",
              "imageMemoryRetentionDays",
            ],
          },
        });
        return updated;
      }),
  }),
});
