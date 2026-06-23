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

const privacyRequestInput = workspaceInput.extend({
  requestType: z.enum(["export", "deletion"]),
  note: z.string().trim().max(500).nullable().optional(),
});

const knowledgeSourceInput = workspaceInput.extend({
  sourceType: z.enum(["upload", "website", "manual_text", "integration"]),
  name: z.string().trim().min(1).max(200),
  sourceReference: z.string().trim().max(1024).nullable().optional(),
});

async function requireWorkspace(
  ctx: { user: { id: number; name: string | null } },
  workspaceId?: number
) {
  const { workspace } = await requireWorkspaceMembership(ctx, workspaceId);
  return workspace;
}

async function requireWorkspaceMembership(
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

  return {
    workspace: workspaceId ? workspace : await db.getOrCreateUserWorkspace(ctx.user),
    membership,
  };
}

async function requireCurrentWorkspaceMembership(ctx: {
  user: { id: number; name: string | null };
}) {
  const workspace = await db.getOrCreateUserWorkspace(ctx.user);
  const membership = await db.getWorkspaceMembership(workspace.id, ctx.user.id);

  if (!membership) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "workspace access denied",
    });
  }

  return { workspace, membership };
}

function badRequest(error: unknown, fallback: string) {
  return new TRPCError({
    code: "BAD_REQUEST",
    message: error instanceof Error ? error.message : fallback,
  });
}

function redactChannelAccessToken<T extends { encryptedAccessToken?: unknown }>(
  channel: T
) {
  const { encryptedAccessToken, ...redactedChannel } = channel;
  void encryptedAccessToken;
  return redactedChannel;
}

function redactFacebookPageToken<T extends { accessToken?: unknown }>(page: T) {
  const { accessToken, ...redactedPage } = page;
  void accessToken;
  return redactedPage;
}

export const portalRouter = router({
  auth: router({
    session: protectedProcedure.query(async ({ ctx }) => {
      const { workspace, membership } = await requireCurrentWorkspaceMembership(ctx);
      return {
        user: {
          id: ctx.user.id,
          email: ctx.user.email,
          name: ctx.user.name,
          role: ctx.user.role,
        },
        workspace: {
          id: workspace.id,
          name: workspace.name,
          slug: workspace.slug,
        },
        membership: {
          role: membership.role,
        },
      };
    }),
  }),

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
      return connections.map(redactChannelAccessToken);
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
          pages: pages.map(redactFacebookPageToken),
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

    disconnect: protectedProcedure
      .input(workspaceInput)
      .mutation(async ({ ctx, input }) => {
        await requireWorkspace(ctx, input.workspaceId);
        const connections = await db.listChannelConnections(input.workspaceId);
        const facebook = connections.find(
          connection => connection.channel === "facebook_messenger"
        );
        await db.disconnectChannelConnection(input.workspaceId, "facebook_messenger");
        await db.insertAuditLog({
          workspaceId: input.workspaceId,
          userId: ctx.user.id,
          event: "facebook_page.disconnected",
          metadata: {
            previousStatus: facebook?.status ?? "disconnected",
          },
        });
        return { success: true, status: "disconnected" } as const;
      }),
  }),

  usage: router({
    summary: protectedProcedure.input(workspaceInput).query(async ({ ctx, input }) => {
      await requireWorkspace(ctx, input.workspaceId);
      return db.getWorkspaceUsageSummary(input.workspaceId);
    }),

    requestUpgrade: protectedProcedure
      .input(workspaceInput)
      .mutation(async ({ ctx, input }) => {
        await requireWorkspace(ctx, input.workspaceId);
        const usage = await db.getWorkspaceUsageSummary(input.workspaceId);
        await db.insertAuditLog({
          workspaceId: input.workspaceId,
          userId: ctx.user.id,
          event: "billing_upgrade.requested",
          metadata: {
            planName: usage.plan.name,
            billingStatus: usage.plan.billingStatus,
            upgradeReason: usage.upgrade.reason,
            imagesRemainingToday: usage.remaining.imagesToday,
            blockedToday: usage.blockedCount,
          },
        });
        return {
          success: true,
          status: "requested",
        } as const;
      }),
  }),

  knowledge: router({
    list: protectedProcedure.input(workspaceInput).query(async ({ ctx, input }) => {
      await requireWorkspace(ctx, input.workspaceId);
      return db.listWorkspaceKnowledgeSources(input.workspaceId);
    }),

    summary: protectedProcedure.input(workspaceInput).query(async ({ ctx, input }) => {
      await requireWorkspace(ctx, input.workspaceId);
      return db.getWorkspaceKnowledgeSummary(input.workspaceId);
    }),

    registerSource: protectedProcedure
      .input(knowledgeSourceInput)
      .mutation(async ({ ctx, input }) => {
        await requireWorkspace(ctx, input.workspaceId);
        const source = await db.registerWorkspaceKnowledgeSource(input.workspaceId, {
          sourceType: input.sourceType,
          name: input.name,
          sourceReference: input.sourceReference || null,
        });
        await db.insertAuditLog({
          workspaceId: input.workspaceId,
          userId: ctx.user.id,
          event: "knowledge_source.registered",
          metadata: {
            sourceType: input.sourceType,
            status: source.status,
          },
        });
        return source;
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

    requests: protectedProcedure.input(workspaceInput).query(async ({ ctx, input }) => {
      await requireWorkspace(ctx, input.workspaceId);
      return db.listWorkspacePrivacyRequests(input.workspaceId);
    }),

    createRequest: protectedProcedure
      .input(privacyRequestInput)
      .mutation(async ({ ctx, input }) => {
        await requireWorkspace(ctx, input.workspaceId);
        const request = await db.createWorkspacePrivacyRequest(
          input.workspaceId,
          ctx.user.id,
          {
            requestType: input.requestType,
            note: input.note || null,
          },
          {
            event: "privacy_request.created",
            metadata: {
              requestType: input.requestType,
              status: "requested",
            },
          }
        );
        return request;
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
