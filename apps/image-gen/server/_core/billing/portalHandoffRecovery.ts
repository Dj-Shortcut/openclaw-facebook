import { and, desc, eq, sql } from "drizzle-orm";

import {
  billingIntents,
  billingOutbox,
  channelConnections,
} from "../../../drizzle/schema";
import { getDatabaseOrThrow } from "../../db";
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
  if (
    !process.env.DATABASE_URL?.trim() ||
    !facebookPageId ||
    facebookPageId.length > 160 ||
    !/^[a-f0-9]{64}$/.test(input.messengerSenderUserKey)
  ) {
    return false;
  }

  try {
    const database = await getDatabaseOrThrow();
    const rearmed = await database.transaction(async tx => {
      const bindings = await tx
        .select({ workspaceId: channelConnections.workspaceId })
        .from(channelConnections)
        .where(
          and(
            eq(channelConnections.channel, "facebook_messenger"),
            eq(channelConnections.status, "connected"),
            eq(channelConnections.externalId, facebookPageId)
          )
        )
        .limit(2)
        .for("update");
      if (bindings.length !== 1) return null;
      const workspaceId = bindings[0]!.workspaceId;

      const jobs = await tx
        .select()
        .from(billingOutbox)
        .where(
          and(
            eq(billingOutbox.workspaceId, workspaceId),
            eq(billingOutbox.eventType, "send_portal_handoff"),
            eq(billingOutbox.status, "failed"),
            sql`JSON_UNQUOTE(JSON_EXTRACT(${billingOutbox.payload}, '$.messengerSenderUserKey')) = ${input.messengerSenderUserKey}`,
            sql`JSON_UNQUOTE(JSON_EXTRACT(${billingOutbox.payload}, '$.messengerPageId')) = ${facebookPageId}`
          )
        )
        .orderBy(desc(billingOutbox.id))
        .limit(1)
        .for("update");
      const job = jobs[0];
      if (
        !job?.lastErrorCode ||
        !RECOVERABLE_HANDOFF_FAILURES.has(job.lastErrorCode)
      ) {
        return null;
      }

      const payload = readHandoffPayload(job.payload);
      if (!payload) return null;
      const intents = await tx
        .select({ intentId: billingIntents.intentId })
        .from(billingIntents)
        .where(
          and(
            eq(billingIntents.intentId, payload.intentId),
            eq(billingIntents.workspaceId, workspaceId),
            eq(billingIntents.mode, job.mode),
            eq(billingIntents.status, "paid"),
            eq(
              billingIntents.messengerSenderUserKey,
              input.messengerSenderUserKey
            ),
            eq(billingIntents.messengerPageId, facebookPageId)
          )
        )
        .limit(1)
        .for("update");
      if (!intents[0]) return null;

      await tx
        .update(billingOutbox)
        .set({
          status: "pending",
          attemptCount: 0,
          availableAt: new Date(),
          lockedAt: null,
          leaseToken: null,
          lastErrorCode: "customer_message_rearm",
        })
        .where(
          and(
            eq(billingOutbox.id, job.id),
            eq(billingOutbox.workspaceId, workspaceId),
            eq(billingOutbox.mode, job.mode),
            eq(billingOutbox.status, "failed")
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

function readHandoffPayload(payload: unknown): {
  intentId: string;
  messengerSenderUserKey: string;
  messengerPageId: string;
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
    !record.messengerPageId.trim()
  ) {
    return null;
  }
  return {
    intentId: record.intentId,
    messengerSenderUserKey: record.messengerSenderUserKey,
    messengerPageId: record.messengerPageId.trim(),
  };
}
