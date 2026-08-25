import { and, eq } from "drizzle-orm";

import {
  channelConnections,
  messengerPrivacySubjects,
  messengerProviderAttemptFences,
} from "../../drizzle/schema";
import { getDatabaseOrThrow } from "../db";
import {
  reserveStartpilotImageUsageWithinTransaction,
  type StartpilotImageUsageDecision,
  type StartpilotImageUsageInput,
} from "./billing/entitlementUsageStore";
import {
  MESSENGER_PROVIDER_FENCE_LEASE_MS,
  type MessengerProviderAttemptFence,
} from "./messengerProviderAttemptFence";

type StartpilotImageProviderAdmissionInput = StartpilotImageUsageInput & {
  fence: MessengerProviderAttemptFence;
  providerOperation: string;
};

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

function affectedRows(result: unknown): number {
  const metadata: unknown = Array.isArray(result)
    ? (result as unknown[])[0]
    : result;
  return Number(
    (metadata as { affectedRows?: number } | undefined)?.affectedRows ?? 0
  );
}
