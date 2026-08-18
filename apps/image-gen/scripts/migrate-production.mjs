/* global process */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import mysql from "mysql2/promise";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const appDirectory = path.resolve(scriptDirectory, "..");
const drizzleDirectory = path.join(appDirectory, "drizzle");
const manifestPath = path.join(drizzleDirectory, "migration-manifest.json");
const journalPath = path.join(drizzleDirectory, "meta", "_journal.json");
const finalMigrationTag = "0015_production_readiness_registry";

const required0015Tables = [
  "billing_accounting_event_links",
  "billing_accounting_import_cursors",
  "billing_accounting_import_runs",
  "billing_accounting_provider_events",
  "billing_handoff_recovery_events",
  "billing_notification_inbox",
  "billing_notification_receipts",
  "billing_notification_receiver_outbox",
  "billing_notification_scheduler_tenants",
  "billing_profile_operator_actions",
  "billing_provider_operations",
  "billing_scheduler_process_heartbeats",
  "billing_scheduler_tenants",
  "billing_webhook_routes",
  "messenger_privacy_subjects",
  "messenger_provider_attempt_fences",
  "workspace_billing_profiles",
];

const required0015Columns = [
  ["billing_intents", "billing_profile_version"],
  ["billing_intents", "url_exposed_at"],
  ["billing_outbox", "delivery_id"],
  ["billing_outbox", "delivery_state"],
  ["channelConnections", "bindingEpoch"],
  ["portalHandoffTokens", "capability_generation"],
  ["workspace_entitlement_usage_reservations", "owner_token_hash"],
  ["workspace_entitlement_usage_reservations", "resolution_due_at"],
];

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
  if (manifest.schemaSnapshot !== "meta/0015_snapshot.json") {
    throw new Error("migration manifest schema snapshot path is unsupported");
  }
  if (manifest.baseSchemaSnapshot !== "meta/0014_snapshot.json") {
    throw new Error("migration manifest base snapshot path is unsupported");
  }
  const journalHash = crypto
    .createHash("sha256")
    .update(journalRaw)
    .digest("hex");
  if (journalHash !== manifest.journalSha256) {
    throw new Error("Drizzle journal hash does not match migration manifest");
  }
  const [baseSnapshotRaw, snapshotRaw] = await Promise.all([
    fs.readFile(
      path.join(drizzleDirectory, manifest.baseSchemaSnapshot),
      "utf8"
    ),
    fs.readFile(path.join(drizzleDirectory, manifest.schemaSnapshot), "utf8"),
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
    const actualHash = crypto.createHash("sha256").update(sql).digest("hex");
    if (actualHash !== expected.sha256) {
      throw new Error(`migration file hash mismatch for ${expected.tag}`);
    }
  }
  return {
    migrations: manifest.migrations,
    baseSnapshot: JSON.parse(baseSnapshotRaw),
    snapshot: JSON.parse(snapshotRaw),
  };
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

async function readAppliedMigrations(connection) {
  const [[table]] = await connection.query(
    "SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='__drizzle_migrations'"
  );
  if (Number(table.count) === 0) return [];
  const [rows] = await connection.query(
    "SELECT `hash`,`created_at` AS createdAt FROM `__drizzle_migrations` ORDER BY `id`"
  );
  return rows;
}

async function inspectSchemaContract(
  connection,
  snapshot,
  expectedTriggers = {}
) {
  const [tables] = await connection.query(
    "SELECT `TABLE_NAME` AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()"
  );
  const [columns] = await connection.query(
    "SELECT `TABLE_NAME` AS tableName,`COLUMN_NAME` AS columnName,LOWER(`COLUMN_TYPE`) AS columnType,`IS_NULLABLE` AS isNullable,`COLUMN_DEFAULT` AS columnDefault,LOWER(`EXTRA`) AS extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()"
  );
  const [constraints] = await connection.query(
    "SELECT `CONSTRAINT_NAME` AS name FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE()"
  );
  const [indexes] = await connection.query(
    "SELECT `TABLE_NAME` AS tableName,`INDEX_NAME` AS name,`NON_UNIQUE` AS nonUnique,`SEQ_IN_INDEX` AS sequence,`COLUMN_NAME` AS columnName FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() ORDER BY `TABLE_NAME`,`INDEX_NAME`,`SEQ_IN_INDEX`"
  );
  const [foreignKeys] = await connection.query(
    "SELECT k.`CONSTRAINT_NAME` AS name,k.`TABLE_NAME` AS tableFrom,k.`COLUMN_NAME` AS columnFrom,k.`REFERENCED_TABLE_NAME` AS tableTo,k.`REFERENCED_COLUMN_NAME` AS columnTo,k.`ORDINAL_POSITION` AS sequence,LOWER(r.`DELETE_RULE`) AS onDelete,LOWER(r.`UPDATE_RULE`) AS onUpdate FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME AND r.TABLE_NAME=k.TABLE_NAME WHERE k.CONSTRAINT_SCHEMA=DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.`CONSTRAINT_NAME`,k.`ORDINAL_POSITION`"
  );
  const [triggers] = await connection.query(
    "SELECT `TRIGGER_NAME` AS name,LOWER(`ACTION_TIMING`) AS timing,LOWER(`EVENT_MANIPULATION`) AS eventName,`EVENT_OBJECT_TABLE` AS tableName FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()"
  );
  const tableNames = new Set(tables.map(row => row.name));
  const actualColumns = new Map(
    columns.map(row => [`${row.tableName}.${row.columnName}`, row])
  );
  const constraintNames = new Set(constraints.map(row => row.name));
  const actualIndexes = groupRows(
    indexes,
    row => `${row.tableName}.${row.name}`
  );
  const actualForeignKeys = groupRows(foreignKeys, row => row.name);
  const actualTriggers = new Map(triggers.map(row => [row.name, row]));
  const snapshotTables = Object.values(snapshot.tables);
  const expectedTables = snapshotTables.map(table => table.name);
  const expectedColumns = snapshotTables.flatMap(table =>
    Object.values(table.columns).map(column => ({ table: table.name, column }))
  );
  const expectedConstraints = snapshotTables.flatMap(table => [
    ...Object.keys(table.foreignKeys ?? {}),
    ...Object.keys(table.uniqueConstraints ?? {}),
    ...Object.keys(table.checkConstraint ?? {}),
  ]);
  const expectedIndexes = snapshotTables.flatMap(table => [
    ...Object.values(table.indexes ?? {}).map(index => ({
      table: table.name,
      index,
    })),
    ...Object.values(table.uniqueConstraints ?? {}).map(index => ({
      table: table.name,
      index: { ...index, isUnique: true },
    })),
  ]);
  const expectedForeignKeys = snapshotTables.flatMap(table =>
    Object.values(table.foreignKeys ?? {})
  );
  const missing = [
    ...expectedTables
      .filter(name => !tableNames.has(name))
      .map(name => `table:${name}`),
    ...expectedColumns.flatMap(({ table, column }) => {
      const name = `${table}.${column.name}`;
      const actual = actualColumns.get(name);
      if (!actual) return [`column:${name}`];
      const problems = [];
      if (
        normalizeColumnType(actual.columnType) !==
        normalizeColumnType(column.type)
      )
        problems.push("type");
      if ((actual.isNullable === "NO") !== Boolean(column.notNull))
        problems.push("nullability");
      if (
        actual.extra.includes("auto_increment") !==
        Boolean(column.autoincrement)
      )
        problems.push("autoincrement");
      if (
        normalizeDefault(actual.columnDefault) !==
        normalizeDefault(column.default)
      )
        problems.push("default");
      return problems.map(problem => `column-${problem}:${name}`);
    }),
    ...expectedConstraints
      .filter(name => !constraintNames.has(name))
      .map(name => `constraint:${name}`),
    ...expectedIndexes.flatMap(({ table, index }) => {
      const actual = actualIndexes.get(`${table}.${index.name}`);
      if (!actual) return [`index:${table}.${index.name}`];
      const valid =
        arraysEqual(
          actual.map(row => row.columnName),
          index.columns
        ) && Number(actual[0].nonUnique) === (index.isUnique ? 0 : 1);
      return valid ? [] : [`index-shape:${table}.${index.name}`];
    }),
    ...expectedForeignKeys.flatMap(expected => {
      const actual = actualForeignKeys.get(expected.name);
      if (!actual) return [`foreign-key:${expected.name}`];
      const valid =
        actual[0].tableFrom === expected.tableFrom &&
        actual[0].tableTo === expected.tableTo &&
        arraysEqual(
          actual.map(row => row.columnFrom),
          expected.columnsFrom
        ) &&
        arraysEqual(
          actual.map(row => row.columnTo),
          expected.columnsTo
        ) &&
        actual[0].onDelete === expected.onDelete &&
        actual[0].onUpdate === expected.onUpdate;
      return valid ? [] : [`foreign-key-shape:${expected.name}`];
    }),
    ...Object.entries(expectedTriggers).flatMap(([name, expected]) => {
      const actual = actualTriggers.get(name);
      const valid =
        actual &&
        arraysEqual(
          [actual.timing, actual.eventName, actual.tableName],
          expected
        );
      return valid ? [] : [`trigger-shape:${name}`];
    }),
  ];
  const expectedTableNames = new Set(expectedTables);
  const expectedColumnNames = new Set(
    expectedColumns.map(({ table, column }) => `${table}.${column.name}`)
  );
  for (const table of tableNames) {
    if (table !== "__drizzle_migrations" && !expectedTableNames.has(table))
      missing.push(`unexpected-table:${table}`);
  }
  for (const name of actualColumns.keys()) {
    if (
      !name.startsWith("__drizzle_migrations.") &&
      !expectedColumnNames.has(name)
    )
      missing.push(`unexpected-column:${name}`);
  }
  const footprintCount =
    required0015Tables.filter(name => tableNames.has(name)).length +
    required0015Columns.filter(([table, column]) =>
      actualColumns.has(`${table}.${column}`)
    ).length;
  return { footprintCount, missing };
}

const finalTriggerContract = {
  billing_outbox_wake_scheduler_after_insert: [
    "after",
    "insert",
    "billing_outbox",
  ],
  billing_outbox_wake_scheduler_after_update: [
    "after",
    "update",
    "billing_outbox",
  ],
  billing_scheduler_execution_epoch_before_update: [
    "before",
    "update",
    "billing_scheduler_tenants",
  ],
};

async function isSchemaEmpty(connection) {
  const [[row]] = await connection.query(
    "SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME<>'__drizzle_migrations'"
  );
  return Number(row.count) === 0;
}

function groupRows(rows, keyFor) {
  const grouped = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key, group);
  }
  return grouped;
}

