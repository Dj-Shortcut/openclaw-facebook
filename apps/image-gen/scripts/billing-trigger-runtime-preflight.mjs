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

  const probeId = randomUUID();
  const deliveryId = randomUUID();
  const schedulerLeaseToken = randomUUID();
  const workspaceName = `leaderbot-runtime-trigger-preflight-${probeId}`;
  const deduplicationKey = `runtime-trigger-preflight:${deliveryId}`;
  let transactionStarted = false;
  let operationError;
  try {
    await runStage("transaction", () => connection.beginTransaction());
    transactionStarted = true;

    const [sentinelRows] = await runStage("sentinel_absence", () =>
      connection.query(
        "SELECT (SELECT COUNT(*) FROM `workspaces` WHERE `id`=0) AS workspaceCount,(SELECT COUNT(*) FROM `billing_scheduler_tenants` WHERE `id`=0 OR `workspace_id`=0) AS schedulerCount,(SELECT COUNT(*) FROM `billing_outbox` WHERE `id`=0 OR `workspace_id`=0) AS outboxCount"
      )
    );
    if (
      sentinelRows.length !== 1 ||
      Number(sentinelRows[0]?.workspaceCount) !== 0 ||
      Number(sentinelRows[0]?.schedulerCount) !== 0 ||
      Number(sentinelRows[0]?.outboxCount) !== 0
    ) {
      throw new BillingTriggerRuntimePreflightError("sentinel_absence");
    }

    const [workspaceInsert] = await runStage("workspace_insert", () =>
      connection.query(
        "INSERT INTO `workspaces` (`id`,`name`,`slug`) VALUES (0,?,?)",
        [workspaceName, workspaceName]
      )
    );
    if (Number(workspaceInsert.affectedRows) !== 1) {
      throw new BillingTriggerRuntimePreflightError("workspace_insert");
    }

    const [schedulerInsert] = await runStage("scheduler_insert", () =>
      connection.query(
        "INSERT INTO `billing_scheduler_tenants` (`id`,`workspace_id`,`mode`,`kind`,`enabled`,`execution_epoch`,`pending_work_count`,`dead_letter_count`,`next_due_at`,`lease_token`,`lease_until`) VALUES (0,0,?,'outbox',false,1,0,0,'2030-01-01 00:00:00',?,'2030-01-01 00:10:00')",
        [mode, schedulerLeaseToken]
      )
    );
    if (Number(schedulerInsert.affectedRows) !== 1) {
      throw new BillingTriggerRuntimePreflightError("scheduler_insert");
    }

    const [schedulerUpdate] = await runStage("scheduler_update_trigger", () =>
      connection.query(
        "UPDATE `billing_scheduler_tenants` SET `enabled`=true,`execution_epoch`=77 WHERE `id`=0 AND `workspace_id`=0 AND `mode`=? AND `kind`='outbox' AND `enabled`=false",
        [mode]
      )
    );
    if (Number(schedulerUpdate.affectedRows) !== 1) {
      throw new BillingTriggerRuntimePreflightError("scheduler_update_trigger");
    }
    const [schedulerUpdateRows] = await runStage(
      "scheduler_update_effect",
      () => readSyntheticScheduler(connection, mode)
    );
    assertSyntheticSchedulerEffect(
      schedulerUpdateRows,
      {
        enabled: 1,
        executionEpoch: 2,
        pendingWorkCount: 0,
        deadLetterCount: 0,
        nextDueAt: "2030-01-01 00:00:00",
      },
      "scheduler_update_effect"
    );

    const [outboxInsert] = await runStage("outbox_insert_trigger", () =>
      connection.query(
        "INSERT INTO `billing_outbox` (`id`,`delivery_id`,`workspace_id`,`mode`,`event_type`,`deduplication_key`,`payload`,`status`,`attempt_count`,`max_attempts`,`available_at`) VALUES (0,?,0,?,'manual_review',?,JSON_OBJECT('reason','runtime_trigger_preflight'),'pending',0,1,'2000-01-01 00:00:00')",
        [deliveryId, mode, deduplicationKey]
      )
    );
    if (Number(outboxInsert.affectedRows) !== 1) {
      throw new BillingTriggerRuntimePreflightError("outbox_insert_trigger");
    }
    const [outboxInsertRows] = await runStage("outbox_insert_effect", () =>
      readSyntheticScheduler(connection, mode)
    );
    assertSyntheticSchedulerEffect(
      outboxInsertRows,
      {
        enabled: 1,
        executionEpoch: 2,
        pendingWorkCount: 1,
        deadLetterCount: 0,
        nextDueAt: "2000-01-01 00:00:00",
      },
      "outbox_insert_effect"
    );

    const [outboxUpdate] = await runStage("outbox_update_trigger", () =>
      connection.query(
        "UPDATE `billing_outbox` SET `status`='failed',`last_error_code`='runtime_trigger_preflight' WHERE `id`=0 AND `delivery_id`=? AND `workspace_id`=0 AND `mode`=? AND `status`='pending'",
        [deliveryId, mode]
      )
    );
    if (Number(outboxUpdate.affectedRows) !== 1) {
      throw new BillingTriggerRuntimePreflightError("outbox_update_trigger");
    }
    const [outboxUpdateRows] = await runStage("outbox_update_effect", () =>
      readSyntheticScheduler(connection, mode)
    );
    assertSyntheticSchedulerEffect(
      outboxUpdateRows,
      {
        enabled: 1,
        executionEpoch: 2,
        pendingWorkCount: 0,
        deadLetterCount: 1,
        nextDueAt: "2000-01-01 00:00:00",
      },
      "outbox_update_effect"
    );
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
      "SELECT (SELECT COUNT(*) FROM `workspaces` WHERE `id`=0 OR `slug`=?) AS workspaceCount,(SELECT COUNT(*) FROM `billing_scheduler_tenants` WHERE `id`=0 OR `workspace_id`=0) AS schedulerCount,(SELECT COUNT(*) FROM `billing_outbox` WHERE `id`=0 OR `workspace_id`=0 OR `delivery_id`=?) AS outboxCount",
      [workspaceName, deliveryId]
    )
  );
  if (
    remaining.length !== 1 ||
    Number(remaining[0]?.workspaceCount) !== 0 ||
    Number(remaining[0]?.schedulerCount) !== 0 ||
    Number(remaining[0]?.outboxCount) !== 0
  ) {
    throw new BillingTriggerRuntimePreflightError("rollback_verification");
  }
  if (operationError) throw operationError;
}

