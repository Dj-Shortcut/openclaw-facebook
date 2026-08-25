import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";

import {
  channelConnections,
  messengerPrivacySubjects,
  messengerProviderAttemptFences,
  workspaceEntitlementUsage,
  workspaceEntitlementUsageReservations,
} from "../../drizzle/schema";
import { getDatabaseOrThrow } from "../db";
import {
  reserveStartpilotImageUsageWithinTransaction,
  type StartpilotImageUsageDecision,
  type StartpilotImageUsageInput,
  utcDateKey,
} from "./billing/entitlementUsageStore";
import {
  MESSENGER_PROVIDER_FENCE_LEASE_MS,
  type MessengerProviderAttemptFence,
} from "./messengerProviderAttemptFence";

type StartpilotImageProviderAdmissionInput = StartpilotImageUsageInput & {
  fence: MessengerProviderAttemptFence;
  providerOperation: string;
};

export type StartpilotImageProviderAdmissionRecoveryInput =
  StartpilotImageProviderAdmissionInput & { pageIdHash: string };

type ExactStartpilotFence = {
  leaseToken: string;
  attemptKeyHash: string;
  pageId: string;
  userKey: string;
  privacyEpoch: number;
};

/**
 * Commits the first paid image unit and crosses the provider-attempt boundary
 * in one transaction. This prevents a crash from consuming paid capacity while
 * leaving the exact provider attempt safely reclaimable as merely reserved.
 */
export async function admitStartpilotImageProviderAttempt(
  input: StartpilotImageProviderAdmissionInput
): Promise<StartpilotImageUsageDecision> {
  const now = input.now ?? new Date();
  const fence = assertExactStartpilotFence(input);
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const owners = await tx
      .select({ id: channelConnections.id })
      .from(channelConnections)
      .where(
        and(
          eq(channelConnections.id, input.channelConnectionId),
          eq(channelConnections.workspaceId, input.workspaceId),
          eq(channelConnections.channel, "facebook_messenger"),
          eq(channelConnections.externalId, fence.pageId),
          eq(channelConnections.status, "connected"),
          eq(channelConnections.bindingEpoch, input.bindingEpoch)
        )
      )
      .limit(1)
      .for("update");
    if (!owners[0]) {
      throw new Error("Startpilot provider ownership changed");
    }

    const subjects = await tx
      .select({ id: messengerPrivacySubjects.id })
      .from(messengerPrivacySubjects)
      .where(
        and(
          eq(messengerPrivacySubjects.workspaceId, input.workspaceId),
          eq(
            messengerPrivacySubjects.channelConnectionId,
            input.channelConnectionId
          ),
          eq(messengerPrivacySubjects.userKey, fence.userKey),
          eq(messengerPrivacySubjects.privacyEpoch, fence.privacyEpoch),
          eq(messengerPrivacySubjects.status, "active")
        )
      )
      .limit(1)
      .for("update");
    if (!subjects[0]) {
      throw new Error("Startpilot provider privacy changed");
    }

    const decision = await reserveStartpilotImageUsageWithinTransaction(
      tx,
      input,
      now
    );
    const mutation = await tx
      .update(messengerProviderAttemptFences)
      .set(
        decision.allowed
          ? {
              status: "started",
              startedAt: now,
              leaseUntil: new Date(
                now.getTime() + MESSENGER_PROVIDER_FENCE_LEASE_MS
              ),
            }
          : {
              status: "known_failed",
              completedAt: now,
              leaseUntil: now,
            }
      )
      .where(
        and(
          eq(messengerProviderAttemptFences.workspaceId, input.workspaceId),
          eq(
            messengerProviderAttemptFences.channelConnectionId,
            input.channelConnectionId
          ),
          eq(messengerProviderAttemptFences.bindingEpoch, input.bindingEpoch),
          eq(messengerProviderAttemptFences.userKey, fence.userKey),
          eq(messengerProviderAttemptFences.privacyEpoch, fence.privacyEpoch),
          eq(
            messengerProviderAttemptFences.providerOperation,
            input.providerOperation
          ),
          eq(
            messengerProviderAttemptFences.attemptKeyHash,
            fence.attemptKeyHash
          ),
          eq(messengerProviderAttemptFences.leaseToken, fence.leaseToken),
          eq(messengerProviderAttemptFences.status, "reserved")
        )
      );
    if (affectedRows(mutation) !== 1) {
      throw new Error("Startpilot provider admission ownership was lost");
    }
    return decision;
  });
}

/**
 * Completes an exact pre-transport rollback after paid admission returned an
 * error. It handles both possible database outcomes: the admission transaction
 * rolled back and left a reservation fence, or it committed the paid receipt
 * and started fence before its acknowledgement was lost.
 */
