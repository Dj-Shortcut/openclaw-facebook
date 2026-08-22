import { createHash, randomUUID } from "node:crypto";
import { and, eq, lte, or } from "drizzle-orm";

import {
  channelConnections,
  messengerProviderAttemptFences,
  messengerPrivacySubjects,
} from "../../drizzle/schema";
import { getDatabaseOrThrow } from "../db";
import type { MessengerGenerationJob } from "./messengerGenerationJob";

const PROVIDER_FENCE_LEASE_MS = 15 * 60_000;

export type MessengerProviderAttemptFence = Readonly<{
  leaseToken: string | null;
  attemptKeyHash: string | null;
  workspaceId?: number;
  channelConnectionId?: number;
  bindingEpoch?: number;
  pageId?: string;
  userKey?: string;
  privacyEpoch?: number;
}>;

export type MessengerProviderAttemptOutcome =
  "known_failed" | "succeeded" | "ambiguous";

export async function containMessengerProviderAttemptsForPrivacy(
  input: {
    workspaceId: number;
    channelConnectionId: number;
    userKey: string;
  },
  now = new Date()
): Promise<boolean> {
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const scope = and(
      eq(messengerProviderAttemptFences.workspaceId, input.workspaceId),
      eq(
        messengerProviderAttemptFences.channelConnectionId,
        input.channelConnectionId
      ),
      eq(messengerProviderAttemptFences.userKey, input.userKey)
    );
    await tx
      .update(messengerProviderAttemptFences)
      .set({ status: "contained", completedAt: now, leaseUntil: now })
      .where(
        and(
          scope,
          or(
            eq(messengerProviderAttemptFences.status, "reserved"),
            eq(messengerProviderAttemptFences.status, "known_failed"),
            eq(messengerProviderAttemptFences.status, "succeeded"),
            eq(messengerProviderAttemptFences.status, "ambiguous"),
            and(
              eq(messengerProviderAttemptFences.status, "started"),
              lte(messengerProviderAttemptFences.leaseUntil, now)
            )
          )
        )
      );
    const active = await tx
      .select({ id: messengerProviderAttemptFences.id })
      .from(messengerProviderAttemptFences)
      .where(and(scope, eq(messengerProviderAttemptFences.status, "started")))
      .limit(1)
      .for("update");
    return active.length === 0;
  });
}

const LOCAL_FENCE: MessengerProviderAttemptFence = {
  leaseToken: null,
  attemptKeyHash: null,
};

export async function reserveMessengerProviderAttemptFence(
  job: MessengerGenerationJob,
  providerOperation: string,
  providerAttemptSequence: number,
  now = new Date()
): Promise<MessengerProviderAttemptFence> {
  if (
    process.env.NODE_ENV !== "production" &&
    !process.env.DATABASE_URL?.trim()
  ) {
    return LOCAL_FENCE;
  }
  if (
    !job.pageId ||
    !job.workspaceId ||
    !job.channelConnectionId ||
    !job.bindingEpoch ||
    !job.userId ||
    !job.privacyEpoch ||
    !providerOperation.trim() ||
    !Number.isSafeInteger(providerAttemptSequence) ||
    providerAttemptSequence <= 0
  ) {
    throw new Error("Messenger provider attempt ownership is incomplete");
  }
  const workspaceId = job.workspaceId;
  const channelConnectionId = job.channelConnectionId;
  const bindingEpoch = job.bindingEpoch;
  const pageId = job.pageId;
  const userKey = job.userId;
  const privacyEpoch = job.privacyEpoch;
  const operation = providerOperation.trim();
  const attemptKeyHash = createHash("sha256")
    .update(String(workspaceId))
    .update("\0")
    .update(String(channelConnectionId))
    .update("\0")
    .update(String(bindingEpoch))
    .update("\0")
    .update(userKey)
    .update("\0")
    .update(String(privacyEpoch))
    .update("\0")
    .update(operation)
    .update("\0")
    .update(job.reqId)
    .digest("hex");
  const leaseToken = randomUUID();
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const owners = await tx
      .select({ id: channelConnections.id })
      .from(channelConnections)
      .where(
        and(
          eq(channelConnections.id, channelConnectionId),
          eq(channelConnections.workspaceId, workspaceId),
          eq(channelConnections.externalId, pageId),
          eq(channelConnections.status, "connected"),
          eq(channelConnections.bindingEpoch, bindingEpoch)
        )
      )
      .limit(1)
      .for("update");
    if (!owners[0]) throw new Error("Messenger provider ownership changed");
    const subjects = await tx
      .select({ id: messengerPrivacySubjects.id })
      .from(messengerPrivacySubjects)
      .where(
        and(
          eq(messengerPrivacySubjects.workspaceId, workspaceId),
          eq(messengerPrivacySubjects.channelConnectionId, channelConnectionId),
          eq(messengerPrivacySubjects.userKey, userKey),
          eq(messengerPrivacySubjects.privacyEpoch, privacyEpoch),
          eq(messengerPrivacySubjects.status, "active")
        )
      )
      .limit(1)
      .for("update");
    if (!subjects[0]) throw new Error("Messenger provider privacy changed");

    await tx
      .insert(messengerProviderAttemptFences)
      .values({
        attemptKeyHash,
        workspaceId,
        channelConnectionId,
        bindingEpoch,
        userKey,
        privacyEpoch,
        providerOperation: operation,
        attemptNumber: 1,
        status: "reserved",
        leaseToken,
        leaseUntil: new Date(now.getTime() + PROVIDER_FENCE_LEASE_MS),
      })
      .onDuplicateKeyUpdate({ set: { attemptKeyHash } });
    const existing = await tx
      .select({
        status: messengerProviderAttemptFences.status,
        leaseToken: messengerProviderAttemptFences.leaseToken,
        leaseUntil: messengerProviderAttemptFences.leaseUntil,
        attemptNumber: messengerProviderAttemptFences.attemptNumber,
      })
      .from(messengerProviderAttemptFences)
      .where(eq(messengerProviderAttemptFences.attemptKeyHash, attemptKeyHash))
      .limit(1)
      .for("update");
    const fence = existing[0];
    if (fence?.leaseToken === leaseToken) {
      return {
        leaseToken,
        attemptKeyHash,
        workspaceId,
        channelConnectionId,
        bindingEpoch,
        pageId,
        userKey,
        privacyEpoch,
      };
    }
    // Only a reservation proves that no provider request started. Started or
    // ambiguous attempts are never reclaimed without provider-side evidence.
    if (fence?.status === "reserved" && fence.leaseUntil <= now) {
      const takeover = await tx
        .update(messengerProviderAttemptFences)
        .set({
          leaseToken,
          leaseUntil: new Date(now.getTime() + PROVIDER_FENCE_LEASE_MS),
        })
        .where(
          and(
            eq(messengerProviderAttemptFences.attemptKeyHash, attemptKeyHash),
            eq(messengerProviderAttemptFences.status, "reserved"),
            lte(messengerProviderAttemptFences.leaseUntil, now)
          )
        );
      if (affectedRows(takeover) !== 1) {
        throw new Error("Messenger provider attempt fence takeover was lost");
      }
      return {
        leaseToken,
        attemptKeyHash,
        workspaceId,
        channelConnectionId,
        bindingEpoch,
        pageId,
        userKey,
        privacyEpoch,
      };
    }
    if (fence?.status === "known_failed") {
      const retry = await tx
        .update(messengerProviderAttemptFences)
        .set({
          status: "reserved",
          leaseToken,
          leaseUntil: new Date(now.getTime() + PROVIDER_FENCE_LEASE_MS),
          attemptNumber: fence.attemptNumber + 1,
          startedAt: null,
          completedAt: null,
        })
        .where(
          and(
            eq(messengerProviderAttemptFences.attemptKeyHash, attemptKeyHash),
            eq(messengerProviderAttemptFences.status, "known_failed"),
            eq(
              messengerProviderAttemptFences.attemptNumber,
              fence.attemptNumber
            )
          )
        );
      if (affectedRows(retry) !== 1) {
        throw new Error("Messenger provider attempt retry fence was lost");
      }
      return {
        leaseToken,
        attemptKeyHash,
        workspaceId,
        channelConnectionId,
        bindingEpoch,
        pageId,
        userKey,
        privacyEpoch,
      };
    }
    throw new Error("Messenger provider attempt already fenced");
  });
}

