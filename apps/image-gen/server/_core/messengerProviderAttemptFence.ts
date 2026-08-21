import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lt, lte, or } from "drizzle-orm";

import {
  auditLog,
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
  channel?: "facebook_messenger" | "whatsapp";
}>;

export type MessengerProviderAttemptOutcome =
  "known_failed" | "succeeded" | "ambiguous";

export type BlockedMessengerPrivacyProviderAttempt = Readonly<{
  cursorId: number;
  attemptKeyHash: string;
  workspaceId: number;
  channelConnectionId: number;
  bindingEpoch: number;
  privacyEpoch: number;
  providerOperation: string;
  attemptNumber: number;
  status: "started" | "ambiguous" | "abandoned";
  leaseUntil: Date;
  startedAt: Date;
  updatedAt: Date;
}>;

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
          inArray(messengerProviderAttemptFences.status, [
            "reserved",
            "known_failed",
            "succeeded",
          ])
        )
      );
    const active = await tx
      .select({ id: messengerProviderAttemptFences.id })
      .from(messengerProviderAttemptFences)
      .where(
        and(
          scope,
          inArray(messengerProviderAttemptFences.status, [
            "started",
            "ambiguous",
            // A legacy blind abandonment is unresolved evidence, not proof
            // that provider artifacts were contained.
            "abandoned",
          ])
        )
      )
      .limit(1)
      .for("update");
    if (active.length > 0) return false;

    // Provider-attempt rows contain a privacy-scoped user key and also pin the
    // immutable Page binding/subject epoch through composite FKs. Once no
    // transport can still finish, remove all terminal metadata in this scope
    // so erasure and a later connection rebind can complete.
    await tx
      .delete(messengerProviderAttemptFences)
      .where(
        and(
          scope,
          inArray(messengerProviderAttemptFences.status, [
            "reserved",
            "known_failed",
            "succeeded",
            "contained",
          ])
        )
      );
    return true;
  });
}

export async function listBlockedMessengerPrivacyProviderAttempts(
  workspaceId: number,
  limit = 50,
  beforeId?: number
): Promise<BlockedMessengerPrivacyProviderAttempt[]> {
  if (
    !Number.isSafeInteger(workspaceId) ||
    workspaceId <= 0 ||
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    limit > 100 ||
    (beforeId !== undefined &&
      (!Number.isSafeInteger(beforeId) || beforeId <= 0))
  ) {
    throw new Error("Messenger provider attempt query scope is invalid");
  }
  const database = await getDatabaseOrThrow();
  const rows = await database
    .select({
      cursorId: messengerProviderAttemptFences.id,
      attemptKeyHash: messengerProviderAttemptFences.attemptKeyHash,
      workspaceId: messengerProviderAttemptFences.workspaceId,
      channelConnectionId: messengerProviderAttemptFences.channelConnectionId,
      bindingEpoch: messengerProviderAttemptFences.bindingEpoch,
      privacyEpoch: messengerProviderAttemptFences.privacyEpoch,
      providerOperation: messengerProviderAttemptFences.providerOperation,
      attemptNumber: messengerProviderAttemptFences.attemptNumber,
      status: messengerProviderAttemptFences.status,
      leaseUntil: messengerProviderAttemptFences.leaseUntil,
      startedAt: messengerProviderAttemptFences.startedAt,
      updatedAt: messengerProviderAttemptFences.updatedAt,
    })
    .from(messengerProviderAttemptFences)
    .innerJoin(
      messengerPrivacySubjects,
      and(
        eq(
          messengerPrivacySubjects.workspaceId,
          messengerProviderAttemptFences.workspaceId
        ),
        eq(
          messengerPrivacySubjects.channelConnectionId,
          messengerProviderAttemptFences.channelConnectionId
        ),
        eq(
          messengerPrivacySubjects.userKey,
          messengerProviderAttemptFences.userKey
        ),
        eq(
          messengerPrivacySubjects.privacyEpoch,
          messengerProviderAttemptFences.privacyEpoch
        )
      )
    )
    .where(
      and(
        eq(messengerProviderAttemptFences.workspaceId, workspaceId),
        beforeId === undefined
          ? undefined
          : lt(messengerProviderAttemptFences.id, beforeId),
        inArray(messengerPrivacySubjects.status, ["active", "erasing"]),
        inArray(messengerProviderAttemptFences.status, [
          "started",
          "ambiguous",
          "abandoned",
        ])
      )
    )
    .orderBy(desc(messengerProviderAttemptFences.id))
    .limit(limit);

  return rows.map(row => {
    if (
      (row.status !== "started" &&
        row.status !== "ambiguous" &&
        row.status !== "abandoned") ||
      !row.startedAt
    ) {
      throw new Error("Messenger provider attempt state is invalid");
    }
    return { ...row, status: row.status, startedAt: row.startedAt };
  });
}