export async function recoverStartpilotImageProviderAdmission(
  input: StartpilotImageProviderAdmissionRecoveryInput
): Promise<void> {
  const now = input.now ?? new Date();
  const fence = assertExactStartpilotRecoveryFence(input);
  const database = await getDatabaseOrThrow();
  await database.transaction(async tx => {
    // Recovery is allowed after disconnect, rebind, or privacy erasure because
    // it only reverses a pre-transport charge. Prove the immutable historical
    // Page ownership here instead of relying on mutable current-state gates.
    const historicalOwners = await tx
      .select({
        id: channelConnections.id,
        externalId: channelConnections.externalId,
      })
      .from(channelConnections)
      .where(
        and(
          eq(channelConnections.id, input.channelConnectionId),
          eq(channelConnections.workspaceId, input.workspaceId),
          eq(channelConnections.channel, "facebook_messenger")
        )
      )
      .limit(1)
      .for("update");
    const historicalOwner = historicalOwners[0];
    if (
      !historicalOwner ||
      !historicalOwner.externalId ||
      createHash("sha256").update(historicalOwner.externalId).digest("hex") !==
        input.pageIdHash ||
      (input.fence.pageId !== undefined &&
        createHash("sha256").update(input.fence.pageId.trim()).digest("hex") !==
          input.pageIdHash)
    ) {
      throw new Error("Startpilot provider recovery owner scope mismatch");
    }

    const usageRows = await tx
      .select()
      .from(workspaceEntitlementUsage)
      .where(
        and(
          eq(workspaceEntitlementUsage.workspaceId, input.workspaceId),
          eq(workspaceEntitlementUsage.mode, input.mode),
          eq(workspaceEntitlementUsage.entitlementId, input.entitlementId)
        )
      )
      .limit(1)
      .for("update");
    const usage = usageRows[0];
    if (!usage) {
      throw new Error("Startpilot provider recovery usage is unavailable");
    }

    const receiptRows = await tx
      .select()
      .from(workspaceEntitlementUsageReservations)
      .where(
        and(
          eq(
            workspaceEntitlementUsageReservations.workspaceId,
            input.workspaceId
          ),
          eq(workspaceEntitlementUsageReservations.mode, input.mode),
          eq(
            workspaceEntitlementUsageReservations.idempotencyKey,
            input.idempotencyKey
          )
        )
      )
      .limit(1)
      .for("update");
    const receipt = receiptRows[0];
    if (
      receipt &&
      (receipt.entitlementId !== input.entitlementId ||
        receipt.channelConnectionId !== input.channelConnectionId ||
        receipt.bindingEpoch !== input.bindingEpoch ||
        receipt.kind !== "image")
    ) {
      throw new Error("Startpilot provider recovery receipt scope mismatch");
    }

    const fenceRows = await tx
      .select({
        status: messengerProviderAttemptFences.status,
        leaseToken: messengerProviderAttemptFences.leaseToken,
      })
      .from(messengerProviderAttemptFences)
      .where(
        and(
          eq(messengerProviderAttemptFences.workspaceId, input.workspaceId),
          eq(
            messengerProviderAttemptFences.channelConnectionId,
            input.channelConnectionId
          ),
          eq(messengerProviderAttemptFences.bindingEpoch, input.bindingEpoch),
          eq(messengerProviderAttemptFences.userKey, fence.userKey),
          eq(messengerProviderAttemptFences.privacyEpoch, fence.privacyEpoch),
          eq(
            messengerProviderAttemptFences.providerOperation,
            input.providerOperation
          ),
          eq(
            messengerProviderAttemptFences.attemptKeyHash,
            fence.attemptKeyHash
          )
        )
      )
      .limit(1)
      .for("update");
    const storedFence = fenceRows[0];
    if (!storedFence || storedFence.leaseToken !== fence.leaseToken) {
      throw new Error("Startpilot provider recovery fence scope mismatch");
    }

    if (
      (storedFence.status === "known_failed" ||
        storedFence.status === "contained") &&
      (!receipt || receipt.status === "released")
    ) {
      return;
    }

    if (storedFence.status === "reserved" && !receipt) {
      const finalized = await tx
        .update(messengerProviderAttemptFences)
        .set({ status: "known_failed", completedAt: now, leaseUntil: now })
        .where(
          and(
            eq(
              messengerProviderAttemptFences.attemptKeyHash,
              fence.attemptKeyHash
            ),
            eq(messengerProviderAttemptFences.leaseToken, fence.leaseToken),
            eq(messengerProviderAttemptFences.status, "reserved")
          )
        );
      if (affectedRows(finalized) !== 1) {
        throw new Error("Startpilot provider recovery finalization was lost");
      }
      return;
    }

    if (storedFence.status !== "started" || receipt?.status !== "committed") {
      throw new Error("Startpilot provider recovery state is unsafe");
    }
    if (
      !Number.isSafeInteger(usage.imagesUsed) ||
      usage.imagesUsed <= 0 ||
      !Number.isSafeInteger(usage.imagesUsedToday) ||
      usage.imagesUsedToday < 0 ||
      !receipt.committedAt
    ) {
      throw new Error("Startpilot provider recovery counter is inconsistent");
    }
    const committedToday =
      usage.imageUsageDate === utcDateKey(receipt.committedAt);
    if (committedToday && usage.imagesUsedToday <= 0) {
      throw new Error("Startpilot provider recovery daily counter is empty");
    }
    const usageUpdate = await tx
      .update(workspaceEntitlementUsage)
      .set({
        imagesUsed: usage.imagesUsed - 1,
        imagesUsedToday: committedToday
          ? usage.imagesUsedToday - 1
          : usage.imagesUsedToday,
      })
      .where(
        and(
          eq(workspaceEntitlementUsage.id, usage.id),
          eq(workspaceEntitlementUsage.workspaceId, input.workspaceId),
          eq(workspaceEntitlementUsage.mode, input.mode),
          eq(workspaceEntitlementUsage.entitlementId, input.entitlementId),
          eq(workspaceEntitlementUsage.imagesUsed, usage.imagesUsed),
          eq(workspaceEntitlementUsage.imagesUsedToday, usage.imagesUsedToday)
        )
      );
    if (affectedRows(usageUpdate) !== 1) {
      throw new Error("Startpilot provider recovery usage update was lost");
    }
    const receiptUpdate = await tx
      .update(workspaceEntitlementUsageReservations)
      .set({ status: "released", releasedAt: now })
      .where(
        and(
          eq(
            workspaceEntitlementUsageReservations.reservationId,
            receipt.reservationId
          ),
          eq(workspaceEntitlementUsageReservations.status, "committed")
        )
      );
    const fenceUpdate = await tx
      .update(messengerProviderAttemptFences)
      .set({ status: "known_failed", completedAt: now, leaseUntil: now })
      .where(
        and(
          eq(
            messengerProviderAttemptFences.attemptKeyHash,
            fence.attemptKeyHash
          ),
          eq(messengerProviderAttemptFences.leaseToken, fence.leaseToken),
          eq(messengerProviderAttemptFences.status, "started")
        )
      );
    if (affectedRows(receiptUpdate) !== 1 || affectedRows(fenceUpdate) !== 1) {
      throw new Error("Startpilot provider recovery completion was lost");
    }
  });
}

