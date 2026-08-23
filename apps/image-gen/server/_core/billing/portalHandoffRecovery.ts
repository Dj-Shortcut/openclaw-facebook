import { and, desc, eq, sql } from "drizzle-orm";

import {
  billingIntents,
  billingHandoffRecoveryEvents,
  billingOutbox,
  channelConnections,
  messengerPrivacySubjects,
} from "../../../drizzle/schema";
import {
  getDatabaseOrThrow,
  lockActiveMessengerPrivacyIdentity,
} from "../../db";
import { safeLog } from "../logger";

const RECOVERABLE_HANDOFF_FAILURES = new Set([
  "portal_handoff_response_window_closed",
  "portal_handoff_messenger_user_not_found",
  "portal_handoff_page_binding_unavailable",
  "portal_handoff_send_failed_exhausted",
]);

type InboundPortalHandoffRecovery = Readonly<{
  facebookPageId: string;
  messengerSenderUserKey: string;
  eventIdHash: string;
  eventTimestamp: Date;
  source: "verified_messenger_inbound";
  now?: Date;
}>;

type RearmedPortalHandoff = Readonly<{
  outboxId: number;
  workspaceId: number;
  previousErrorCode: string;
}>;

/**
 * A fresh, verified inbound Messenger event is the customer-controlled proof
 * that the Page-scoped response window reopened. Rearm only the same paid
 * outbox operation; never create checkout, payment, entitlement, or a new
 * delivery identity here.
 */
