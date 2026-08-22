/* global process, URL */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import {
  captureMigrationHistory,
  captureProductionSchemaState,
  assertProductionMigrationRuntime,
  productionMigrationSetSha256,
  productionSchemaContractVersion,
  sha256,
} from "./production-schema-contract.mjs";

const adminUrlValue = process.env.MYSQL_REHEARSAL_URL?.trim();
if (!adminUrlValue) throw new Error("MYSQL_REHEARSAL_URL is required");
const adminUrl = new URL(adminUrlValue);
const appDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const outputPath = path.join(
  appDirectory,
  "drizzle",
  "production-schema-contract.json"
);
const database = "leaderbot_schema_contract_generation";
const legacyDatabase = "leaderbot_schema_contract_legacy_0007";
const admin = await mysql.createConnection(connectionOptions());

try {
  await recreateDatabase(database);
  await recreateDatabase(legacyDatabase);
  const migrationFiles = (await fs.readdir(path.join(appDirectory, "drizzle")))
    .filter(name => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  const through0014 = migrationFiles.filter(
    name => Number(name.slice(0, 4)) <= 14
  );
  const finalMigration = migrationFiles.find(name => name.startsWith("0015_"));
  if (!finalMigration) throw new Error("0015 migration is required");
  const journal = JSON.parse(
    await fs.readFile(
      path.join(appDirectory, "drizzle", "meta", "_journal.json"),
      "utf8"
    )
  );
  const migrationSet = await Promise.all(
    migrationFiles.map(async (file, idx) => {
      const tag = file.replace(/\.sql$/, "");
      const entry = journal.entries.find(item => item.tag === tag);
      if (!entry || entry.idx !== idx) {
        throw new Error(`journal entry mismatch for ${tag}`);
      }
      return {
        idx,
        when: Number(entry.when),
        tag,
        sha256: sha256(
          await fs.readFile(path.join(appDirectory, "drizzle", file), "utf8")
        ),
      };
    })
  );

  const connection = await mysql.createConnection(databaseUrl());
  let base0014;
  let baseHistory;
  let final0015;
  let finalHistory;
  try {
    await assertProductionMigrationRuntime(connection);
    await createHistoryTable(connection);
    await applyFiles(connection, through0014);
    base0014 = await captureProductionSchemaState(connection);
    baseHistory = await captureMigrationHistory(connection);
    await applyFile(connection, finalMigration);
    final0015 = await captureProductionSchemaState(connection);
    finalHistory = await captureMigrationHistory(connection);
  } finally {
    await connection.end();
  }

  const legacyConnection = await mysql.createConnection(
    databaseUrl(legacyDatabase)
  );
  let legacy0007;
  let legacyHistory;
  try {
    await assertProductionMigrationRuntime(legacyConnection);
    await createHistoryTable(legacyConnection);
    await applyFiles(legacyConnection, migrationFiles.slice(0, 8));
    await normalizeLegacy0007History(legacyConnection);
    legacy0007 = await captureProductionSchemaState(legacyConnection);
    legacyHistory = await captureMigrationHistory(legacyConnection);
  } finally {
    await legacyConnection.end();
  }

  const versionConnection = await mysql.createConnection(databaseUrl());
  let mysqlVersion;
  try {
    const [[row]] = await versionConnection.query(
      "SELECT VERSION() AS version"
    );
    mysqlVersion = row.version;
  } finally {
    await versionConnection.end();
  }

  if (String(mysqlVersion) !== "8.4.11") {
    throw new Error(`MySQL 8.4.11 is required, received ${mysqlVersion}`);
  }
  const contract = {
    version: productionSchemaContractVersion,
    generatedBy: { mysqlVersion },
    normalization: "show-create-and-trigger-v1",
    migrationSetSha256: productionMigrationSetSha256(migrationSet),
    legacy0007,
    legacyHistory,
    base0014,
    baseHistory,
    final0015,
    finalHistory,
  };
  await fs.writeFile(
    outputPath,
    `${JSON.stringify(contract, null, 2)}\n`,
    "utf8"
  );
  process.stdout.write(
    `Generated ${path.relative(appDirectory, outputPath)} with MySQL ${mysqlVersion}.\n`
  );
} finally {
  await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await admin.query(`DROP DATABASE IF EXISTS \`${legacyDatabase}\``);
  await admin.end();
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

function databaseUrl(databaseName = database) {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function recreateDatabase(databaseName) {
  await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
  await admin.query(
    `CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`
  );
}

async function normalizeLegacy0007History(connection) {
  const legacyHashes = new Map([
    [3, "66006eca333555566ca23afd43379b024bf9efd86c7e62468e4763ec169e2845"],
    [4, "ad9f1a8e045112995be23b617068174d67ceaba6bfeabfc07054d16f3d05d9c8"],
  ]);
  for (const [id, hash] of legacyHashes) {
    const [result] = await connection.query(
      "UPDATE `__drizzle_migrations` SET `hash`=? WHERE `id`=?",
      [hash, id]
    );
    if (Number(result.affectedRows) !== 1) {
      throw new Error(`legacy 0007 history row ${id} is unavailable`);
    }
  }
}

async function createHistoryTable(connection) {
  await connection.query(`CREATE TABLE \`__drizzle_migrations\` (
    \`id\` serial PRIMARY KEY,
    \`hash\` text NOT NULL,
    \`created_at\` bigint
  )`);
}

async function applyFiles(connection, files) {
  for (const file of files) await applyFile(connection, file);
}

async function applyFile(connection, file) {
  const sql = await fs.readFile(
    path.join(appDirectory, "drizzle", file),
    "utf8"
  );
  for (const statement of sql
    .split("--> statement-breakpoint")
    .map(value => value.trim())
    .filter(Boolean)) {
    await connection.query(statement);
  }
  const journal = JSON.parse(
    await fs.readFile(
      path.join(appDirectory, "drizzle", "meta", "_journal.json"),
      "utf8"
    )
  );
  const tag = file.replace(/\.sql$/, "");
  const entry = journal.entries.find(item => item.tag === tag);
  if (!entry) throw new Error(`journal entry missing for ${tag}`);
  const { createHash } = await import("node:crypto");
  await connection.query(
    "INSERT INTO `__drizzle_migrations` (`hash`,`created_at`) VALUES (?,?)",
    [createHash("sha256").update(sql).digest("hex"), entry.when]
  );
}
