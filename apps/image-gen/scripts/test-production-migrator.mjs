/* global process, URL */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import {
  cleanupMigrationConnection,
  combineMigrationErrors,
  assertProductionSchemaContractManifest,
  loadAndVerifyMigrationManifest,
  migrationLockName,
  runProductionMigrations,
} from "./migrate-production.mjs";
import {
  normalizeShowCreate,
  normalizeSqlOutsideQuotedValues,
  assertProductionMigrationRuntime,
  assertProductionRuntimeValues,
  assertTriggerGrantScope,
  canonicalTriggerTuple,
  productionSchemaSqlMode,
  sha256,
} from "./production-schema-contract.mjs";

await testCleanupContracts();
testSchemaDigestContracts();
await testContractManifestBinding();

const adminUrlValue = process.env.MYSQL_REHEARSAL_URL?.trim();
if (!adminUrlValue) throw new Error("MYSQL_REHEARSAL_URL is required");
const adminUrl = new URL(adminUrlValue);
const appDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const databases = [
  "leaderbot_production_migrator_concurrency",
  "leaderbot_production_migrator_upgrade",
  "leaderbot_production_migrator_upgrade_with_state",
  "leaderbot_production_migrator_short_history",
  "leaderbot_production_migrator_drifted_base",
  "leaderbot_production_migrator_partial",
  "leaderbot_production_migrator_partial_middle",
  "leaderbot_production_migrator_partial_late",
  "leaderbot_production_migrator_malformed_state",
  "leaderbot_production_migrator_historyless_state",
  "leaderbot_production_migrator_wrong_runtime",
  "leaderbot_production_migrator_empty_history",
  "leaderbot_production_migrator_first_unsupported_partial",
  "leaderbot_production_migrator_advanced_0014_history",
  "leaderbot_production_migrator_poisoned_session",
  "leaderbot_production_migrator_primary_key_fresh",
  "leaderbot_production_migrator_primary_key_upgrade",
  "leaderbot_production_migrator_prepared_capacity",
  "leaderbot_production_migrator_single_prepared_slot",
];
const admin = await mysql.createConnection({
  host: adminUrl.hostname,
  port: Number(adminUrl.port || 3306),
  user: decodeURIComponent(adminUrl.username),
  password: decodeURIComponent(adminUrl.password),
});

