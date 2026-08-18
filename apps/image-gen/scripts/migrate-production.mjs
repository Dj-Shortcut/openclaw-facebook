/* global process */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql from "mysql2/promise";
import {
  assertExactSchemaState,
  assertProductionMigrationRuntime,
  captureMigrationHistory,
  captureProductionSchemaState,
  canonicalJson,
  productionMigrationSetSha256,
} from "./production-schema-contract.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const appDirectory = path.resolve(scriptDirectory, "..");
const drizzleDirectory = path.join(appDirectory, "drizzle");
const manifestPath = path.join(drizzleDirectory, "migration-manifest.json");
const journalPath = path.join(drizzleDirectory, "meta", "_journal.json");

export async function loadAndVerifyMigrationManifest() {
  const [manifestRaw, journalRaw] = await Promise.all([
    fs.readFile(manifestPath, "utf8"),
    fs.readFile(journalPath, "utf8"),
  ]);
  const manifest = JSON.parse(manifestRaw);
  const journal = JSON.parse(journalRaw);
  if (manifest.version !== 1 || !Array.isArray(manifest.migrations)) {
    throw new Error("migration manifest format is unsupported");
  }
  if (manifest.baseSchemaSnapshot !== "meta/0014_snapshot.json") {
    throw new Error("migration manifest base snapshot path is unsupported");
  }
  if (manifest.schemaSnapshot !== "meta/0015_snapshot.json") {
    throw new Error("migration manifest schema snapshot path is unsupported");
  }
  if (manifest.productionSchemaContract !== "production-schema-contract.json") {
    throw new Error("production schema contract path is unsupported");
  }
  assertContentHash(journalRaw, manifest.journalSha256, "Drizzle journal");
  const [baseSnapshotRaw, snapshotRaw, productionContractRaw] =
    await Promise.all([
      fs.readFile(
        path.join(drizzleDirectory, manifest.baseSchemaSnapshot),
        "utf8"
      ),
      fs.readFile(path.join(drizzleDirectory, manifest.schemaSnapshot), "utf8"),
      fs.readFile(
        path.join(drizzleDirectory, manifest.productionSchemaContract),
        "utf8"
      ),
    ]);
  assertContentHash(
    baseSnapshotRaw,
    manifest.baseSchemaSnapshotSha256,
    "base schema snapshot"
  );
  assertContentHash(
    snapshotRaw,
    manifest.schemaSnapshotSha256,
    "schema snapshot"
  );
  assertContentHash(
    productionContractRaw,
    manifest.productionSchemaContractSha256,
    "production schema contract"
  );
  if (journal.entries.length !== manifest.migrations.length) {
    throw new Error("migration manifest does not match the Drizzle journal");
  }
  for (let index = 0; index < manifest.migrations.length; index += 1) {
    const expected = manifest.migrations[index];
    const journalEntry = journal.entries[index];
    if (
      expected.idx !== index ||
      journalEntry.idx !== index ||
      expected.tag !== journalEntry.tag ||
      Number(expected.when) !== Number(journalEntry.when)
    ) {
      throw new Error(`migration manifest ordering mismatch at index ${index}`);
    }
    const sql = await fs.readFile(
      path.join(drizzleDirectory, `${expected.tag}.sql`),
      "utf8"
    );
    assertContentHash(sql, expected.sha256, `migration ${expected.tag}`);
  }
  const productionContract = JSON.parse(productionContractRaw);
  if (
    productionContract.version !== 1 ||
    !productionContract.base0014 ||
    !productionContract.baseHistory ||
    !productionContract.final0015 ||
    !productionContract.finalHistory
  ) {
    throw new Error("production schema contract format is unsupported");
  }
  assertProductionSchemaContractManifest(
    productionContract,
    manifest.migrations
  );
  return { migrations: manifest.migrations, productionContract };
}

export function assertProductionSchemaContractManifest(contract, migrations) {
  if (
    contract.normalization !== "show-create-and-trigger-v1" ||
    contract.generatedBy?.mysqlVersion !== "8.4.11"
  ) {
    throw new Error("production schema contract generator metadata mismatch");
  }
  if (
    contract.migrationSetSha256 !== productionMigrationSetSha256(migrations)
  ) {
    throw new Error("production schema contract migration set mismatch");
  }
  const expectedRows = migrations.map((migration, index) => ({
    id: index + 1,
    hash: migration.sha256,
    createdAt: Number(migration.when),
  }));
  if (
    JSON.stringify(contract.baseHistory.rows) !==
      JSON.stringify(expectedRows.slice(0, -1)) ||
    JSON.stringify(contract.finalHistory.rows) !== JSON.stringify(expectedRows)
  ) {
    throw new Error(
      "production schema contract history does not match manifest"
    );
  }
}

function assertContentHash(content, expectedHash, label) {
  const actualHash = crypto.createHash("sha256").update(content).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || actualHash !== expectedHash) {
    throw new Error(`${label} hash does not match migration manifest`);
  }
}

export function assertAppliedMigrationPrefix(appliedRows, manifest) {
  if (appliedRows.length > manifest.length) {
    throw new Error("database contains unknown applied migrations");
  }
  for (let index = 0; index < appliedRows.length; index += 1) {
    const applied = appliedRows[index];
    const expected = manifest[index];
    if (
      Number(applied.id) !== index + 1 ||
      Number(applied.createdAt) !== Number(expected.when) ||
      applied.hash !== expected.sha256
    ) {
      throw new Error(
        `applied migration hash/order mismatch at index ${index}`
      );
    }
  }
}

