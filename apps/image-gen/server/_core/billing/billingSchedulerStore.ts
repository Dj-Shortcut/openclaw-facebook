import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";

import {
  auditLog,
  billingExecutionControls,
  billingIntents,
  billingOutbox,
  billingProviderOperations,
  billingSchedulerProcessHeartbeats,
  billingSchedulerTenants,
  billingSubscriptions,
} from "../../../drizzle/schema";
import { getDatabaseOrThrow } from "../../db";
import type { MollieMode } from "./config";
import { getBillingSchedulerRollout } from "./config";

const TENANT_LEASE_MS = 15 * 60_000;
export type BillingScheduleKind =
  "outbox" | "reconciliation" | "profile_expiry" | "ai_finalization";
export type BillingProcessKind = BillingScheduleKind | "notification_receiver";

export type BillingTenantLease = Readonly<{
  workspaceId: number;
  mode: MollieMode;
  kind: BillingScheduleKind;
  leaseToken: string;
  executionEpoch: number;
}>;

export type BillingExecutionBoundary = Readonly<{
  workspaceId: number;
  mode: MollieMode;
  authorizationEpoch: number;
  laneEpochs: Readonly<Record<BillingScheduleKind, number>>;
}>;

export async function registerBillingSchedulerTenant(
  workspaceId: number,
  mode: MollieMode,
  nextOutboxAt = new Date(),
  nextReconciliationAt = nextOutboxAt,
  nextProfileExpiryAt?: Date
): Promise<void> {
  const database = await getDatabaseOrThrow();
  const schedules: Array<[BillingScheduleKind, Date]> = [
    ["outbox", nextOutboxAt],
    ["reconciliation", nextReconciliationAt],
    ["profile_expiry", nextProfileExpiryAt ?? nextReconciliationAt],
    ["ai_finalization", nextOutboxAt],
  ];
  await database.transaction(async tx => {
    await tx
      .insert(billingExecutionControls)
      .values({ workspaceId, mode, commercialEnabled: false })
      .onDuplicateKeyUpdate({
        set: { workspaceId: sql`${billingExecutionControls.workspaceId}` },
      });
    for (const [kind, nextDueAt] of schedules) {
      await tx
        .insert(billingSchedulerTenants)
        .values({
          workspaceId,
          mode,
          kind,
          // The outbox remains available as the safety drain for exact
          // cancellation and metadata-only review notifications. Commercial
          // work is fenced independently by billingExecutionControls.
          enabled: kind === "outbox",
          nextDueAt,
        })
        .onDuplicateKeyUpdate({
          // Never undo an explicit disable or move already-due work forward.
          set: {
            nextDueAt: sql`LEAST(${billingSchedulerTenants.nextDueAt}, ${nextDueAt})`,
          },
        });
    }
  });
}

