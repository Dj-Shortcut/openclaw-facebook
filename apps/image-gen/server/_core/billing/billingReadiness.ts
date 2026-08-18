import { and, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";

import {
  billingAccountingEventLinks,
  billingAccountingImportCursors,
  billingAccountingImportRuns,
  billingAccountingProviderEvents,
  billingOutbox,
  billingExecutionControls,
  billingSchedulerProcessHeartbeats,
  billingProviderOperations,
  billingIntents,
  billingWebhookRoutes,
  billingNotificationInbox,
  billingNotificationSchedulerTenants,
  billingNotificationReceipts,
  billingNotificationReceiverOutbox,
  billingSchedulerTenants,
  messengerPrivacySubjects,
  messengerProviderAttemptFences,
  workspaceBillingProfiles,
  workspaceEntitlementUsageReservations,
} from "../../../drizzle/schema";
import { getDatabaseOrThrow } from "../../db";
import type { MollieMode } from "./config";
import {
  getBillingSchedulerRollout,
  getTenantBillingWorkerWorkspaceId,
} from "./config";

type SchedulerControlReadinessRow = Readonly<{
  workspaceId: number;
  commercialEnabled: boolean;
  authorizationEpoch: number;
}>;

type SchedulerLaneReadinessRow = Readonly<{
  workspaceId: number;
  kind: "outbox" | "reconciliation" | "profile_expiry" | "ai_finalization";
  enabled: boolean;
  executionEpoch: number;
  operatorRequestId: string | null;
  enabledByUserId: number | null;
  enabledAt: Date | null;
  deadLetterCount: number;
}>;

export function assertBillingSchedulerRegistryCoherence(
  controls: readonly SchedulerControlReadinessRow[],
  lanes: readonly SchedulerLaneReadinessRow[]
): void {
  if (controls.length === 0) {
    throw new Error(
      "No billing execution control is provisioned for this mode"
    );
  }
  for (const control of controls) {
    const tenantLanes = lanes.filter(
      lane => lane.workspaceId === control.workspaceId
    );
    const expectedKinds = new Set([
      "outbox",
      "reconciliation",
      "profile_expiry",
      "ai_finalization",
    ]);
    if (
      tenantLanes.length !== 4 ||
      new Set(tenantLanes.map(lane => lane.kind)).size !== 4 ||
      tenantLanes.some(lane => !expectedKinds.has(lane.kind)) ||
      tenantLanes.some(
        lane => lane.executionEpoch !== control.authorizationEpoch
      )
    ) {
      throw new Error("Billing scheduler execution epochs are incoherent");
    }
    for (const lane of tenantLanes) {
      const shouldBeEnabled =
        control.commercialEnabled || lane.kind === "outbox";
      if (lane.enabled !== shouldBeEnabled) {
        throw new Error("Billing scheduler lane enablement is incoherent");
      }
      if (lane.enabled && Number(lane.deadLetterCount) > 0) {
        throw new Error("Billing scheduler has unresolved dead letters");
      }
      if (
        control.commercialEnabled &&
        (!lane.operatorRequestId ||
          !lane.enabledByUserId ||
          !lane.enabledAt ||
          lane.executionEpoch <= 1)
      ) {
        throw new Error("Billing scheduler commercial audit gate is not ready");
      }
    }
  }
}

/**
 * Verifies the credential-free schema and scheduler execution boundary.
 * Schema probes use impossible predicates and therefore read no tenant rows.
 */
export async function assertBillingDatabaseReadiness(
  mode: MollieMode,
  options: { requireRuntimeHeartbeat?: boolean } = {}
): Promise<void> {
  const database = await getDatabaseOrThrow();
  await Promise.all([
    database
      .select({
        workspaceId: billingNotificationSchedulerTenants.workspaceId,
        mode: billingNotificationSchedulerTenants.mode,
        nextDueAt: billingNotificationSchedulerTenants.nextDueAt,
        deadLetterCount: billingNotificationSchedulerTenants.deadLetterCount,
      })
      .from(billingNotificationSchedulerTenants)
      .where(sql`1 = 0`),
    database
      .select({
        processId: billingSchedulerProcessHeartbeats.processId,
        kind: billingSchedulerProcessHeartbeats.kind,
        status: billingSchedulerProcessHeartbeats.status,
        lastPollAt: billingSchedulerProcessHeartbeats.lastPollAt,
      })
      .from(billingSchedulerProcessHeartbeats)
      .where(sql`1 = 0`),
    database
      .select({
        providerAccountId: billingAccountingImportRuns.providerAccountId,
        mode: billingAccountingImportRuns.mode,
        status: billingAccountingImportRuns.status,
        cursor: billingAccountingImportRuns.cursor,
      })
      .from(billingAccountingImportRuns)
      .where(sql`1 = 0`),
    database
      .select({
        providerAccountId: billingAccountingProviderEvents.providerAccountId,
        mode: billingAccountingProviderEvents.mode,
        providerEventId: billingAccountingProviderEvents.providerEventId,
        eventDigest: billingAccountingProviderEvents.eventDigest,
        status: billingAccountingProviderEvents.status,
      })
      .from(billingAccountingProviderEvents)
      .where(sql`1 = 0`),
    database
      .select({
        providerAccountId: billingAccountingImportCursors.providerAccountId,
        mode: billingAccountingImportCursors.mode,
        cursor: billingAccountingImportCursors.cursor,
        highWaterProviderEventId:
          billingAccountingImportCursors.highWaterProviderEventId,
        pendingHighWaterProviderEventId:
          billingAccountingImportCursors.pendingHighWaterProviderEventId,
        leaseToken: billingAccountingImportCursors.leaseToken,
        leaseUntil: billingAccountingImportCursors.leaseUntil,
      })
      .from(billingAccountingImportCursors)
      .where(sql`1 = 0`),
    database
      .select({
        workspaceId: billingAccountingEventLinks.workspaceId,
        providerEventId: billingAccountingEventLinks.providerEventId,
        paymentLedgerId: billingAccountingEventLinks.paymentLedgerId,
        linkStatus: billingAccountingEventLinks.linkStatus,
      })
      .from(billingAccountingEventLinks)
      .where(sql`1 = 0`),
    database
      .select({
        authorizationEpoch: billingProviderOperations.authorizationEpoch,
        providerCustomerId: billingProviderOperations.providerCustomerId,
        state: billingProviderOperations.state,
        credentialGenerationId:
          billingProviderOperations.credentialGenerationId,
        retryBefore: billingProviderOperations.retryBefore,
        resolutionDueAt: billingProviderOperations.resolutionDueAt,
      })
      .from(billingProviderOperations)
      .where(sql`1 = 0`),
    database
      .select({
        workspaceId: billingExecutionControls.workspaceId,
        mode: billingExecutionControls.mode,
        commercialEnabled: billingExecutionControls.commercialEnabled,
        authorizationEpoch: billingExecutionControls.authorizationEpoch,
      })
      .from(billingExecutionControls)
      .where(sql`1 = 0`),
    database
      .select({
        authorizationEpoch: billingIntents.authorizationEpoch,
        urlExposedAt: billingIntents.urlExposedAt,
        billingProfileVersion: billingIntents.billingProfileVersion,
      })
      .from(billingIntents)
      .where(sql`1 = 0`),
    database
      .select({
        mode: billingWebhookRoutes.mode,
        paymentId: billingWebhookRoutes.molliePaymentId,
        workspaceId: billingWebhookRoutes.workspaceId,
        intentId: billingWebhookRoutes.intentId,
      })
      .from(billingWebhookRoutes)
      .where(sql`1 = 0`),
    database
      .select({
        deliveryId: billingOutbox.deliveryId,
        deliveryEpoch: billingOutbox.deliveryEpoch,
        deliveryState: billingOutbox.deliveryState,
        privacyErasedAt: billingOutbox.privacyErasedAt,
      })
      .from(billingOutbox)
      .where(sql`1 = 0`),
    database
      .select({
        sourceId: billingNotificationReceipts.sourceId,
        deliveryId: billingNotificationReceipts.deliveryId,
        workspaceId: billingNotificationReceipts.workspaceId,
        bodyDigest: billingNotificationReceipts.bodyDigest,
      })
      .from(billingNotificationReceipts)
      .where(sql`1 = 0`),
    database
      .select({
        receiptId: billingNotificationReceiverOutbox.receiptId,
        status: billingNotificationReceiverOutbox.status,
        attemptCount: billingNotificationReceiverOutbox.attemptCount,
        availableAt: billingNotificationReceiverOutbox.availableAt,
        leaseToken: billingNotificationReceiverOutbox.leaseToken,
      })
      .from(billingNotificationReceiverOutbox)
      .where(sql`1 = 0`),
    database
      .select({
        receiptId: billingNotificationInbox.receiptId,
        workspaceId: billingNotificationInbox.workspaceId,
        audience: billingNotificationInbox.audience,
      })
      .from(billingNotificationInbox)
      .where(sql`1 = 0`),
    database
      .select({
        ownerTokenHash: workspaceEntitlementUsageReservations.ownerTokenHash,
        ownerLeaseUntil: workspaceEntitlementUsageReservations.ownerLeaseUntil,
        channelConnectionId:
          workspaceEntitlementUsageReservations.channelConnectionId,
        bindingEpoch: workspaceEntitlementUsageReservations.bindingEpoch,
        deliveryAttemptTokenHash:
          workspaceEntitlementUsageReservations.deliveryAttemptTokenHash,
        resolutionDueAt: workspaceEntitlementUsageReservations.resolutionDueAt,
      })
      .from(workspaceEntitlementUsageReservations)
      .where(sql`1 = 0`),
    database
      .select({
        workspaceId: messengerPrivacySubjects.workspaceId,
        privacyEpoch: messengerPrivacySubjects.privacyEpoch,
        status: messengerPrivacySubjects.status,
      })
      .from(messengerPrivacySubjects)
      .where(sql`1 = 0`),
    database
      .select({
        workspaceId: messengerProviderAttemptFences.workspaceId,
        providerOperation: messengerProviderAttemptFences.providerOperation,
        attemptNumber: messengerProviderAttemptFences.attemptNumber,
        status: messengerProviderAttemptFences.status,
      })
      .from(messengerProviderAttemptFences)
      .where(sql`1 = 0`),
    database
      .select({
        eligibilityVersion: workspaceBillingProfiles.eligibilityVersion,
        expiresAt: workspaceBillingProfiles.verificationExpiresAt,
        revokedAt: workspaceBillingProfiles.revokedAt,
      })
      .from(workspaceBillingProfiles)
      .where(sql`1 = 0`),
    database
      .select({
        kind: billingSchedulerTenants.kind,
        nextDueAt: billingSchedulerTenants.nextDueAt,
        leaseToken: billingSchedulerTenants.leaseToken,
        executionEpoch: billingSchedulerTenants.executionEpoch,
        operatorRequestId: billingSchedulerTenants.operatorRequestId,
        pendingWorkCount: billingSchedulerTenants.pendingWorkCount,
        deadLetterCount: billingSchedulerTenants.deadLetterCount,
      })
      .from(billingSchedulerTenants)
      .where(sql`1 = 0`),
  ]);

  const rollout = getBillingSchedulerRollout();
  const pinnedWorkspaceId = getTenantBillingWorkerWorkspaceId();
  const controls = await database
    .select({
      workspaceId: billingExecutionControls.workspaceId,
      commercialEnabled: billingExecutionControls.commercialEnabled,
      authorizationEpoch: billingExecutionControls.authorizationEpoch,
    })
    .from(billingExecutionControls)
    .where(
      and(
        eq(billingExecutionControls.mode, mode),
        ...(pinnedWorkspaceId
          ? [eq(billingExecutionControls.workspaceId, pinnedWorkspaceId)]
          : [])
      )
    );
  const lanes = await database
    .select({
      workspaceId: billingSchedulerTenants.workspaceId,
      kind: billingSchedulerTenants.kind,
      enabled: billingSchedulerTenants.enabled,
      executionEpoch: billingSchedulerTenants.executionEpoch,
      operatorRequestId: billingSchedulerTenants.operatorRequestId,
      enabledByUserId: billingSchedulerTenants.enabledByUserId,
      enabledAt: billingSchedulerTenants.enabledAt,
      deadLetterCount: billingSchedulerTenants.deadLetterCount,
    })
    .from(billingSchedulerTenants)
    .where(
      and(
        eq(billingSchedulerTenants.mode, mode),
        ...(pinnedWorkspaceId
          ? [eq(billingSchedulerTenants.workspaceId, pinnedWorkspaceId)]
          : [])
      )
    );
  assertBillingSchedulerRegistryCoherence(controls, lanes);
  if (options.requireRuntimeHeartbeat !== false) {
    const requiredHeartbeatKinds = [
      "outbox",
      "reconciliation",
      "profile_expiry",
      "ai_finalization",
      ...(process.env.BILLING_NOTIFICATION_PLANE_ENABLED === "true"
        ? (["notification_receiver"] as const)
        : []),
    ] as const;
    const processId =
      process.env.FLY_MACHINE_ID?.trim() ||
      process.env.BILLING_SCHEDULER_PROCESS_ID?.trim() ||
      "";
    if (!/^[A-Za-z0-9._:-]{3,96}$/.test(processId)) {
      throw new Error("Billing scheduler process identity is missing");
    }
    const heartbeat = await database
      .select({
        laneCount: sql<number>`COUNT(DISTINCT ${billingSchedulerProcessHeartbeats.kind})`,
      })
      .from(billingSchedulerProcessHeartbeats)
      .where(
        and(
          eq(billingSchedulerProcessHeartbeats.processId, processId),
          eq(billingSchedulerProcessHeartbeats.mode, mode),
          inArray(
            billingSchedulerProcessHeartbeats.kind,
            requiredHeartbeatKinds
          ),
          eq(billingSchedulerProcessHeartbeats.status, "polling"),
          sql`${billingSchedulerProcessHeartbeats.lastPollAt} > ${new Date(Date.now() - 20 * 60_000)}`
        )
      );
    if (
      Number(heartbeat[0]?.laneCount ?? 0) !== requiredHeartbeatKinds.length
    ) {
      throw new Error("Billing scheduler process heartbeat is incomplete");
    }
  }
  if (rollout.mode === "pilot_pin" && pinnedWorkspaceId) {
    const rogue = await database
      .select({ count: sql<number>`COUNT(*)` })
      .from(billingSchedulerTenants)
      .where(
        and(
          eq(billingSchedulerTenants.mode, mode),
          eq(billingSchedulerTenants.enabled, true),
          sql`${billingSchedulerTenants.workspaceId} <> ${pinnedWorkspaceId}`
        )
      );
    if (Number(rogue[0]?.count ?? 0) > 0) {
      throw new Error("Enabled billing scheduler tenant exceeds pilot pin");
    }
    const profiles = await database
      .select({
        status: workspaceBillingProfiles.verificationStatus,
        expiresAt: workspaceBillingProfiles.verificationExpiresAt,
        revokedAt: workspaceBillingProfiles.revokedAt,
      })
      .from(workspaceBillingProfiles)
      .where(eq(workspaceBillingProfiles.workspaceId, pinnedWorkspaceId))
      .limit(2);
    if (
      profiles.length !== 1 ||
      profiles[0]?.status !== "verified" ||
      !profiles[0].expiresAt ||
      profiles[0].expiresAt <= new Date() ||
      profiles[0].revokedAt
    ) {
      throw new Error("Pinned billing workspace has no eligible profile");
    }
  }
}

export async function assertBillingNotificationRuntimeReadiness(
  mode: MollieMode
): Promise<void> {
  const processId =
    process.env.FLY_MACHINE_ID?.trim() ||
    process.env.BILLING_SCHEDULER_PROCESS_ID?.trim() ||
    "";
  if (!/^[A-Za-z0-9._:-]{3,96}$/.test(processId)) {
    throw new Error("Billing notification process identity is missing");
  }
  const database = await getDatabaseOrThrow();
  const [heartbeat, schedulerHealth, receiverBacklog, receiverDeadLetters] =
    await Promise.all([
      database
        .select({ processId: billingSchedulerProcessHeartbeats.processId })
        .from(billingSchedulerProcessHeartbeats)
        .where(
          and(
            eq(billingSchedulerProcessHeartbeats.processId, processId),
            eq(billingSchedulerProcessHeartbeats.mode, mode),
            eq(billingSchedulerProcessHeartbeats.kind, "notification_receiver"),
            eq(billingSchedulerProcessHeartbeats.status, "polling"),
            sql`${billingSchedulerProcessHeartbeats.lastPollAt} > ${new Date(Date.now() - 60_000)}`
          )
        )
        .limit(1),
      database
        .select({
          tenantCount: sql<number>`COUNT(*)`,
          deadLetters: sql<number>`SUM(${billingNotificationSchedulerTenants.deadLetterCount})`,
          invalidCounters: sql<number>`SUM(CASE WHEN ${billingNotificationSchedulerTenants.pendingWorkCount} < 0 OR ${billingNotificationSchedulerTenants.deadLetterCount} < 0 THEN 1 ELSE 0 END)`,
          overdueBacklogs: sql<number>`SUM(CASE WHEN ${billingNotificationSchedulerTenants.pendingWorkCount} > 0 AND ${billingNotificationSchedulerTenants.nextDueAt} < ${new Date(Date.now() - 5 * 60_000)} THEN 1 ELSE 0 END)`,
        })
        .from(billingNotificationSchedulerTenants)
        .where(eq(billingNotificationSchedulerTenants.mode, mode)),
      database
        .select({ count: sql<number>`COUNT(*)` })
        .from(billingNotificationReceiverOutbox)
        .where(
          and(
            eq(billingNotificationReceiverOutbox.mode, mode),
            inArray(billingNotificationReceiverOutbox.status, [
              "pending",
              "processing",
            ])
          )
        ),
      database
        .select({ count: sql<number>`COUNT(*)` })
        .from(billingNotificationReceiverOutbox)
        .where(
          and(
            eq(billingNotificationReceiverOutbox.mode, mode),
            eq(billingNotificationReceiverOutbox.status, "dead_letter")
          )
        ),
    ]);
  if (!heartbeat[0]) {
    throw new Error("Billing notification receiver heartbeat is stale");
  }
  if (
    (Number(schedulerHealth[0]?.tenantCount ?? 0) === 0 &&
      Number(receiverBacklog[0]?.count ?? 0) > 0) ||
    Number(schedulerHealth[0]?.deadLetters ?? 0) > 0 ||
    Number(receiverDeadLetters[0]?.count ?? 0) > 0 ||
    Number(schedulerHealth[0]?.invalidCounters ?? 0) > 0 ||
    Number(schedulerHealth[0]?.overdueBacklogs ?? 0) > 0
  ) {
    throw new Error("Billing notification receiver scheduler is unhealthy");
  }
}

export async function assertAiAnswerFinalizationReadiness(
  mode: MollieMode
): Promise<void> {
  const rollout = getBillingSchedulerRollout();
  const database = await getDatabaseOrThrow();
  await database
    .select({
      ownerTokenHash: workspaceEntitlementUsageReservations.ownerTokenHash,
      ownerLeaseUntil: workspaceEntitlementUsageReservations.ownerLeaseUntil,
      channelConnectionId:
        workspaceEntitlementUsageReservations.channelConnectionId,
      bindingEpoch: workspaceEntitlementUsageReservations.bindingEpoch,
      deliveryStartedAt:
        workspaceEntitlementUsageReservations.deliveryStartedAt,
      deliveryKnownRejectedAt:
        workspaceEntitlementUsageReservations.deliveryKnownRejectedAt,
      deliveryAttemptTokenHash:
        workspaceEntitlementUsageReservations.deliveryAttemptTokenHash,
      resolutionDueAt: workspaceEntitlementUsageReservations.resolutionDueAt,
    })
    .from(workspaceEntitlementUsageReservations)
    .where(sql`1 = 0`);
  const lanes = await database
    .select({ workspaceId: billingSchedulerTenants.workspaceId })
    .from(billingSchedulerTenants)
    .where(
      and(
        eq(billingSchedulerTenants.mode, mode),
        eq(billingSchedulerTenants.kind, "ai_finalization"),
        eq(billingSchedulerTenants.enabled, true),
        ...(rollout.pinnedWorkspaceId
          ? [eq(billingSchedulerTenants.workspaceId, rollout.pinnedWorkspaceId)]
          : [])
      )
    )
    .limit(1);
  if (!lanes[0]) {
    throw new Error(
      rollout.mode === "pilot_pin"
        ? "The pinned AI answer finalization lane is not ready"
        : "No enabled AI answer finalization lane is ready"
    );
  }
  const token =
    process.env.INTERNAL_IMAGE_REQUEST_TOKEN?.trim() ||
    process.env.ADMIN_TOKEN?.trim() ||
    "";
  if (token.length < 32) {
    throw new Error("AI answer quota protocol token is missing or too short");
  }
}

export async function assertMollieAccountingSchemaReadiness(): Promise<void> {
  const database = await getDatabaseOrThrow();
  await Promise.all([
    database
      .select({
        providerAccountId: billingAccountingImportCursors.providerAccountId,
        mode: billingAccountingImportCursors.mode,
        cursor: billingAccountingImportCursors.cursor,
        highWaterProviderEventId:
          billingAccountingImportCursors.highWaterProviderEventId,
        pendingHighWaterProviderEventId:
          billingAccountingImportCursors.pendingHighWaterProviderEventId,
        leaseToken: billingAccountingImportCursors.leaseToken,
      })
      .from(billingAccountingImportCursors)
      .where(sql`1 = 0`),
    database
      .select({
        providerEventId: billingAccountingProviderEvents.providerEventId,
      })
      .from(billingAccountingProviderEvents)
      .where(sql`1 = 0`),
    database
      .select({ providerEventId: billingAccountingEventLinks.providerEventId })
      .from(billingAccountingEventLinks)
      .where(sql`1 = 0`),
  ]);
}

export async function assertMollieAccountingWorkerReadiness(input: {
  providerAccountId: string;
  mode: MollieMode;
  now?: Date;
}): Promise<void> {
  await assertMollieAccountingSchemaReadiness();
  const database = await getDatabaseOrThrow();
  const rows = await database
    .select({
      lastSuccessfulAt: billingAccountingImportCursors.lastSuccessfulAt,
    })
    .from(billingAccountingImportCursors)
    .where(
      and(
        eq(
          billingAccountingImportCursors.providerAccountId,
          input.providerAccountId
        ),
        eq(billingAccountingImportCursors.mode, input.mode)
      )
    )
    .limit(1);
  const lastSuccessfulAt = rows[0]?.lastSuccessfulAt;
  const now = input.now ?? new Date();
  if (
    !lastSuccessfulAt ||
    now.getTime() - lastSuccessfulAt.getTime() > 15 * 60_000
  ) {
    throw new Error("Mollie accounting worker heartbeat is missing or stale");
  }
  const [quarantine, staleRuns] = await Promise.all([
    database
      .select({ count: sql<number>`COUNT(*)` })
      .from(billingAccountingProviderEvents)
      .where(
        and(
          eq(
            billingAccountingProviderEvents.providerAccountId,
            input.providerAccountId
          ),
          eq(billingAccountingProviderEvents.mode, input.mode),
          eq(billingAccountingProviderEvents.status, "quarantined")
        )
      ),
    database
      .select({ count: sql<number>`COUNT(*)` })
      .from(billingAccountingImportRuns)
      .where(
        and(
          eq(
            billingAccountingImportRuns.providerAccountId,
            input.providerAccountId
          ),
          eq(billingAccountingImportRuns.mode, input.mode),
          inArray(billingAccountingImportRuns.status, ["pending", "fetching"]),
          lt(
            billingAccountingImportRuns.updatedAt,
            new Date(now.getTime() - 5 * 60_000)
          )
        )
      ),
  ]);
  if (Number(quarantine[0]?.count ?? 0) > 0) {
    throw new Error("Mollie accounting quarantine requires review");
  }
  if (Number(staleRuns[0]?.count ?? 0) > 0) {
    throw new Error("Mollie accounting import has stale unfinished runs");
  }
}