export async function markMessengerProviderAttemptStarted(
  fence: MessengerProviderAttemptFence,
  now = new Date()
): Promise<void> {
  if (!fence.leaseToken) return;
  const database = await getDatabaseOrThrow();
  await database.transaction(async tx => {
    const owners = await tx
      .select({ id: channelConnections.id })
      .from(channelConnections)
      .where(
        and(
          eq(channelConnections.id, fence.channelConnectionId!),
          eq(channelConnections.workspaceId, fence.workspaceId!),
          eq(channelConnections.externalId, fence.pageId!),
          eq(channelConnections.status, "connected"),
          eq(channelConnections.bindingEpoch, fence.bindingEpoch!)
        )
      )
      .limit(1)
      .for("update");
    if (!owners[0]) throw new Error("Messenger provider ownership changed");
    const subjects = await tx
      .select({ id: messengerPrivacySubjects.id })
      .from(messengerPrivacySubjects)
      .where(
        and(
          eq(messengerPrivacySubjects.workspaceId, fence.workspaceId!),
          eq(
            messengerPrivacySubjects.channelConnectionId,
            fence.channelConnectionId!
          ),
          eq(messengerPrivacySubjects.userKey, fence.userKey!),
          eq(messengerPrivacySubjects.privacyEpoch, fence.privacyEpoch!),
          eq(messengerPrivacySubjects.status, "active")
        )
      )
      .limit(1)
      .for("update");
    if (!subjects[0]) throw new Error("Messenger provider privacy changed");
    const result = await tx
      .update(messengerProviderAttemptFences)
      .set({
        status: "started",
        startedAt: now,
        leaseUntil: new Date(now.getTime() + PROVIDER_FENCE_LEASE_MS),
      })
      .where(
        and(
          eq(messengerProviderAttemptFences.leaseToken, fence.leaseToken!),
          eq(messengerProviderAttemptFences.status, "reserved")
        )
      );
    if (affectedRows(result) !== 1) {
      throw new Error("Messenger provider attempt fence ownership was lost");
    }
  });
}

function affectedRows(result: unknown): number {
  const metadata: unknown = Array.isArray(result)
    ? (result as unknown[])[0]
    : result;
  return Number(
    (metadata as { affectedRows?: number } | undefined)?.affectedRows ?? 0
  );
}

export async function finalizeMessengerProviderAttemptFence(
  fence: MessengerProviderAttemptFence,
  outcome: MessengerProviderAttemptOutcome,
  now = new Date()
): Promise<void> {
  if (!fence.leaseToken) return;
  const database = await getDatabaseOrThrow();
  const result = await database
    .update(messengerProviderAttemptFences)
    .set({ status: outcome, completedAt: now, leaseUntil: now })
    .where(
      and(
        eq(messengerProviderAttemptFences.leaseToken, fence.leaseToken),
        or(
          eq(messengerProviderAttemptFences.status, "reserved"),
          eq(messengerProviderAttemptFences.status, "started")
        )
      )
    );
  if (affectedRows(result) !== 1) {
    throw new Error("Messenger provider attempt fence finalization was lost");
  }
}
