import { z } from "zod";

import { adminProcedure, router } from "../trpc";
import {
  attestWorkspaceBillingProfile,
  getWorkspaceBillingProfileAttestationStatus,
  revokeWorkspaceBillingProfile,
} from "./billingProfileStore";
import { getConfiguredBillingMode } from "./config";
import {
  disableBillingSchedulerTenant,
  enableBillingSchedulerTenant,
  registerBillingSchedulerTenant,
} from "./billingSchedulerStore";
import {
  acknowledgeOperatorBillingNotification,
  listOperatorBillingNotifications,
} from "./billingNotificationInboxStore";

const workspaceId = z.number().int().positive();

export const billingAdminRouter = router({
  operatorNotifications: adminProcedure
    .input(
      z.object({
        workspaceId,
        limit: z.number().int().min(1).max(50).optional(),
      })
    )
    .query(({ input }) => listOperatorBillingNotifications(input)),

  acknowledgeOperatorNotification: adminProcedure
    .input(
      z.object({
        workspaceId,
        notificationId: z.number().int().positive(),
      })
    )
    .mutation(({ ctx, input }) =>
      acknowledgeOperatorBillingNotification({
        ...input,
        actorUserId: ctx.user.id,
      })
    ),

  profileStatus: adminProcedure
    .input(z.object({ workspaceId }))
    .query(({ input }) =>
      getWorkspaceBillingProfileAttestationStatus(input.workspaceId)
    ),

  attestProfile: adminProcedure
    .input(
      z
        .object({
          requestId: z.uuid(),
          workspaceId,
          expectedVersion: z.number().int().nonnegative(),
          evidenceReference: z
            .string()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,255}$/),
          expiresAt: z.date(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const result = await attestWorkspaceBillingProfile({
        ...input,
        actorUserId: ctx.user.id,
      });
      await registerBillingSchedulerTenant(
        input.workspaceId,
        getConfiguredBillingMode(),
        new Date(),
        new Date(),
        input.expiresAt
      );
      return { success: true, ...result } as const;
    }),

  enableSchedulerTenant: adminProcedure
    .input(
      z.object({
        requestId: z.uuid(),
        workspaceId,
        expectedExecutionEpoch: z.number().int().positive(),
        reason: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _./:-]{7,159}$/),
      })
    )
    .mutation(async ({ ctx, input }) => ({
      success: true as const,
      ...(await enableBillingSchedulerTenant({
        ...input,
        actorUserId: ctx.user.id,
        mode: getConfiguredBillingMode(),
      })),
    })),

  disableSchedulerTenant: adminProcedure
    .input(
      z.object({
        requestId: z.uuid(),
        workspaceId,
        expectedExecutionEpoch: z.number().int().positive(),
        reason: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _./:-]{7,159}$/),
      })
    )
    .mutation(async ({ ctx, input }) => ({
      success: true as const,
      ...(await disableBillingSchedulerTenant({
        ...input,
        actorUserId: ctx.user.id,
        mode: getConfiguredBillingMode(),
      })),
    })),

  revokeProfile: adminProcedure
    .input(
      z.object({
        requestId: z.uuid(),
        workspaceId,
        expectedVersion: z.number().int().positive(),
        reason: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _./:-]{7,159}$/),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const result = await revokeWorkspaceBillingProfile({
        ...input,
        actorUserId: ctx.user.id,
      });
      return { success: true, ...result } as const;
    }),
});