function assertExactStartpilotFence(
  input: StartpilotImageProviderAdmissionInput
): ExactStartpilotFence {
  const fence = input.fence;
  const providerOperation = input.providerOperation.trim();
  if (
    !fence.leaseToken ||
    !fence.attemptKeyHash ||
    fence.channel !== "facebook_messenger" ||
    fence.workspaceId !== input.workspaceId ||
    fence.channelConnectionId !== input.channelConnectionId ||
    fence.bindingEpoch !== input.bindingEpoch ||
    !fence.pageId?.trim() ||
    !fence.userKey?.trim() ||
    !Number.isSafeInteger(fence.privacyEpoch) ||
    fence.privacyEpoch! <= 0 ||
    fence.providerOperation !== providerOperation ||
    (fence.privacyMode !== undefined && fence.privacyMode !== "active")
  ) {
    throw new Error("Startpilot provider admission scope is incomplete");
  }
  return {
    leaseToken: fence.leaseToken,
    attemptKeyHash: fence.attemptKeyHash,
    pageId: fence.pageId,
    userKey: fence.userKey,
    privacyEpoch: fence.privacyEpoch!,
  };
}

function assertExactStartpilotRecoveryFence(
  input: StartpilotImageProviderAdmissionRecoveryInput
): Omit<ExactStartpilotFence, "pageId"> {
  const fence = input.fence;
  const providerOperation = input.providerOperation.trim();
  if (
    !fence.leaseToken ||
    !fence.attemptKeyHash ||
    fence.channel !== "facebook_messenger" ||
    fence.workspaceId !== input.workspaceId ||
    fence.channelConnectionId !== input.channelConnectionId ||
    fence.bindingEpoch !== input.bindingEpoch ||
    !fence.userKey?.trim() ||
    !Number.isSafeInteger(fence.privacyEpoch) ||
    fence.privacyEpoch! <= 0 ||
    fence.providerOperation !== providerOperation ||
    !/^[a-f0-9]{64}$/.test(input.pageIdHash) ||
    (fence.privacyMode !== undefined && fence.privacyMode !== "active")
  ) {
    throw new Error("Startpilot provider recovery scope is incomplete");
  }
  return {
    leaseToken: fence.leaseToken,
    attemptKeyHash: fence.attemptKeyHash,
    userKey: fence.userKey,
    privacyEpoch: fence.privacyEpoch!,
  };
}

function affectedRows(result: unknown): number {
  const metadata: unknown = Array.isArray(result)
    ? (result as unknown[])[0]
    : result;
  return Number(
    (metadata as { affectedRows?: number } | undefined)?.affectedRows ?? 0
  );
}
