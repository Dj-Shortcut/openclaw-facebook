/* global process */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql from "mysql2/promise";
import {
  cleanupMigrationConnection,
  loadAndVerifyMigrationManifest,
  migrationLockName,
  productionLegacy0007Rows,
} from "./migrate-production.mjs";
import {
  assertExactSchemaState,
  assertProductionMigrationRuntime,
  canonicalJson,
  captureMigrationHistory,
  captureProductionSchemaState,
} from "./production-schema-contract.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const appDirectory = path.resolve(scriptDirectory, "..");
const drizzleDirectory = path.join(appDirectory, "drizzle");

export async function runProductionLegacyBridge(options = {}) {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const lockTimeoutSeconds = options.lockTimeoutSeconds ?? 30;
  if (
    !Number.isInteger(lockTimeoutSeconds) ||
    lockTimeoutSeconds < 0 ||
    lockTimeoutSeconds > 300
  ) {
    throw new Error("migration lock timeout must be an integer from 0 to 300");
  }

  const { migrations, productionContract: contract } =
    await loadAndVerifyMigrationManifest();
  const connection = await mysql.createConnection(databaseUrl);
  let lockName;
  let lockHeld = false;
  let bridgeDirectory;
  let result;
  let operationError;
  const startedAt = Date.now();
  try {
    const runtime = await assertProductionMigrationRuntime(connection);
    lockName = migrationLockName(runtime.databaseName);
    const [[lock]] = await connection.query(
      "SELECT GET_LOCK(?,?) AS acquired",
      [lockName, lockTimeoutSeconds]
    );
    if (Number(lock.acquired) !== 1) {
      throw new Error("migration singleton lock is unavailable");
    }
    lockHeld = true;

    const state = await inspectLegacyBridgeState(
      connection,
      contract,
      migrations
    );
    if (state === "legacy") {
      bridgeDirectory = await createBridgeMigrationDirectory(migrations);
      await migrate(drizzle(connection), {
        migrationsFolder: bridgeDirectory,
      });
      await assertTransitional0014State(connection, contract, migrations);
    }
    if (state !== "complete") {
      await normalizeLegacyHistory(connection, contract, migrations);
    }

    const history = await captureMigrationHistory(connection);
    assertExactHistory(history, contract.baseHistory, "0014");
    const schema = await captureProductionSchemaState(connection);
    assertExactSchemaState(schema, contract.base0014, "0014");
    result = {
      appliedCount: 15,
      lockWaitMs: Date.now() - startedAt,
    };
  } catch (error) {
    operationError = error;
  }

  const cleanupErrors = [];
  if (bridgeDirectory) {
    try {
      await fs.rm(bridgeDirectory, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  const connectionCleanupError = await cleanupMigrationConnection(
    connection,
    lockHeld ? lockName : null
  );
  if (connectionCleanupError) cleanupErrors.push(connectionCleanupError);
  if (operationError || cleanupErrors.length > 0) {
    if (operationError && cleanupErrors.length === 0) throw operationError;
    throw new AggregateError(
      [operationError, ...cleanupErrors].filter(Boolean),
      operationError
        ? `legacy bridge failed and cleanup also failed: ${operationError instanceof Error ? operationError.message : "unknown bridge error"}`
        : "legacy bridge cleanup failed",
      operationError ? { cause: operationError } : undefined
    );
  }
  return result;
}

export async function inspectLegacyBridgeState(
  connection,
  contract,
  migrations
) {
  const history = await captureMigrationHistory(connection);
  const schema = await captureProductionSchemaState(connection);
  if (
    isExactHistory(history, contract.baseHistory) &&
    isExactSchema(schema, contract.base0014)
  ) {
    return "complete";
  }
  if (
    isExactHistory(history, contract.legacyHistory) &&
    isExactSchema(schema, contract.legacy0007)
  ) {
    return "legacy";
  }
  if (
    isTransitional0014History(history, contract, migrations) &&
    isExactSchema(schema, contract.base0014)
  ) {
    return "normalize";
  }
  throw new Error("database is not an exact supported legacy 0007/0014 state");
}

async function assertTransitional0014State(connection, contract, migrations) {
  const history = await captureMigrationHistory(connection);
  if (!isTransitional0014History(history, contract, migrations)) {
    throw new Error("legacy bridge produced an unexpected migration history");
  }
  const schema = await captureProductionSchemaState(connection);
  assertExactSchemaState(schema, contract.base0014, "bridged 0014");
}

function isTransitional0014History(history, contract, migrations) {
  if (
    !history ||
    history.nextId !== contract.baseHistory.nextId ||
    history.showCreateSha256 !== contract.baseHistory.showCreateSha256
  ) {
    return false;
  }
  const expected = [
    ...productionLegacy0007Rows(migrations),
    ...migrations.slice(8, 15).map((migration, index) => ({
      id: index + 9,
      hash: migration.sha256,
      createdAt: Number(migration.when),
    })),
  ];
  return canonicalJson(history.rows) === canonicalJson(expected);
}

async function normalizeLegacyHistory(connection, contract, migrations) {
  const legacyRows = productionLegacy0007Rows(migrations);
  await connection.beginTransaction();
  try {
    for (const id of [3, 4]) {
      const expectedLegacy = legacyRows[id - 1];
      const expectedCanonical = contract.baseHistory.rows[id - 1];
      const [update] = await connection.query(
        "UPDATE `__drizzle_migrations` SET `hash`=? WHERE `id`=? AND `hash`=? AND `created_at`=?",
        [
          expectedCanonical.hash,
          id,
          expectedLegacy.hash,
          expectedLegacy.createdAt,
        ]
      );
      if (Number(update.affectedRows) !== 1) {
        throw new Error(`legacy migration history row ${id} changed`);
      }
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

async function createBridgeMigrationDirectory(migrations) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "leaderbot-0007-to-0014-")
  );
  const metaDirectory = path.join(directory, "meta");
  await fs.mkdir(metaDirectory);
  const journal = JSON.parse(
    await fs.readFile(
      path.join(drizzleDirectory, "meta", "_journal.json"),
      "utf8"
    )
  );
  const selected = migrations.slice(8, 15);
  const selectedTags = new Set(selected.map(migration => migration.tag));
  const entries = journal.entries.filter(entry => selectedTags.has(entry.tag));
  if (entries.length !== selected.length) {
    throw new Error("legacy bridge journal is incomplete");
  }
  await fs.writeFile(
    path.join(metaDirectory, "_journal.json"),
    `${JSON.stringify({ ...journal, entries }, null, 2)}\n`,
    "utf8"
  );
  for (const migration of selected) {
    await fs.copyFile(
      path.join(drizzleDirectory, `${migration.tag}.sql`),
      path.join(directory, `${migration.tag}.sql`)
    );
  }
  return directory;
}

function assertExactHistory(actual, expected, label) {
  if (!isExactHistory(actual, expected)) {
    throw new Error(`${label} migration history contract mismatch`);
  }
}

function isExactHistory(actual, expected) {
  return canonicalJson(actual) === canonicalJson(expected);
}

function isExactSchema(actual, expected) {
  return canonicalJson(actual) === canonicalJson(expected);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runProductionLegacyBridge();
  process.stdout.write(
    `Production legacy bridge verified (${result.appliedCount} applied).\n`
  );
}