try {
  for (const database of databases) {
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.query(
      `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`
    );
  }
  await admin.query(
    `ALTER DATABASE \`${databases[10]}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`
  );

  const concurrentUrl = databaseUrl(databases[0]);
  const [[showCreateDefaults]] = await admin.query(
    "SELECT @@GLOBAL.sql_quote_show_create AS quoteShowCreate,@@GLOBAL.show_create_table_verbosity AS tableVerbosity"
  );
  let results;
  try {
    await admin.query("SET GLOBAL sql_quote_show_create=0");
    await admin.query("SET GLOBAL show_create_table_verbosity=0");
    results = await Promise.all([
      runProductionMigrations({ databaseUrl: concurrentUrl }),
      runProductionMigrations({ databaseUrl: concurrentUrl }),
    ]);
  } finally {
    await admin.query(
      `SET GLOBAL sql_quote_show_create=${Number(showCreateDefaults.quoteShowCreate)}`
    );
    await admin.query(
      `SET GLOBAL show_create_table_verbosity=${Number(showCreateDefaults.tableVerbosity)}`
    );
  }
  assert(
    results.every(result => result.appliedCount === 16),
    "concurrent apply"
  );
  const beforeNoop = await withDatabaseResult(databases[0], connection =>
    captureSchemaFingerprint(connection)
  );
  const idempotent = await runProductionMigrations({
    databaseUrl: concurrentUrl,
  });
  assert(idempotent.appliedCount === 16, "already-complete idempotent apply");
  const afterNoop = await withDatabaseResult(databases[0], connection =>
    captureSchemaFingerprint(connection)
  );
  assert(
    beforeNoop === afterNoop,
    "complete 0015 no-op leaves schema/history unchanged"
  );

  const { migrations: manifest } = await loadAndVerifyMigrationManifest();
  const finalStatements = await readMigrationStatements(manifest.at(-1));
  await withDatabase(databases[14], async connection => {
    await connection.query("SET SESSION sql_safe_updates=1");
    await connection.query("SET SESSION unique_checks=0");
    await connection.query("SET SESSION transaction_read_only=1");
    await connection.query("SET SESSION timestamp=1700000000");
    await connection.query("SET SESSION sql_select_limit=10");
    await connection.query("SET SESSION sql_big_selects=0");
    await assertProductionMigrationRuntime(connection);
    // insert_id is intentionally never SET by the runner: setting it to zero
    // still forces the next AUTO_INCREMENT value to zero in MySQL. A reused
    // connection with a pending explicit insert id must therefore be refused.
    await connection.query("SET SESSION insert_id=77");
    await expectFailure(
      assertProductionMigrationRuntime(connection),
      "poisoned insert id",
      "production migration session contract mismatch"
    );
  });
  const canonicalizedSession = await runProductionMigrations({
    databaseUrl: databaseUrl(databases[14]),
  });
  assert(
    canonicalizedSession.appliedCount === 16,
    "poisoned session values are canonicalized before fresh migration"
  );

  const [[primaryKeyDefault]] = await admin.query(
    "SELECT @@GLOBAL.sql_require_primary_key AS value"
  );
  try {
    await admin.query("SET GLOBAL sql_require_primary_key=1");
    const primaryKeyFresh = await runProductionMigrations({
      databaseUrl: databaseUrl(databases[15]),
    });
    assert(
      primaryKeyFresh.appliedCount === 16,
      "fresh migration supports required primary keys"
    );
    await withDatabase(databases[16], connection =>
      applyMigrationPrefix(connection, manifest.slice(0, -1))
    );
    const primaryKeyUpgrade = await runProductionMigrations({
      databaseUrl: databaseUrl(databases[16]),
    });
    assert(
      primaryKeyUpgrade.appliedCount === 16,
      "0014 upgrade supports required primary keys"
    );
  } finally {
    await admin.query(
      `SET GLOBAL sql_require_primary_key=${Number(primaryKeyDefault.value)}`
    );
  }

  const [[preparedDefault]] = await admin.query(
    "SELECT @@GLOBAL.max_prepared_stmt_count AS value"
  );
  try {
    await admin.query("SET GLOBAL max_prepared_stmt_count=0");
    await expectFailure(
      runProductionMigrations({ databaseUrl: databaseUrl(databases[17]) }),
      "fresh migration without prepared statement capacity",
      "MySQL prepared statement capacity is exhausted"
    );
  } finally {
    await admin.query(
      `SET GLOBAL max_prepared_stmt_count=${Number(preparedDefault.value)}`
    );
  }
  await withDatabase(databases[17], connection =>
    assertNoApplicationTables(connection, "prepared capacity refusal")
  );
  try {
    const [[preparedUsed]] = await admin.query(
      "SHOW GLOBAL STATUS LIKE 'Prepared_stmt_count'"
    );
    await admin.query(
      `SET GLOBAL max_prepared_stmt_count=${Number(preparedUsed.Value) + 1}`
    );
    await expectFailure(
      runProductionMigrations({ databaseUrl: databaseUrl(databases[18]) }),
      "fresh migration with one free prepared statement slot",
      "MySQL prepared statement capacity is exhausted"
    );
  } finally {
    await admin.query(
      `SET GLOBAL max_prepared_stmt_count=${Number(preparedDefault.value)}`
    );
  }
  await withDatabase(databases[18], connection =>
    assertNoApplicationTables(connection, "single prepared slot refusal")
  );
  await testCompletedSchemaRefusals(databases[0], finalStatements);
  await testHistoryRefusals(databases[0], manifest);
  await withDatabase(databases[1], async connection => {
    await applyMigrationPrefix(connection, manifest.slice(0, -1));
    await applyStatements(connection, finalStatements.slice(0, 3));
  });
  const upgraded = await runProductionMigrations({
    databaseUrl: databaseUrl(databases[1]),
  });
  assert(upgraded.appliedCount === 16, "clean 0014 to 0015 upgrade");

  await withDatabase(databases[2], async connection => {
    await applyMigrationPrefix(connection, manifest.slice(0, -1));
    await applyStatements(connection, finalStatements.slice(0, 4));
    await connection.query(
      "INSERT INTO `messengerState` (`psid`,`userKey`) VALUES ('migration-preserved-psid','migration-preserved-key')"
    );
  });
  const upgradedWithState = await runProductionMigrations({
    databaseUrl: databaseUrl(databases[2]),
  });
  assert(
    upgradedWithState.appliedCount === 16,
    "0014 with exact legacy state to 0015 upgrade"
  );
  await withDatabase(databases[2], async connection => {
    const [[row]] = await connection.query(
      "SELECT COUNT(*) AS count FROM `messengerState` WHERE `userKey`='migration-preserved-key'"
    );
    assert(Number(row.count) === 1, "messengerState partial row preserved");
  });

  await withDatabase(databases[3], async connection => {
    await applyMigrationPrefix(connection, manifest.slice(0, 1));
  });
  await expectFailure(
    runProductionMigrations({ databaseUrl: databaseUrl(databases[3]) }),
    "unsupported short history",
    "unsupported migration history length"
  );

  await withDatabase(databases[4], async connection => {
    await applyMigrationPrefix(connection, manifest.slice(0, -1));
    await createLegacyMessengerState(connection);
    await connection.query(
      "ALTER TABLE `billing_outbox` MODIFY COLUMN `attempt_count` bigint NOT NULL DEFAULT 0"
    );
  });
  await expectFailure(
    runProductionMigrations({ databaseUrl: databaseUrl(databases[4]) }),
    "drifted 0014 schema",
    "0014 schema fingerprint mismatch"
  );
  await withDatabase(databases[4], async connection => {
    await connection.query(
      "ALTER TABLE `billing_outbox` MODIFY COLUMN `attempt_count` int NOT NULL DEFAULT 0"
    );
    await connection.query(
      "CREATE TRIGGER `billing_outbox_wake_scheduler_after_insert` AFTER INSERT ON `billing_outbox` FOR EACH ROW SET @unexpected_trigger = 1"
    );
  });
  await expectFailure(
    runProductionMigrations({ databaseUrl: databaseUrl(databases[4]) }),
    "same-name wrong trigger before 0015",
    "0014 schema fingerprint mismatch"
  );
  await withDatabase(databases[4], connection =>
    connection.query(
      "DROP TRIGGER `billing_outbox_wake_scheduler_after_insert`"
    )
  );

  await withDatabase(databases[0], async connection => {
    await connection.query(
      "UPDATE `__drizzle_migrations` SET `hash`=REPEAT('0',64) WHERE `created_at`=?",
      [manifest.at(-1).when]
    );
  });
  await expectFailure(
    runProductionMigrations({
      databaseUrl: concurrentUrl,
      lockTimeoutSeconds: 0,
    }),
    "applied hash mismatch",
    "applied migration hash/order mismatch"
  );

  await withDatabase(databases[5], async connection => {
    await connection.query(
      "CREATE TABLE `billing_accounting_event_links` (`id` bigint PRIMARY KEY)"
    );
  });
  await expectFailure(
    runProductionMigrations({
      databaseUrl: databaseUrl(databases[5]),
      lockTimeoutSeconds: 0,
    }),
    "partial 0015 footprint",
    "empty database schema fingerprint mismatch"
  );

  await expectFailure(
    runProductionMigrations({ databaseUrl: databaseUrl(databases[10]) }),
    "wrong database collation refuses before migration",
    "migration database default charset/collation mismatch"
  );
  await withDatabase(databases[10], async connection => {
    const [[history]] = await connection.query(
      "SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='__drizzle_migrations'"
    );
    assert(
      Number(history.count) === 0,
      "runtime refusal happens before the migration executor"
    );
  });

  await withDatabase(databases[11], connection =>
    connection.query(
      "CREATE TABLE `__drizzle_migrations` (`id` serial PRIMARY KEY,`hash` text NOT NULL,`created_at` bigint)"
    )
  );
  await expectFailure(
    runProductionMigrations({ databaseUrl: databaseUrl(databases[11]) }),
    "empty migration history is not a fresh database",
    "database with empty migration history is not a supported fresh state"
  );
  await withDatabase(databases[11], async connection => {
    await assertNoApplicationTables(connection, "empty history refusal");
    await connection.query(
      "ALTER TABLE `__drizzle_migrations` AUTO_INCREMENT=17"
    );
  });
  await expectFailure(
    runProductionMigrations({ databaseUrl: databaseUrl(databases[11]) }),
    "advanced empty migration history is not resumable",
    "database with empty migration history is not a supported fresh state"
  );
  await withDatabase(databases[11], connection =>
    assertNoApplicationTables(connection, "advanced empty history refusal")
  );

  await withDatabase(databases[12], async connection => {
    await applyMigrationPrefix(connection, manifest.slice(0, -1));
    await applyStatements(connection, finalStatements.slice(0, 5));
  });
  await expectFailure(
    runProductionMigrations({ databaseUrl: databaseUrl(databases[12]) }),
    "first unsupported durable 0015 partial",
    "0014 schema fingerprint mismatch"
  );

  await withDatabase(databases[13], async connection => {
    await applyMigrationPrefix(connection, manifest.slice(0, -1));
    await connection.query(
      "ALTER TABLE `__drizzle_migrations` AUTO_INCREMENT=100"
    );
  });
  await expectFailure(
    runProductionMigrations({ databaseUrl: databaseUrl(databases[13]) }),
    "0014 advanced migration counter",
    "0014 migration history table contract mismatch"
  );
  await withDatabase(databases[13], connection =>
    assertNo0015Objects(connection, "advanced 0014 history refusal")
  );

  await withDatabase(databases[6], async connection => {
    await applyMigrationPrefix(connection, manifest.slice(0, -1));
    await applyStatements(
      connection,
      finalStatements.slice(0, Math.floor(finalStatements.length / 2))
    );
  });
  await expectFailure(
    runProductionMigrations({ databaseUrl: databaseUrl(databases[6]) }),
    "middle 0015 partial",
    "0014 schema fingerprint mismatch"
  );

  await withDatabase(databases[7], async connection => {
    await applyMigrationPrefix(connection, manifest.slice(0, -1));
    await applyStatements(connection, finalStatements.slice(0, -1));
  });
  await expectFailure(
    runProductionMigrations({ databaseUrl: databaseUrl(databases[7]) }),
    "late 0015 partial",
    "0014 schema fingerprint mismatch"
  );

  await withDatabase(databases[8], async connection => {
    await applyMigrationPrefix(connection, manifest.slice(0, -1));
    await createLegacyMessengerState(connection);
    await connection.query(
      "ALTER TABLE `messengerState` MODIFY COLUMN `updatedAt` timestamp DEFAULT (now()) NOT NULL"
    );
  });
  await expectFailure(
    runProductionMigrations({ databaseUrl: databaseUrl(databases[8]) }),
    "messengerState missing on-update",
    "0014 schema fingerprint mismatch"
  );

  await withDatabase(databases[9], async connection => {
    await createLegacyMessengerState(connection);
    await connection.query(
      "INSERT INTO `messengerState` (`psid`,`userKey`) VALUES ('historyless-psid','historyless-key')"
    );
  });
  await expectFailure(
    runProductionMigrations({ databaseUrl: databaseUrl(databases[9]) }),
    "historyless messengerState is not resumable",
    "empty database schema fingerprint mismatch"
  );
  await resetLegacyMessengerState(databases[8]);
  await withDatabase(databases[8], connection =>
    connection.query(
      "ALTER TABLE `messengerState` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_bin"
    )
  );
  await expectFailure(
    runProductionMigrations({ databaseUrl: databaseUrl(databases[8]) }),
    "messengerState wrong collation",
    "0014 schema fingerprint mismatch"
  );
  await resetLegacyMessengerState(databases[8]);
  await withDatabase(databases[8], connection =>
    connection.query(
      "ALTER TABLE `messengerState` ADD UNIQUE INDEX `temporary_id_unique` (`id`), DROP PRIMARY KEY"
    )
  );
  await expectFailure(
    runProductionMigrations({ databaseUrl: databaseUrl(databases[8]) }),
    "messengerState malformed primary key",
    "0014 schema fingerprint mismatch"
  );

  await withDatabase(databases[0], async connection => {
    const lockName = migrationLockName(databases[0]);
    const [[lock]] = await connection.query(
      "SELECT GET_LOCK(?,0) AS acquired",
      [lockName]
    );
    assert(Number(lock.acquired) === 1, "test lock acquired");
    try {
      await expectFailure(
        runProductionMigrations({
          databaseUrl: concurrentUrl,
          lockTimeoutSeconds: 0,
        }),
        "singleton lock contention",
        "migration singleton lock is unavailable"
      );
    } finally {
      await connection.query("SELECT RELEASE_LOCK(?)", [lockName]);
    }
  });

  process.stdout.write(
    "Production migrator passed: singleton, manifest hash and partial-state refusal.\n"
  );
} finally {
  for (const database of databases) {
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
  }
  await admin.end();
}

