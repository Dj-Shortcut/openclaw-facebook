/* global process, URL */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { runProductionLegacyBridge } from "./bridge-production-0007-to-0014.mjs";
import {
  cleanupMigrationConnection,
  combineMigrationErrors,
  assertProductionSchemaContractManifest,
  loadAndVerifyMigrationManifest,
  migrationLockName,
  productionMigrationOptionsForMode,
  productionSchemaPhases,
  runProductionMigrations as runProductionMigrationStage,
} from "./migrate-production.mjs";
import {
  productionMigrationTags,
  resolveProductionMigrationPlan,
} from "./production-migration-plan.mjs";
import {
  normalizeShowCreate,
  normalizeSqlOutsideQuotedValues,
  assertExpandMigrationGrantScope,
  assertProductionInspectionGrantScope,
  assertProductionMigrationRuntime,
  assertProductionRuntimeGrantScope,
  assertProductionRuntimeValues,
  assertTriggerGrantScope,
  canonicalTriggerTuple,
  productionSchemaSqlMode,
  sha256,
} from "./production-schema-contract.mjs";

await testCleanupContracts();
testStagedRolloutContracts();
testSchemaDigestContracts();
await testContractManifestBinding();

async function runProductionMigrations(options = {}) {
  if (options.verifyOnly) {
    return runProductionMigrationStage({
      ...options,
      target: options.target ?? "expand",
    });
  }
  try {
    return await runProductionMigrationStage({
      ...options,
      target: "expand",
      allowEmptyBootstrap: true,
    });
  } catch (error) {
    if (
      String(error?.message).includes(
        "expand migration requires the completed 0015 base schema"
      )
    ) {
      await apply0015PrerequisiteForTest(options.databaseUrl);
    } else {
      throw error;
    }
  }
  return runProductionMigrationStage({
    ...options,
    target: "expand",
    verifyOnly: false,
  });
}

