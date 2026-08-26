import { describe, expect, it, vi } from "vitest";

import {
  assertBillingTriggerRuntimePreflight,
  BillingTriggerRuntimePreflightError,
  billingTriggerPreflightPublicErrorCode,
} from "./billing-trigger-runtime-preflight.mjs";

function successfulConnection(options = {}) {
  const scheduler = {
    enabled: 0,
    executionEpoch: 1,
    leaseToken: "synthetic-lease",
    leaseUntil: new Date("2030-01-01T00:10:00.000Z"),
    pendingWorkCount: 0,
    deadLetterCount: 0,
    nextDueAt: "2030-01-01 00:00:00",
  };
  let sentinelReadCount = 0;
  const queryImplementation = async statement => {
    if (statement.startsWith("SELECT (SELECT COUNT(*) FROM `workspaces`")) {
      sentinelReadCount += 1;
      const count = options.rollbackResidue && sentinelReadCount > 1 ? 1 : 0;
      return [[{ workspaceCount: count, schedulerCount: 0, outboxCount: 0 }]];
    }
    if (statement.startsWith("UPDATE `billing_scheduler_tenants`")) {
      scheduler.enabled = 1;
      scheduler.executionEpoch = options.schedulerTriggerMissing ? 77 : 2;
      if (!options.schedulerTriggerMissing) {
        scheduler.leaseToken = null;
        scheduler.leaseUntil = null;
      }
      return [{ affectedRows: 1 }];
    }
    if (statement.startsWith("INSERT INTO `billing_outbox`")) {
      if (!options.insertTriggerMissing) {
        scheduler.pendingWorkCount = 1;
        scheduler.nextDueAt = "2000-01-01 00:00:00";
      }
      return [{ affectedRows: 1 }];
    }
    if (statement.startsWith("UPDATE `billing_outbox`")) {
      if (!options.updateTriggerMissing) {
        scheduler.pendingWorkCount = 0;
        scheduler.deadLetterCount = 1;
      }
      return [{ affectedRows: 1 }];
    }
    if (statement.startsWith("SELECT `enabled`")) {
      return [[{ ...scheduler }]];
    }
    return [{ affectedRows: 1 }];
  };
  const query = vi.fn(queryImplementation);
  const rollback = vi.fn(async () => undefined);
  return {
    query,
    queryImplementation,
    beginTransaction: vi.fn(async () => undefined),
    rollback,
  };
}

describe("billing trigger runtime preflight", () => {
  it("exercises all three triggers and always verifies the rollback", async () => {
    const connection = successfulConnection();

    await expect(
      assertBillingTriggerRuntimePreflight(connection, "test")
    ).resolves.toBeUndefined();

    const statements = connection.query.mock.calls.map(([statement]) =>
      String(statement)
    );
    expect(
      statements.some(statement =>
        statement.startsWith("UPDATE `billing_scheduler_tenants`")
      )
    ).toBe(true);
    expect(
      statements.some(statement =>
        statement.startsWith("INSERT INTO `billing_outbox` (`id`,")
      )
    ).toBe(true);
    expect(
      statements.some(statement => statement.includes("NO_AUTO_VALUE_ON_ZERO"))
    ).toBe(true);
    expect(
      statements.some(statement =>
        statement.startsWith("INSERT INTO `workspaces` (`id`,")
      )
    ).toBe(true);
    expect(
      statements.some(statement =>
        statement.startsWith("INSERT INTO `billing_scheduler_tenants` (`id`,")
      )
    ).toBe(true);
    const outboxInsertCall = connection.query.mock.calls.find(([statement]) =>
      String(statement).startsWith("INSERT INTO `billing_outbox`")
    );
    expect(String(outboxInsertCall?.[0])).toContain("VALUES (0,?,0,?");
    expect(statements.join("\n")).not.toContain("ORDER BY `workspace_id`");
    expect(
      statements.some(statement =>
        statement.startsWith("UPDATE `billing_outbox`")
      )
    ).toBe(true);
    expect(connection.beginTransaction).toHaveBeenCalledOnce();
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(statements.at(-1)).toMatch(
      /^SELECT \(SELECT COUNT\(\*\) FROM `workspaces`/
    );
  });

  it.each([
    [
      "scheduler update",
      { schedulerTriggerMissing: true },
      "scheduler_update_effect",
    ],
    ["outbox insert", { insertTriggerMissing: true }, "outbox_insert_effect"],
    ["outbox update", { updateTriggerMissing: true }, "outbox_update_effect"],
  ])(
    "refuses a missing %s trigger by checking its exact effect",
    async (_label, options, stage) => {
      const connection = successfulConnection(options);

      await expect(
        assertBillingTriggerRuntimePreflight(connection, "test")
      ).rejects.toMatchObject({ stage });
      expect(connection.rollback).toHaveBeenCalledOnce();
    }
  );

  it("rolls back and reports only the failed trigger stage", async () => {
    const connection = successfulConnection();
    connection.query.mockImplementation(async statement => {
      if (statement.startsWith("INSERT INTO `billing_outbox`")) {
        throw Object.assign(new Error("sensitive principal and table"), {
          code: "ER_TABLEACCESS_DENIED_ERROR",
        });
      }
      return connection.queryImplementation(statement);
    });

    const error = await assertBillingTriggerRuntimePreflight(
      connection,
      "test"
    ).catch(value => value);

    expect(error).toBeInstanceOf(BillingTriggerRuntimePreflightError);
    expect(error.stage).toBe("outbox_insert_trigger");
    expect(billingTriggerPreflightPublicErrorCode(error)).toBe(
      "outbox_insert_trigger"
    );
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.query).toHaveBeenCalledWith(
      expect.stringMatching(/^SELECT \(SELECT COUNT\(\*\) FROM `workspaces`/),
      expect.anything()
    );
  });

  it("makes rollback failure dominant without exposing its cause", async () => {
    const connection = successfulConnection();
    connection.query.mockRejectedValueOnce(new Error("session outage"));
    const sessionError = await assertBillingTriggerRuntimePreflight(
      connection,
      "test"
    ).catch(value => value);
    expect(billingTriggerPreflightPublicErrorCode(sessionError)).toBe(
      "session"
    );

    const transactionConnection = successfulConnection();
    transactionConnection.query.mockImplementation(async statement => {
      if (statement.startsWith("UPDATE `billing_scheduler_tenants`")) {
        throw new Error("trigger failure");
      }
      return transactionConnection.queryImplementation(statement);
    });
    transactionConnection.rollback.mockRejectedValueOnce(
      new Error("rollback failure")
    );
    const rollbackError = await assertBillingTriggerRuntimePreflight(
      transactionConnection,
      "test"
    ).catch(value => value);
    expect(rollbackError.stage).toBe("rollback");
    expect(billingTriggerPreflightPublicErrorCode(rollbackError)).toBe(
      "rollback"
    );
  });

  it("rejects an unsupported mode before opening a transaction", async () => {
    const connection = successfulConnection();

    await expect(
      assertBillingTriggerRuntimePreflight(connection, "sandbox")
    ).rejects.toMatchObject({ stage: "configuration" });
    expect(connection.query).not.toHaveBeenCalled();
    expect(connection.beginTransaction).not.toHaveBeenCalled();
  });

  it("fails closed when rollback verification finds probe data", async () => {
    const connection = successfulConnection({ rollbackResidue: true });

    await expect(
      assertBillingTriggerRuntimePreflight(connection, "test")
    ).rejects.toMatchObject({ stage: "rollback_verification" });
    expect(connection.rollback).toHaveBeenCalledOnce();
  });
});
