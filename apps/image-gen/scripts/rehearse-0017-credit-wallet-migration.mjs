/* global process, URL */
import fs from "node:fs/promises";
import path from "node:path";

import mysql from "mysql2/promise";

const urlValue = process.env.MYSQL_REHEARSAL_URL?.trim();
if (!urlValue) throw new Error("MYSQL_REHEARSAL_URL is required");
const adminUrl = new URL(urlValue);
const drizzleDirectory = path.resolve("drizzle");
const migrationFiles = (await fs.readdir(drizzleDirectory))
  .filter(name => /^\d{4}_.+[.]sql$/.test(name))
  .sort();
const through0016 = migrationFiles.filter(
  name => Number(name.slice(0, 4)) <= 16
);
const migration0017Files = migrationFiles.filter(name =>
  name.startsWith("0017_credit_wallet_expand")
);
if (
  migration0017Files.length !== 1 ||
  through0016.at(-1)?.startsWith("0016_") !== true
) {
  throw new Error("exact 0016 -> 0017 migration chain is required");
}
const migration0017 = await readStatements(migration0017Files[0]);
const through0017 = [...through0016, migration0017Files[0]];
assert(migration0017.length === 49, "0017 must contain 49 reviewed statements");
assert(
  migration0017[0].startsWith(
    "CREATE TEMPORARY TABLE `credit_0017_legacy_effect_preflight`"
  ) &&
    migration0017[1] ===
      "DROP TEMPORARY TABLE `credit_0017_legacy_effect_preflight`;" &&
    migration0017[2] ===
    "ALTER TABLE `payment_ledger`\n\tADD CONSTRAINT `payment_ledger_exact_payment_scope_unique` UNIQUE(`id`,`workspace_id`,`mode`,`mollie_payment_id`);",
  "0017 must prove legacy ownership before the first permanent DDL"
);

