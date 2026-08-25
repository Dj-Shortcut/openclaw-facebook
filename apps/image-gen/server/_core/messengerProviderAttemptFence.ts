import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, lte, or } from "drizzle-orm";

import {
  channelConnections,
  messengerProviderAttemptFences,
  messengerPrivacySubjects,
} from "../../drizzle/schema";
import { getDatabaseOrThrow } from "../db";
import type { MessengerGenerationJob } from "./messengerGenerationJob";

export const MESSENGER_PROVIDER_FENCE_LEASE_MS = 15 * 60_000;
export const WHATSAPP_ERASURE_CONTROL_PROVIDER_OPERATION =
  "whatsapp_graph_erasure_control_text";

type MessengerProviderAttemptPrivacyMode = "active" | "erasure_control";

export type MessengerProviderAttemptFence = Readonly<{
  leaseToken: string | null;
  attemptKeyHash: string | null;
  channel?: "facebook_messenger" | "whatsapp";
  workspaceId?: number;
  channelConnectionId?: number;
  bindingEpoch?: number;
  pageId?: string;
  userKey?: string;
  privacyEpoch?: number;
  providerOperation?: string;
  privacyMode?: MessengerProviderAttemptPrivacyMode;
}>;

export type MessengerProviderAttemptOutcome =
  "known_failed" | "succeeded" | "ambiguous";

export type MessengerProviderAttemptStoredStatus =
  | "reserved"
  | "started"
  | "known_failed"
  | "succeeded"
  | "ambiguous"
  | "contained"
  | "abandoned";

export type MessengerProviderAttemptClaim =
  | { kind: "owned"; fence: MessengerProviderAttemptFence }
  | { kind: "busy"; retryAt: Date }
  | {
      kind: "unsafe_or_done";
      status: "started" | "ambiguous" | "succeeded";
      attemptKeyHash?: string;
    }
  | { kind: "blocked"; status: "contained" | "abandoned" };

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
            and(
              or(
                eq(messengerProviderAttemptFences.status, "started"),
                eq(messengerProviderAttemptFences.status, "ambiguous")
              ),
              lte(messengerProviderAttemptFences.leaseUntil, now)
            )
          )
        )
      );
    const active = await tx
      .select({ id: messengerProviderAttemptFences.id })
      .from(messengerProviderAttemptFences)
      .where(
        and(
          scope,
          or(
            eq(messengerProviderAttemptFences.status, "started"),
            eq(messengerProviderAttemptFences.status, "ambiguous")
          )
        )
      )
      .limit(1)
      .for("update");
    return active.length === 0;
  });
}

const LOCAL_FENCE: MessengerProviderAttemptFence = {
  leaseToken: null,
  attemptKeyHash: null,
};

type MessengerProviderAttemptClaimOptions = Readonly<{
  takeOverReserved?: boolean;
  expectedChannel?: "facebook_messenger" | "whatsapp";
}>;