export async function enableBillingSchedulerTenant(input: {
  workspaceId: number;
  mode: MollieMode;
  actorUserId: number;
  requestId: string;
  expectedExecutionEpoch: number;
  reason: string;
}): Promise<{ executionEpoch: number }> {
  if (
    !Number.isSafeInteger(input.workspaceId) ||
    input.workspaceId <= 0 ||
    !Number.isSafeInteger(input.actorUserId) ||
    input.actorUserId <= 0 ||
    !/^[0-9a-f-]{36}$/i.test(input.requestId) ||
    !Number.isSafeInteger(input.expectedExecutionEpoch) ||
    input.expectedExecutionEpoch <= 0 ||
    !/^[A-Za-z0-9][A-Za-z0-9 _./:-]{7,159}$/.test(input.reason)
  ) {
    throw new Error("invalid billing scheduler enable request");
  }
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        "billing-scheduler-enable-v1",
        input.workspaceId,
        input.mode,
        input.actorUserId,
        input.expectedExecutionEpoch,
        input.reason,
      ])
    )
    .digest("hex");
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const controls = await tx
      .select()
      .from(billingExecutionControls)
      .where(
        and(
          eq(billingExecutionControls.workspaceId, input.workspaceId),
          eq(billingExecutionControls.mode, input.mode)
        )
      )
      .limit(1)
      .for("update");
    const control = controls[0];
    if (!control)
      throw new Error("billing execution control is not provisioned");
    const rows = await tx
      .select()
      .from(billingSchedulerTenants)
      .where(
        and(
          eq(billingSchedulerTenants.workspaceId, input.workspaceId),
          eq(billingSchedulerTenants.mode, input.mode)
        )
      )
      .orderBy(asc(billingSchedulerTenants.kind))
      .for("update");
    if (rows.length !== 4 || new Set(rows.map(row => row.kind)).size !== 4) {
      throw new Error("billing scheduler tenant is not provisioned");
    }
    const replay = rows.every(
      row =>
        row.operatorRequestId === input.requestId &&
        row.operatorRequestFingerprint === fingerprint &&
        row.enabled
    );
    if (replay && control.commercialEnabled) {
      return { executionEpoch: control.authorizationEpoch };
    }
    if (rows.some(row => row.operatorRequestId === input.requestId)) {
      throw new Error("billing scheduler enable request conflicts");
    }
    if (
      rows.some(
        row =>
          (row.kind !== "outbox" && row.enabled) ||
          row.executionEpoch !== input.expectedExecutionEpoch
      ) ||
      control.commercialEnabled ||
      control.authorizationEpoch !== input.expectedExecutionEpoch
    ) {
      throw new Error("billing scheduler enable epoch mismatch");
    }
    const now = new Date();
    const resultingEpoch = input.expectedExecutionEpoch + 1;
    const controlResult = await tx
      .update(billingExecutionControls)
      .set({ commercialEnabled: true, authorizationEpoch: resultingEpoch })
      .where(
        and(
          eq(billingExecutionControls.workspaceId, input.workspaceId),
          eq(billingExecutionControls.mode, input.mode),
          eq(billingExecutionControls.commercialEnabled, false),
          eq(
            billingExecutionControls.authorizationEpoch,
            input.expectedExecutionEpoch
          )
        )
      );
    if (extractAffectedRows(controlResult) !== 1) {
      throw new Error("billing execution enable fence was lost");
    }
    const result = await tx
      .update(billingSchedulerTenants)
      .set({
        enabled: true,
        executionEpoch: resultingEpoch,
        operatorRequestId: input.requestId,
        operatorRequestFingerprint: fingerprint,
        enabledByUserId: input.actorUserId,
        enabledAt: now,
      })
      .where(
        and(
          eq(billingSchedulerTenants.workspaceId, input.workspaceId),
          eq(billingSchedulerTenants.mode, input.mode),
          eq(
            billingSchedulerTenants.executionEpoch,
            input.expectedExecutionEpoch
          )
        )
      );
    if (extractAffectedRows(result) !== 4) {
      throw new Error("billing scheduler enable fence was lost");
    }
    await tx.insert(auditLog).values({
      workspaceId: input.workspaceId,
      userId: input.actorUserId,
      event: "billing_scheduler_enabled",
      metadata: {
        mode: input.mode,
        requestId: input.requestId,
        previousExecutionEpoch: input.expectedExecutionEpoch,
        resultingExecutionEpoch: resultingEpoch,
        reason: input.reason,
      },
    });
    return { executionEpoch: resultingEpoch };
  });
}

