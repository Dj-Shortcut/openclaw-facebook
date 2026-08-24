import { type SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDatabaseOrThrow: vi.fn(),
  listWorkspaceNotifications: vi.fn(),
}));

vi.mock("../../db", () => ({
  getDatabaseOrThrow: mocks.getDatabaseOrThrow,
}));

vi.mock("./billingNotificationReceiverWorker", () => ({
  listWorkspaceBillingNotifications: mocks.listWorkspaceNotifications,
}));

import {
  acknowledgeOperatorBillingNotification,
  BillingNotificationInboxError,
  listOperatorBillingNotifications,
} from "./billingNotificationInboxStore";

const mysqlDialect = new MySqlDialect();

describe("billing operator notification inbox", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists only the requested workspace operator audience", async () => {
    mocks.listWorkspaceNotifications.mockResolvedValue([
      {
        id: 81,
        eventType: "payment_warning",
        reason: "payment_cancellation_failed",
      },
    ]);

    await expect(
      listOperatorBillingNotifications({ workspaceId: 42, limit: 10 })
    ).resolves.toHaveLength(1);
    expect(mocks.listWorkspaceNotifications).toHaveBeenCalledWith({
      workspaceId: 42,
      audience: "operator",
      limit: 10,
    });
  });

  it("acknowledges one exact unread operator row and writes metadata-only audit", async () => {
    const harness = acknowledgementDatabase(1);
    mocks.getDatabaseOrThrow.mockResolvedValue(harness.database);
    const now = new Date("2026-08-24T12:00:00.000Z");

    await expect(
      acknowledgeOperatorBillingNotification({
        workspaceId: 42,
        notificationId: 81,
        actorUserId: 91,
        now,
      })
    ).resolves.toEqual({ acknowledgedAt: now });

    const query = mysqlDialect.sqlToQuery(harness.predicate as SQL);
    expect(query.params).toEqual([81, 42, "operator"]);
    expect(query.sql).toMatch(/`id` = \?/);
    expect(query.sql).toMatch(/`workspace_id` = \?/);
    expect(query.sql).toMatch(/`audience` = \?/);
    expect(query.sql).toMatch(/`read_at` is null/i);
    expect(harness.updatedValues).toEqual([{ readAt: now }]);
    expect(harness.insertedValues).toEqual([
      {
        workspaceId: 42,
        userId: 91,
        event: "billing_notification.operator_acknowledged",
        metadata: {
          notificationId: 81,
          audience: "operator",
          acknowledgedAt: now.toISOString(),
        },
      },
    ]);
  });

  it("fails closed without audit for wrong workspace, customer audience, or replay", async () => {
    const harness = acknowledgementDatabase(0);
    mocks.getDatabaseOrThrow.mockResolvedValue(harness.database);

    await expect(
      acknowledgeOperatorBillingNotification({
        workspaceId: 42,
        notificationId: 81,
        actorUserId: 91,
      })
    ).rejects.toBeInstanceOf(BillingNotificationInboxError);

    expect(harness.insertedValues).toEqual([]);
  });
});

function acknowledgementDatabase(resultAffectedRows: number) {
  let predicate: SQL | undefined;
  const updatedValues: unknown[] = [];
  const insertedValues: unknown[] = [];
  const tx = {
    update: vi.fn(() => ({
      set: vi.fn((values: unknown) => {
        updatedValues.push(values);
        return {
          where: vi.fn(async (value: SQL) => {
            predicate = value;
            return [{ affectedRows: resultAffectedRows }];
          }),
        };
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(async (values: unknown) => {
        insertedValues.push(values);
      }),
    })),
  };
  return {
    database: {
      transaction: vi.fn(
        async (callback: (transaction: typeof tx) => Promise<unknown>) =>
          callback(tx)
      ),
    },
    get predicate() {
      return predicate;
    },
    updatedValues,
    insertedValues,
  };
}