export function migrationLockName(databaseName) {
  const digest = crypto.createHash("sha256").update(databaseName).digest("hex");
  return `leaderbot:migrate:${digest.slice(0, 40)}`;
}

function assertExactHistory(actual, expected, label) {
  if (!actual || actual.showCreateSha256 !== expected.showCreateSha256) {
    throw new Error(`${label} migration history table contract mismatch`);
  }
  if (JSON.stringify(actual.rows) !== JSON.stringify(expected.rows)) {
    throw new Error(`${label} migration history rows mismatch`);
  }
}

function schemaWithOptionalMessengerState(contract) {
  const messengerStateHash = contract.final0015.tables.messengerState;
  if (!messengerStateHash) {
    throw new Error("production schema contract omits messengerState");
  }
  return {
    ...contract.base0014,
    tables: {
      ...contract.base0014.tables,
      messengerState: messengerStateHash,
    },
  };
}

function isExactSchemaState(actual, expected) {
  return canonicalJson(actual) === canonicalJson(expected);
}

function schemaDifference(actual, expected) {
  for (const section of ["tables", "views", "triggers"]) {
    const names = new Set([
      ...Object.keys(actual[section] ?? {}),
      ...Object.keys(expected[section] ?? {}),
    ]);
    for (const name of [...names].sort()) {
      if (actual[section]?.[name] !== expected[section]?.[name]) {
        return `${section}.${name}`;
      }
    }
  }
  return "unknown";
}

async function inspectBeforeState(connection, contract, manifest) {
  const history = await captureMigrationHistory(connection);
  const schema = await captureProductionSchemaState(connection);
  const rows = history?.rows ?? [];
  assertAppliedMigrationPrefix(rows, manifest);

  if (rows.length === 0) {
    if (history) {
      throw new Error(
        "database with empty migration history is not a supported fresh state"
      );
    }
    assertExactSchemaState(
      schema,
      { tables: {}, views: {}, triggers: {} },
      "empty database"
    );
    return "fresh";
  }
  if (rows.length === manifest.length - 1) {
    assertExactHistory(history, contract.baseHistory, "0014");
    const legacyWithState = schemaWithOptionalMessengerState(contract);
    if (
      !isExactSchemaState(schema, contract.base0014) &&
      !isExactSchemaState(schema, legacyWithState)
    ) {
      throw new Error(
        `0014 schema fingerprint mismatch (${schemaDifference(schema, legacyWithState)})`
      );
    }
    return "upgrade";
  }
  if (rows.length === manifest.length) {
    assertExactHistory(history, contract.finalHistory, "0015");
    assertExactSchemaState(schema, contract.final0015, "0015");
    return "complete";
  }
  throw new Error("unsupported migration history length");
}

export async function runProductionMigrations(options = {}) {
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
  const { migrations: manifest, productionContract: contract } =
    await loadAndVerifyMigrationManifest();
  const connection = await mysql.createConnection(databaseUrl);
  let lockName;
  let lockHeld = false;
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

    const beforeState = await inspectBeforeState(
      connection,
      contract,
      manifest
    );
    if (beforeState === "complete") {
      result = {
        appliedCount: manifest.length,
        lockWaitMs: Date.now() - startedAt,
      };
    } else {
      await migrate(drizzle(connection), {
        migrationsFolder: drizzleDirectory,
      });
      const history = await captureMigrationHistory(connection);
      assertAppliedMigrationPrefix(history?.rows ?? [], manifest);
      assertExactHistory(history, contract.finalHistory, "0015");
      const schema = await captureProductionSchemaState(connection);
      assertExactSchemaState(schema, contract.final0015, "0015");
      result = {
        appliedCount: manifest.length,
        lockWaitMs: Date.now() - startedAt,
      };
    }
  } catch (error) {
    operationError = error;
  }
  const cleanupError = await cleanupMigrationConnection(
    connection,
    lockHeld ? lockName : null
  );
  if (operationError && cleanupError) {
    throw combineMigrationErrors(operationError, cleanupError);
  }
  if (operationError) throw operationError;
  if (cleanupError) throw cleanupError;
  return result;
}

export function combineMigrationErrors(operationError, cleanupError) {
  return new AggregateError(
    [operationError, cleanupError],
    `migration failed and connection cleanup also failed: ${operationError instanceof Error ? operationError.message : "unknown migration error"}`,
    { cause: operationError }
  );
}

export async function cleanupMigrationConnection(connection, lockName) {
  const cleanupErrors = [];
  if (lockName) {
    try {
      const [[released]] = await connection.query(
        "SELECT RELEASE_LOCK(?) AS released",
        [lockName]
      );
      if (Number(released.released) !== 1) {
        cleanupErrors.push(
          new Error("migration singleton lock release failed")
        );
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await connection.end();
  } catch (error) {
    cleanupErrors.push(error);
    try {
      await Promise.resolve(connection.destroy());
    } catch (destroyError) {
      cleanupErrors.push(destroyError);
    }
  }
  if (cleanupErrors.length === 0) return null;
  if (cleanupErrors.length === 1) return cleanupErrors[0];
  return new AggregateError(
    cleanupErrors,
    "migration connection cleanup failed"
  );
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const result = await runProductionMigrations();
    process.stdout.write(
      `Production migrations verified (${result.appliedCount} applied).\n`
    );
  } catch (error) {
    process.stderr.write(
      `Production migration refused: ${error instanceof Error ? error.message : "unknown error"}\n`
    );
    process.exitCode = 1;
  }
}