export async function disableBillingSchedulerTenant(input: {
  workspaceId: number;
  mode: MollieMode;
  actorUserId: number;
  requestId: string;
  expectedExecutionEpoch: number;
  reason: string;
}): Promise<{ executionEpoch: number }> {
  if (
    !Number.isSafeInteger(input.workspaceId) ||
    input.workspaceId <= 0 ||
    !Number.isSafeInteger(input.actorUserId) ||
    input.actorUserId <= 0 ||
    !/^[0-9a-f-]{36}$/i.test(input.requestId) ||
    !Number.isSafeInteger(input.expectedExecutionEpoch) ||
    input.expectedExecutionEpoch <= 0 ||
    !/^[A-Za-z0-9][A-Za-z0-9 _./:-]{7,159}$/.test(input.reason)
  ) {
    throw new Error("invalid billing scheduler disable request");
  }
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        "billing-scheduler-disable-v1",
        input.workspaceId,
        input.mode,
        input.actorUserId,
        input.expectedExecutionEpoch,
        input.reason,
      ])
    )
    .digest("hex");
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const controls = await tx
      .select()
      .from(billingExecutionControls)
      .where(
        and(
          eq(billingExecutionControls.workspaceId, input.workspaceId),
          eq(billingExecutionControls.mode, input.mode)
        )
      )
      .limit(1)
      .for("update");
    const control = controls[0];
    if (!control)
      throw new Error("billing execution control is not provisioned");
    // Canonical order is execution control -> intent -> scheduler. Outbox
    // triggers also touch the scheduler row, while profile revoke/expiry lock
    // profile -> intent before inserting outbox work.
    await tx
      .select({ intentId: billingIntents.intentId })
      .from(billingIntents)
      .where(
        and(
          eq(billingIntents.workspaceId, input.workspaceId),
          eq(billingIntents.mode, input.mode)
        )
      )
      .for("update");
    const rows = await tx
      .select()
      .from(billingSchedulerTenants)
      .where(
        and(
          eq(billingSchedulerTenants.workspaceId, input.workspaceId),
          eq(billingSchedulerTenants.mode, input.mode)
        )
      )
      .orderBy(asc(billingSchedulerTenants.kind))
      .for("update");
    if (rows.length !== 4 || new Set(rows.map(row => row.kind)).size !== 4) {
      throw new Error("billing scheduler tenant is not provisioned");
    }
    const replay = rows.every(
      row =>
        row.operatorRequestId === input.requestId &&
        row.operatorRequestFingerprint === fingerprint &&
        (row.kind === "outbox" ? row.enabled : !row.enabled)
    );
    if (replay && !control.commercialEnabled) {
      return { executionEpoch: control.authorizationEpoch };
    }
    if (rows.some(row => row.operatorRequestId === input.requestId)) {
      throw new Error("billing scheduler disable request conflicts");
    }
    if (
      rows.some(
        row =>
          !row.enabled || row.executionEpoch !== input.expectedExecutionEpoch
      ) ||
      !control.commercialEnabled ||
      control.authorizationEpoch !== input.expectedExecutionEpoch
    ) {
      throw new Error("billing scheduler disable epoch mismatch");
    }
    const now = new Date();
    const resultingEpoch = input.expectedExecutionEpoch + 1;
    const controlResult = await tx
      .update(billingExecutionControls)
      .set({ commercialEnabled: false, authorizationEpoch: resultingEpoch })
      .where(
        and(
          eq(billingExecutionControls.workspaceId, input.workspaceId),
          eq(billingExecutionControls.mode, input.mode),
          eq(billingExecutionControls.commercialEnabled, true),
          eq(
            billingExecutionControls.authorizationEpoch,
            input.expectedExecutionEpoch
          )
        )
      );
    if (extractAffectedRows(controlResult) !== 1) {
      throw new Error("billing execution disable fence was lost");
    }
    const result = await tx
      .update(billingSchedulerTenants)
      .set({
        enabled: sql`${billingSchedulerTenants.kind} = 'outbox'`,
        executionEpoch: resultingEpoch,
        leaseToken: null,
        leaseUntil: null,
        operatorRequestId: input.requestId,
        operatorRequestFingerprint: fingerprint,
        enabledByUserId: input.actorUserId,
        enabledAt: sql`IF(${billingSchedulerTenants.kind} = 'outbox', ${billingSchedulerTenants.enabledAt}, NULL)`,
        nextDueAt: sql`IF(${billingSchedulerTenants.kind} = 'outbox', LEAST(${billingSchedulerTenants.nextDueAt}, ${now}), ${billingSchedulerTenants.nextDueAt})`,
      })
      .where(
        and(
          eq(billingSchedulerTenants.workspaceId, input.workspaceId),
          eq(billingSchedulerTenants.mode, input.mode),
          eq(
            billingSchedulerTenants.executionEpoch,
            input.expectedExecutionEpoch
          )
        )
      );
    if (extractAffectedRows(result) !== 4) {
      throw new Error("billing scheduler disable fence was lost");
    }
    const intents = await tx
      .select({
        intentId: billingIntents.intentId,
        molliePaymentId: billingIntents.molliePaymentId,
      })
      .from(billingIntents)
      .where(
        and(
          eq(billingIntents.workspaceId, input.workspaceId),
          eq(billingIntents.mode, input.mode),
          inArray(billingIntents.status, [
            "created",
            "creating_payment",
            "open",
            "api_unknown",
          ])
        )
      )
      .for("update");
    await tx
      .update(billingIntents)
      .set({ status: "contained" })
      .where(
        and(
          eq(billingIntents.workspaceId, input.workspaceId),
          eq(billingIntents.mode, input.mode),
          inArray(billingIntents.status, [
            "created",
            "creating_payment",
            "open",
            "api_unknown",
          ])
        )
      );
    for (const intent of intents) {
      if (!intent.molliePaymentId) continue;
      await tx
        .insert(billingOutbox)
        .values({
          workspaceId: input.workspaceId,
          mode: input.mode,
          eventType: "cancel_payment",
          deduplicationKey: `execution_disabled_payment:${intent.molliePaymentId}`,
          payload: {
            reason: "billing_execution_disabled",
            intentId: intent.intentId,
            targetPaymentId: intent.molliePaymentId,
          },
          status: "pending",
        })
        .onDuplicateKeyUpdate({
          set: { deduplicationKey: sql`deduplication_key` },
        });
    }
    const revokedOperations = await tx
      .select({
        operationId: billingProviderOperations.operationId,
        operationType: billingProviderOperations.operationType,
        intentId: billingProviderOperations.intentId,
        state: billingProviderOperations.state,
        providerResourceId: billingProviderOperations.providerResourceId,
        providerCustomerId: billingProviderOperations.providerCustomerId,
      })
      .from(billingProviderOperations)
      .where(
        and(
          eq(billingProviderOperations.workspaceId, input.workspaceId),
          eq(billingProviderOperations.mode, input.mode),
          eq(
            billingProviderOperations.authorizationEpoch,
            input.expectedExecutionEpoch
          ),
          inArray(billingProviderOperations.operationType, [
            "create_payment",
            "create_subscription",
          ]),
          inArray(billingProviderOperations.state, [
            "succeeded",
            "transport_started",
            "ambiguous",
            "reconciliation_only",
          ])
        )
      )
      .for("update");
    for (const operation of revokedOperations) {
      const isPayment = operation.operationType === "create_payment";
      if (
        operation.state === "succeeded" &&
        operation.providerResourceId &&
        operation.providerCustomerId
      ) {
        const contained = await tx
          .update(billingProviderOperations)
          .set({ state: "contained", resolutionDueAt: now })
          .where(
            and(
              eq(billingProviderOperations.operationId, operation.operationId),
              eq(billingProviderOperations.workspaceId, input.workspaceId),
              eq(billingProviderOperations.mode, input.mode),
              eq(billingProviderOperations.state, "succeeded"),
              eq(
                billingProviderOperations.authorizationEpoch,
                input.expectedExecutionEpoch
              )
            )
          );
        if (extractAffectedRows(contained) !== 1) {
          throw new Error("billing provider containment fence was lost");
        }
        await tx
          .insert(billingOutbox)
          .values({
            workspaceId: input.workspaceId,
            mode: input.mode,
            eventType: isPayment ? "cancel_payment" : "cancel_subscription",
            deduplicationKey: `execution_disabled_${isPayment ? "payment" : "subscription"}:${operation.providerResourceId}`,
            payload: isPayment
              ? {
                  reason: "billing_execution_disabled",
                  intentId: operation.intentId,
                  targetCustomerId: operation.providerCustomerId,
                  targetPaymentId: operation.providerResourceId,
                  revokedAuthorizationEpoch: input.expectedExecutionEpoch,
                }
              : {
                  reason: "billing_execution_disabled",
                  expectedSourceIntentId: operation.intentId,
                  targetCustomerId: operation.providerCustomerId,
                  targetSubscriptionId: operation.providerResourceId,
                  revokedAuthorizationEpoch: input.expectedExecutionEpoch,
                },
            status: "pending",
          })
          .onDuplicateKeyUpdate({
            set: { deduplicationKey: sql`deduplication_key` },
          });
        continue;
      }
      if (operation.providerCustomerId) {
        await tx
          .insert(billingOutbox)
          .values({
            workspaceId: input.workspaceId,
            mode: input.mode,
            eventType: isPayment ? "cancel_payment" : "cancel_subscription",
            deduplicationKey: `${isPayment ? "payment" : "subscription"}_ambiguous_reconcile:${operation.operationId}`,
            payload: isPayment
              ? {
                  reason: "billing_execution_disabled",
                  intentId: operation.intentId,
                  targetCustomerId: operation.providerCustomerId,
                  targetPaymentId: null,
                  providerOperationId: operation.operationId,
                  revokedAuthorizationEpoch: input.expectedExecutionEpoch,
                }
              : {
                  reason: "billing_execution_disabled",
                  expectedSourceIntentId: operation.intentId,
                  targetCustomerId: operation.providerCustomerId,
                  targetSubscriptionId: null,
                  providerOperationId: operation.operationId,
                  revokedAuthorizationEpoch: input.expectedExecutionEpoch,
                },
            status: "pending",
          })
          .onDuplicateKeyUpdate({
            set: { deduplicationKey: sql`deduplication_key` },
          });
      }
      await tx
        .insert(billingOutbox)
        .values({
          workspaceId: input.workspaceId,
          mode: input.mode,
          eventType: "manual_review",
          deduplicationKey: `provider_ambiguous_after_disable:${operation.operationId}`,
          payload: {
            reason: isPayment
              ? "payment_provider_ambiguous_after_disable"
              : "subscription_provider_ambiguous_after_disable",
            intentId: operation.intentId,
          },
          status: "pending",
        })
        .onDuplicateKeyUpdate({
          set: { deduplicationKey: sql`deduplication_key` },
        });
    }
    const subscriptions = await tx
      .select({
        sourceIntentId: billingSubscriptions.sourceIntentId,
        mollieCustomerId: billingSubscriptions.mollieCustomerId,
        mollieSubscriptionId: billingSubscriptions.mollieSubscriptionId,
      })
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.workspaceId, input.workspaceId),
          eq(billingSubscriptions.mode, input.mode),
          eq(billingSubscriptions.status, "provisioning")
        )
      )
      .for("update");
    for (const subscription of subscriptions) {
      if (!subscription.mollieSubscriptionId) continue;
      await tx
        .insert(billingOutbox)
        .values({
          workspaceId: input.workspaceId,
          mode: input.mode,
          eventType: "cancel_subscription",
          deduplicationKey: `execution_disabled_subscription:${subscription.mollieSubscriptionId}`,
          payload: {
            reason: "billing_execution_disabled",
            revokedAuthorizationEpoch: input.expectedExecutionEpoch,
            expectedSourceIntentId: subscription.sourceIntentId,
            targetCustomerId: subscription.mollieCustomerId,
            targetSubscriptionId: subscription.mollieSubscriptionId,
          },
          status: "pending",
        })
        .onDuplicateKeyUpdate({
          set: { deduplicationKey: sql`deduplication_key` },
        });
    }
    await tx.insert(auditLog).values({
      workspaceId: input.workspaceId,
      userId: input.actorUserId,
      event: "billing_scheduler_disabled",
      metadata: {
        mode: input.mode,
        requestId: input.requestId,
        previousExecutionEpoch: input.expectedExecutionEpoch,
        resultingExecutionEpoch: resultingEpoch,
        reason: input.reason,
      },
    });
    return { executionEpoch: resultingEpoch };
  });
}

