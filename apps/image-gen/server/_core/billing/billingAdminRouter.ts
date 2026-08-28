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
import {
  listOpenCreditReservationTransportReviews,
  resolveAmbiguousPaidCreditReservation,
} from "./creditReservationOperatorResolution";

const workspaceId = z.number().int().positive();
const operatorReservationResolution = z
  .object({
    requestId: z.uuid(),
    workspaceId,
    mode: z.enum(["test", "live"]),
    reservationId: z.uuid(),
    walletId: z.uuid(),
    decision: z.enum([
      "delivered_output",
      "output_not_delivered",
      "provider_rejected",
    ]),
    providerStatus: z.number().int().min(200).max(499).optional(),
    evidenceReference: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,255}$/),
  })
  .strict()
  .superRefine((input, context) => {
    const delivered =
      input.decision === "delivered_output" &&
      input.providerStatus !== undefined &&
      input.providerStatus >= 200 &&
      input.providerStatus <= 299;
    const outputNotDelivered =
      input.decision === "output_not_delivered" &&
      (input.providerStatus === undefined ||
        (input.providerStatus >= 200 && input.providerStatus <= 299));
    const rejected =
      input.decision === "provider_rejected" &&
      input.providerStatus !== undefined &&
      input.providerStatus >= 400 &&
      input.providerStatus <= 499 &&
      input.providerStatus !== 408 &&
      input.providerStatus !== 429;
    if (!delivered && !outputNotDelivered && !rejected) {
      context.addIssue({
        code: "custom",
        path: ["providerStatus"],
        message: "Provider proof does not match the operator decision",
      });
    }
  });

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

  creditReservationTransportReviews: adminProcedure
    .input(
      z.object({
        workspaceId,
        mode: z.enum(["test", "live"]),
        limit: z.number().int().min(1).max(50).optional(),
      })
    )
    .query(({ input }) => listOpenCreditReservationTransportReviews(input)),

  resolveCreditReservationTransport: adminProcedure
    .input(operatorReservationResolution)
    .mutation(({ ctx, input }) =>
      resolveAmbiguousPaidCreditReservation({
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