async function claimMessengerProviderAttemptFenceInternal(
  job: MessengerGenerationJob,
  providerOperation: string,
  providerAttemptSequence: number,
  now = new Date(),
  options: MessengerProviderAttemptClaimOptions & {
    privacyMode: MessengerProviderAttemptPrivacyMode;
  }
): Promise<MessengerProviderAttemptClaim> {
  if (
    process.env.NODE_ENV !== "production" &&
    !process.env.DATABASE_URL?.trim()
  ) {
    return { kind: "owned", fence: LOCAL_FENCE };
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
  const expectedChannel = options.expectedChannel ?? "facebook_messenger";
  const privacyMode = options.privacyMode;
  if (
    (privacyMode === "erasure_control" &&
      (expectedChannel !== "whatsapp" ||
        operation !== WHATSAPP_ERASURE_CONTROL_PROVIDER_OPERATION)) ||
    (privacyMode === "active" &&
      operation === WHATSAPP_ERASURE_CONTROL_PROVIDER_OPERATION)
  ) {
    throw new Error("Messenger provider privacy mode is invalid");
  }
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
    .update(String(providerAttemptSequence))
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
    const readExistingFence = async () => {
      const rows = await tx
        .select({
          status: messengerProviderAttemptFences.status,
          leaseToken: messengerProviderAttemptFences.leaseToken,
          leaseUntil: messengerProviderAttemptFences.leaseUntil,
          attemptNumber: messengerProviderAttemptFences.attemptNumber,
        })
        .from(messengerProviderAttemptFences)
        .where(
          and(
            eq(messengerProviderAttemptFences.workspaceId, workspaceId),
            eq(
              messengerProviderAttemptFences.channelConnectionId,
              channelConnectionId
            ),
            eq(messengerProviderAttemptFences.bindingEpoch, bindingEpoch),
            eq(messengerProviderAttemptFences.userKey, userKey),
            eq(messengerProviderAttemptFences.privacyEpoch, privacyEpoch),
            eq(messengerProviderAttemptFences.providerOperation, operation),
            eq(messengerProviderAttemptFences.attemptKeyHash, attemptKeyHash)
          )
        )
        .limit(1)
        .for("update");
      return rows[0];
    };

    // Read the exact historical attempt before current privacy admission. A
    // later reactivation advances the subject epoch, but may only recognize a
    // terminal old attempt; it can never authorize another provider call.
    const existingBeforePrivacyAdmission =
      privacyMode === "erasure_control" ? await readExistingFence() : undefined;
    const subjects = await tx
      .select({
        id: messengerPrivacySubjects.id,
        status: messengerPrivacySubjects.status,
        privacyEpoch: messengerPrivacySubjects.privacyEpoch,
      })
      .from(messengerPrivacySubjects)
      .where(
        and(
          eq(messengerPrivacySubjects.workspaceId, workspaceId),
          eq(messengerPrivacySubjects.channelConnectionId, channelConnectionId),
          eq(messengerPrivacySubjects.userKey, userKey),
          ...(privacyMode === "active"
            ? [
                eq(messengerPrivacySubjects.privacyEpoch, privacyEpoch),
                eq(messengerPrivacySubjects.status, "active"),
              ]
            : [])
        )
      )
      .limit(1)
      .for("update");
    const subject = subjects[0];
    if (!subject) throw new Error("Messenger provider privacy changed");

    // Reactivation is never authority to send a new deletion outcome. The
    // active state is admitted only to recognize a matching attempt that
    // already crossed the provider boundary, which keeps replays fail-closed.
    if (privacyMode === "erasure_control" && subject.status === "active") {
      const existing = existingBeforePrivacyAdmission;
      if (
        existing?.status === "started" ||
        existing?.status === "ambiguous" ||
        existing?.status === "succeeded"
      ) {
        return {
          kind: "unsafe_or_done",
          status: existing.status,
          attemptKeyHash,
        };
      }
      throw new Error("Messenger provider privacy changed");
    }
    if (
      privacyMode === "erasure_control" &&
      (subject.privacyEpoch !== privacyEpoch ||
        (subject.status !== "erasing" && subject.status !== "erased"))
    ) {
      throw new Error("Messenger provider privacy changed");
    }

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
        leaseUntil: new Date(now.getTime() + MESSENGER_PROVIDER_FENCE_LEASE_MS),
      })
      .onDuplicateKeyUpdate({ set: { attemptKeyHash } });
    const fence = await readExistingFence();
    if (fence?.leaseToken === leaseToken) {
      return {
        kind: "owned",
        fence: {
          leaseToken,
          attemptKeyHash,
          channel: expectedChannel,
          workspaceId,
          channelConnectionId,
          bindingEpoch,
          pageId,
          userKey,
          privacyEpoch,
          providerOperation: operation,
          privacyMode,
        },
      };
    }
    // Only a reservation proves that no provider request started. Started or
    // ambiguous attempts are never reclaimed without provider-side evidence.
    if (
      fence?.status === "reserved" &&
      (options.takeOverReserved === true || fence.leaseUntil <= now)
    ) {
      const takeover = await tx
        .update(messengerProviderAttemptFences)
        .set({
          leaseToken,
          leaseUntil: new Date(
            now.getTime() + MESSENGER_PROVIDER_FENCE_LEASE_MS
          ),
          attemptNumber: fence.attemptNumber + 1,
          startedAt: null,
          completedAt: null,
        })
        .where(
          and(
            eq(messengerProviderAttemptFences.workspaceId, workspaceId),
            eq(
              messengerProviderAttemptFences.channelConnectionId,
              channelConnectionId
            ),
            eq(messengerProviderAttemptFences.bindingEpoch, bindingEpoch),
            eq(messengerProviderAttemptFences.userKey, userKey),
            eq(messengerProviderAttemptFences.privacyEpoch, privacyEpoch),
            eq(messengerProviderAttemptFences.attemptKeyHash, attemptKeyHash),
            eq(messengerProviderAttemptFences.status, "reserved"),
            eq(messengerProviderAttemptFences.leaseToken, fence.leaseToken)
          )
        );
      if (affectedRows(takeover) !== 1) {
        throw new Error("Messenger provider attempt fence takeover was lost");
      }
      return {
        kind: "owned",
        fence: {
          leaseToken,
          attemptKeyHash,
          channel: expectedChannel,
          workspaceId,
          channelConnectionId,
          bindingEpoch,
          pageId,
          userKey,
          privacyEpoch,
          providerOperation: operation,
          privacyMode,
        },
      };
    }
    if (fence?.status === "known_failed") {
      const retry = await tx
        .update(messengerProviderAttemptFences)
        .set({
          status: "reserved",
          leaseToken,
          leaseUntil: new Date(
            now.getTime() + MESSENGER_PROVIDER_FENCE_LEASE_MS
          ),
          attemptNumber: fence.attemptNumber + 1,
          startedAt: null,
          completedAt: null,
        })
        .where(
          and(
            eq(messengerProviderAttemptFences.workspaceId, workspaceId),
            eq(
              messengerProviderAttemptFences.channelConnectionId,
              channelConnectionId
            ),
            eq(messengerProviderAttemptFences.bindingEpoch, bindingEpoch),
            eq(messengerProviderAttemptFences.userKey, userKey),
            eq(messengerProviderAttemptFences.privacyEpoch, privacyEpoch),
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
        kind: "owned",
        fence: {
          leaseToken,
          attemptKeyHash,
          channel: expectedChannel,
          workspaceId,
          channelConnectionId,
          bindingEpoch,
          pageId,
          userKey,
          privacyEpoch,
          providerOperation: operation,
          privacyMode,
        },
      };
    }
    if (fence?.status === "reserved") {
      return { kind: "busy", retryAt: fence.leaseUntil };
    }
    if (
      fence?.status === "started" ||
      fence?.status === "ambiguous" ||
      fence?.status === "succeeded"
    ) {
      return {
        kind: "unsafe_or_done",
        status: fence.status,
        ...(privacyMode === "erasure_control" ? { attemptKeyHash } : {}),
      };
    }
    if (fence?.status === "contained" || fence?.status === "abandoned") {
      return { kind: "blocked", status: fence.status };
    }
    throw new Error("Messenger provider attempt fence state is unavailable");
  });
}

