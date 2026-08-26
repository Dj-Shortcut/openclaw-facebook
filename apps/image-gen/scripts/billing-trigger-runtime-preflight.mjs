import { randomUUID } from "node:crypto";

const billingModes = new Set(["test", "live"]);

export class BillingTriggerRuntimePreflightError extends Error {
  constructor(stage, cause) {
    super("Billing trigger runtime preflight failed", { cause });
    this.name = "BillingTriggerRuntimePreflightError";
    this.stage = stage;
  }
}

function asPreflightError(stage, error) {
  return error instanceof BillingTriggerRuntimePreflightError
    ? error
    : new BillingTriggerRuntimePreflightError(stage, error);
}

async function runStage(stage, action) {
  try {
    return await action();
  } catch (error) {
    throw asPreflightError(stage, error);
  }
}

/**
 * Exercises every production billing scheduler trigger through the DML-only
 * runtime principal. All writes use synthetic metadata and are rolled back.
 */
export async function assertBillingTriggerRuntimePreflight(connection, mode) {
  if (!billingModes.has(mode)) {
    throw new BillingTriggerRuntimePreflightError("configuration");
  }

  await runStage("session", async () => {
    await connection.query("SET SESSION time_zone='+00:00'");
    await connection.query("SET SESSION innodb_lock_wait_timeout=5");
    await connection.query("SET SESSION transaction_read_only=0");
    await connection.query(
      "SET SESSION sql_mode=IF(FIND_IN_SET('NO_AUTO_VALUE_ON_ZERO',@@SESSION.sql_mode)>0,@@SESSION.sql_mode,CONCAT_WS(',',@@SESSION.sql_mode,'NO_AUTO_VALUE_ON_ZERO'))"
    );
  });

  const deliveryId = randomUUID();
  const deduplicationKey = `runtime-trigger-preflight:${deliveryId}`;
  let transactionStarted = false;
  let operationError;
  try {
    await runStage("transaction", () => connection.beginTransaction());
    transactionStarted = true;

    const [rows] = await runStage("scheduler_lock", () =>
      connection.query(
        "SELECT `id`,`workspace_id` AS workspaceId FROM `billing_scheduler_tenants` WHERE `mode`=? AND `kind`='outbox' ORDER BY `workspace_id` LIMIT 1 FOR UPDATE",
        [mode]
      )
    );
    const scheduler = rows[0];
    if (
      rows.length !== 1 ||
      !Number.isSafeInteger(Number(scheduler?.id)) ||
      Number(scheduler?.id) <= 0 ||
      !Number.isSafeInteger(Number(scheduler?.workspaceId)) ||
      Number(scheduler?.workspaceId) <= 0
    ) {
      throw new BillingTriggerRuntimePreflightError("scheduler_registry");
    }

    const [schedulerUpdate] = await runStage("scheduler_update_trigger", () =>
      connection.query(
        "UPDATE `billing_scheduler_tenants` SET `next_due_at`=`next_due_at` WHERE `id`=? AND `workspace_id`=? AND `mode`=? AND `kind`='outbox'",
        [scheduler.id, scheduler.workspaceId, mode]
      )
    );
    if (Number(schedulerUpdate.affectedRows) !== 1) {
      throw new BillingTriggerRuntimePreflightError("scheduler_update_trigger");
    }

    const [outboxInsert] = await runStage("outbox_insert_trigger", () =>
      connection.query(
        "INSERT INTO `billing_outbox` (`id`,`delivery_id`,`workspace_id`,`mode`,`event_type`,`deduplication_key`,`payload`,`status`,`attempt_count`,`max_attempts`,`available_at`) VALUES (?,?,?,?,'manual_review',?,JSON_OBJECT('reason','runtime_trigger_preflight'),'pending',0,1,CURRENT_TIMESTAMP)",
        [0, deliveryId, scheduler.workspaceId, mode, deduplicationKey]
      )
    );
    if (Number(outboxInsert.affectedRows) !== 1) {
      throw new BillingTriggerRuntimePreflightError("outbox_insert_trigger");
    }

    const [outboxUpdate] = await runStage("outbox_update_trigger", () =>
      connection.query(
        "UPDATE `billing_outbox` SET `status`='failed',`last_error_code`='runtime_trigger_preflight' WHERE `delivery_id`=? AND `workspace_id`=? AND `mode`=? AND `status`='pending'",
        [deliveryId, scheduler.workspaceId, mode]
      )
    );
    if (Number(outboxUpdate.affectedRows) !== 1) {
      throw new BillingTriggerRuntimePreflightError("outbox_update_trigger");
    }
  } catch (error) {
    operationError = error;
  }

  if (transactionStarted) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      throw new BillingTriggerRuntimePreflightError(
        "rollback",
        operationError
          ? new AggregateError([operationError, rollbackError])
          : rollbackError
      );
    }
  }
  if (!transactionStarted && operationError) throw operationError;

  const [remaining] = await runStage("rollback_verification", () =>
    connection.query(
      "SELECT COUNT(*) AS count FROM `billing_outbox` WHERE `delivery_id`=?",
      [deliveryId]
    )
  );
  if (Number(remaining[0]?.count) !== 0) {
    throw new BillingTriggerRuntimePreflightError("rollback_verification");
  }
  if (operationError) throw operationError;
}

export function billingTriggerPreflightPublicErrorCode(error) {
  if (!(error instanceof BillingTriggerRuntimePreflightError)) {
    return "unexpected_error";
  }
  return new Set([
    "configuration",
    "session",
    "transaction",
    "scheduler_lock",
    "scheduler_registry",
    "scheduler_update_trigger",
    "outbox_insert_trigger",
    "outbox_update_trigger",
    "rollback",
    "rollback_verification",
  ]).has(error.stage)
    ? error.stage
    : "unexpected_error";
}