const expectedTables = ["credit_ledger", "credit_reservations", "credit_wallets"];
const expectedProcedures = [
  "credit_apply_chargeback_debit",
  "credit_apply_chargeback_restore",
  "credit_apply_refund_debit",
  "credit_commit_reservation",
  "credit_consume_checkout_capability",
  "credit_create_reservation_hold",
  "credit_create_wallet",
  "credit_erase_wallet",
  "credit_expire_reservation",
  "credit_grant_purchase",
  "credit_release_reservation",
  "credit_scrub_terminal_reservation",
];
const expectedTriggers = Array.from(
  (await fs.readFile(path.join(drizzleDirectory, migration0017Files[0]), "utf8")).matchAll(
    /CREATE TRIGGER `([^`]+)`/g
  ),
  match => match[1]
).sort();
assert(expectedTriggers.length === 14, "0017 must contain 14 reviewed triggers");

const databases = {
  collision: "leaderbot_0017_credit_wallet_collision_rehearsal",
  fresh: "leaderbot_0017_credit_wallet_fresh_rehearsal",
  locked: "leaderbot_0017_credit_wallet_locked_rehearsal",
  upgrade: "leaderbot_0017_credit_wallet_upgrade_rehearsal",
};
const admin = await mysql.createConnection(connectionOptions());

try {
  const [[version]] = await admin.query(
    "SELECT VERSION() AS version,@@innodb_page_size AS pageSize,@@GLOBAL.binlog_format AS binlogFormat"
  );
  assert(
    String(version.version) === "8.4.11",
    `MySQL 8.4.11 is required, received ${String(version.version)}`
  );
  assert(
    [8192, 16384].includes(Number(version.pageSize)),
    `0017 requires an 8KB or 16KB InnoDB page size, received ${String(version.pageSize)}`
  );
  assert(
    String(version.binlogFormat) === "ROW",
    `0017 credit procedures require binlog_format=ROW, received ${String(version.binlogFormat)}`
  );
  for (const database of Object.values(databases)) {
    assert(
      /^leaderbot_0017_credit_wallet_(?:collision|fresh|locked|upgrade)_rehearsal$/.test(database),
      "unsafe rehearsal database name"
    );
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.query(
      `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`
    );
  }

  await withDatabase(databases.locked, connection =>
    applyFiles(connection, through0016)
  );
  const lockHolder = await connectDatabase(databases.locked);
  const lockContender = await connectDatabase(databases.locked);
  try {
    await lockHolder.query("LOCK TABLES `payment_ledger` WRITE");
    await lockContender.query("SET SESSION lock_wait_timeout=1");
    let lockError;
    try {
      await lockContender.query(migration0017[0]);
    } catch (error) {
      lockError = error;
    }
    assert(
      lockError?.code === "ER_LOCK_WAIT_TIMEOUT",
      "first 0017 prerequisite must fail within the existing metadata-lock bound"
    );
  } finally {
    await lockHolder.query("UNLOCK TABLES");
    await lockContender.end();
    await lockHolder.end();
  }
  await withDatabase(databases.locked, async connection => {
    const [[shape]] = await connection.query(
      "SELECT COUNT(*) AS tableCount FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'credit\\_%'"
    );
    assert(
      Number(shape.tableCount) === 0,
      "blocked prerequisite must leave zero permanent credit tables"
    );
  });

  await withDatabase(databases.upgrade, async connection => {
    await applyFiles(connection, through0016);
    await connection.query(
      "INSERT INTO `workspaces` (`id`,`name`,`slug`) VALUES (1701,'Credit upgrade','credit-upgrade')"
    );
    await connection.query(
      "INSERT INTO `payment_ledger` (`mollie_payment_id`,`workspace_id`,`mode`,`gross_amount`,`currency`,`status`,`refunds`,`chargebacks`,`observed_snapshot_hash`,`paid_effect_applied`,`occurred_at`) VALUES ('tr_legacy_recurring_001',1701,'test','19.00','EUR','open',JSON_ARRAY(),JSON_ARRAY(),REPEAT('a',64),0,'2026-08-28 00:00:00')"
    );
    await applyStatements(connection, migration0017);
    await connection.query(
      "UPDATE `payment_ledger` SET `status`='paid',`observed_snapshot_hash`=REPEAT('b',64),`occurred_at`='2026-08-28 00:01:00',`paid_effect_applied`=1 WHERE `mollie_payment_id`='tr_legacy_recurring_001'"
    );
    const [[legacy]] = await connection.query(
      "SELECT `paid_effect_applied` AS applied,`payment_effect_owner_kind` AS ownerKind,`occurred_at` AS occurredAt FROM `payment_ledger` WHERE `mollie_payment_id`='tr_legacy_recurring_001'"
    );
    assert(
      Number(legacy.applied) === 1 && legacy.ownerKind === null,
      "0016-style ownerless recurring paid-effect write remains compatible"
    );
    await assertInstalledShape(connection);
  });

  await withDatabase(databases.collision, async connection => {
    await applyFiles(connection, through0016);
    await connection.query(
      "INSERT INTO `workspaces` (`id`,`name`,`slug`) VALUES (1711,'Credit collision A','credit-collision-a'),(1712,'Credit collision B','credit-collision-b')"
    );
    await connection.query(
      "INSERT INTO `billing_intents` (`intent_id`,`workspace_id`,`mode`,`plan_code`,`kind`,`expected_amount`,`currency`,`interval`,`entitlements`,`mollie_description`,`status`,`mollie_payment_id`,`idempotency_key`,`checkout_scope_key`,`messenger_sender_user_key`,`messenger_page_id`,`billing_profile_version`,`authorization_epoch`) VALUES ('17120000-0000-4000-8000-000000000001',1712,'test','startpilot','startpilot_purchase','19.00','EUR','one-time',JSON_OBJECT('aiAnswers',300),'Legacy cross-workspace collision','paid','tr_legacy_cross_workspace','collision-intent-key','collision-intent-scope','collision-user','collision-page',0,1)"
    );
    await connection.query(
      "INSERT INTO `payment_ledger` (`mollie_payment_id`,`workspace_id`,`mode`,`gross_amount`,`currency`,`status`,`refunds`,`chargebacks`,`observed_snapshot_hash`,`paid_effect_applied`,`occurred_at`) VALUES ('tr_legacy_cross_workspace',1711,'test','19.00','EUR','paid',JSON_ARRAY(),JSON_ARRAY(),REPEAT('c',64),1,'2026-08-28 00:00:00')"
    );
    let collisionError;
    try {
      await applyStatements(connection, migration0017);
    } catch (error) {
      collisionError = error;
    }
    assert(
      collisionError?.code === "ER_CHECK_CONSTRAINT_VIOLATED",
      "cross-workspace legacy payment ownership must fail before credit DDL"
    );
    const [[shape]] = await connection.query(
      "SELECT COUNT(*) AS tableCount FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'credit\\_%'"
    );
    assert(
      Number(shape.tableCount) === 0,
      "legacy ownership collision must leave zero permanent credit tables"
    );
  });

  await withDatabase(databases.fresh, async connection => {
    await applyFiles(connection, through0017);
    await assertInstalledShape(connection);
    await assertRuntimePrivilegeBoundary(connection, databases.fresh);
  });

  process.stdout.write(
    `0017 credit-wallet rehearsal passed on ${String(version.version)} with ${Number(version.pageSize) / 1024}KB pages: bounded metadata-lock failure, cross-workspace ownership rejection, fresh chain, exact 0016 upgrade, legacy writer compatibility, runtime SELECT+EXECUTE boundary, ${migration0017.length} statements.\n`
  );
} finally {
  for (const database of Object.values(databases)) {
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
  }
  await admin.end();
}

async function assertInstalledShape(connection) {
  const [tables] = await connection.query(
    "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'credit\\_%' ORDER BY TABLE_NAME"
  );
  assert(
    JSON.stringify(tables.map(row => row.name)) === JSON.stringify(expectedTables),
    "0017 must install exactly three credit tables"
  );
  const [procedures] = await connection.query(
    "SELECT ROUTINE_NAME AS name,SECURITY_TYPE AS securityType FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE() AND ROUTINE_NAME LIKE 'credit\\_%' ORDER BY ROUTINE_NAME"
  );
  assert(
    JSON.stringify(procedures.map(row => row.name)) ===
      JSON.stringify(expectedProcedures),
    "0017 procedure inventory changed"
  );
  assert(
    procedures.every(row => row.securityType === "DEFINER"),
    "every credit procedure must use SQL SECURITY DEFINER"
  );
  const [triggers] = await connection.query(
    "SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME IN (?) ORDER BY TRIGGER_NAME",
    [expectedTriggers]
  );
  assert(
    JSON.stringify(triggers.map(row => row.name)) ===
      JSON.stringify(expectedTriggers),
    "0017 trigger inventory changed"
  );
}

async function assertRuntimePrivilegeBoundary(connection, database) {
  const runtimeUser = "lb_credit_rt_rehearsal";
  const runtimePassword = "credit-runtime-rehearsal-only";
  const walletId = "17170000-0000-4000-8000-000000000001";
  const userKey = `u2.k1.${"a".repeat(64)}`;
  const financialSubjectRef = "b".repeat(64);
  await admin.query(`DROP USER IF EXISTS '${runtimeUser}'@'localhost'`);
  try {
    await connection.query(
      "INSERT INTO `workspaces` (`id`,`name`,`slug`) VALUES (1717,'Credit privilege','credit-privilege')"
    );
    await connection.query(
      "INSERT INTO `billing_execution_controls` (`workspace_id`,`mode`,`commercial_enabled`,`authorization_epoch`) VALUES (1717,'test',true,2)"
    );
    await connection.query(
      "INSERT INTO `channelConnections` (`id`,`workspaceId`,`channel`,`status`,`externalId`,`bindingEpoch`) VALUES (1717,1717,'facebook_messenger','connected','credit-privilege-page',1)"
    );
    await connection.query(
      "INSERT INTO `messenger_privacy_subjects` (`workspace_id`,`channel_connection_id`,`user_key`,`privacy_epoch`,`status`) VALUES (1717,1717,?,1,'active')",
      [userKey]
    );
    await admin.query(
      `CREATE USER '${runtimeUser}'@'localhost' IDENTIFIED BY '${runtimePassword}'`
    );
    await admin.query(
      `GRANT SELECT ON \`${database}\`.* TO '${runtimeUser}'@'localhost'`
    );
    for (const procedure of expectedProcedures) {
      await admin.query(
        `GRANT EXECUTE ON PROCEDURE \`${database}\`.\`${procedure}\` TO '${runtimeUser}'@'localhost'`
      );
    }
    const runtime = await mysql.createConnection({
      ...connectionOptions(),
      database,
      password: runtimePassword,
      user: runtimeUser,
    });
    try {
      await runtime.query(
        "CALL `credit_create_wallet`(?,1717,'test',1717,1,1,?,?)",
        [walletId, userKey, financialSubjectRef]
      );
      const [[wallet]] = await runtime.query(
        "SELECT `credit_balance` AS balance FROM `credit_wallets` WHERE `wallet_id`=?",
        [walletId]
      );
      assert(Number(wallet.balance) === 0, "runtime procedure must create a zero-balance wallet");
      for (const forbidden of [
        ["UPDATE `credit_wallets` SET `credit_balance`=1 WHERE `wallet_id`=?", [walletId]],
        ["UPDATE `payment_ledger` SET `paid_effect_applied`=1 WHERE 1=0", []],
        ["DELETE FROM `credit_reservations` WHERE 1=0", []],
        ["INSERT INTO `credit_ledger` (`entry_id`) VALUES ('17170000-0000-4000-8000-000000000002')", []],
      ]) {
        let denied;
        try {
          await runtime.query(forbidden[0], forbidden[1]);
        } catch (error) {
          denied = error;
        }
        assert(
          denied?.code === "ER_TABLEACCESS_DENIED_ERROR",
          "runtime direct financial DML must be denied"
        );
      }
    } finally {
      await runtime.end();
    }
  } finally {
    await admin.query(`DROP USER IF EXISTS '${runtimeUser}'@'localhost'`);
  }
}

async function withDatabase(database, action) {
  const connection = await connectDatabase(database);
  try {
    await connection.query("SET SESSION sql_require_primary_key=ON");
    await action(connection);
  } finally {
    await connection.end();
  }
}

async function connectDatabase(database) {
  return mysql.createConnection({ ...connectionOptions(), database });
}

function connectionOptions() {
  return {
    host: adminUrl.hostname,
    port: Number(adminUrl.port || 3306),
    user: decodeURIComponent(adminUrl.username),
    password: decodeURIComponent(adminUrl.password),
    socketPath: adminUrl.searchParams.get("socket") || undefined,
  };
}

async function readStatements(filename) {
  const sql = await fs.readFile(path.join(drizzleDirectory, filename), "utf8");
  return sql
    .split("--> statement-breakpoint")
    .map(statement => statement.trim())
    .filter(Boolean);
}

async function applyFiles(connection, filenames) {
  for (const filename of filenames) {
    await applyStatements(connection, await readStatements(filename));
  }
}

async function applyStatements(connection, statements) {
  for (const statement of statements) await connection.query(statement);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