/** Wake an already-provisioned scheduler tenant without creating or enabling it. */
export async function wakeBillingSchedulerTenant(
  workspaceId: number,
  mode: MollieMode,
  nextAt = new Date()
): Promise<boolean> {
  const database = await getDatabaseOrThrow();
  const result = await database
    .update(billingSchedulerTenants)
    .set({
      nextDueAt: sql`LEAST(${billingSchedulerTenants.nextDueAt}, ${nextAt})`,
    })
    .where(
      and(
        eq(billingSchedulerTenants.workspaceId, workspaceId),
        eq(billingSchedulerTenants.mode, mode),
        eq(billingSchedulerTenants.kind, "outbox"),
        eq(billingSchedulerTenants.enabled, true)
      )
    );
  return extractAffectedRows(result) === 1;
}

export async function wakeAiFinalizationTenant(
  workspaceId: number,
  mode: MollieMode,
  nextAt: Date
): Promise<boolean> {
  const database = await getDatabaseOrThrow();
  const result = await database
    .update(billingSchedulerTenants)
    .set({
      nextDueAt: sql`LEAST(${billingSchedulerTenants.nextDueAt}, ${nextAt})`,
    })
    .where(
      and(
        eq(billingSchedulerTenants.workspaceId, workspaceId),
        eq(billingSchedulerTenants.mode, mode),
        eq(billingSchedulerTenants.kind, "ai_finalization"),
        eq(billingSchedulerTenants.enabled, true)
      )
    );
  return extractAffectedRows(result) === 1;
}