export async function rearmFailedPortalHandoffAfterInbound(
  input: InboundPortalHandoffRecovery
): Promise<boolean> {
  const facebookPageId = input.facebookPageId.trim();
  const now = input.now ?? new Date();
  if (
    !process.env.DATABASE_URL?.trim() ||
    !facebookPageId ||
    facebookPageId.length > 160 ||
    !/^[a-f0-9]{64}$/.test(input.messengerSenderUserKey) ||
    !/^[a-f0-9]{64}$/.test(input.eventIdHash) ||
    input.source !== "verified_messenger_inbound" ||
    !Number.isFinite(input.eventTimestamp.getTime()) ||
    input.eventTimestamp.getTime() < now.getTime() - 5 * 60_000 ||
    input.eventTimestamp.getTime() > now.getTime() + 60_000
  ) {
    return false;
  }

  try {
    const database = await getDatabaseOrThrow();
    const rearmed = await database.transaction(async tx => {
      const bindings = await tx
        .select({
          workspaceId: channelConnections.workspaceId,
          channelConnectionId: channelConnections.id,
        })
        .from(channelConnections)
        .where(
          and(
            eq(channelConnections.channel, "facebook_messenger"),
            eq(channelConnections.status, "connected"),
            eq(channelConnections.externalId, facebookPageId)
          )
        )
        .limit(2);
      if (bindings.length !== 1) return null;
      const { workspaceId, channelConnectionId } = bindings[0];

      const subjects = await tx
        .select({ privacyEpoch: messengerPrivacySubjects.privacyEpoch })
        .from(messengerPrivacySubjects)
        .where(
          and(
            eq(messengerPrivacySubjects.workspaceId, workspaceId),
            eq(
              messengerPrivacySubjects.channelConnectionId,
              channelConnectionId
            ),
            eq(messengerPrivacySubjects.userKey, input.messengerSenderUserKey),
            eq(messengerPrivacySubjects.status, "active")
          )
        )
        .limit(1);
      const privacyEpoch = subjects[0]?.privacyEpoch;
      if (!privacyEpoch) return null;
      await lockActiveMessengerPrivacyIdentity(tx, {
        workspaceId,
        channelConnectionId,
        userKey: input.messengerSenderUserKey,
        privacyEpoch,
        pageId: facebookPageId,
      });

      // First read only enough metadata to identify the immutable intent. The
      // actual outbox row is locked only after that intent is locked.
      const jobs = await tx
        .select()
        .from(billingOutbox)
        .where(
          and(
            eq(billingOutbox.workspaceId, workspaceId),
            eq(billingOutbox.eventType, "send_portal_handoff"),
            eq(billingOutbox.status, "failed"),
            sql`JSON_UNQUOTE(JSON_EXTRACT(${billingOutbox.payload}, '$.messengerSenderUserKey')) = ${input.messengerSenderUserKey}`,
            sql`JSON_UNQUOTE(JSON_EXTRACT(${billingOutbox.payload}, '$.messengerPageId')) = ${facebookPageId}`,
            sql`CAST(JSON_UNQUOTE(JSON_EXTRACT(${billingOutbox.payload}, '$.messengerChannelConnectionId')) AS UNSIGNED) = ${channelConnectionId}`,
            sql`CAST(JSON_UNQUOTE(JSON_EXTRACT(${billingOutbox.payload}, '$.messengerPrivacyEpoch')) AS UNSIGNED) = ${privacyEpoch}`
          )
        )
        .orderBy(desc(billingOutbox.id))
        .limit(1);
      const candidate = jobs[0];
      if (
        !candidate?.lastErrorCode ||
        !RECOVERABLE_HANDOFF_FAILURES.has(candidate.lastErrorCode)
      ) {
        return null;
      }

      const candidatePayload = readHandoffPayload(candidate.payload);
      if (
        !candidatePayload ||
        candidatePayload.messengerSenderUserKey !==
          input.messengerSenderUserKey ||
        candidatePayload.messengerPageId !== facebookPageId ||
        candidatePayload.messengerChannelConnectionId !== channelConnectionId ||
        candidatePayload.messengerPrivacyEpoch !== privacyEpoch
      ) {
        return null;
      }
      const intents = await tx
        .select({ intentId: billingIntents.intentId })
        .from(billingIntents)
        .where(
          and(
            eq(billingIntents.intentId, candidatePayload.intentId),
            eq(billingIntents.workspaceId, workspaceId),
            eq(billingIntents.mode, candidate.mode),
            eq(billingIntents.status, "paid"),
            eq(
              billingIntents.messengerSenderUserKey,
              input.messengerSenderUserKey
            ),
            eq(billingIntents.messengerPageId, facebookPageId),
            eq(
              billingIntents.messengerChannelConnectionId,
              channelConnectionId
            ),
            eq(billingIntents.messengerPrivacyEpoch, privacyEpoch)
          )
        )
        .limit(1)
        .for("update");
      if (!intents[0]) return null;

      const lockedJobs = await tx
        .select()
        .from(billingOutbox)
        .where(eq(billingOutbox.id, candidate.id))
        .limit(1)
        .for("update");
      const job = lockedJobs[0];
      const payload = readHandoffPayload(job?.payload);
      if (
        !job ||
        job.workspaceId !== workspaceId ||
        job.mode !== candidate.mode ||
        job.eventType !== "send_portal_handoff" ||
        job.status !== "failed" ||
        job.deliveryState !== "idle" ||
        job.privacyErasedAt !== null ||
        !job.lastErrorCode ||
        !RECOVERABLE_HANDOFF_FAILURES.has(job.lastErrorCode) ||
        !payload ||
        payload.intentId !== candidatePayload.intentId ||
        payload.messengerSenderUserKey !== input.messengerSenderUserKey ||
        payload.messengerPageId !== facebookPageId ||
        payload.messengerChannelConnectionId !== channelConnectionId ||
        payload.messengerPrivacyEpoch !== privacyEpoch
      ) {
        return null;
      }

      const recoveryHistory = readRecoveryHistory(job.payload);
      const receipts = await tx
        .select({ id: billingHandoffRecoveryEvents.id })
        .from(billingHandoffRecoveryEvents)
        .where(
          and(
            eq(billingHandoffRecoveryEvents.outboxId, job.id),
            eq(billingHandoffRecoveryEvents.eventIdHash, input.eventIdHash)
          )
        )
        .limit(1)
        .for("update");
      if (receipts[0]) {
        return null;
      }
      await tx.insert(billingHandoffRecoveryEvents).values({
        outboxId: job.id,
        workspaceId,
        eventIdHash: input.eventIdHash,
        source: input.source,
        eventTimestamp: input.eventTimestamp,
      });
      await tx
        .update(billingOutbox)
        .set({
          status: "pending",
          attemptCount: 0,
          availableAt: now,
          lockedAt: null,
          leaseToken: null,
          lastErrorCode: "customer_message_rearm",
          payload: {
            ...(job.payload as Record<string, unknown>),
            recoveryHistory: [
              ...recoveryHistory,
              {
                kind: "rearmed",
                previousErrorCode: job.lastErrorCode,
                previousAttemptCount: job.attemptCount,
                actor: "customer",
                source: input.source,
                eventIdHash: input.eventIdHash,
                eventTimestamp: input.eventTimestamp.toISOString(),
                recordedAt: now.toISOString(),
              },
            ].slice(-20),
          },
        })
        .where(
          and(
            eq(billingOutbox.id, job.id),
            eq(billingOutbox.workspaceId, workspaceId),
            eq(billingOutbox.mode, job.mode),
            eq(billingOutbox.status, "failed"),
            eq(billingOutbox.deliveryState, "idle"),
            sql`${billingOutbox.privacyErasedAt} IS NULL`
          )
        );

      return {
        outboxId: job.id,
        workspaceId,
        previousErrorCode: job.lastErrorCode,
      } satisfies RearmedPortalHandoff;
    });

    if (!rearmed) return false;
    safeLog("portal_handoff_rearmed_after_inbound", {
      workspaceId: rearmed.workspaceId,
      outboxId: rearmed.outboxId,
      previousErrorCode: rearmed.previousErrorCode,
    });
    return true;
  } catch (error) {
    safeLog("portal_handoff_rearm_failed", {
      level: "error",
      errorCode:
        error instanceof Error ? error.constructor.name : "UnknownError",
    });
    return false;
  }
}

function readRecoveryHistory(payload: unknown): unknown[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }
  const history = (payload as Record<string, unknown>).recoveryHistory;
  return Array.isArray(history) ? history.slice(-19) : [];
}

function readHandoffPayload(payload: unknown): {
  intentId: string;
  messengerSenderUserKey: string;
  messengerPageId: string;
  messengerChannelConnectionId: number;
  messengerPrivacyEpoch: number;
} | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (
    typeof record.intentId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(record.intentId) ||
    typeof record.messengerSenderUserKey !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.messengerSenderUserKey) ||
    typeof record.messengerPageId !== "string" ||
    !record.messengerPageId.trim() ||
    record.messengerPageId.length > 160 ||
    !Number.isSafeInteger(record.messengerChannelConnectionId) ||
    Number(record.messengerChannelConnectionId) <= 0 ||
    !Number.isSafeInteger(record.messengerPrivacyEpoch) ||
    Number(record.messengerPrivacyEpoch) <= 0
  ) {
    return null;
  }
  return {
    intentId: record.intentId,
    messengerSenderUserKey: record.messengerSenderUserKey,
    messengerPageId: record.messengerPageId.trim(),
    messengerChannelConnectionId: Number(record.messengerChannelConnectionId),
    messengerPrivacyEpoch: Number(record.messengerPrivacyEpoch),
  };
}