export async function reconcileMessengerPrivacyProviderAttempt(input: {
  requestId: string;
  attemptKeyHash: string;
  workspaceId: number;
  channelConnectionId: number;
  expectedBindingEpoch: number;
  expectedPrivacyEpoch: number;
  expectedAttemptNumber: number;
  expectedStatus: "started" | "ambiguous" | "abandoned";
  resolution: "reconciled_not_accepted" | "artifacts_contained";
  evidenceReferenceHash: string;
  actorUserId: number;
  now?: Date;
}): Promise<{ resolved: boolean; status: "contained" }> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.requestId
    ) ||
    !/^[a-f0-9]{64}$/.test(input.attemptKeyHash) ||
    !Number.isSafeInteger(input.workspaceId) ||
    input.workspaceId <= 0 ||
    !Number.isSafeInteger(input.channelConnectionId) ||
    input.channelConnectionId <= 0 ||
    !Number.isSafeInteger(input.expectedBindingEpoch) ||
    input.expectedBindingEpoch <= 0 ||
    !Number.isSafeInteger(input.expectedPrivacyEpoch) ||
    input.expectedPrivacyEpoch <= 0 ||
    !Number.isSafeInteger(input.expectedAttemptNumber) ||
    input.expectedAttemptNumber <= 0 ||
    (input.expectedStatus !== "started" &&
      input.expectedStatus !== "ambiguous" &&
      input.expectedStatus !== "abandoned") ||
    !Number.isSafeInteger(input.actorUserId) ||
    input.actorUserId <= 0 ||
    !/^[a-f0-9]{64}$/.test(input.evidenceReferenceHash) ||
    (input.resolution !== "reconciled_not_accepted" &&
      input.resolution !== "artifacts_contained")
  ) {
    throw new Error("Messenger provider attempt resolution scope is invalid");
  }
  const now = input.now ?? new Date();
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const rows = await tx
      .select({
        id: messengerProviderAttemptFences.id,
        attemptKeyHash: messengerProviderAttemptFences.attemptKeyHash,
        userKey: messengerProviderAttemptFences.userKey,
        privacyEpoch: messengerProviderAttemptFences.privacyEpoch,
        providerOperation: messengerProviderAttemptFences.providerOperation,
        attemptNumber: messengerProviderAttemptFences.attemptNumber,
        status: messengerProviderAttemptFences.status,
        leaseUntil: messengerProviderAttemptFences.leaseUntil,
      })
      .from(messengerProviderAttemptFences)
      .where(
        and(
          eq(
            messengerProviderAttemptFences.attemptKeyHash,
            input.attemptKeyHash
          ),
          eq(messengerProviderAttemptFences.workspaceId, input.workspaceId),
          eq(
            messengerProviderAttemptFences.channelConnectionId,
            input.channelConnectionId
          ),
          eq(
            messengerProviderAttemptFences.bindingEpoch,
            input.expectedBindingEpoch
          ),
          eq(
            messengerProviderAttemptFences.privacyEpoch,
            input.expectedPrivacyEpoch
          )
        )
      )
      .limit(1)
      .for("update");
    const attempt = rows[0];
    if (!attempt) throw new Error("Messenger provider attempt was not found");
    if (attempt.status === "contained") {
      return { resolved: false, status: "contained" } as const;
    }
    if (
      attempt.status !== input.expectedStatus ||
      attempt.attemptNumber !== input.expectedAttemptNumber
    ) {
      throw new Error("Messenger provider attempt resolution is stale");
    }
    if (attempt.status === "started" && attempt.leaseUntil > now) {
      throw new Error("Messenger provider attempt lease is still active");
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
          eq(messengerPrivacySubjects.userKey, attempt.userKey),
          eq(messengerPrivacySubjects.privacyEpoch, attempt.privacyEpoch),
          inArray(messengerPrivacySubjects.status, ["active", "erasing"])
        )
      )
      .limit(1)
      .for("update");
    if (!subjects[0]) {
      throw new Error("Messenger privacy subject is not active");
    }
    const result = await tx
      .update(messengerProviderAttemptFences)
      .set({ status: "contained", completedAt: now, leaseUntil: now })
      .where(
        and(
          eq(messengerProviderAttemptFences.id, attempt.id),
          eq(messengerProviderAttemptFences.status, input.expectedStatus),
          eq(
            messengerProviderAttemptFences.attemptNumber,
            input.expectedAttemptNumber
          )
        )
      );
    if (affectedRows(result) !== 1) {
      throw new Error("Messenger provider attempt resolution was lost");
    }
    await tx.insert(auditLog).values({
      workspaceId: input.workspaceId,
      userId: input.actorUserId,
      event: "messenger_provider_attempt.operator_contained",
      metadata: {
        actorKind: "platform_admin",
        reason: "provider_outcome_reconciled_for_containment",
        requestId: input.requestId,
        attemptKeyHash: attempt.attemptKeyHash,
        channelConnectionId: input.channelConnectionId,
        bindingEpoch: input.expectedBindingEpoch,
        privacyEpoch: input.expectedPrivacyEpoch,
        providerOperation: attempt.providerOperation,
        attemptNumber: attempt.attemptNumber,
        previousStatus: attempt.status,
        resolution: input.resolution,
        evidenceReferenceHash: input.evidenceReferenceHash,
      },
    });
    return { resolved: true, status: "contained" } as const;
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
  now = new Date(),
  expectedChannel: "facebook_messenger" | "whatsapp" = "facebook_messenger"
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
  // The sequence is caller telemetry, not a new logical operation. Image and
  // video providers cannot prove that a timed-out/5xx transport was rejected,
  // so a later automatic callback must hit this same fence and fail closed
  // before another billable request starts.
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
          eq(channelConnections.channel, expectedChannel),
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
        channel: expectedChannel,
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
        channel: expectedChannel,
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
        channel: expectedChannel,
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
          eq(channelConnections.channel, fence.channel ?? "facebook_messenger"),
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