export async function assertBillingSchedulerTenantEnabled(
  workspaceId: number,
  mode: MollieMode
): Promise<BillingExecutionBoundary> {
  const pinnedWorkspaceId = getBillingSchedulerRollout().pinnedWorkspaceId;
  if (pinnedWorkspaceId && pinnedWorkspaceId !== workspaceId) {
    throw new Error("billing scheduler tenant is outside the pilot boundary");
  }
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const controls = await tx
      .select({
        commercialEnabled: billingExecutionControls.commercialEnabled,
        authorizationEpoch: billingExecutionControls.authorizationEpoch,
      })
      .from(billingExecutionControls)
      .where(
        and(
          eq(billingExecutionControls.workspaceId, workspaceId),
          eq(billingExecutionControls.mode, mode)
        )
      )
      .limit(1)
      .for("update");
    const control = controls[0];
    if (!control?.commercialEnabled) {
      throw new Error("billing commercial execution is disabled");
    }
    const rows = await tx
      .select({
        kind: billingSchedulerTenants.kind,
        executionEpoch: billingSchedulerTenants.executionEpoch,
      })
      .from(billingSchedulerTenants)
      .where(
        and(
          eq(billingSchedulerTenants.workspaceId, workspaceId),
          eq(billingSchedulerTenants.mode, mode),
          eq(billingSchedulerTenants.enabled, true)
        )
      )
      .for("update");
    if (
      new Set(rows.map(row => row.kind)).size !== 4 ||
      rows.some(row => row.executionEpoch !== control.authorizationEpoch)
    ) {
      throw new Error("billing scheduler tenant is not enabled");
    }
    return {
      workspaceId,
      mode,
      authorizationEpoch: control.authorizationEpoch,
      laneEpochs: Object.freeze(
        Object.fromEntries(
          rows.map(row => [row.kind, row.executionEpoch])
        ) as Record<BillingScheduleKind, number>
      ),
    };
  });
}