function readSyntheticScheduler(connection, mode) {
  return connection.query(
    "SELECT `enabled`,`execution_epoch` AS executionEpoch,`lease_token` AS leaseToken,`lease_until` AS leaseUntil,`pending_work_count` AS pendingWorkCount,`dead_letter_count` AS deadLetterCount,DATE_FORMAT(`next_due_at`,'%Y-%m-%d %H:%i:%s') AS nextDueAt FROM `billing_scheduler_tenants` WHERE `id`=0 AND `workspace_id`=0 AND `mode`=? AND `kind`='outbox'",
    [mode]
  );
}

function assertSyntheticSchedulerEffect(rows, expected, stage) {
  const row = rows[0];
  if (
    rows.length !== 1 ||
    Number(row?.enabled) !== expected.enabled ||
    Number(row?.executionEpoch) !== expected.executionEpoch ||
    row?.leaseToken !== null ||
    row?.leaseUntil !== null ||
    Number(row?.pendingWorkCount) !== expected.pendingWorkCount ||
    Number(row?.deadLetterCount) !== expected.deadLetterCount ||
    row?.nextDueAt !== expected.nextDueAt
  ) {
    throw new BillingTriggerRuntimePreflightError(stage);
  }
}

export function billingTriggerPreflightPublicErrorCode(error) {
  if (!(error instanceof BillingTriggerRuntimePreflightError)) {
    return "unexpected_error";
  }
  return new Set([
    "configuration",
    "session",
    "transaction",
    "sentinel_absence",
    "workspace_insert",
    "scheduler_insert",
    "scheduler_update_trigger",
    "scheduler_update_effect",
    "outbox_insert_trigger",
    "outbox_insert_effect",
    "outbox_update_trigger",
    "outbox_update_effect",
    "rollback",
    "rollback_verification",
  ]).has(error.stage)
    ? error.stage
    : "unexpected_error";
}