function databaseUrl(database) {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function withDatabase(database, action) {
  const connection = await mysql.createConnection(databaseUrl(database));
  try {
    await action(connection);
  } finally {
    await connection.end();
  }
}

async function withDatabaseResult(database, action) {
  let result;
  await withDatabase(database, async connection => {
    result = await action(connection);
  });
  return result;
}

async function captureSchemaFingerprint(connection) {
  const [tables] = await connection.query(
    "SELECT `TABLE_NAME` AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY `TABLE_NAME`"
  );
  const createStatements = [];
  for (const table of tables) {
    const [[created]] = await connection.query(
      `SHOW CREATE TABLE \`${table.name.replaceAll("`", "``")}\``
    );
    createStatements.push(Object.values(created).at(-1));
  }
  const [triggers] = await connection.query(
    "SELECT `TRIGGER_NAME` AS name,`ACTION_STATEMENT` AS actionStatement FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY `TRIGGER_NAME`"
  );
  const [history] = await connection.query(
    "SELECT `id`,`hash`,`created_at` AS createdAt FROM `__drizzle_migrations` ORDER BY `id`"
  );
  return JSON.stringify({ createStatements, triggers, history });
}

async function assertNoApplicationTables(connection, label) {
  const [[row]] = await connection.query(
    "SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME<>'__drizzle_migrations'"
  );
  assert(Number(row.count) === 0, `${label} leaves no application tables`);
}

async function assertNo0015Objects(connection, label) {
  const [[row]] = await connection.query(
    "SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('messengerState','billing_accounting_event_links','billing_scheduler_tenants')"
  );
  assert(Number(row.count) === 0, `${label} happens before 0015 DDL`);
}

async function testCompletedSchemaRefusals(database, finalStatements) {
  await withDatabase(database, connection =>
    connection.query(
      "ALTER TABLE `messengerState` ADD UNIQUE INDEX `temporary_id_unique` (`id`), DROP PRIMARY KEY"
    )
  );
  await expectRunnerRefusal(
    database,
    "complete schema malformed primary key",
    "0015 schema fingerprint mismatch"
  );
  await withDatabase(database, connection =>
    connection.query(
      "ALTER TABLE `messengerState` ADD PRIMARY KEY (`id`), DROP INDEX `temporary_id_unique`"
    )
  );

  await withDatabase(database, async connection => {
    await connection.query(
      "ALTER TABLE `billing_outbox` DROP CHECK `billing_outbox_attempts_nonnegative`"
    );
    await connection.query(
      "ALTER TABLE `billing_outbox` ADD CONSTRAINT `billing_outbox_attempts_nonnegative` CHECK (`attempt_count` >= -1 AND `max_attempts` > 0)"
    );
  });
  await expectRunnerRefusal(
    database,
    "complete schema altered check body",
    "0015 schema fingerprint mismatch"
  );
  await withDatabase(database, async connection => {
    await connection.query(
      "ALTER TABLE `billing_outbox` DROP CHECK `billing_outbox_attempts_nonnegative`"
    );
    await connection.query(
      "ALTER TABLE `billing_outbox` ADD CONSTRAINT `billing_outbox_attempts_nonnegative` CHECK (`attempt_count` >= 0 AND `max_attempts` > 0)"
    );
  });

  const insertTrigger = finalStatements.find(statement =>
    statement.startsWith(
      "CREATE TRIGGER `billing_outbox_wake_scheduler_after_insert`"
    )
  );
  assert(insertTrigger, "canonical insert trigger statement available");
  await withDatabase(database, async connection => {
    await connection.query(
      "DROP TRIGGER `billing_outbox_wake_scheduler_after_insert`"
    );
    await connection.query(
      "CREATE TRIGGER `billing_outbox_wake_scheduler_after_insert` AFTER INSERT ON `billing_outbox` FOR EACH ROW SET @unexpected_trigger = 1"
    );
  });
  await expectRunnerRefusal(
    database,
    "complete schema altered trigger body",
    "0015 schema fingerprint mismatch"
  );
  await withDatabase(database, async connection => {
    await connection.query(
      "DROP TRIGGER `billing_outbox_wake_scheduler_after_insert`"
    );
    await connection.query(insertTrigger);
  });

  await withDatabase(database, async connection => {
    await connection.query(
      "CREATE TABLE `unexpected_schema_object` (`id` int)"
    );
    await connection.query(
      "CREATE PROCEDURE `unexpected_schema_routine`() SELECT 1"
    );
    await connection.query(
      "CREATE EVENT `unexpected_schema_event` ON SCHEDULE AT CURRENT_TIMESTAMP + INTERVAL 1 DAY DO SET @unexpected_event = 1"
    );
  });
  await expectRunnerRefusal(
    database,
    "complete schema extra objects",
    "production schema contract requires no routines or events"
  );
  await withDatabase(database, async connection => {
    await connection.query("DROP EVENT `unexpected_schema_event`");
    await connection.query("DROP PROCEDURE `unexpected_schema_routine`");
    await connection.query("DROP TABLE `unexpected_schema_object`");
  });

  await withDatabase(database, connection =>
    connection.query(
      "ALTER TABLE `__drizzle_migrations` ADD COLUMN `unexpected_history_column` int"
    )
  );
  await expectRunnerRefusal(
    database,
    "migration history table extra column",
    "0015 migration history table contract mismatch"
  );
  await withDatabase(database, connection =>
    connection.query(
      "ALTER TABLE `__drizzle_migrations` DROP COLUMN `unexpected_history_column`"
    )
  );
}

async function testHistoryRefusals(database, manifest) {
  await withDatabase(database, connection =>
    connection.query("ALTER TABLE `__drizzle_migrations` AUTO_INCREMENT=100")
  );
  await expectRunnerRefusal(
    database,
    "complete migration history counter drift",
    "0015 migration history table contract mismatch"
  );
  await withDatabase(database, connection =>
    connection.query("ALTER TABLE `__drizzle_migrations` AUTO_INCREMENT=17")
  );

  const removed = await withDatabaseResult(database, async connection => {
    const [[row]] = await connection.query(
      "SELECT `id`,`hash`,`created_at` AS createdAt FROM `__drizzle_migrations` ORDER BY `id` LIMIT 1 OFFSET 7"
    );
    await connection.query("DELETE FROM `__drizzle_migrations` WHERE `id`=?", [
      row.id,
    ]);
    return row;
  });
  await expectRunnerRefusal(
    database,
    "migration history middle gap",
    "applied migration hash/order mismatch"
  );
  await withDatabase(database, connection =>
    connection.query(
      "INSERT INTO `__drizzle_migrations` (`id`,`hash`,`created_at`) VALUES (?,?,?)",
      [removed.id, removed.hash, removed.createdAt]
    )
  );

  const swapped = await withDatabaseResult(database, async connection => {
    const [rows] = await connection.query(
      "SELECT `id` FROM `__drizzle_migrations` ORDER BY `id` LIMIT 2 OFFSET 7"
    );
    await swapHistoryIds(connection, rows[0].id, rows[1].id, 1_000_000);
    return rows;
  });
  await expectRunnerRefusal(
    database,
    "migration history reordered",
    "applied migration hash/order mismatch"
  );
  await withDatabase(database, connection =>
    swapHistoryIds(connection, swapped[0].id, swapped[1].id, 1_000_001)
  );

  await withDatabase(database, connection =>
    connection.query(
      "INSERT INTO `__drizzle_migrations` (`hash`,`created_at`) VALUES (?,?)",
      ["f".repeat(64), manifest.at(-1).when + 1]
    )
  );
  await expectRunnerRefusal(
    database,
    "migration history extra row",
    "database contains unknown applied migrations"
  );
  await withDatabase(database, connection =>
    connection.query(
      "DELETE FROM `__drizzle_migrations` WHERE `created_at`=?",
      [manifest.at(-1).when + 1]
    )
  );
}

async function swapHistoryIds(connection, firstId, secondId, temporaryId) {
  await connection.query(
    "UPDATE `__drizzle_migrations` SET `id`=? WHERE `id`=?",
    [temporaryId, firstId]
  );
  await connection.query(
    "UPDATE `__drizzle_migrations` SET `id`=? WHERE `id`=?",
    [firstId, secondId]
  );
  await connection.query(
    "UPDATE `__drizzle_migrations` SET `id`=? WHERE `id`=?",
    [secondId, temporaryId]
  );
}

async function expectRunnerRefusal(database, label, expectedMessage) {
  await expectFailure(
    runProductionMigrations({ databaseUrl: databaseUrl(database) }),
    label,
    expectedMessage
  );
  await withDatabase(database, async connection => {
    const lockName = migrationLockName(database);
    const [[lock]] = await connection.query(
      "SELECT GET_LOCK(?,0) AS acquired",
      [lockName]
    );
    assert(Number(lock.acquired) === 1, `${label} releases singleton lock`);
    await connection.query("SELECT RELEASE_LOCK(?)", [lockName]);
  });
}

async function applyMigrationPrefix(connection, migrations) {
  await connection.query(
    "CREATE TABLE `__drizzle_migrations` (`id` serial PRIMARY KEY,`hash` text NOT NULL,`created_at` bigint)"
  );
  for (const migration of migrations) {
    const sql = await fs.readFile(
      path.join(appDirectory, "drizzle", `${migration.tag}.sql`),
      "utf8"
    );
    const statements = sql
      .split("--> statement-breakpoint")
      .map(value => value.trim())
      .filter(Boolean);
    for (const statement of statements) await connection.query(statement);
    await connection.query(
      "INSERT INTO `__drizzle_migrations` (`hash`,`created_at`) VALUES (?,?)",
      [migration.sha256, migration.when]
    );
  }
}

async function readMigrationStatements(migration) {
  const sql = await fs.readFile(
    path.join(appDirectory, "drizzle", `${migration.tag}.sql`),
    "utf8"
  );
  return sql
    .split("--> statement-breakpoint")
    .map(value => value.trim())
    .filter(Boolean);
}

async function applyStatements(connection, statements) {
  for (const statement of statements) await connection.query(statement);
}

async function createLegacyMessengerState(connection) {
  await connection.query(`CREATE TABLE \`messengerState\` (
    \`id\` int AUTO_INCREMENT NOT NULL,
    \`psid\` varchar(64) NOT NULL,
    \`userKey\` varchar(64) NOT NULL,
    \`stage\` enum('IDLE','AWAITING_PHOTO','AWAITING_STYLE','PROCESSING','RESULT_READY','FAILURE') DEFAULT 'IDLE' NOT NULL,
    \`lastPhotoUrl\` varchar(2048),
    \`selectedStyle\` varchar(64),
    \`preferredLang\` varchar(10) DEFAULT 'nl' NOT NULL,
    \`lastGeneratedUrl\` varchar(2048),
    \`updatedAt\` timestamp DEFAULT (now()) NOT NULL ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT \`messengerState_id\` PRIMARY KEY(\`id\`),
    CONSTRAINT \`messengerState_psid_unique\` UNIQUE(\`psid\`),
    CONSTRAINT \`messengerState_userKey_unique\` UNIQUE(\`userKey\`)
  )`);
}

async function resetLegacyMessengerState(database) {
  await withDatabase(database, async connection => {
    await connection.query("DROP TABLE `messengerState`");
    await createLegacyMessengerState(connection);
  });
}

async function expectFailure(promise, label, expectedMessage) {
  try {
    await promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes(expectedMessage)) return;
    throw new Error(
      `wrong refusal for ${label}: expected ${expectedMessage}, received ${message || "unknown"}`,
      { cause: error }
    );
  }
  throw new Error(`expected refusal: ${label}`);
}

