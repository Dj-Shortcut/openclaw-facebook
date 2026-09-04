/* global process, URL */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import {
  captureMigrationHistory,
  captureProductionSchemaState,
  assertProductionMigrationRuntime,
  canonicalJson,
  canonicalPrettyJson,
  productionMigrationSetSha256,
  productionSchemaContractVersion,
  sha256,
} from "./production-schema-contract.mjs";
import { resolveProductionMigrationPlan } from "./production-migration-plan.mjs";

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
  const discoveredMigrationFiles = (
    await fs.readdir(path.join(appDirectory, "drizzle"))
  )
    .filter(name => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  const journal = JSON.parse(
    await fs.readFile(
      path.join(appDirectory, "drizzle", "meta", "_journal.json"),
      "utf8"
    )
  );
  if (
    !Array.isArray(journal.entries) ||
    journal.entries.length !== discoveredMigrationFiles.length
  ) {
    throw new Error("journal and migration file count mismatch");
  }
  const discoveredMigrations = await Promise.all(
    journal.entries.map(async (entry, idx) => {
      const file = `${entry.tag}.sql`;
      if (entry.idx !== idx || discoveredMigrationFiles[idx] !== file) {
        throw new Error(`journal entry mismatch for ${entry.tag}`);
      }
      return {
        idx,
        when: Number(entry.when),
        tag: entry.tag,
        sha256: sha256(
          await fs.readFile(path.join(appDirectory, "drizzle", file), "utf8")
        ),
      };
    })
  );
  const migrationPlan = resolveProductionMigrationPlan(discoveredMigrations);
  const migrationSet = migrationPlan.all;
  const through0014 = migrationPlan.through0014.map(migrationFile);
  const migration0015 = migrationFile(migrationPlan.base0015);
  const migration0016 = migrationFile(migrationPlan.expand0016);
  const migration0017 = migrationFile(migrationPlan.creditWallet0017);
  const migration0018 = migrationFile(migrationPlan.creditCheckout0018);
  const migration0019 = migrationFile(migrationPlan.creditOffer0019);

  const connection = await mysql.createConnection(databaseUrl());
  let base0014;
  let baseHistory;
  let final0015;
  let history0015;
  let partial0016LastErasedAt;
  let partial0016ProviderScope;
  let partial0016StaticScope;
  let partial0016BillingColumns;
  let final0016;
  let history0016;
  let partial0017CreditWallet;
  let final0017;
  let history0017;
  let partial0018CreditCheckout;
  let final0018;
  let history0018;
  let partial0019CreditOffer;
  let final0019;
  let history0019;
  try {
    await assertProductionMigrationRuntime(connection, "credit-bootstrap");
    await createHistoryTable(connection);
    await applyFiles(connection, through0014);
    base0014 = await captureProductionSchemaState(connection);
    baseHistory = await captureMigrationHistory(connection);
    await applyFile(connection, migration0015);
    final0015 = await captureProductionSchemaState(connection);
    history0015 = await captureMigrationHistory(connection);

    const statements0016 = await readFileStatements(migration0016);
    await applyStatements(connection, statements0016.slice(0, 4));
    partial0016LastErasedAt = await captureProductionSchemaState(connection);
    await applyStatements(connection, statements0016.slice(4, 6));
    partial0016ProviderScope = await captureProductionSchemaState(connection);
    await applyStatements(connection, statements0016.slice(6, 7));
    partial0016StaticScope = await captureProductionSchemaState(connection);
    await applyStatements(connection, statements0016.slice(7, 8));
    partial0016BillingColumns = await captureProductionSchemaState(connection);
    await applyStatements(connection, statements0016.slice(8));
    final0016 = await captureProductionSchemaState(connection);
    await insertMigrationHistory(connection, migration0016);
    history0016 = await captureMigrationHistory(connection);

    const statements0017 = await readFileStatements(migration0017);
    if (statements0017.length !== 54) {
      throw new Error("0017 statement contract is unsupported");
    }
    if (
      !/^CREATE TEMPORARY TABLE `credit_0017_legacy_effect_preflight`(?:\s|\(|$)/i.test(
        statements0017[0]
      ) ||
      !/^DROP TEMPORARY TABLE `credit_0017_legacy_effect_preflight`(?:\s|;|$)/i.test(
        statements0017[1]
      )
    ) {
      throw new Error(
        "0017 data preflight must precede permanent schema changes"
      );
    }
    const stateByFingerprint = new Map();
    const boundaries = [];
    const captureBoundary = async boundary => {
      const schema = await captureProductionSchemaState(connection);
      const serializedSchema = canonicalJson(schema);
      const schemaSha256 = sha256(serializedSchema);
      let state = stateByFingerprint.get(serializedSchema);
      if (!state) {
        state = {
          resumeFrom: boundary,
          lastBoundary: boundary,
          schemaSha256,
          schema,
        };
        stateByFingerprint.set(serializedSchema, state);
      } else {
        if (boundary !== state.lastBoundary + 1) {
          throw new Error("0017 schema state replay is non-contiguous");
        }
        state.lastBoundary = boundary;
      }
      boundaries.push({
        boundary,
        resumeFrom: state.resumeFrom,
        schemaSha256: state.schemaSha256,
      });
    };
    await captureBoundary(0);
    for (let index = 0; index < statements0017.length; index += 1) {
      await connection.query(statements0017[index]);
      await captureBoundary(index + 1);
    }
    const partialStates = [...stateByFingerprint.values()].map(
      ({ lastBoundary: _lastBoundary, ...state }) => state
    );
    if (
      boundaries.length !== statements0017.length + 1 ||
      partialStates.length < 2 ||
      partialStates.at(-1)?.resumeFrom !== statements0017.length
    ) {
      throw new Error("0017 partial schema contract is unsupported");
    }
    partial0017CreditWallet = {
      statementCount: statements0017.length,
      statementSha256: statements0017.map(statement => sha256(statement)),
      boundaries,
      states: partialStates,
    };
    final0017 = await captureProductionSchemaState(connection);
    await insertMigrationHistory(connection, migration0017);
    history0017 = await captureMigrationHistory(connection);

    const statements0018 = await readFileStatements(migration0018);
    if (
      statements0018.length !== 5 ||
      statements0018[0] !==
        "DROP PROCEDURE IF EXISTS `credit_create_wallet`;" ||
      !/^CREATE PROCEDURE `credit_reserve_checkout_intent`(?:\s|\()/i.test(
        statements0018[1]
      ) ||
      statements0018[2] !==
        "DROP PROCEDURE IF EXISTS `credit_expire_pristine_checkout`;" ||
      !/^CREATE PROCEDURE `credit_expire_pristine_checkout`(?:\s|\()/i.test(
        statements0018[3]
      ) ||
      statements0018[4] !==
        "CREATE INDEX `billing_intents_credit_capability_expiry_idx` ON `billing_intents` (`kind`,`status`,`checkout_capability_expires_at`,`intent_id`);"
    ) {
      throw new Error("0018 statement contract is unsupported");
    }
    const states0018 = [];
    const boundaries0018 = [];
    for (let boundary = 0; boundary <= statements0018.length; boundary += 1) {
      const schema = await captureProductionSchemaState(connection);
      const schemaSha256 = sha256(canonicalJson(schema));
      states0018.push({ resumeFrom: boundary, schemaSha256, schema });
      boundaries0018.push({ boundary, resumeFrom: boundary, schemaSha256 });
      if (boundary < statements0018.length) {
        await connection.query(statements0018[boundary]);
      }
    }
    partial0018CreditCheckout = {
      statementCount: statements0018.length,
      statementSha256: statements0018.map(statement => sha256(statement)),
      boundaries: boundaries0018,
      states: states0018,
    };
    final0018 = await captureProductionSchemaState(connection);
    await insertMigrationHistory(connection, migration0018);
    history0018 = await captureMigrationHistory(connection);

    const statements0019 = await readFileStatements(migration0019);
    if (
      statements0019.length !== 4 ||
      statements0019[0] !==
        "DROP PROCEDURE IF EXISTS `credit_reserve_checkout_intent`;" ||
      !/^CREATE PROCEDURE `credit_reserve_checkout_intent`(?:\s|\()/i.test(
        statements0019[1]
      ) ||
      statements0019[2] !==
        "DROP PROCEDURE IF EXISTS `credit_freeze_wallet_for_review`;" ||
      !/^CREATE PROCEDURE `credit_freeze_wallet_for_review`(?:\s|\()/i.test(
        statements0019[3]
      )
    ) {
      throw new Error("0019 statement contract is unsupported");
    }
    const states0019 = [];
    const boundaries0019 = [];
    for (let boundary = 0; boundary <= statements0019.length; boundary += 1) {
      const schema = await captureProductionSchemaState(connection);
      const schemaSha256 = sha256(canonicalJson(schema));
      states0019.push({ resumeFrom: boundary, schemaSha256, schema });
      boundaries0019.push({ boundary, resumeFrom: boundary, schemaSha256 });
      if (boundary < statements0019.length) {
        await connection.query(statements0019[boundary]);
      }
    }
    partial0019CreditOffer = {
      statementCount: statements0019.length,
      statementSha256: statements0019.map(statement => sha256(statement)),
      boundaries: boundaries0019,
      states: states0019,
    };
    final0019 = await captureProductionSchemaState(connection);
    await insertMigrationHistory(connection, migration0019);
    history0019 = await captureMigrationHistory(connection);
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
    await applyFiles(
      legacyConnection,
      migrationPlan.all.slice(0, 8).map(migrationFile)
    );
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
    normalization: "show-create-trigger-and-routine-v2",
    migrationSetSha256: productionMigrationSetSha256(migrationSet),
    legacy0007,
    legacyHistory,
    base0014,
    baseHistory,
    final0015,
    history0015,
    partial0016LastErasedAt,
    partial0016ProviderScope,
    partial0016StaticScope,
    partial0016BillingColumns,
    final0016,
    history0016,
    partial0017CreditWallet,
    final0017,
    history0017,
    partial0018CreditCheckout,
    final0018,
    history0018,
    partial0019CreditOffer,
    final0019,
    history0019,
  };
  await fs.writeFile(outputPath, `${canonicalPrettyJson(contract)}\n`, "utf8");
  process.stdout.write(
    `Generated ${path.relative(appDirectory, outputPath)} with MySQL ${mysqlVersion}.\n`
  );
} finally {
  await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await admin.query(`DROP DATABASE IF EXISTS \`${legacyDatabase}\``);
  await admin.end();
}

function migrationFile(migration) {
  return `${migration.tag}.sql`;
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
  await applyStatements(connection, await readFileStatements(file));
  await insertMigrationHistory(connection, file);
}

async function readFileStatements(file) {
  const sql = await fs.readFile(
    path.join(appDirectory, "drizzle", file),
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

async function insertMigrationHistory(connection, file) {
  const sql = await fs.readFile(
    path.join(appDirectory, "drizzle", file),
    "utf8"
  );
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
