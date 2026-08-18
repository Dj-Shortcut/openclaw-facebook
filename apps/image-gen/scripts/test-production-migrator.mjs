/* global process, URL */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import {
  loadAndVerifyMigrationManifest,
  migrationLockName,
  runProductionMigrations,
} from "./migrate-production.mjs";

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

  const concurrentUrl = databaseUrl(databases[0]);
  const results = await Promise.all([
    runProductionMigrations({ databaseUrl: concurrentUrl }),
    runProductionMigrations({ databaseUrl: concurrentUrl }),
  ]);
  assert(
    results.every(result => result.appliedCount === 16),
    "concurrent apply"
  );
  const idempotent = await runProductionMigrations({
    databaseUrl: concurrentUrl,
  });
  assert(idempotent.appliedCount === 16, "already-complete idempotent apply");

  const { migrations: manifest } = await loadAndVerifyMigrationManifest();
  await withDatabase(databases[1], async connection => {
    await applyMigrationPrefix(connection, manifest.slice(0, -1));
  });
  const upgraded = await runProductionMigrations({
    databaseUrl: databaseUrl(databases[1]),
  });
  assert(upgraded.appliedCount === 16, "clean 0014 to 0015 upgrade");

  await withDatabase(databases[2], async connection => {
    await applyMigrationPrefix(connection, manifest.slice(0, -1));
    await createLegacyMessengerState(connection);
  });
  const upgradedWithState = await runProductionMigrations({
    databaseUrl: databaseUrl(databases[2]),
  });
  assert(
    upgradedWithState.appliedCount === 16,
    "0014 with exact legacy state to 0015 upgrade"
  );

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
    "0014 schema contract is incomplete"
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
    "partial 0015 schema detected"
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