function assert(condition, label) {
  if (!condition) throw new Error(`production migrator test failed: ${label}`);
}

async function testCleanupContracts() {
  let ended = false;
  let destroyed = false;
  const releaseError = new Error("release failed");
  const endError = new Error("end failed");
  const cleanupError = await cleanupMigrationConnection(
    {
      async query() {
        throw releaseError;
      },
      async end() {
        ended = true;
        throw endError;
      },
      destroy() {
        destroyed = true;
      },
    },
    "test-lock"
  );
  assert(
    ended && destroyed,
    "cleanup always ends and destroys after end failure"
  );
  assert(
    cleanupError instanceof AggregateError && cleanupError.errors.length === 2,
    "cleanup preserves release and end failures"
  );
  const primaryError = new Error("primary migration failure");
  const combined = combineMigrationErrors(primaryError, cleanupError);
  assert(
    combined instanceof AggregateError &&
      combined.cause === primaryError &&
      combined.errors[0] === primaryError &&
      combined.errors[1] === cleanupError,
    "primary and cleanup failures remain ordered"
  );
}

function testSchemaDigestContracts() {
  assert(
    normalizeShowCreate(
      "CREATE TABLE `t` (`id` int) ENGINE=InnoDB AUTO_INCREMENT=9\r\n"
    ) === "CREATE TABLE `t` (`id` int) ENGINE=InnoDB",
    "SHOW CREATE normalization strips only volatile counters and trailing whitespace"
  );
  assert(
    normalizeShowCreate(
      "CREATE TABLE `t` (`value` varchar(64) DEFAULT ' AUTO_INCREMENT=9 ') ENGINE=InnoDB AUTO_INCREMENT=12"
    ) ===
      "CREATE TABLE `t` (`value` varchar(64) DEFAULT ' AUTO_INCREMENT=9 ') ENGINE=InnoDB",
    "SHOW CREATE normalization preserves AUTO_INCREMENT text in literals"
  );
  const spacedLiteral = normalizeSqlOutsideQuotedValues("SET @value = 'A B'");
  const compactLiteral = normalizeSqlOutsideQuotedValues("SET @value='ab'");
  assert(
    sha256(spacedLiteral) !== sha256(compactLiteral),
    "trigger normalization preserves literal bytes and case"
  );
  assert(
    normalizeSqlOutsideQuotedValues("SET   @value =  `Column Name`") ===
      "SET @value = `Column Name`",
    "trigger normalization changes whitespace only outside quoted values"
  );
  const trigger = {
    definer: "migrator@localhost",
    timing: "AFTER",
    eventName: "INSERT",
    tableName: "billing_outbox",
    orientation: "ROW",
    actionOrder: 1,
    actionCondition: null,
    actionStatement: "SET @value = 'A B'",
    sqlMode: productionSchemaSqlMode,
    characterSetClient: "utf8mb4",
    collationConnection: "utf8mb4_0900_ai_ci",
    databaseCollation: "utf8mb4_0900_ai_ci",
  };
  assert(
    canonicalTriggerTuple(trigger, "migrator@localhost").definer ===
      "$MIGRATION_USER",
    "trigger definer is normalized only for the current migration principal"
  );
  expectSynchronousFailure(
    () => canonicalTriggerTuple(trigger, "other@localhost"),
    "mismatched trigger definer",
    "trigger definer does not match the migration principal"
  );
  expectSynchronousFailure(
    () =>
      assertTriggerGrantScope(
        [
          "GRANT ALL PRIVILEGES ON *.* TO `migrator`@`%`",
          "REVOKE TRIGGER ON `leaderbot`.* FROM `migrator`@`%`",
        ],
        "leaderbot",
        false
      ),
    "current-schema partial revoke overrides global trigger grant",
    "migration principal lacks scoped privileges"
  );
  const validRuntime = {
    version: "8.4.11",
    databaseName: "leaderbot",
    characterSet: "utf8mb4",
    collationName: "utf8mb4_0900_ai_ci",
    sqlMode: productionSchemaSqlMode,
    timeZone: "+00:00",
    transactionIsolation: "READ-COMMITTED",
    foreignKeyChecks: 1,
    defaultStorageEngine: "InnoDB",
    innodbDefaultRowFormat: "dynamic",
    innodbPageSize: 16384,
    innodbForceRecovery: 0,
    innodbReadOnly: 0,
    readOnly: 0,
    superReadOnly: 0,
    disabledStorageEngines: "",
    innodbStrictMode: 1,
    lowerCaseTableNames: 0,
    explicitTimestampDefaults: 1,
    autoIncrementIncrement: 1,
    autoIncrementOffset: 1,
    informationSchemaStatsExpiry: 0,
    sqlQuoteShowCreate: 1,
    showCreateTableVerbosity: 1,
    sqlSafeUpdates: 0,
    uniqueChecks: 1,
    transactionReadOnly: 0,
    timestampIsDefault: 1,
    insertId: 0,
    sqlSelectLimitIsDefault: 1,
    sqlBigSelects: 1,
    schemaReadOnly: 0,
    defaultEncryption: "NO",
  };
  assertProductionRuntimeValues(validRuntime);
  assertTriggerGrantScope(
    [
      "GRANT CREATE, CREATE TEMPORARY TABLES, ALTER, INDEX, REFERENCES, SELECT, INSERT, UPDATE, TRIGGER ON `leaderbot`.* TO `migrator`@`%`",
    ],
    "leaderbot",
    false
  );
  assertTriggerGrantScope(
    ["GRANT ALL PRIVILEGES ON *.* TO `migrator`@`%`"],
    "leaderbot",
    true
  );
  expectSynchronousFailure(
    () =>
      assertTriggerGrantScope(
        ["GRANT ALL PRIVILEGES ON `otherdb`.* TO `migrator`@`%`"],
        "leaderbot",
        false
      ),
    "wrong-schema trigger grant",
    "migration principal lacks scoped privileges"
  );
  expectSynchronousFailure(
    () =>
      assertTriggerGrantScope(
        [
          "GRANT CREATE, CREATE TEMPORARY TABLES, ALTER, INDEX, REFERENCES, SELECT, INSERT, UPDATE, TRIGGER ON `leaderbot`.* TO `migrator`@`%`",
        ],
        "leaderbot",
        true
      ),
    "schema trigger without global SUPER",
    "migration principal lacks global SUPER for triggers"
  );
  expectSynchronousFailure(
    () => assertProductionRuntimeValues({ ...validRuntime, version: "8.0.42" }),
    "unsupported MySQL runtime",
    "production migration requires MySQL 8.4.11"
  );
  for (const [field, value] of [
    ["defaultStorageEngine", "MyISAM"],
    ["innodbDefaultRowFormat", "compact"],
    ["innodbPageSize", 4096],
    ["innodbForceRecovery", 1],
    ["innodbReadOnly", 1],
    ["readOnly", 1],
    ["superReadOnly", 1],
    ["disabledStorageEngines", "MyISAM,InnoDB"],
    ["innodbStrictMode", 0],
    ["lowerCaseTableNames", 2],
    ["explicitTimestampDefaults", 0],
    ["autoIncrementIncrement", 2],
    ["autoIncrementOffset", 2],
    ["informationSchemaStatsExpiry", 86400],
    ["sqlQuoteShowCreate", 0],
    ["showCreateTableVerbosity", 0],
    ["sqlSafeUpdates", 1],
    ["uniqueChecks", 0],
    ["transactionReadOnly", 1],
    ["timestampIsDefault", 0],
    ["insertId", 7],
    ["sqlSelectLimitIsDefault", 0],
    ["sqlBigSelects", 0],
    ["schemaReadOnly", 1],
    ["defaultEncryption", "YES"],
  ]) {
    expectSynchronousFailure(
      () => assertProductionRuntimeValues({ ...validRuntime, [field]: value }),
      `unsupported runtime ${field}`,
      "production migration session contract mismatch"
    );
  }
}

async function testContractManifestBinding() {
  const { migrations, productionContract } =
    await loadAndVerifyMigrationManifest();
  assertProductionSchemaContractManifest(productionContract, migrations);
  const changedManifest = migrations.map(row => ({ ...row }));
  changedManifest.at(-1).sha256 = "0".repeat(64);
  expectSynchronousFailure(
    () =>
      assertProductionSchemaContractManifest(
        productionContract,
        changedManifest
      ),
    "stale schema contract refuses a changed migration set",
    "production schema contract migration set mismatch"
  );
  const staleHistoryContract = JSON.parse(JSON.stringify(productionContract));
  staleHistoryContract.baseHistory.rows[0].hash = "f".repeat(64);
  expectSynchronousFailure(
    () =>
      assertProductionSchemaContractManifest(staleHistoryContract, migrations),
    "stale contract history refuses before database access",
    "production schema contract history does not match manifest"
  );
}

function expectSynchronousFailure(action, label, expectedMessage) {
  try {
    action();
  } catch (error) {
    if (error instanceof Error && error.message.includes(expectedMessage)) {
      return;
    }
    throw new Error(`wrong synchronous refusal for ${label}`, { cause: error });
  }
  throw new Error(`expected synchronous refusal: ${label}`);
}