const adminUrlValue = process.env.MYSQL_REHEARSAL_URL?.trim();
if (!adminUrlValue) throw new Error("MYSQL_REHEARSAL_URL is required");
const adminUrl = new URL(adminUrlValue);
const appDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const resume0016Databases = Array.from(
  { length: 10 },
  (_, index) => `leaderbot_production_migrator_resume_0016_${index}`
);
const stagedRolloutDatabase = "leaderbot_production_migrator_staged_rollout";
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
  "leaderbot_production_migrator_legacy_bridge",
  "leaderbot_production_migrator_legacy_drift",
  "leaderbot_production_migrator_legacy_partial",
  "leaderbot_production_migrator_verify_only",
  ...resume0016Databases,
  stagedRolloutDatabase,
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

  const { migrations: manifest, migrationPlan } =
    await loadAndVerifyMigrationManifest();
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
    results.every(
      result => result.appliedCount === migrationPlan.through0016.length
    ),
    "concurrent apply"
  );
  const beforeNoop = await withDatabaseResult(databases[0], connection =>
    captureSchemaFingerprint(connection)
  );
  const idempotent = await runProductionMigrations({
    databaseUrl: concurrentUrl,
  });
  assert(
    idempotent.appliedCount === migrationPlan.through0016.length,
    "already-complete idempotent apply"
  );
  const afterNoop = await withDatabaseResult(databases[0], connection =>
    captureSchemaFingerprint(connection)
  );
  assert(
    beforeNoop === afterNoop,
    "complete 0016 no-op leaves schema/history unchanged"
  );

  await withDatabase(stagedRolloutDatabase, async connection => {
    await applyMigrationPrefix(connection, migrationPlan.through0015);
    await connection.query(
      "INSERT INTO `workspaces` (`id`,`name`,`slug`) VALUES (7201,'Staged rollout','staged-rollout')"
    );
    await connection.query(
      "INSERT INTO `channelConnections` (`id`,`workspaceId`,`channel`,`status`,`externalId`) VALUES (7202,7201,'facebook_messenger','connected','staged-page')"
    );
    await connection.query(
      "INSERT INTO `messenger_privacy_subjects` (`workspace_id`,`channel_connection_id`,`user_key`,`privacy_epoch`,`status`) VALUES (7201,7202,'staged-user',3,'active')"
    );
  });
  const verifiedBaseBridge = await runProductionMigrationStage({
    databaseUrl: databaseUrl(stagedRolloutDatabase),
    verifyOnly: true,
    target: "compatible",
  });
  assert(
    verifiedBaseBridge.schemaPhase === "0015_base",
    "compatibility bridge accepts base schema before expand"
  );
  await expectFailure(
    runProductionMigrationStage({
      databaseUrl: databaseUrl(stagedRolloutDatabase),
      verifyOnly: true,
      target: "expand",
    }),
    "new writer cannot deploy before expand",
    "schema is at 0015_base; expand verification refused"
  );
  const expanded = await runProductionMigrationStage({
    databaseUrl: databaseUrl(stagedRolloutDatabase),
    target: "expand",
  });
  assert(
    expanded.schemaPhase === "0016_expand" &&
      expanded.appliedCount === migrationPlan.through0016.length,
    "expand applies only 0016"
  );
  await withDatabase(stagedRolloutDatabase, connection =>
    connection.query(
      "INSERT INTO `billing_intents` (`intent_id`,`workspace_id`,`mode`,`plan_code`,`kind`,`expected_amount`,`currency`,`interval`,`entitlements`,`mollie_description`,`status`,`idempotency_key`,`checkout_scope_key`,`messenger_sender_user_key`,`messenger_page_id`,`billing_profile_version`,`authorization_epoch`) VALUES ('72000000-0000-4000-8000-000000000001',7201,'test','startpilot','startpilot_purchase','19.00','EUR','one-time',JSON_OBJECT('aiAnswers',300),'Old writer during expand','paid','staged-old-writer-key','staged-old-writer-scope','staged-user','staged-page',0,1)"
    )
  );
  await withDatabase(stagedRolloutDatabase, async connection => {
    const [[terminal]] = await connection.query(
      "SELECT `messenger_channel_connection_id` AS connectionId,`messenger_privacy_epoch` AS privacyEpoch FROM `billing_intents` WHERE `intent_id`='72000000-0000-4000-8000-000000000001'"
    );
    assert(
      terminal.connectionId === null && terminal.privacyEpoch === null,
      "0016 remains the exact terminal schema without retired 0017 repair"
    );
  });
  await withDatabase(databases[22], connection =>
    applyMigrationPrefix(connection, migrationPlan.through0016)
  );
  const verifiedExpand = await runProductionMigrationStage({
    databaseUrl: databaseUrl(databases[22]),
    verifyOnly: true,
    target: "expand",
  });
  assert(
    verifiedExpand.schemaPhase === "0016_expand" &&
      verifiedExpand.appliedCount === migrationPlan.through0016.length,
    "expand release accepts the exact expanded schema"
  );
  const verifiedExpandBridge = await runProductionMigrationStage({
    databaseUrl: databaseUrl(databases[22]),
    verifyOnly: true,
    target: "compatible",
  });
  assert(
    verifiedExpandBridge.schemaPhase === "0016_expand",
    "compatibility bridge accepts the expanded schema"
  );
  const verifiedComplete = await runProductionMigrations({
    databaseUrl: concurrentUrl,
    verifyOnly: true,
  });
  assert(
    verifiedComplete.appliedCount === migrationPlan.through0016.length,
    "verify-only release accepts exact completed schema"
  );
  await expectFailure(
    runProductionMigrationStage({
      databaseUrl: concurrentUrl,
      verifyOnly: true,
      target: "contract",
    }),
    "retired contract target",
    "migration target must be compatible or expand"
  );
  const migration0016ForVerify = await readMigrationStatements(
    migrationPlan.expand0016
  );
  await withDatabase(databases[1], async connection => {
    await applyMigrationPrefix(connection, migrationPlan.through0015);
    await connection.query(
      "INSERT INTO `workspaces` (`id`,`name`,`slug`) VALUES (7101,'Verify only','verify-only')"
    );
    await connection.query(
      "INSERT INTO `channelConnections` (`id`,`workspaceId`,`channel`,`status`,`externalId`) VALUES (7102,7101,'facebook_messenger','connected','verify-only-page')"
    );
    await connection.query(
      "INSERT INTO `messenger_privacy_subjects` (`workspace_id`,`channel_connection_id`,`user_key`,`privacy_epoch`,`status`,`erased_at`) VALUES (7101,7102,'verify-only-user',2,'erased','2026-08-23 08:00:00')"
    );
    await applyStatements(connection, migration0016ForVerify.slice(0, 4));
  });
  const beforePartialVerify = await withDatabaseResult(
    databases[1],
    connection => captureSchemaFingerprint(connection)
  );
  await expectFailure(
    runProductionMigrations({
      databaseUrl: databaseUrl(databases[1]),
      verifyOnly: true,
    }),
    "verify-only release on partial 0016",
    "release verification requires an exact stable schema phase"
  );
  const afterPartialVerify = await withDatabaseResult(
    databases[1],
    connection => captureSchemaFingerprint(connection)
  );
  assert(
    beforePartialVerify === afterPartialVerify,
    "verify-only release leaves partial 0016 schema/data/history unchanged"
  );
  await withDatabase(databases[1], async connection => {
    const [[subject]] = await connection.query(
      "SELECT `last_erased_at` AS lastErasedAt FROM `messenger_privacy_subjects` WHERE `workspace_id`=7101 AND `channel_connection_id`=7102 AND `user_key`='verify-only-user'"
    );
    assert(
      subject.lastErasedAt === null,
      "verify-only does not run the pending 0016 data backfill"
    );
  });
  await withDatabase(databases[19], connection =>
    applyLegacy0007(connection, manifest)
  );
  const bridgeResults = await Promise.all([
    runProductionLegacyBridge({
      databaseUrl: databaseUrl(databases[19]),
    }),
    runProductionLegacyBridge({
      databaseUrl: databaseUrl(databases[19]),
    }),
  ]);
  assert(
    bridgeResults.every(result => result.appliedCount === 15),
    "exact legacy 0007 bridges concurrently to canonical 0014"
  );
  const bridgeNoop = await runProductionLegacyBridge({
    databaseUrl: databaseUrl(databases[19]),
  });
  assert(
    bridgeNoop.appliedCount === 15,
    "canonical 0014 bridge rerun is an exact no-op"
  );
  const migratedLegacy = await runProductionMigrations({
    databaseUrl: databaseUrl(databases[19]),
  });
  assert(
    migratedLegacy.appliedCount === migrationPlan.through0016.length,
    "bridged 0014 continues through canonical 0016"
  );

  await withDatabase(databases[20], async connection => {
    await applyLegacy0007(connection, manifest);
    await connection.query(
      "ALTER TABLE `dailyQuota` ADD COLUMN `unexpectedLegacyDrift` int NULL"
    );
  });
  await expectFailure(
    runProductionLegacyBridge({ databaseUrl: databaseUrl(databases[20]) }),
    "drifted legacy 0007 bridge",
    "database is not an exact supported legacy 0007/0014 state"
  );

  await withDatabase(databases[21], async connection => {
    await applyLegacy0007(connection, manifest);
    const partialStatements = await readMigrationStatements(manifest[8]);
    await connection.query(partialStatements[0]);
  });
  await expectFailure(
    runProductionLegacyBridge({ databaseUrl: databaseUrl(databases[21]) }),
    "partially applied legacy bridge",
    "database is not an exact supported legacy 0007/0014 state"
  );
  const migration0016Statements = await readMigrationStatements(
    migrationPlan.expand0016
  );
  const migration0015Statements = await readMigrationStatements(
    migrationPlan.base0015
  );
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
    canonicalizedSession.appliedCount === migrationPlan.through0016.length,
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
      primaryKeyFresh.appliedCount === migrationPlan.through0016.length,
      "fresh migration supports required primary keys"
    );
    await withDatabase(databases[16], connection =>
      applyMigrationPrefix(connection, migrationPlan.through0015)
    );
    const primaryKeyUpgrade = await runProductionMigrations({
      databaseUrl: databaseUrl(databases[16]),
    });
    assert(
      primaryKeyUpgrade.appliedCount === migrationPlan.through0016.length,
      "0015 upgrade supports required primary keys"
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
  await testCompletedSchemaRefusals(databases[0], migration0015Statements);
  await testHistoryRefusals(databases[0], migrationPlan);
  await testEveryTailStatementBoundary({
    migrationPlan,
    migration0016Statements,
  });

  await withDatabase(databases[2], async connection => {
    await applyMigrationPrefix(connection, migrationPlan.through0014);
    await createLegacyMessengerState(connection);
    await connection.query(
      "INSERT INTO `messengerState` (`psid`,`userKey`) VALUES ('migration-preserved-psid','migration-preserved-key')"
    );
  });
  await expectFailure(
    runProductionMigrationStage({
      databaseUrl: databaseUrl(databases[2]),
      target: "expand",
    }),
    "expand cannot silently include older migrations",
    "expand migration requires the completed 0015 base schema"
  );
  const upgradedWithState = await runProductionMigrations({
    databaseUrl: databaseUrl(databases[2]),
  });
  assert(
    upgradedWithState.appliedCount === migrationPlan.through0016.length,
    "0014 with exact legacy state continues through 0016"
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
    await applyMigrationPrefix(connection, migrationPlan.through0014);
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
      [migrationPlan.expand0016.when]
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
    await applyMigrationPrefix(connection, migrationPlan.through0015);
    await applyStatements(connection, migration0016Statements.slice(0, 4));
    await connection.query(
      "ALTER TABLE `messenger_privacy_subjects` ADD COLUMN `unexpected_partial_drift` int NULL"
    );
  });
  await expectFailure(
    runProductionMigrations({ databaseUrl: databaseUrl(databases[12]) }),
    "arbitrary 0016 partial drift",
    "0016 partial schema fingerprint mismatch"
  );

  await withDatabase(databases[13], async connection => {
    await applyMigrationPrefix(connection, migrationPlan.through0014);
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

  await withDatabase(databases[7], async connection => {
    await applyMigrationPrefix(connection, migrationPlan.through0015);
    await connection.query(
      "INSERT INTO `workspaces` (`id`,`name`,`slug`) VALUES (7001,'Partial data','partial-data')"
    );
    await connection.query(
      "INSERT INTO `channelConnections` (`id`,`workspaceId`,`channel`,`status`,`externalId`) VALUES (7002,7001,'facebook_messenger','connected','partial-page')"
    );
    await connection.query(
      "INSERT INTO `messenger_privacy_subjects` (`workspace_id`,`channel_connection_id`,`user_key`,`privacy_epoch`,`status`) VALUES (7001,7002,'partial-user',1,'active')"
    );
    await applyStatements(connection, migration0016Statements.slice(0, 4));
    await connection.query(
      "UPDATE `messenger_privacy_subjects` SET `last_erased_at`='2026-08-23 00:00:00.123' WHERE `erased_at` IS NULL"
    );
  });
  const resumedReactivatedSubject = await runProductionMigrations({
    databaseUrl: databaseUrl(databases[7]),
  });
  assert(
    resumedReactivatedSubject.appliedCount === migrationPlan.through0016.length,
    "0016 resume accepts a reactivated subject with retained erasure history"
  );
  await withDatabase(databases[7], async connection => {
    const [[subject]] = await connection.query(
      "SELECT `status`,`erased_at` AS erasedAt,`last_erased_at` AS lastErasedAt FROM `messenger_privacy_subjects` WHERE `workspace_id`=7001 AND `channel_connection_id`=7002 AND `user_key`='partial-user'"
    );
    assert(
      subject.status === "active" &&
        subject.erasedAt === null &&
        subject.lastErasedAt instanceof Date,
      "0016 resume preserves reactivation erasure history"
    );
  });

  await withDatabase(databases[8], async connection => {
    await applyMigrationPrefix(connection, migrationPlan.through0014);
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
    "Production migrator passed: singleton, exact 0000-0016 plan, forward resume at every 0016 boundary, and drift refusal.\n"
  );
} finally {
  for (const database of databases) {
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
  }
  await admin.end();
}

async function testEveryTailStatementBoundary({
  migrationPlan,
  migration0016Statements,
}) {
  for (
    let boundary = 0;
    boundary <= migration0016Statements.length;
    boundary += 1
  ) {
    const database = resume0016Databases[boundary];
    await withDatabase(database, async connection => {
      await applyMigrationPrefix(connection, migrationPlan.through0015);
      await applyStatements(
        connection,
        migration0016Statements.slice(0, boundary)
      );
    });
    const resumed = await runProductionMigrations({
      databaseUrl: databaseUrl(database),
    });
    assert(
      resumed.appliedCount === migrationPlan.through0016.length,
      `0016 resumes after statement boundary ${boundary}`
    );
  }
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

async function testCompletedSchemaRefusals(database, migration0015Statements) {
  await withDatabase(database, connection =>
    connection.query(
      "ALTER TABLE `messengerState` ADD UNIQUE INDEX `temporary_id_unique` (`id`), DROP PRIMARY KEY"
    )
  );
  await expectRunnerRefusal(
    database,
    "complete schema malformed primary key",
    "0016 schema fingerprint mismatch"
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
    "0016 schema fingerprint mismatch"
  );
  await withDatabase(database, async connection => {
    await connection.query(
      "ALTER TABLE `billing_outbox` DROP CHECK `billing_outbox_attempts_nonnegative`"
    );
    await connection.query(
      "ALTER TABLE `billing_outbox` ADD CONSTRAINT `billing_outbox_attempts_nonnegative` CHECK (`attempt_count` >= 0 AND `max_attempts` > 0)"
    );
  });

  const insertTrigger = migration0015Statements.find(statement =>
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
    "0016 schema fingerprint mismatch"
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
    "0016 migration history table contract mismatch"
  );
  await withDatabase(database, connection =>
    connection.query(
      "ALTER TABLE `__drizzle_migrations` DROP COLUMN `unexpected_history_column`"
    )
  );
}

async function testHistoryRefusals(database, migrationPlan) {
  await withDatabase(database, connection =>
    connection.query("ALTER TABLE `__drizzle_migrations` AUTO_INCREMENT=100")
  );
  await expectRunnerRefusal(
    database,
    "complete migration history counter drift",
    "0016 migration history table contract mismatch"
  );
  await withDatabase(database, connection =>
    connection.query(
      `ALTER TABLE \`__drizzle_migrations\` AUTO_INCREMENT=${migrationPlan.through0016.length + 1}`
    )
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
      ["f".repeat(64), migrationPlan.expand0016.when + 1]
    )
  );
  await expectRunnerRefusal(
    database,
    "future migration history row on the 0016 runtime",
    "database contains unknown applied migrations"
  );
  await withDatabase(database, connection =>
    connection.query(
      "DELETE FROM `__drizzle_migrations` WHERE `created_at`=?",
      [migrationPlan.expand0016.when + 1]
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
  await assertProductionMigrationRuntime(connection);
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

async function apply0015PrerequisiteForTest(databaseUrlValue) {
  const { migrationPlan } = await loadAndVerifyMigrationManifest();
  const migration = migrationPlan.base0015;
  const connection = await mysql.createConnection(databaseUrlValue);
  try {
    await assertProductionMigrationRuntime(connection);
    for (const statement of await readMigrationStatements(migration)) {
      await connection.query(statement);
    }
    await connection.query(
      "INSERT INTO `__drizzle_migrations` (`hash`,`created_at`) VALUES (?,?)",
      [migration.sha256, migration.when]
    );
  } finally {
    await connection.end();
  }
}

async function applyLegacy0007(connection, migrations) {
  await applyMigrationPrefix(connection, migrations.slice(0, 8));
  const legacyHashes = new Map([
    [3, "66006eca333555566ca23afd43379b024bf9efd86c7e62468e4763ec169e2845"],
    [4, "ad9f1a8e045112995be23b617068174d67ceaba6bfeabfc07054d16f3d05d9c8"],
  ]);
  for (const [id, hash] of legacyHashes) {
    const [result] = await connection.query(
      "UPDATE `__drizzle_migrations` SET `hash`=? WHERE `id`=?",
      [hash, id]
    );
    assert(Number(result.affectedRows) === 1, `legacy history row ${id}`);
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

function testStagedRolloutContracts() {
  assert(
    JSON.stringify(productionSchemaPhases) ===
      JSON.stringify(["0015_base", "0016_expand"]),
    "schema phase names are stable"
  );
  const exactPlanRows = productionMigrationTags.map((tag, idx) => ({
    idx,
    tag,
  }));
  const exactPlan = resolveProductionMigrationPlan(exactPlanRows);
  assert(
    exactPlan.expand0016.tag === "0016_static_epoch_scope_fks" &&
      exactPlan.through0016.length === productionMigrationTags.length,
    "exact named production migration plan terminates at 0016"
  );
  for (const [label, tail] of [
    ["retired 0017", "0017_handoff_privacy_scope"],
    ["unreviewed future tail", "0018_unreviewed_future_tail"],
  ]) {
    const planWithFutureTail = resolveProductionMigrationPlan([
      ...exactPlanRows,
      { idx: exactPlanRows.length, tag: tail },
    ]);
    assert(
      planWithFutureTail.all.length === productionMigrationTags.length &&
        planWithFutureTail.through0016.length ===
          productionMigrationTags.length &&
        !planWithFutureTail.all.some(migration => migration.tag === tail),
      `${label} cannot alter the selected or bootstrapped migration count`
    );
  }
  for (const [label, rows] of [
    ["missing required migration", exactPlanRows.slice(0, -1)],
    [
      "duplicate migration tag",
      [
        ...exactPlanRows,
        {
          idx: exactPlanRows.length,
          tag: "0016_static_epoch_scope_fks",
        },
      ],
    ],
    [
      "future migration interleaved before 0016",
      exactPlanRows.map((row, index) =>
        index === exactPlanRows.length - 1
          ? { idx: index, tag: "0017_handoff_privacy_scope" }
          : row
      ),
    ],
  ]) {
    expectSynchronousFailure(
      () => resolveProductionMigrationPlan(rows),
      label,
      "production migration plan"
    );
  }
  assert(
    JSON.stringify(
      productionMigrationOptionsForMode("inspect-recovery-compatibility")
    ) ===
      JSON.stringify({
        verifyOnly: true,
        target: "compatible",
        inspectExpandTransition: true,
        privilegeProfile: "inspection",
      }),
    "recovery inspection uses a read-only principal"
  );
  assert(
    productionMigrationOptionsForMode("inspect-expand-transition")
      ?.privilegeProfile === "expand",
    "schema-transition inspection retains the exact expand principal"
  );
  assert(
    JSON.stringify(
      productionMigrationOptionsForMode("apply-expand", "migration-bridge")
    ) ===
      JSON.stringify({
        verifyOnly: false,
        target: "expand",
        privilegeProfile: "expand",
      }),
    "expand apply mode requires the immutable bridge"
  );
  assert(
    JSON.stringify(
      productionMigrationOptionsForMode("verify-artifact", "migration-bridge")
    ) ===
      JSON.stringify({
        verifyOnly: true,
        target: "compatible",
        privilegeProfile: "runtime",
      }),
    "migration bridge verifies both base and expand schemas"
  );
  assert(
    JSON.stringify(
      productionMigrationOptionsForMode("verify-artifact", "runtime")
    ) ===
      JSON.stringify({
        verifyOnly: true,
        target: "expand",
        privilegeProfile: "runtime",
      }),
    "runtime artifact refuses the base schema"
  );
  assert(
    JSON.stringify(
      productionMigrationOptionsForMode("apply-empty-bootstrap")
    ) ===
      JSON.stringify({
        verifyOnly: false,
        target: "expand",
        allowEmptyBootstrap: true,
      }),
    "empty bootstrap is bounded to the exact 0016 expand plan"
  );
  assert(
    productionMigrationOptionsForMode("apply") === null &&
      productionMigrationOptionsForMode("verify") === null &&
      productionMigrationOptionsForMode("apply-expand") === null &&
      productionMigrationOptionsForMode("apply-expand", "runtime") === null &&
      productionMigrationOptionsForMode("verify-artifact") === null &&
      productionMigrationOptionsForMode("verify-artifact", "unknown") ===
        null &&
      productionMigrationOptionsForMode("apply-contract") === null &&
      productionMigrationOptionsForMode("verify-contract") === null,
    "legacy and production contract apply modes fail closed"
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
  assertProductionRuntimeGrantScope(
    [
      "GRANT USAGE ON *.* TO `runtime`@`%`",
      "GRANT SELECT, INSERT, UPDATE, DELETE ON `leaderbot`.* TO `runtime`@`%`",
    ],
    "leaderbot"
  );
  assertProductionInspectionGrantScope(
    [
      "GRANT USAGE ON *.* TO `inspector`@`%`",
      "GRANT SELECT ON `leaderbot`.* TO `inspector`@`%`",
    ],
    "leaderbot"
  );
  expectSynchronousFailure(
    () =>
      assertProductionInspectionGrantScope(
        ["GRANT SELECT, INSERT ON `leaderbot`.* TO `inspector`@`%`"],
        "leaderbot"
      ),
    "inspection principal rejects write rights",
    "inspection principal privilege boundary mismatch"
  );
  expectSynchronousFailure(
    () =>
      assertProductionRuntimeGrantScope(
        ["GRANT ALL PRIVILEGES ON *.* TO `runtime`@`%`"],
        "leaderbot"
      ),
    "runtime rejects global database administration",
    "runtime principal privilege boundary mismatch"
  );
  expectSynchronousFailure(
    () =>
      assertProductionRuntimeGrantScope(
        [
          "GRANT SELECT, INSERT, UPDATE, DELETE, ALTER ON `leaderbot`.* TO `runtime`@`%`",
        ],
        "leaderbot"
      ),
    "runtime rejects schema DDL",
    "excessive ALTER"
  );
  assertExpandMigrationGrantScope(
    [
      "GRANT USAGE ON *.* TO `expand_migrator`@`%`",
      "GRANT CREATE TEMPORARY TABLES, ALTER, INDEX, REFERENCES, SELECT, INSERT, UPDATE ON `leaderbot`.* TO `expand_migrator`@`%`",
    ],
    "leaderbot"
  );
  expectSynchronousFailure(
    () =>
      assertExpandMigrationGrantScope(
        [
          "GRANT CREATE, CREATE TEMPORARY TABLES, ALTER, INDEX, REFERENCES, SELECT, INSERT, UPDATE, TRIGGER ON `leaderbot`.* TO `expand_migrator`@`%`",
        ],
        "leaderbot"
      ),
    "expand principal rejects unused CREATE and TRIGGER rights",
    "expand migration principal privilege boundary mismatch"
  );
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
  const { migrations, migrationPlan, productionContract } =
    await loadAndVerifyMigrationManifest();
  assertProductionSchemaContractManifest(productionContract, migrations);
  assertProductionSchemaContractManifest(productionContract, [
    ...migrations,
    {
      idx: migrations.length,
      tag: "0017_future_append_only",
      when: Number(migrationPlan.expand0016.when) + 1,
      sha256: "a".repeat(64),
    },
  ]);
  const changedManifest = migrations.map(row => ({ ...row }));
  changedManifest.find(row => row.tag === migrationPlan.expand0016.tag).sha256 =
    "0".repeat(64);
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
  const staleLegacyContract = JSON.parse(JSON.stringify(productionContract));
  staleLegacyContract.legacyHistory.rows[2].hash = "e".repeat(64);
  expectSynchronousFailure(
    () =>
      assertProductionSchemaContractManifest(staleLegacyContract, migrations),
    "stale legacy contract history refuses before database access",
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
