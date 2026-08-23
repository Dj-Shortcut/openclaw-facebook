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
  billingHandoffWriterLockName,
  loadAndVerifyMigrationManifest,
  migrationLockName,
  productionMigrationOptionsForMode,
  productionSchemaPhases,
  runProductionMigrations as runProductionMigrationStage,
  assertContractRolloutRevision,
} from "./migrate-production.mjs";
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
testBillingHandoffWriterLockContract();
testStagedRolloutContracts();
testSchemaDigestContracts();
await testContractManifestBinding();

const reviewedWriterRevision = "a".repeat(40);

async function runProductionMigrations(options = {}) {
  if (options.verifyOnly) {
    return runProductionMigrationStage({
      ...options,
      target: options.target ?? "contract",
    });
  }
  try {
    return await runProductionMigrationStage({
      ...options,
      target: "contract",
      allowEmptyBootstrap: true,
      sourceRevision: reviewedWriterRevision,
      fullyDeployedWriterRevision: reviewedWriterRevision,
    });
  } catch (error) {
    if (
      String(error?.message).includes(
        "contract migration cannot skip the reviewed 0016 expand rollout"
      )
    ) {
      await apply0015PrerequisiteForTest(options.databaseUrl);
    } else if (
      !String(error?.message).includes(
        "contract migration requires the completed 0016 expand phase"
      )
    ) {
      throw error;
    }
  }
  await runProductionMigrationStage({
    ...options,
    target: "expand",
    verifyOnly: false,
  });
  return runProductionMigrationStage({
    ...options,
    target: "contract",
    verifyOnly: false,
    sourceRevision: reviewedWriterRevision,
    fullyDeployedWriterRevision: reviewedWriterRevision,
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
const resume0017Databases = Array.from(
  { length: 18 },
  (_, index) => `leaderbot_production_migrator_resume_0017_${index}`
);
const handoffWriterLockDatabase =
  "leaderbot_production_migrator_handoff_writer_lock";
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
  "leaderbot_production_migrator_handoff_backfill",
  handoffWriterLockDatabase,
  ...resume0016Databases,
  ...resume0017Databases,
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
    results.every(result => result.appliedCount === 18),
    "concurrent apply"
  );
  const beforeNoop = await withDatabaseResult(databases[0], connection =>
    captureSchemaFingerprint(connection)
  );
  const idempotent = await runProductionMigrations({
    databaseUrl: concurrentUrl,
  });
  assert(idempotent.appliedCount === 18, "already-complete idempotent apply");
  const afterNoop = await withDatabaseResult(databases[0], connection =>
    captureSchemaFingerprint(connection)
  );
  assert(
    beforeNoop === afterNoop,
    "complete 0017 no-op leaves schema/history unchanged"
  );

  const { migrations: manifest } = await loadAndVerifyMigrationManifest();
  await withDatabase(stagedRolloutDatabase, async connection => {
    await applyMigrationPrefix(connection, manifest.slice(0, -2));
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
    expanded.schemaPhase === "0016_expand" && expanded.appliedCount === 17,
    "expand applies only 0016"
  );
  await withDatabase(stagedRolloutDatabase, connection =>
    connection.query(
      "INSERT INTO `billing_intents` (`intent_id`,`workspace_id`,`mode`,`plan_code`,`kind`,`expected_amount`,`currency`,`interval`,`entitlements`,`mollie_description`,`status`,`idempotency_key`,`checkout_scope_key`,`messenger_sender_user_key`,`messenger_page_id`,`billing_profile_version`,`authorization_epoch`) VALUES ('72000000-0000-4000-8000-000000000001',7201,'test','startpilot','startpilot_purchase','19.00','EUR','one-time',JSON_OBJECT('aiAnswers',300),'Old writer during expand','paid','staged-old-writer-key','staged-old-writer-scope','staged-user','staged-page',0,1)"
    )
  );
  const beforeContractAttestation = await withDatabaseResult(
    stagedRolloutDatabase,
    connection => captureSchemaFingerprint(connection)
  );
  await expectFailure(
    runProductionMigrationStage({
      databaseUrl: databaseUrl(stagedRolloutDatabase),
      target: "contract",
    }),
    "contract without rollout attestation",
    "exact fully deployed reviewed writer source revision"
  );
  await expectFailure(
    runProductionMigrationStage({
      databaseUrl: databaseUrl(stagedRolloutDatabase),
      target: "contract",
      sourceRevision: "a".repeat(40),
      fullyDeployedWriterRevision: "b".repeat(40),
    }),
    "contract with a different reviewed writer",
    "exact fully deployed reviewed writer source revision"
  );
  const afterContractAttestation = await withDatabaseResult(
    stagedRolloutDatabase,
    connection => captureSchemaFingerprint(connection)
  );
  assert(
    beforeContractAttestation === afterContractAttestation,
    "contract attestation refusal leaves schema and history unchanged"
  );
  const contracted = await runProductionMigrationStage({
    databaseUrl: databaseUrl(stagedRolloutDatabase),
    target: "contract",
    sourceRevision: reviewedWriterRevision,
    fullyDeployedWriterRevision: reviewedWriterRevision,
  });
  assert(
    contracted.schemaPhase === "0017_contract" &&
      contracted.appliedCount === 18,
    "attested contract applies only after expand"
  );
  await withDatabase(stagedRolloutDatabase, async connection => {
    const [[repaired]] = await connection.query(
      "SELECT `messenger_channel_connection_id` AS connectionId,`messenger_privacy_epoch` AS privacyEpoch FROM `billing_intents` WHERE `intent_id`='72000000-0000-4000-8000-000000000001'"
    );
    assert(
      repaired.connectionId === 7202 && repaired.privacyEpoch === 3,
      "contract repairs an old-writer row accepted during expand"
    );
    await expectMysqlCheckFailure(
      connection.query(
        "INSERT INTO `billing_intents` (`intent_id`,`workspace_id`,`mode`,`plan_code`,`kind`,`expected_amount`,`currency`,`interval`,`entitlements`,`mollie_description`,`status`,`idempotency_key`,`checkout_scope_key`,`messenger_sender_user_key`,`messenger_page_id`,`billing_profile_version`,`authorization_epoch`) VALUES ('72000000-0000-4000-8000-000000000002',7201,'test','startpilot','startpilot_purchase','19.00','EUR','one-time',JSON_OBJECT('aiAnswers',300),'Old writer after contract','paid','staged-fenced-key','staged-fenced-scope','staged-user','staged-page',0,1)"
      ),
      "contract fences an old handoff writer"
    );
  });
  await withDatabase(databases[22], connection =>
    applyMigrationPrefix(connection, manifest.slice(0, -1))
  );
  const beforeVerifyOnlyRefusal = await withDatabaseResult(
    databases[22],
    connection => captureSchemaFingerprint(connection)
  );
  await expectFailure(
    runProductionMigrations({
      databaseUrl: databaseUrl(databases[22]),
      verifyOnly: true,
    }),
    "verify-only release on pending 0017",
    "schema is at 0016_expand; contract verification refused"
  );
  const verifiedExpand = await runProductionMigrationStage({
    databaseUrl: databaseUrl(databases[22]),
    verifyOnly: true,
    target: "expand",
  });
  assert(
    verifiedExpand.schemaPhase === "0016_expand" &&
      verifiedExpand.appliedCount === 17,
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
  const afterVerifyOnlyRefusal = await withDatabaseResult(
    databases[22],
    connection => captureSchemaFingerprint(connection)
  );
  assert(
    beforeVerifyOnlyRefusal === afterVerifyOnlyRefusal,
    "verify-only release leaves pending schema/history unchanged"
  );
  const verifiedComplete = await runProductionMigrations({
    databaseUrl: concurrentUrl,
    verifyOnly: true,
  });
  assert(
    verifiedComplete.appliedCount === 18,
    "verify-only release accepts exact completed schema"
  );
  for (const target of ["compatible", "expand"]) {
    await expectFailure(
      runProductionMigrationStage({
        databaseUrl: concurrentUrl,
        verifyOnly: true,
        target,
      }),
      `${target} verifier on unauthorized 0017`,
      `schema is at 0017_contract; ${target} verification refused`
    );
  }
  const verifiedContract = await runProductionMigrationStage({
    databaseUrl: concurrentUrl,
    verifyOnly: true,
    target: "contract",
  });
  assert(
    verifiedContract.schemaPhase === "0017_contract",
    "contract verification accepts only the contract schema"
  );
  await expectFailure(
    runProductionMigrationStage({
      databaseUrl: concurrentUrl,
      verifyOnly: false,
      target: "expand",
    }),
    "expand apply on unauthorized 0017",
    "expand migration refuses the 0017 contract schema"
  );
  const migration0016ForVerify = await readMigrationStatements(manifest.at(-2));
  await withDatabase(databases[1], async connection => {
    await applyMigrationPrefix(connection, manifest.slice(0, -2));
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
    migratedLegacy.appliedCount === 18,
    "bridged 0014 continues through canonical 0017"
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
    manifest.at(-2)
  );
  const migration0017Statements = await readMigrationStatements(
    manifest.at(-1)
  );
  const migration0015Statements = await readMigrationStatements(
    manifest.at(-3)
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
    canonicalizedSession.appliedCount === 18,
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
      primaryKeyFresh.appliedCount === 18,
      "fresh migration supports required primary keys"
    );
    await withDatabase(databases[16], connection =>
      applyMigrationPrefix(connection, manifest.slice(0, -1))
    );
    const primaryKeyUpgrade = await runProductionMigrations({
      databaseUrl: databaseUrl(databases[16]),
    });
    assert(
      primaryKeyUpgrade.appliedCount === 18,
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
  await testHistoryRefusals(databases[0], manifest);
  await testEveryTailStatementBoundary({
    manifest,
    migration0016Statements,
    migration0017Statements,
  });
  await testHandoffPrivacyBackfill(manifest);

  await withDatabase(databases[2], async connection => {
    await applyMigrationPrefix(connection, manifest.slice(0, -3));
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
    upgradedWithState.appliedCount === 18,
    "0014 with exact legacy state continues through 0017"
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
    await applyMigrationPrefix(connection, manifest.slice(0, -3));
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
    await applyMigrationPrefix(connection, manifest.slice(0, -2));
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
    await applyMigrationPrefix(connection, manifest.slice(0, -3));
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
    await applyStatements(connection, migration0017Statements.slice(0, 4));
    await connection.query(
      "ALTER TABLE `billing_intents` ADD COLUMN `unexpected_partial_drift` int NULL"
    );
  });
  await expectFailure(
    runProductionMigrations({ databaseUrl: databaseUrl(databases[6]) }),
    "arbitrary 0017 partial drift",
    "0017 partial schema fingerprint mismatch"
  );

  await withDatabase(databases[7], async connection => {
    await applyMigrationPrefix(connection, manifest.slice(0, -2));
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
    resumedReactivatedSubject.appliedCount === manifest.length,
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
    await applyMigrationPrefix(connection, manifest.slice(0, -3));
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

  await withDatabase(handoffWriterLockDatabase, async connection => {
    await applyMigrationPrefix(connection, manifest.slice(0, -1));
    const lockName = billingHandoffWriterLockName(handoffWriterLockDatabase);
    const [[lock]] = await connection.query(
      "SELECT GET_LOCK(?,0) AS acquired",
      [lockName]
    );
    assert(Number(lock.acquired) === 1, "handoff writer test lock acquired");
    try {
      await expectFailure(
        runProductionMigrations({
          databaseUrl: databaseUrl(handoffWriterLockDatabase),
          lockTimeoutSeconds: 0,
        }),
        "handoff writer lock contention",
        "billing handoff writer lock is unavailable"
      );
    } finally {
      await connection.query("SELECT RELEASE_LOCK(?)", [lockName]);
    }
  });
  await runProductionMigrations({
    databaseUrl: databaseUrl(handoffWriterLockDatabase),
  });

  process.stdout.write(
    "Production migrator passed: singleton, exact manifest, forward resume at every 0016/0017 boundary, and drift refusal.\n"
  );
} finally {
  for (const database of databases) {
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
  }
  await admin.end();
}

async function testEveryTailStatementBoundary({
  manifest,
  migration0016Statements,
  migration0017Statements,
}) {
  for (
    let boundary = 0;
    boundary <= migration0016Statements.length;
    boundary += 1
  ) {
    const database = resume0016Databases[boundary];
    await withDatabase(database, async connection => {
      await applyMigrationPrefix(connection, manifest.slice(0, -2));
      await applyStatements(
        connection,
        migration0016Statements.slice(0, boundary)
      );
    });
    const resumed = await runProductionMigrations({
      databaseUrl: databaseUrl(database),
    });
    assert(
      resumed.appliedCount === manifest.length,
      `0016 resumes after statement boundary ${boundary}`
    );
  }

  for (
    let boundary = 0;
    boundary <= migration0017Statements.length;
    boundary += 1
  ) {
    const database = resume0017Databases[boundary];
    await withDatabase(database, async connection => {
      await applyMigrationPrefix(connection, manifest.slice(0, -1));
      await applyStatements(
        connection,
        migration0017Statements.slice(0, boundary)
      );
      if (boundary === 12) {
        await insertInterruptedLegacyDeletionFixture(connection);
      }
      if (boundary === 15) {
        await insertPostErasureLegacyWriterFixture(connection);
      }
    });
    const resumed = await runProductionMigrations({
      databaseUrl: databaseUrl(database),
    });
    assert(
      resumed.appliedCount === manifest.length,
      `0017 resumes after statement boundary ${boundary}`
    );
    if (boundary === 15) {
      await withDatabase(database, async connection => {
        const [[contained]] = await connection.query(
          "SELECT `status`,`messengerSenderUserKey` AS userKey,`facebookPageId` AS pageId,`messenger_channel_connection_id` AS connectionId,`messenger_privacy_epoch` AS privacyEpoch FROM `portalHandoffTokens` WHERE `tokenHash`='post-erasure-token'"
        );
        assert(
          contained.status === "revoked" &&
            contained.userKey === null &&
            contained.pageId === null &&
            contained.connectionId === null &&
            contained.privacyEpoch === null,
          "post-erasure legacy write is scrubbed before constraints"
        );
        await expectMysqlCheckFailure(
          connection.query(
            "INSERT INTO `portalHandoffTokens` (`workspaceId`,`tokenHash`,`messengerSenderUserKey`,`facebookPageId`,`purpose`,`status`,`expiresAt`) VALUES (7701,'old-shape-after-check','post-erasure-user','post-erasure-page','workspace_onboarding','pending',DATE_ADD(NOW(),INTERVAL 1 HOUR))"
          ),
          "old-shape writer after strict handoff check"
        );
      });
    }
    if (boundary === 12) {
      await withDatabase(database, async connection => {
        const [[intent]] = await connection.query(
          "SELECT `status`,`messenger_sender_user_key` AS userKey,`messenger_page_id` AS pageId,`messenger_channel_connection_id` AS connectionId,`messenger_privacy_epoch` AS privacyEpoch FROM `billing_intents` WHERE `intent_id`='79000000-0000-4000-8000-000000000001'"
        );
        assert(
          intent.status === "paid" &&
            intent.userKey === null &&
            intent.pageId === null &&
            intent.connectionId === null &&
            intent.privacyEpoch === null,
          "resume contains a legacy deletion that landed after data COMMIT"
        );
      });
    }
  }
}

async function insertInterruptedLegacyDeletionFixture(connection) {
  await connection.query(
    "INSERT INTO `workspaces` (`id`,`name`,`slug`) VALUES (7901,'Interrupted deletion','interrupted-deletion')"
  );
  await connection.query(
    "INSERT INTO `channelConnections` (`id`,`workspaceId`,`channel`,`status`,`externalId`) VALUES (7902,7901,'facebook_messenger','connected','interrupted-page')"
  );
  await connection.query(
    "INSERT INTO `messenger_privacy_subjects` (`workspace_id`,`channel_connection_id`,`user_key`,`privacy_epoch`,`status`) VALUES (7901,7902,'interrupted-user',3,'active')"
  );
  await connection.query(
    "INSERT INTO `billing_intents` (`intent_id`,`workspace_id`,`mode`,`plan_code`,`kind`,`expected_amount`,`currency`,`interval`,`entitlements`,`mollie_description`,`status`,`idempotency_key`,`checkout_scope_key`,`messenger_sender_user_key`,`messenger_page_id`,`messenger_channel_connection_id`,`messenger_privacy_epoch`,`billing_profile_version`,`authorization_epoch`) VALUES ('79000000-0000-4000-8000-000000000001',7901,'test','startpilot','startpilot_purchase','19.00','EUR','one-time',JSON_OBJECT('aiAnswers',300),'Interrupted deletion','paid','interrupted-deletion-key','interrupted-deletion-scope','interrupted-user','interrupted-page',7902,3,0,1)"
  );
  await connection.query(
    "UPDATE `messenger_privacy_subjects` SET `privacy_epoch`=4,`status`='erased',`erased_at`='2026-08-23 10:30:00',`last_erased_at`='2026-08-23 10:30:00.000' WHERE `workspace_id`=7901 AND `channel_connection_id`=7902 AND `user_key`='interrupted-user'"
  );
  // Old code knows only the legacy pair. This is the reachable durable shape
  // if it erases identity after the migration data COMMIT but before CHECK DDL.
  await connection.query(
    "UPDATE `billing_intents` SET `messenger_sender_user_key`=NULL,`messenger_page_id`=NULL WHERE `intent_id`='79000000-0000-4000-8000-000000000001'"
  );
}

async function insertPostErasureLegacyWriterFixture(connection) {
  await connection.query(
    "INSERT INTO `workspaces` (`id`,`name`,`slug`) VALUES (7701,'Post erasure','post-erasure')"
  );
  await connection.query(
    "INSERT INTO `channelConnections` (`id`,`workspaceId`,`channel`,`status`,`externalId`) VALUES (7702,7701,'facebook_messenger','connected','post-erasure-page')"
  );
  await connection.query(
    "INSERT INTO `messenger_privacy_subjects` (`workspace_id`,`channel_connection_id`,`user_key`,`privacy_epoch`,`status`,`erased_at`,`last_erased_at`) VALUES (7701,7702,'post-erasure-user',2,'erased','2026-08-23 10:00:00','2026-08-23 10:00:00.000')"
  );
  // Simulates an old process that was already past its application-level
  // privacy check when deletion completed, but writes before the DB CHECK.
  await connection.query(
    "INSERT INTO `portalHandoffTokens` (`workspaceId`,`tokenHash`,`messengerSenderUserKey`,`facebookPageId`,`purpose`,`status`,`expiresAt`) VALUES (7701,'post-erasure-token','post-erasure-user','post-erasure-page','workspace_onboarding','pending',DATE_ADD(NOW(),INTERVAL 1 HOUR))"
  );
}

async function testHandoffPrivacyBackfill(manifest) {
  const database = "leaderbot_production_migrator_handoff_backfill";
  await withDatabase(database, async connection => {
    await applyMigrationPrefix(connection, manifest.slice(0, -1));
    await connection.query(
      "INSERT INTO `workspaces` (`id`,`name`,`slug`) VALUES (7801,'Handoff backfill','handoff-backfill')"
    );
    await connection.query(
      "INSERT INTO `channelConnections` (`id`,`workspaceId`,`channel`,`status`,`externalId`) VALUES (7802,7801,'facebook_messenger','connected','backfill-page')"
    );
    await connection.query(
      "INSERT INTO `messenger_privacy_subjects` (`workspace_id`,`channel_connection_id`,`user_key`,`privacy_epoch`,`status`,`erased_at`,`last_erased_at`) VALUES (7801,7802,'active-user',4,'active',NULL,NULL),(7801,7802,'erased-user',7,'erased','2026-08-23 09:00:00','2026-08-23 09:00:00.000')"
    );
    await connection.query(
      "INSERT INTO `billing_intents` (`intent_id`,`workspace_id`,`mode`,`plan_code`,`kind`,`expected_amount`,`currency`,`interval`,`entitlements`,`mollie_description`,`status`,`idempotency_key`,`checkout_scope_key`,`messenger_sender_user_key`,`messenger_page_id`,`billing_profile_version`,`authorization_epoch`) VALUES ('78000000-0000-4000-8000-000000000001',7801,'test','startpilot','startpilot_purchase','19.00','EUR','one-time',JSON_OBJECT('aiAnswers',300),'Valid backfill','paid','backfill-valid-key','backfill-valid-scope','active-user','backfill-page',0,1),('78000000-0000-4000-8000-000000000002',7801,'test','startpilot','startpilot_purchase','19.00','EUR','one-time',JSON_OBJECT('aiAnswers',300),'Erased backfill','paid','backfill-erased-key','backfill-erased-scope','erased-user','backfill-page',0,1)"
    );
    await connection.query(
      "INSERT INTO `portalHandoffTokens` (`workspaceId`,`tokenHash`,`messengerSenderUserKey`,`facebookPageId`,`purpose`,`status`,`expiresAt`) VALUES (7801,'backfill-valid-token','active-user','backfill-page','workspace_onboarding','consumed',DATE_SUB(NOW(),INTERVAL 1 HOUR)),(7801,'backfill-erased-token','erased-user','backfill-page','workspace_onboarding','pending',DATE_ADD(NOW(),INTERVAL 1 HOUR))"
    );
    await connection.query(
      "INSERT INTO `billing_outbox` (`id`,`delivery_id`,`workspace_id`,`mode`,`event_type`,`deduplication_key`,`payload`,`status`,`available_at`) VALUES (7803,'78000000-0000-4000-8000-000000000003',7801,'test','send_portal_handoff','backfill-valid-outbox',JSON_OBJECT('intentId','78000000-0000-4000-8000-000000000001','messengerSenderUserKey','active-user','messengerPageId','backfill-page'),'pending',NOW()),(7804,'78000000-0000-4000-8000-000000000004',7801,'test','send_portal_handoff','backfill-erased-outbox',JSON_OBJECT('intentId','78000000-0000-4000-8000-000000000002','messengerSenderUserKey','erased-user','messengerPageId','backfill-page'),'pending',NOW())"
    );
    await connection.query(
      "INSERT INTO `billing_handoff_recovery_events` (`outbox_id`,`workspace_id`,`event_id_hash`,`source`,`event_timestamp`) VALUES (7804,7801,REPEAT('a',64),'migration-test',NOW())"
    );
  });

  const migrated = await runProductionMigrations({
    databaseUrl: databaseUrl(database),
  });
  assert(
    migrated.appliedCount === manifest.length,
    "handoff privacy fixture reaches final schema"
  );
  await withDatabase(database, async connection => {
    const [intents] = await connection.query(
      "SELECT `intent_id` AS id,`status`,`messenger_sender_user_key` AS userKey,`messenger_page_id` AS pageId,`messenger_channel_connection_id` AS connectionId,`messenger_privacy_epoch` AS privacyEpoch FROM `billing_intents` WHERE `workspace_id`=7801 ORDER BY `intent_id`"
    );
    assert(
      intents[0].status === "paid" &&
        intents[0].userKey === "active-user" &&
        intents[0].connectionId === 7802 &&
        intents[0].privacyEpoch === 4,
      "active billing identity receives immutable scope"
    );
    assert(
      intents[1].status === "paid" &&
        intents[1].userKey === null &&
        intents[1].pageId === null &&
        intents[1].connectionId === null &&
        intents[1].privacyEpoch === null,
      "erased billing identity is scrubbed without changing financial truth"
    );
    const [tokens] = await connection.query(
      "SELECT `tokenHash` AS tokenHash,`status`,`messengerSenderUserKey` AS userKey,`messenger_channel_connection_id` AS connectionId,`messenger_privacy_epoch` AS privacyEpoch FROM `portalHandoffTokens` WHERE `workspaceId`=7801 ORDER BY `tokenHash`"
    );
    assert(
      tokens[0].status === "revoked" && tokens[0].userKey === null,
      "erased portal capability is revoked and scrubbed"
    );
    assert(
      tokens[1].status === "consumed" &&
        tokens[1].userKey === "active-user" &&
        tokens[1].connectionId === 7802 &&
        tokens[1].privacyEpoch === 4,
      "consumed active portal capability keeps its immutable scope"
    );
    const [outbox] = await connection.query(
      "SELECT `id`,`status`,`last_error_code` AS errorCode,`privacy_erased_at` AS privacyErasedAt,JSON_UNQUOTE(JSON_EXTRACT(`payload`,'$.messengerChannelConnectionId')) AS payloadConnection,JSON_UNQUOTE(JSON_EXTRACT(`payload`,'$.messengerPrivacyEpoch')) AS payloadEpoch,JSON_UNQUOTE(JSON_EXTRACT(`payload`,'$.privacyErased')) AS payloadErased FROM `billing_outbox` WHERE `workspace_id`=7801 ORDER BY `id`"
    );
    assert(
      outbox[0].status === "pending" &&
        Number(outbox[0].payloadConnection) === 7802 &&
        Number(outbox[0].payloadEpoch) === 4,
      "valid handoff job receives the immutable scope"
    );
    assert(
      outbox[1].status === "failed" &&
        outbox[1].errorCode === "privacy_erased" &&
        outbox[1].privacyErasedAt instanceof Date &&
        outbox[1].payloadErased === "true",
      "invalid handoff job is fenced and scrubbed"
    );
    const [[recovery]] = await connection.query(
      "SELECT COUNT(*) AS count FROM `billing_handoff_recovery_events` WHERE `outbox_id`=7804"
    );
    assert(Number(recovery.count) === 0, "invalid handoff recovery is removed");
  });
}

async function expectMysqlCheckFailure(promise, label) {
  try {
    await promise;
  } catch (error) {
    if (
      error?.code === "ER_CHECK_CONSTRAINT_VIOLATED" ||
      Number(error?.errno) === 3819
    ) {
      return;
    }
    throw new Error(`${label} failed for an unexpected reason`, {
      cause: error,
    });
  }
  throw new Error(`expected MySQL CHECK refusal: ${label}`);
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
    "0017 schema fingerprint mismatch"
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
    "0017 schema fingerprint mismatch"
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
    "0017 schema fingerprint mismatch"
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
    "0017 migration history table contract mismatch"
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
    "0017 migration history table contract mismatch"
  );
  await withDatabase(database, connection =>
    connection.query(
      `ALTER TABLE \`__drizzle_migrations\` AUTO_INCREMENT=${manifest.length + 1}`
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
  const { migrations } = await loadAndVerifyMigrationManifest();
  const migration = migrations.at(-3);
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

function testBillingHandoffWriterLockContract() {
  const first = billingHandoffWriterLockName("leaderbot_a");
  const same = billingHandoffWriterLockName("leaderbot_a");
  const other = billingHandoffWriterLockName("leaderbot_b");
  assert(first === same, "handoff writer lock is stable per database");
  assert(first !== other, "handoff writer lock is isolated per database");
  assert(
    first.startsWith("leaderbot:handoff:") && first.length <= 64,
    "handoff writer lock fits the MySQL named-lock contract"
  );
}

function testStagedRolloutContracts() {
  assert(
    JSON.stringify(productionSchemaPhases) ===
      JSON.stringify(["0015_base", "0016_expand", "0017_contract"]),
    "schema phase names are stable"
  );
  assertContractRolloutRevision("a".repeat(40), "a".repeat(40));
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
    productionMigrationOptionsForMode("apply") === null &&
      productionMigrationOptionsForMode("verify") === null &&
      productionMigrationOptionsForMode("apply-expand") === null &&
      productionMigrationOptionsForMode("apply-expand", "runtime") === null &&
      productionMigrationOptionsForMode("verify-artifact") === null &&
      productionMigrationOptionsForMode("verify-artifact", "unknown") ===
        null &&
      productionMigrationOptionsForMode("apply-contract") === null,
    "legacy and production contract apply modes fail closed"
  );
  expectSynchronousFailure(
    () => assertContractRolloutRevision("a".repeat(40), "b".repeat(40)),
    "contract rejects a different deployed writer",
    "exact fully deployed reviewed writer"
  );
  expectSynchronousFailure(
    () =>
      assertContractRolloutRevision("unreviewed-local-build", "a".repeat(40)),
    "contract rejects an unreviewed local image",
    "exact fully deployed reviewed writer"
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
