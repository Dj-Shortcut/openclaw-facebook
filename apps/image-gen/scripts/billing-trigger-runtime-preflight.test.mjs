import { describe, expect, it, vi } from "vitest";

import {
  assertBillingTriggerRuntimePreflight,
  BillingTriggerRuntimePreflightError,
  billingTriggerPreflightPublicErrorCode,
} from "./billing-trigger-runtime-preflight.mjs";

function successfulConnection() {
  const query = vi.fn(async statement => {
    if (statement.startsWith("SELECT `id`,`workspace_id`")) {
      return [[{ id: 81, workspaceId: 42 }]];
    }
    if (statement.startsWith("SELECT COUNT(*)")) {
      return [[{ count: 0 }]];
    }
    return [{ affectedRows: 1 }];
  });
  return {
    query,
    beginTransaction: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
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
    const insertCall = connection.query.mock.calls.find(([statement]) =>
      String(statement).startsWith("INSERT INTO `billing_outbox`")
    );
    expect(insertCall?.[1]?.[0]).toBe(0);
    expect(
      statements.some(statement =>
        statement.startsWith("UPDATE `billing_outbox`")
      )
    ).toBe(true);
    expect(connection.beginTransaction).toHaveBeenCalledOnce();
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(statements.at(-1)).toMatch(/^SELECT COUNT\(\*\)/);
  });

  it("rolls back and reports only the failed trigger stage", async () => {
    const connection = successfulConnection();
    connection.query.mockImplementation(async statement => {
      if (statement.startsWith("SELECT `id`,`workspace_id`")) {
        return [[{ id: 81, workspaceId: 42 }]];
      }
      if (statement.startsWith("INSERT INTO `billing_outbox`")) {
        throw Object.assign(new Error("sensitive principal and table"), {
          code: "ER_TABLEACCESS_DENIED_ERROR",
        });
      }
      if (statement.startsWith("SELECT COUNT(*)")) {
        return [[{ count: 0 }]];
      }
      return [{ affectedRows: 1 }];
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
      expect.stringMatching(/^SELECT COUNT\(\*\)/),
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
      if (statement.startsWith("SELECT `id`,`workspace_id`")) {
        return [[{ id: 81, workspaceId: 42 }]];
      }
      if (statement.startsWith("UPDATE `billing_scheduler_tenants`")) {
        throw new Error("trigger failure");
      }
      return [{ affectedRows: 1 }];
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
    const connection = successfulConnection();
    connection.query.mockImplementation(async statement => {
      if (statement.startsWith("SELECT `id`,`workspace_id`")) {
        return [[{ id: 81, workspaceId: 42 }]];
      }
      if (statement.startsWith("SELECT COUNT(*)")) {
        return [[{ count: 1 }]];
      }
      return [{ affectedRows: 1 }];
    });

    await expect(
      assertBillingTriggerRuntimePreflight(connection, "test")
    ).rejects.toMatchObject({ stage: "rollback_verification" });
    expect(connection.rollback).toHaveBeenCalledOnce();
  });
});