function arraysEqual(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function normalizeDefault(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return String(value);
  const normalized = String(value).trim();
  if (
    normalized === "(now())" ||
    /^current_timestamp(?:\(\))?$/i.test(normalized)
  )
    return "current_timestamp";
  if (normalized.startsWith("'") && normalized.endsWith("'"))
    return normalized.slice(1, -1);
  return normalized;
}

function normalizeColumnType(value) {
  const normalized = value.toLowerCase();
  return normalized === "boolean" ? "tinyint(1)" : normalized;
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
  const contract = await loadAndVerifyMigrationManifest();
  const manifest = contract.migrations;
  const connection = await mysql.createConnection(databaseUrl);
  let lockName;
  let lockHeld = false;
  const startedAt = Date.now();
  try {
    const [[database]] = await connection.query("SELECT DATABASE() AS name");
    if (!database.name) throw new Error("migration database must be selected");
    lockName = migrationLockName(database.name);
    const [[lock]] = await connection.query(
      "SELECT GET_LOCK(?,?) AS acquired",
      [lockName, lockTimeoutSeconds]
    );
    if (Number(lock.acquired) !== 1) {
      throw new Error("migration singleton lock is unavailable");
    }
    lockHeld = true;

    const before = await readAppliedMigrations(connection);
    assertAppliedMigrationPrefix(before, manifest);
    const finalMigration = manifest.find(row => row.tag === finalMigrationTag);
    if (!finalMigration)
      throw new Error("final migration is absent from manifest");
    const beforeContract = await inspectSchemaContract(
      connection,
      contract.snapshot,
      finalTriggerContract
    );
    if (before.length === 0 && beforeContract.footprintCount > 0) {
      throw new Error(
        "partial 0015 schema detected; restore the pre-migration backup before retry"
      );
    }
    if (before.length === 0 && !(await isSchemaEmpty(connection))) {
      throw new Error("database without migration history is not empty");
    }
    if (![0, manifest.length - 1, manifest.length].includes(before.length)) {
      throw new Error("unsupported migration history length");
    }
    if (before.length === manifest.length - 1) {
      const baseContract = await inspectSchemaContract(
        connection,
        contract.baseSnapshot
      );
      if (baseContract.missing.length > 0) {
        throw new Error(
          `0014 schema contract is incomplete (${baseContract.missing[0]})`
        );
      }
    }
    if (
      before.length === manifest.length &&
      beforeContract.missing.length > 0
    ) {
      throw new Error("applied 0015 schema contract is incomplete");
    }

    await migrate(drizzle(connection), { migrationsFolder: drizzleDirectory });

    const after = await readAppliedMigrations(connection);
    assertAppliedMigrationPrefix(after, manifest);
    if (after.length !== manifest.length) {
      throw new Error("not all migrations were recorded as applied");
    }
    const afterContract = await inspectSchemaContract(
      connection,
      contract.snapshot,
      finalTriggerContract
    );
    if (afterContract.missing.length > 0) {
      throw new Error(
        `0015 schema contract is incomplete (${afterContract.missing[0]})`
      );
    }
    return { appliedCount: after.length, lockWaitMs: Date.now() - startedAt };
  } finally {
    if (lockHeld) {
      await releaseMigrationLock(connection, lockName);
    }
    await connection.end();
  }
}

async function releaseMigrationLock(connection, lockName) {
  const [[released]] = await connection.query(
    "SELECT RELEASE_LOCK(?) AS released",
    [lockName]
  );
  if (Number(released.released) !== 1) {
    throw new Error("migration singleton lock release failed");
  }
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
