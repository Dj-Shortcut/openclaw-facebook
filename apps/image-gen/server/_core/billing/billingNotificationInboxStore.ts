import { and, eq, isNull } from "drizzle-orm";

import { auditLog, billingNotificationInbox } from "../../../drizzle/schema";
import { getDatabaseOrThrow } from "../../db";
import { listWorkspaceBillingNotifications } from "./billingNotificationReceiverWorker";

export class BillingNotificationInboxError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BillingNotificationInboxError";
  }
}

export async function listOperatorBillingNotifications(input: {
  workspaceId: number;
  limit?: number;
}) {
  assertPositiveInteger(input.workspaceId);
  return listWorkspaceBillingNotifications({
    workspaceId: input.workspaceId,
    audience: "operator",
    limit: input.limit,
  });
}

export async function acknowledgeOperatorBillingNotification(input: {
  workspaceId: number;
  notificationId: number;
  actorUserId: number;
  now?: Date;
}): Promise<{ acknowledgedAt: Date }> {
  assertPositiveInteger(input.workspaceId);
  assertPositiveInteger(input.notificationId);
  assertPositiveInteger(input.actorUserId);
  const acknowledgedAt = input.now ?? new Date();
  const database = await getDatabaseOrThrow();

  await database.transaction(async tx => {
    const result = await tx
      .update(billingNotificationInbox)
      .set({ readAt: acknowledgedAt })
      .where(
        and(
          eq(billingNotificationInbox.id, input.notificationId),
          eq(billingNotificationInbox.workspaceId, input.workspaceId),
          eq(billingNotificationInbox.audience, "operator"),
          isNull(billingNotificationInbox.readAt)
        )
      );
    if (affectedRows(result) !== 1) {
      throw new BillingNotificationInboxError(
        "billing_notification_acknowledgement_conflict"
      );
    }
    await tx.insert(auditLog).values({
      workspaceId: input.workspaceId,
      userId: input.actorUserId,
      event: "billing_notification.operator_acknowledged",
      metadata: {
        notificationId: input.notificationId,
        audience: "operator",
        acknowledgedAt: acknowledgedAt.toISOString(),
      },
    });
  });

  return { acknowledgedAt };
}

function assertPositiveInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new BillingNotificationInboxError(
      "billing_notification_invalid_scope"
    );
  }
}

function affectedRows(result: unknown): number {
  const metadata: unknown = Array.isArray(result)
    ? (result as unknown[])[0]
    : result;
  return Number(
    (metadata as { affectedRows?: number } | undefined)?.affectedRows ?? 0
  );
}
