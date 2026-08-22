import { z } from "zod";

import {
  listBlockedMessengerPrivacyProviderAttempts,
  reconcileMessengerPrivacyProviderAttempt,
} from "./messengerProviderAttemptFence";
import { adminProcedure, router } from "./trpc";

const positiveInteger = z.number().int().positive();

export const privacyAdminRouter = router({
  blockedProviderAttempts: adminProcedure
    .input(
      z.object({
        workspaceId: positiveInteger,
        limit: z.number().int().min(1).max(100).default(50),
        beforeId: positiveInteger.optional(),
      })
    )
    .query(({ input }) =>
      listBlockedMessengerPrivacyProviderAttempts(
        input.workspaceId,
        input.limit,
        input.beforeId
      )
    ),

  reconcileProviderAttempt: adminProcedure
    .input(
      z.object({
        requestId: z.uuid(),
        attemptKeyHash: z.string().regex(/^[a-f0-9]{64}$/),
        workspaceId: positiveInteger,
        channelConnectionId: positiveInteger,
        expectedBindingEpoch: positiveInteger,
        expectedPrivacyEpoch: positiveInteger,
        expectedAttemptNumber: positiveInteger,
        expectedStatus: z.enum(["started", "ambiguous", "abandoned"]),
        resolution: z.enum(["reconciled_not_accepted", "artifacts_contained"]),
        evidenceReferenceHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
    )
    .mutation(({ ctx, input }) =>
      reconcileMessengerPrivacyProviderAttempt({
        ...input,
        actorUserId: ctx.user.id,
      })
    ),
});