export async function assertBillingExecutionBoundary(
  boundary: BillingExecutionBoundary
): Promise<void> {
  const current = await assertBillingSchedulerTenantEnabled(
    boundary.workspaceId,
    boundary.mode
  );
  if (current.authorizationEpoch !== boundary.authorizationEpoch) {
    throw new Error("billing authorization epoch changed");
  }
  for (const kind of Object.keys(
    boundary.laneEpochs
  ) as BillingScheduleKind[]) {
    if (current.laneEpochs[kind] !== boundary.laneEpochs[kind]) {
      throw new Error("billing scheduler execution boundary changed");
    }
  }
}

export async function claimNextBillingTenant(
  mode: MollieMode,
  now = new Date(),
  kind: BillingScheduleKind = "outbox"
): Promise<BillingTenantLease | null> {
  const rollout = getBillingSchedulerRollout();
  const pinnedWorkspaceId = rollout.pinnedWorkspaceId;
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const rows = await tx
      .select({
        workspaceId: billingSchedulerTenants.workspaceId,
        executionEpoch: billingSchedulerTenants.executionEpoch,
      })
      .from(billingSchedulerTenants)
      .where(
        and(
          eq(billingSchedulerTenants.mode, mode),
          eq(billingSchedulerTenants.kind, kind),
          eq(billingSchedulerTenants.enabled, true),
          lte(billingSchedulerTenants.nextDueAt, now),
          ...(pinnedWorkspaceId
            ? [eq(billingSchedulerTenants.workspaceId, pinnedWorkspaceId)]
            : []),
          or(
            isNull(billingSchedulerTenants.leaseToken),
            lte(billingSchedulerTenants.leaseUntil, now)
          )
        )
      )
      .orderBy(
        asc(billingSchedulerTenants.lastServedAt),
        asc(billingSchedulerTenants.nextDueAt),
        asc(billingSchedulerTenants.workspaceId)
      )
      .limit(1)
      .for("update", { skipLocked: true });
    const workspaceId = rows[0]?.workspaceId;
    const executionEpoch = rows[0]?.executionEpoch;
    if (!workspaceId || !executionEpoch) return null;
    const leaseToken = randomUUID();
    await tx
      .update(billingSchedulerTenants)
      .set({
        leaseToken,
        leaseUntil: new Date(now.getTime() + TENANT_LEASE_MS),
      })
      .where(
        and(
          eq(billingSchedulerTenants.workspaceId, workspaceId),
          eq(billingSchedulerTenants.mode, mode),
          eq(billingSchedulerTenants.kind, kind),
          eq(billingSchedulerTenants.enabled, true),
          eq(billingSchedulerTenants.executionEpoch, executionEpoch),
          ...(pinnedWorkspaceId
            ? [eq(billingSchedulerTenants.workspaceId, pinnedWorkspaceId)]
            : []),
          or(
            isNull(billingSchedulerTenants.leaseToken),
            lte(billingSchedulerTenants.leaseUntil, now)
          )
        )
      );
    const claimed = await tx
      .select({ workspaceId: billingSchedulerTenants.workspaceId })
      .from(billingSchedulerTenants)
      .where(
        and(
          eq(billingSchedulerTenants.workspaceId, workspaceId),
          eq(billingSchedulerTenants.mode, mode),
          eq(billingSchedulerTenants.kind, kind),
          eq(billingSchedulerTenants.leaseToken, leaseToken),
          eq(billingSchedulerTenants.executionEpoch, executionEpoch)
        )
      )
      .limit(1);
    return claimed[0]
      ? { workspaceId, mode, kind, leaseToken, executionEpoch }
      : null;
  });
}