export async function claimMessengerProviderAttemptFence(
  job: MessengerGenerationJob,
  providerOperation: string,
  providerAttemptSequence: number,
  now = new Date(),
  options: MessengerProviderAttemptClaimOptions = {}
): Promise<MessengerProviderAttemptClaim> {
  return claimMessengerProviderAttemptFenceInternal(
    job,
    providerOperation,
    providerAttemptSequence,
    now,
    { ...options, privacyMode: "active" }
  );
}

export async function reserveMessengerProviderAttemptFence(
  job: MessengerGenerationJob,
  providerOperation: string,
  providerAttemptSequence: number,
  now = new Date(),
  expectedChannel: "facebook_messenger" | "whatsapp" = "facebook_messenger"
): Promise<MessengerProviderAttemptFence> {
  const claim = await claimMessengerProviderAttemptFence(
    job,
    providerOperation,
    providerAttemptSequence,
    now,
    { expectedChannel }
  );
  if (claim.kind === "owned") return claim.fence;
  throw new Error(
    claim.kind === "busy"
      ? "Messenger provider attempt is reserved"
      : `Messenger provider attempt is ${claim.status}`
  );
}

export async function claimWhatsAppErasureControlProviderAttemptFence(
  job: MessengerGenerationJob,
  now = new Date()
): Promise<MessengerProviderAttemptClaim> {
  return claimMessengerProviderAttemptFenceInternal(
    job,
    WHATSAPP_ERASURE_CONTROL_PROVIDER_OPERATION,
    1,
    now,
    { expectedChannel: "whatsapp", privacyMode: "erasure_control" }
  );
}

export async function markMessengerProviderAttemptStarted(
  fence: MessengerProviderAttemptFence,
  now = new Date()
): Promise<void> {
  if (!fence.leaseToken) return;
  const privacyMode = fence.privacyMode ?? "active";
  if (
    privacyMode === "erasure_control" &&
    (fence.channel !== "whatsapp" ||
      fence.providerOperation !== WHATSAPP_ERASURE_CONTROL_PROVIDER_OPERATION)
  ) {
    throw new Error("Messenger provider privacy mode is invalid");
  }
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
          privacyMode === "erasure_control"
            ? inArray(messengerPrivacySubjects.status, ["erasing", "erased"])
            : eq(messengerPrivacySubjects.status, "active")
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
        leaseUntil: new Date(now.getTime() + MESSENGER_PROVIDER_FENCE_LEASE_MS),
      })
      .where(
        and(
          eq(messengerProviderAttemptFences.workspaceId, fence.workspaceId!),
          eq(
            messengerProviderAttemptFences.channelConnectionId,
            fence.channelConnectionId!
          ),
          eq(messengerProviderAttemptFences.bindingEpoch, fence.bindingEpoch!),
          eq(messengerProviderAttemptFences.userKey, fence.userKey!),
          eq(messengerProviderAttemptFences.privacyEpoch, fence.privacyEpoch!),
          eq(
            messengerProviderAttemptFences.attemptKeyHash,
            fence.attemptKeyHash!
          ),
          ...(fence.providerOperation
            ? [
                eq(
                  messengerProviderAttemptFences.providerOperation,
                  fence.providerOperation
                ),
              ]
            : []),
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
    .set(
      outcome === "ambiguous"
        ? { status: outcome, completedAt: now }
        : { status: outcome, completedAt: now, leaseUntil: now }
    )
    .where(
      and(
        eq(messengerProviderAttemptFences.workspaceId, fence.workspaceId!),
        eq(
          messengerProviderAttemptFences.channelConnectionId,
          fence.channelConnectionId!
        ),
        eq(messengerProviderAttemptFences.bindingEpoch, fence.bindingEpoch!),
        eq(messengerProviderAttemptFences.userKey, fence.userKey!),
        eq(messengerProviderAttemptFences.privacyEpoch, fence.privacyEpoch!),
        eq(
          messengerProviderAttemptFences.attemptKeyHash,
          fence.attemptKeyHash!
        ),
        ...(fence.providerOperation
          ? [
              eq(
                messengerProviderAttemptFences.providerOperation,
                fence.providerOperation
              ),
            ]
          : []),
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
