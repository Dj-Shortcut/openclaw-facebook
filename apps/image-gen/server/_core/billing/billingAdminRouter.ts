import { z } from "zod";

import { adminProcedure, router } from "../trpc";
import {
  attestWorkspaceBillingProfile,
  revokeWorkspaceBillingProfile,
} from "./billingProfileStore";
import { getConfiguredBillingMode } from "./config";
import {
  disableBillingSchedulerTenant,
  enableBillingSchedulerTenant,
  registerBillingSchedulerTenant,
} from "./billingSchedulerStore";

const workspaceId = z.number().int().positive();

export const billingAdminRouter = router({
  attestProfile: adminProcedure
    .input(
      z.object({
        requestId: z.uuid(),
        workspaceId,
        expectedVersion: z.number().int().nonnegative(),
        countryCode: z.string().regex(/^[A-Z]{2}$/),
        customerType: z.enum(["consumer", "business"]),
        evidenceReference: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,255}$/),
        verificationMethod: z.enum([
          "manual_legal_review",
          "provider_attestation",
        ]),
        expiresAt: z.date(),
        peppolReady: z.boolean().optional(),
      })
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