/** Records one process-level dispatcher heartbeat regardless of tenant count. */
export async function recordBillingSchedulerPoll(
  mode: MollieMode,
  kind: BillingProcessKind,
  now = new Date()
): Promise<number> {
  void getBillingSchedulerRollout();
  const processId =
    process.env.FLY_MACHINE_ID?.trim() ||
    process.env.BILLING_SCHEDULER_PROCESS_ID?.trim() ||
    "";
  if (!/^[A-Za-z0-9._:-]{3,96}$/.test(processId)) {
    throw new Error("Billing scheduler process identity is missing or invalid");
  }
  const database = await getDatabaseOrThrow();
  await database
    .insert(billingSchedulerProcessHeartbeats)
    .values({ processId, mode, kind, status: "polling", lastPollAt: now })
    .onDuplicateKeyUpdate({
      set: { status: "polling", lastPollAt: now },
    });
  return 1;
}

export async function renewBillingTenantLease(
  lease: BillingTenantLease,
  now = new Date()
): Promise<boolean> {
  const database = await getDatabaseOrThrow();
  const result = await database
    .update(billingSchedulerTenants)
    .set({
      leaseUntil: new Date(now.getTime() + TENANT_LEASE_MS),
    })
    .where(
      and(
        eq(billingSchedulerTenants.workspaceId, lease.workspaceId),
        eq(billingSchedulerTenants.mode, lease.mode),
        eq(billingSchedulerTenants.kind, lease.kind),
        eq(billingSchedulerTenants.enabled, true),
        eq(billingSchedulerTenants.leaseToken, lease.leaseToken),
        eq(billingSchedulerTenants.executionEpoch, lease.executionEpoch),
        gt(billingSchedulerTenants.leaseUntil, now)
      )
    );
  const metadata = Array.isArray(result) ? result[0] : result;
  return (
    Number((metadata as { affectedRows?: number })?.affectedRows ?? 0) === 1
  );
}

export async function assertBillingTenantLeaseOwned(
  lease: BillingTenantLease,
  now = new Date()
): Promise<void> {
  const database = await getDatabaseOrThrow();
  const rows = await database
    .select({ workspaceId: billingSchedulerTenants.workspaceId })
    .from(billingSchedulerTenants)
    .where(
      and(
        eq(billingSchedulerTenants.workspaceId, lease.workspaceId),
        eq(billingSchedulerTenants.mode, lease.mode),
        eq(billingSchedulerTenants.kind, lease.kind),
        eq(billingSchedulerTenants.enabled, true),
        eq(billingSchedulerTenants.leaseToken, lease.leaseToken),
        eq(billingSchedulerTenants.executionEpoch, lease.executionEpoch),
        gt(billingSchedulerTenants.leaseUntil, now)
      )
    )
    .limit(1);
  if (!rows[0]) throw new Error("billing scheduler lease ownership was lost");
}

export async function releaseBillingTenantLease(input: {
  workspaceId: number;
  mode: MollieMode;
  kind: BillingScheduleKind;
  leaseToken: string;
  executionEpoch: number;
  nextAt: Date;
  failed: boolean;
  now?: Date;
}): Promise<boolean> {
  const database = await getDatabaseOrThrow();
  const now = input.now ?? new Date();
  const result = await database
    .update(billingSchedulerTenants)
    .set({
      leaseToken: null,
      leaseUntil: null,
      lastServedAt: now,
      nextDueAt: input.failed
        ? sql`DATE_ADD(${now}, INTERVAL LEAST(3600, ${input.kind === "reconciliation" ? 60 : 5} * POW(2, LEAST(10, ${billingSchedulerTenants.consecutiveFailures}))) SECOND)`
        : input.nextAt,
      consecutiveFailures: input.failed
        ? sql`${billingSchedulerTenants.consecutiveFailures} + 1`
        : 0,
    })
    .where(
      and(
        eq(billingSchedulerTenants.workspaceId, input.workspaceId),
        eq(billingSchedulerTenants.mode, input.mode),
        eq(billingSchedulerTenants.kind, input.kind),
        eq(billingSchedulerTenants.enabled, true),
        eq(billingSchedulerTenants.leaseToken, input.leaseToken),
        eq(billingSchedulerTenants.executionEpoch, input.executionEpoch),
        gt(billingSchedulerTenants.leaseUntil, now)
      )
    );
  return extractAffectedRows(result) === 1;
}

function extractAffectedRows(result: unknown): number {
  const metadata: unknown = Array.isArray(result)
    ? (result as unknown[])[0]
    : result;
  return Number((metadata as { affectedRows?: number })?.affectedRows ?? 0);
}
