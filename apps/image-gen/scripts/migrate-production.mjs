/* global process */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import {
  assertExactSchemaState,
  configureProductionSchemaSession,
  assertProductionMigrationRuntime,
  assertPreparedStatementCapacity,
  captureMigrationHistory,
  captureProductionSchemaState,
  canonicalJson,
  creditWalletRoutineNames,
  productionSchemaContractVersion,
  productionMigrationSetSha256,
} from "./production-schema-contract.mjs";
import { resolveProductionMigrationPlan } from "./production-migration-plan.mjs";

const creditWallet0017RoutineNames = Object.freeze([
  ...creditWalletRoutineNames.filter(
    name =>
      name !== "credit_reserve_checkout_intent" &&
      name !== "credit_expire_pristine_checkout"
  ),
  "credit_create_wallet",
]);

const scriptDirectory =
  process.env.RELEASE_COMMAND === "1"
    ? process.cwd()
    : path.dirname(fileURLToPath(import.meta.url));
const appDirectory =
  process.env.RELEASE_COMMAND === "1"
    ? scriptDirectory
    : path.resolve(scriptDirectory, "..");
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
  if (manifest.schemaSnapshot !== "meta/0019_snapshot.json") {
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
  const migrationSqlByTag = new Map();
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
    migrationSqlByTag.set(expected.tag, sql);
    assertContentHash(sql, expected.sha256, `migration ${expected.tag}`);
  }
  const migrationPlan = resolveProductionMigrationPlan(manifest.migrations);
  const productionContract = JSON.parse(productionContractRaw);
  if (
    productionContract.version !== productionSchemaContractVersion ||
    !productionContract.legacy0007 ||
    !productionContract.legacyHistory ||
    !productionContract.base0014 ||
    !productionContract.baseHistory ||
    !productionContract.final0015 ||
    !productionContract.history0015 ||
    !productionContract.partial0016LastErasedAt ||
    !productionContract.partial0016ProviderScope ||
    !productionContract.partial0016StaticScope ||
    !productionContract.partial0016BillingColumns ||
    !productionContract.final0016 ||
    !productionContract.history0016 ||
    !productionContract.partial0017CreditWallet ||
    !productionContract.final0017 ||
    !productionContract.history0017 ||
    !productionContract.partial0018CreditCheckout ||
    !productionContract.final0018 ||
    !productionContract.history0018 ||
    !productionContract.partial0019CreditOffer ||
    !productionContract.final0019 ||
    !productionContract.history0019 ||
    Object.hasOwn(productionContract, "partial0017BillingConstraints") ||
    Object.hasOwn(productionContract, "finalHistory")
  ) {
    throw new Error("production schema contract format is unsupported");
  }
  assertProductionSchemaContractManifest(
    productionContract,
    manifest.migrations
  );
  assert0017StatementHashes(
    productionContract.partial0017CreditWallet,
    migrationSqlByTag.get(migrationPlan.creditWallet0017.tag)
  );
  assert0018StatementHashes(
    productionContract.partial0018CreditCheckout,
    migrationSqlByTag.get(migrationPlan.creditCheckout0018.tag)
  );
  assert0019StatementHashes(
    productionContract.partial0019CreditOffer,
    migrationSqlByTag.get(migrationPlan.creditOffer0019.tag)
  );
  return {
    migrations: manifest.migrations,
    migrationPlan,
    productionContract,
  };
}

export function assertProductionSchemaContractManifest(contract, migrations) {
  const plan = resolveProductionMigrationPlan(migrations);
  if (
    contract.normalization !== "show-create-trigger-and-routine-v2" ||
    contract.generatedBy?.mysqlVersion !== "8.4.11"
  ) {
    throw new Error("production schema contract generator metadata mismatch");
  }
  if (contract.migrationSetSha256 !== productionMigrationSetSha256(plan.all)) {
    throw new Error("production schema contract migration set mismatch");
  }
  const expectedRows = plan.all.map((migration, index) => ({
    id: index + 1,
    hash: migration.sha256,
    createdAt: Number(migration.when),
  }));
  const legacyRows = productionLegacy0007Rows(plan.all);
  const expected0014Rows = expectedRows.slice(0, plan.through0014.length);
  const expected0015Rows = expectedRows.slice(0, plan.through0015.length);
  const expected0016Rows = expectedRows.slice(0, plan.through0016.length);
  const expected0017Rows = expectedRows.slice(0, plan.through0017.length);
  const expected0018Rows = expectedRows.slice(0, plan.through0018.length);
  const expected0019Rows = expectedRows.slice(0, plan.through0019.length);
  if (
    contract.legacyHistory.nextId !== 9 ||
    canonicalJson(contract.legacyHistory.rows) !== canonicalJson(legacyRows) ||
    contract.baseHistory.nextId !== plan.through0014.length + 1 ||
    contract.history0015.nextId !== plan.through0015.length + 1 ||
    contract.history0016.nextId !== plan.through0016.length + 1 ||
    contract.history0017.nextId !== plan.through0017.length + 1 ||
    contract.history0018.nextId !== plan.through0018.length + 1 ||
    contract.history0019.nextId !== plan.through0019.length + 1 ||
    canonicalJson(contract.baseHistory.rows) !==
      canonicalJson(expected0014Rows) ||
    canonicalJson(contract.history0015.rows) !==
      canonicalJson(expected0015Rows) ||
    canonicalJson(contract.history0016.rows) !==
      canonicalJson(expected0016Rows) ||
    canonicalJson(contract.history0017.rows) !==
      canonicalJson(expected0017Rows) ||
    canonicalJson(contract.history0018.rows) !==
      canonicalJson(expected0018Rows) ||
    canonicalJson(contract.history0019.rows) !== canonicalJson(expected0019Rows)
  ) {
    throw new Error(
      "production schema contract history does not match manifest"
    );
  }
  assertPartial0017Contract(contract.partial0017CreditWallet);
  assertPartial0018Contract(contract.partial0018CreditCheckout);
  assertPartial0019Contract(contract.partial0019CreditOffer);
  const addedTables = Object.keys(contract.final0017.tables).filter(
    name => !Object.hasOwn(contract.final0016.tables, name)
  );
  const addedTriggers = Object.keys(contract.final0017.triggers).filter(
    name => !Object.hasOwn(contract.final0016.triggers, name)
  );
  if (
    JSON.stringify(addedTables.sort()) !==
      JSON.stringify(
        ["credit_ledger", "credit_reservations", "credit_wallets"].sort()
      ) ||
    addedTriggers.length !== 14 ||
    addedTriggers.some(name => !name.startsWith("credit_")) ||
    JSON.stringify(Object.keys(contract.final0017.routines).sort()) !==
      JSON.stringify([...creditWallet0017RoutineNames].sort()) ||
    canonicalJson(contract.partial0017CreditWallet.states[0].schema) !==
      canonicalJson(contract.final0016) ||
    canonicalJson(contract.partial0017CreditWallet.states.at(-1).schema) !==
      canonicalJson(contract.final0017)
  ) {
    throw new Error("production 0017 object inventory is unsupported");
  }
  const routines0018 = Object.keys(contract.final0018.routines).sort();
  const expected0018Routines = [...creditWalletRoutineNames].sort();
  // 0018 adds the checkout-capability expiry index to billing_intents. Its
  // exact DDL is pinned by assertPartial0018Contract and the final captured
  // fingerprint below; only views and triggers remain unchanged from 0017.
  const unchangedSections = ["views", "triggers"].every(
    section =>
      canonicalJson(contract.final0018[section]) ===
      canonicalJson(contract.final0017[section])
  );
  if (
    !unchangedSections ||
    JSON.stringify(routines0018) !== JSON.stringify(expected0018Routines) ||
    Object.hasOwn(contract.final0018.routines, "credit_create_wallet") ||
    !Object.hasOwn(
      contract.final0018.routines,
      "credit_reserve_checkout_intent"
    ) ||
    canonicalJson(contract.partial0018CreditCheckout.states[0].schema) !==
      canonicalJson(contract.final0017) ||
    canonicalJson(contract.partial0018CreditCheckout.states.at(-1).schema) !==
      canonicalJson(contract.final0018)
  ) {
    throw new Error("production 0018 object inventory is unsupported");
  }
  const unchanged0019Sections = ["tables", "views", "triggers"].every(
    section =>
      canonicalJson(contract.final0019[section]) ===
      canonicalJson(contract.final0018[section])
  );
  if (
    !unchanged0019Sections ||
    JSON.stringify(Object.keys(contract.final0019.routines).sort()) !==
      JSON.stringify(expected0018Routines) ||
    canonicalJson(contract.partial0019CreditOffer.states[0].schema) !==
      canonicalJson(contract.final0018) ||
    canonicalJson(contract.partial0019CreditOffer.states.at(-1).schema) !==
      canonicalJson(contract.final0019)
  ) {
    throw new Error("production 0019 object inventory is unsupported");
  }
}

export function assertPartial0017Contract(partial) {
  if (
    partial?.statementCount !== 54 ||
    !Array.isArray(partial.statementSha256) ||
    partial.statementSha256.length !== partial.statementCount ||
    partial.statementSha256.some(hash => !/^[a-f0-9]{64}$/.test(hash)) ||
    !Array.isArray(partial.boundaries) ||
    partial.boundaries.length !== partial.statementCount + 1 ||
    !Array.isArray(partial.states) ||
    partial.states.length < 2
  ) {
    throw new Error("production 0017 partial schema contract is unsupported");
  }
  let previousResumeFrom = -1;
  const seenSchemas = new Set();
  const stateByHash = new Map();
  const referencedStateHashes = new Set();
  for (const state of partial.states) {
    if (
      !Number.isInteger(state?.resumeFrom) ||
      state.resumeFrom <= previousResumeFrom ||
      state.resumeFrom < 0 ||
      state.resumeFrom > partial.statementCount ||
      !/^[a-f0-9]{64}$/.test(state.schemaSha256) ||
      !state.schema?.tables ||
      !state.schema?.views ||
      !state.schema?.triggers ||
      !state.schema?.routines
    ) {
      throw new Error("production 0017 partial schema contract is unsupported");
    }
    const schema = canonicalJson(state.schema);
    if (
      seenSchemas.has(schema) ||
      state.schemaSha256 !==
        crypto.createHash("sha256").update(schema).digest("hex") ||
      stateByHash.has(state.schemaSha256)
    ) {
      throw new Error("production 0017 partial schema contract is unsupported");
    }
    seenSchemas.add(schema);
    stateByHash.set(state.schemaSha256, state);
    previousResumeFrom = state.resumeFrom;
  }
  const closedStateHashes = new Set();
  let previousStateHash = null;
  for (let boundary = 0; boundary <= partial.statementCount; boundary += 1) {
    const entry = partial.boundaries[boundary];
    const state = stateByHash.get(entry?.schemaSha256);
    if (
      entry?.boundary !== boundary ||
      !Number.isInteger(entry.resumeFrom) ||
      entry.resumeFrom < 0 ||
      entry.resumeFrom > boundary ||
      !state ||
      state.resumeFrom !== entry.resumeFrom ||
      (closedStateHashes.has(entry.schemaSha256) &&
        entry.schemaSha256 !== previousStateHash)
    ) {
      throw new Error("production 0017 partial schema contract is unsupported");
    }
    if (previousStateHash && previousStateHash !== entry.schemaSha256) {
      closedStateHashes.add(previousStateHash);
    }
    previousStateHash = entry.schemaSha256;
    referencedStateHashes.add(entry.schemaSha256);
  }
  if (
    partial.boundaries[0].resumeFrom !== 0 ||
    partial.boundaries.at(-1).resumeFrom !== partial.statementCount ||
    referencedStateHashes.size !== stateByHash.size
  ) {
    throw new Error("production 0017 partial schema contract is unsupported");
  }
}

export function assert0017StatementHashes(partial, sql) {
  const statements = String(sql ?? "")
    .split("--> statement-breakpoint")
    .map(statement => statement.trim())
    .filter(Boolean);
  if (
    statements.length !== partial.statementCount ||
    statements.some(
      (statement, index) =>
        crypto.createHash("sha256").update(statement).digest("hex") !==
        partial.statementSha256[index]
    )
  ) {
    throw new Error("production 0017 statement fingerprint mismatch");
  }
  assert0017PreDdlStatementOrder(statements);
}

export function assert0017PreDdlStatementOrder(statements) {
  if (
    !/^CREATE TEMPORARY TABLE `credit_0017_legacy_effect_preflight`(?:\s|\(|$)/i.test(
      statements[0] ?? ""
    ) ||
    !/^DROP TEMPORARY TABLE `credit_0017_legacy_effect_preflight`(?:\s|;|$)/i.test(
      statements[1] ?? ""
    ) ||
    statements
      .slice(2)
      .some(statement =>
        /\bcredit_0017_legacy_effect_preflight\b/i.test(statement)
      )
  ) {
    throw new Error(
      "production 0017 data preflight must precede permanent DDL"
    );
  }
}

export function assertPartial0018Contract(partial) {
  if (
    partial?.statementCount !== 5 ||
    !Array.isArray(partial.statementSha256) ||
    partial.statementSha256.length !== partial.statementCount ||
    partial.statementSha256.some(hash => !/^[a-f0-9]{64}$/.test(hash)) ||
    !Array.isArray(partial.boundaries) ||
    partial.boundaries.length !== partial.statementCount + 1 ||
    !Array.isArray(partial.states) ||
    partial.states.length !== partial.statementCount + 1
  ) {
    throw new Error("production 0018 partial schema contract is unsupported");
  }
  for (let boundary = 0; boundary <= partial.statementCount; boundary += 1) {
    const state = partial.states[boundary];
    const entry = partial.boundaries[boundary];
    if (
      state?.resumeFrom !== boundary ||
      entry?.boundary !== boundary ||
      entry?.resumeFrom !== boundary ||
      entry?.schemaSha256 !== state?.schemaSha256 ||
      !/^[a-f0-9]{64}$/.test(state?.schemaSha256 ?? "") ||
      state.schemaSha256 !==
        crypto
          .createHash("sha256")
          .update(canonicalJson(state.schema))
          .digest("hex")
    ) {
      throw new Error("production 0018 partial schema contract is unsupported");
    }
  }
}

export function assert0018StatementHashes(partial, sql) {
  const statements = String(sql ?? "")
    .split("--> statement-breakpoint")
    .map(statement => statement.trim())
    .filter(Boolean);
  if (
    statements.length !== 5 ||
    statements[0] !== "DROP PROCEDURE IF EXISTS `credit_create_wallet`;" ||
    !/^CREATE PROCEDURE `credit_reserve_checkout_intent`(?:\s|\()/i.test(
      statements[1]
    ) ||
    statements[2] !==
      "DROP PROCEDURE IF EXISTS `credit_expire_pristine_checkout`;" ||
    !/^CREATE PROCEDURE `credit_expire_pristine_checkout`(?:\s|\()/i.test(
      statements[3]
    ) ||
    statements[4] !==
      "CREATE INDEX `billing_intents_credit_capability_expiry_idx` ON `billing_intents` (`kind`,`status`,`checkout_capability_expires_at`,`intent_id`);" ||
    statements.some(
      (statement, index) =>
        crypto.createHash("sha256").update(statement).digest("hex") !==
        partial.statementSha256[index]
    )
  ) {
    throw new Error("production 0018 statement fingerprint mismatch");
  }
}

export function assertPartial0019Contract(partial) {
  if (
    partial?.statementCount !== 4 ||
    !Array.isArray(partial.statementSha256) ||
    partial.statementSha256.length !== partial.statementCount ||
    partial.statementSha256.some(hash => !/^[a-f0-9]{64}$/.test(hash)) ||
    !Array.isArray(partial.boundaries) ||
    partial.boundaries.length !== partial.statementCount + 1 ||
    !Array.isArray(partial.states) ||
    partial.states.length !== partial.statementCount + 1
  ) {
    throw new Error("production 0019 partial schema contract is unsupported");
  }
  for (let boundary = 0; boundary <= partial.statementCount; boundary += 1) {
    const state = partial.states[boundary];
    const entry = partial.boundaries[boundary];
    if (
      state?.resumeFrom !== boundary ||
      entry?.boundary !== boundary ||
      entry?.resumeFrom !== boundary ||
      entry?.schemaSha256 !== state?.schemaSha256 ||
      !/^[a-f0-9]{64}$/.test(state?.schemaSha256 ?? "") ||
      state.schemaSha256 !==
        crypto
          .createHash("sha256")
          .update(canonicalJson(state.schema))
          .digest("hex")
    ) {
      throw new Error("production 0019 partial schema contract is unsupported");
    }
  }
}

export function assert0019StatementHashes(partial, sql) {
  const statements = String(sql ?? "")
    .split("--> statement-breakpoint")
    .map(statement => statement.trim())
    .filter(Boolean);
  if (
    statements.length !== 4 ||
    statements[0] !==
      "DROP PROCEDURE IF EXISTS `credit_reserve_checkout_intent`;" ||
    !/^CREATE PROCEDURE `credit_reserve_checkout_intent`(?:\s|\()/i.test(
      statements[1]
    ) ||
    !statements[1].includes("premium_images_8_medium_v1") ||
    !statements[1].includes("premium_images_9_medium_v2") ||
    statements[2] !==
      "DROP PROCEDURE IF EXISTS `credit_freeze_wallet_for_review`;" ||
    !/^CREATE PROCEDURE `credit_freeze_wallet_for_review`(?:\s|\()/i.test(
      statements[3]
    ) ||
    !statements[3].includes(
      "payment.`gross_amount`=intent.`expected_amount`"
    ) ||
    statements.some(
      (statement, index) =>
        crypto.createHash("sha256").update(statement).digest("hex") !==
        partial.statementSha256[index]
    )
  ) {
    throw new Error("production 0019 statement fingerprint mismatch");
  }
}

export function productionLegacy0007Rows(migrations) {
  if (migrations.length < 8) {
    throw new Error("legacy 0007 contract requires eight migrations");
  }
  const rows = migrations.slice(0, 8).map((migration, index) => ({
    id: index + 1,
    hash: migration.sha256,
    createdAt: Number(migration.when),
  }));
  rows[2].hash =
    "66006eca333555566ca23afd43379b024bf9efd86c7e62468e4763ec169e2845";
  rows[3].hash =
    "ad9f1a8e045112995be23b617068174d67ceaba6bfeabfc07054d16f3d05d9c8";
  return rows;
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
  if (
    !actual ||
    actual.showCreateSha256 !== expected.showCreateSha256 ||
    actual.nextId !== expected.nextId
  ) {
    throw new Error(`${label} migration history table contract mismatch`);
  }
  if (canonicalJson(actual.rows) !== canonicalJson(expected.rows)) {
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
  for (const section of ["tables", "views", "triggers", "routines"]) {
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

async function inspectBeforeState(
  connection,
  contract,
  plan,
  schemaCaptureOptions
) {
  const history = await captureMigrationHistory(connection);
  const schema = await captureProductionSchemaState(
    connection,
    schemaCaptureOptions
  );
  const rows = history?.rows ?? [];
  assertAppliedMigrationPrefix(rows, plan.all);

  if (rows.length === 0) {
    if (history) {
      throw new Error(
        "database with empty migration history is not a supported fresh state"
      );
    }
    assertExactSchemaState(
      schema,
      { tables: {}, views: {}, triggers: {}, routines: {} },
      "empty database"
    );
    return { kind: "fresh" };
  }
  if (rows.length === plan.through0014.length) {
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
    return { kind: "drizzle-upgrade" };
  }
  if (rows.length === plan.through0015.length) {
    assertExactHistory(history, contract.history0015, "0015");
    if (isExactSchemaState(schema, contract.final0015)) {
      return { kind: "resume-0016", phase: 0 };
    }
    if (isExactSchemaState(schema, contract.partial0016LastErasedAt)) {
      return { kind: "resume-0016", phase: 4 };
    }
    if (isExactSchemaState(schema, contract.partial0016ProviderScope)) {
      return { kind: "resume-0016", phase: 6 };
    }
    if (isExactSchemaState(schema, contract.partial0016StaticScope)) {
      return { kind: "resume-0016", phase: 7 };
    }
    if (isExactSchemaState(schema, contract.partial0016BillingColumns)) {
      return { kind: "resume-0016", phase: 8 };
    }
    if (isExactSchemaState(schema, contract.final0016)) {
      return { kind: "resume-0016", phase: 9 };
    }
    throw new Error(
      `0016 partial schema fingerprint mismatch (${schemaDifference(schema, contract.final0016)})`
    );
  }
  if (rows.length === plan.through0016.length) {
    assertExactHistory(history, contract.history0016, "0016");
    const state = contract.partial0017CreditWallet.states.find(candidate =>
      isExactSchemaState(schema, candidate.schema)
    );
    if (!state) {
      throw new Error(
        `0017 partial schema fingerprint mismatch (${schemaDifference(schema, contract.final0017)})`
      );
    }
    return { kind: "resume-0017", nextStatement: state.resumeFrom };
  }
  if (rows.length === plan.through0017.length) {
    assertExactHistory(history, contract.history0017, "0017");
    const state = contract.partial0018CreditCheckout.states.find(candidate =>
      isExactSchemaState(schema, candidate.schema)
    );
    if (!state) {
      throw new Error(
        `0018 partial schema fingerprint mismatch (${schemaDifference(schema, contract.final0018)})`
      );
    }
    return { kind: "resume-0018", nextStatement: state.resumeFrom };
  }
  if (rows.length === plan.through0018.length) {
    assertExactHistory(history, contract.history0018, "0018");
    const state = contract.partial0019CreditOffer.states.find(candidate =>
      isExactSchemaState(schema, candidate.schema)
    );
    if (!state) {
      throw new Error(
        `0019 partial schema fingerprint mismatch (${schemaDifference(schema, contract.final0019)})`
      );
    }
    return { kind: "resume-0019", nextStatement: state.resumeFrom };
  }
  if (rows.length === plan.through0019.length) {
    assertExactHistory(history, contract.history0019, "0019");
    assertExactSchemaState(schema, contract.final0019, "0019");
    return { kind: "complete" };
  }
  throw new Error("unsupported migration history length");
}

async function readMigrationStatements(migration) {
  const sql = await fs.readFile(
    path.join(drizzleDirectory, `${migration.tag}.sql`),
    "utf8"
  );
  return sql
    .split("--> statement-breakpoint")
    .map(statement => statement.trim())
    .filter(Boolean);
}

async function applyStatements(connection, statements) {
  for (const statement of statements) await connection.query(statement);
}

async function insertMigrationHistory(connection, migration) {
  await connection.query(
    "INSERT INTO `__drizzle_migrations` (`hash`,`created_at`) VALUES (?,?)",
    [migration.sha256, Number(migration.when)]
  );
}

async function resume0016(
  connection,
  contract,
  migration,
  phase,
  schemaCaptureOptions
) {
  const statements = await readMigrationStatements(migration);
  if (statements.length !== 9) {
    throw new Error("0016 statement contract is unsupported");
  }
  await applyStatements(connection, statements.slice(0, 3));
  if (phase === 0) {
    await connection.query(statements[3]);
    phase = 4;
  }
  // A reactivated subject intentionally keeps last_erased_at while erased_at
  // becomes NULL. Re-run the idempotent repair instead of rejecting that
  // reachable state after an interrupted expand migration.
  await connection.query(statements[4]);
  if (phase < 6) {
    await connection.query(statements[5]);
    phase = 6;
  }
  if (phase < 7) {
    await connection.query(statements[6]);
    phase = 7;
  }
  if (phase < 8) {
    await connection.query(statements[7]);
    phase = 8;
  }
  if (phase < 9) await connection.query(statements[8]);
  const schema = await captureProductionSchemaState(
    connection,
    schemaCaptureOptions
  );
  assertExactSchemaState(schema, contract.final0016, "resumed 0016");
  await insertMigrationHistory(connection, migration);
  const history = await captureMigrationHistory(connection);
  assertExactHistory(history, contract.history0016, "resumed 0016");
}

async function resume0017(
  connection,
  contract,
  migration,
  nextStatement,
  schemaCaptureOptions
) {
  const statements = await readMigrationStatements(migration);
  if (
    statements.length !== contract.partial0017CreditWallet.statementCount ||
    nextStatement < 0 ||
    nextStatement > statements.length
  ) {
    throw new Error("0017 statement contract is unsupported");
  }
  assert0017StatementHashes(
    contract.partial0017CreditWallet,
    statements.join("\n--> statement-breakpoint\n")
  );
  if (nextStatement >= 2) {
    await applyStatements(connection, statements.slice(0, 2));
  }
  await applyStatements(connection, statements.slice(nextStatement));
  const schema = await captureProductionSchemaState(
    connection,
    schemaCaptureOptions
  );
  assertExactSchemaState(schema, contract.final0017, "resumed 0017");
  await insertMigrationHistory(connection, migration);
  const history = await captureMigrationHistory(connection);
  assertExactHistory(history, contract.history0017, "resumed 0017");
}

async function resume0018(
  connection,
  contract,
  migration,
  nextStatement,
  schemaCaptureOptions
) {
  const statements = await readMigrationStatements(migration);
  if (
    statements.length !== contract.partial0018CreditCheckout.statementCount ||
    nextStatement < 0 ||
    nextStatement > statements.length
  ) {
    throw new Error("0018 statement contract is unsupported");
  }
  assert0018StatementHashes(
    contract.partial0018CreditCheckout,
    statements.join("\n--> statement-breakpoint\n")
  );
  await applyStatements(connection, statements.slice(nextStatement));
  const schema = await captureProductionSchemaState(
    connection,
    schemaCaptureOptions
  );
  assertExactSchemaState(schema, contract.final0018, "resumed 0018");
  await insertMigrationHistory(connection, migration);
  const history = await captureMigrationHistory(connection);
  assertExactHistory(history, contract.history0018, "resumed 0018");
}

async function resume0019(
  connection,
  contract,
  migration,
  nextStatement,
  schemaCaptureOptions
) {
  const statements = await readMigrationStatements(migration);
  if (
    statements.length !== contract.partial0019CreditOffer.statementCount ||
    nextStatement < 0 ||
    nextStatement > statements.length
  ) {
    throw new Error("0019 statement contract is unsupported");
  }
  assert0019StatementHashes(
    contract.partial0019CreditOffer,
    statements.join("\n--> statement-breakpoint\n")
  );
  await applyStatements(connection, statements.slice(nextStatement));
  const schema = await captureProductionSchemaState(
    connection,
    schemaCaptureOptions
  );
  assertExactSchemaState(schema, contract.final0019, "resumed 0019");
  await insertMigrationHistory(connection, migration);
  const history = await captureMigrationHistory(connection);
  assertExactHistory(history, contract.history0019, "resumed 0019");
}

export const productionSchemaPhases = Object.freeze([
  "0015_base",
  "0016_expand",
  "0017_credit_wallet_expand",
  "0018_credit_checkout_reservation",
  "0019_credit_offer_v2",
]);

export const productionDatabasePrivilegeProfiles = Object.freeze([
  "inspection",
  "runtime",
  "credit-runtime",
  "expand",
  "credit-expand-pregrant",
  "credit-expand",
  "credit-expand-postddl",
  "bootstrap",
  "credit-bootstrap",
  "phase-bound-runtime",
]);

const productionMigrationModes = Object.freeze({
  "verify-compatible": { verifyOnly: true, target: "compatible" },
  "inspect-expand-transition": {
    verifyOnly: true,
    target: "compatible",
    inspectExpandTransition: true,
    privilegeProfile: "expand",
  },
  "inspect-recovery-compatibility": {
    verifyOnly: true,
    target: "compatible",
    inspectExpandTransition: true,
    privilegeProfile: "inspection",
  },
  "verify-expand": { verifyOnly: true, target: "expand" },
  "verify-expand-transition": {
    verifyOnly: true,
    target: "expand",
    privilegeProfile: "expand",
  },
  "inspect-credit-wallet-transition": {
    verifyOnly: true,
    target: "expand",
    inspectCreditWalletTransition: true,
    privilegeProfile: "credit-expand-pregrant",
  },
  "inspect-credit-wallet-recovery": {
    verifyOnly: true,
    target: "expand",
    inspectCreditWalletTransition: true,
    privilegeProfile: "inspection",
  },
  "verify-credit-wallet": {
    verifyOnly: true,
    target: "credit-wallet",
    privilegeProfile: "credit-runtime",
  },
  "verify-credit-offer": {
    verifyOnly: true,
    target: "credit-offer",
    privilegeProfile: "credit-runtime",
  },
  "apply-empty-bootstrap": {
    verifyOnly: false,
    target: "expand",
    allowEmptyBootstrap: true,
  },
  "apply-empty-credit-wallet-bootstrap": {
    verifyOnly: false,
    target: "credit-wallet",
    allowEmptyBootstrap: true,
    privilegeProfile: "credit-bootstrap",
  },
  "apply-empty-credit-offer-bootstrap": {
    verifyOnly: false,
    target: "credit-offer",
    allowEmptyBootstrap: true,
    privilegeProfile: "credit-bootstrap",
  },
});

export function productionMigrationOptionsForMode(mode, artifactKind = "") {
  if (mode === "verify-credit-wallet-transition") {
    return artifactKind === "migration-bridge"
      ? {
          verifyOnly: true,
          target: "credit-wallet",
          privilegeProfile: "credit-expand",
        }
      : null;
  }
  if (mode === "apply-expand") {
    return artifactKind === "migration-bridge"
      ? {
          verifyOnly: false,
          target: "expand",
          privilegeProfile: "expand",
        }
      : null;
  }
  if (mode === "apply-credit-wallet-expand") {
    return artifactKind === "migration-bridge"
      ? {
          verifyOnly: false,
          target: "credit-wallet",
          privilegeProfile: "credit-expand",
        }
      : null;
  }
  if (mode === "verify-artifact") {
    if (artifactKind === "migration-bridge") {
      return {
        verifyOnly: true,
        target: "compatible",
        bridgeArtifactVerification: true,
        privilegeProfile: "phase-bound-runtime",
      };
    }
    if (artifactKind === "runtime") {
      return {
        verifyOnly: true,
        target: "credit-offer",
        privilegeProfile: "credit-runtime",
      };
    }
    return null;
  }
  const options = productionMigrationModes[mode];
  return options ? { ...options } : null;
}

function stableSchemaPhase(state) {
  if (state.kind === "resume-0016" && state.phase === 0) return "0015_base";
  if (state.kind === "resume-0017" && state.nextStatement === 0) {
    return "0016_expand";
  }
  if (state.kind === "resume-0018" && state.nextStatement === 0) {
    return "0017_credit_wallet_expand";
  }
  if (state.kind === "resume-0019" && state.nextStatement === 0) {
    return "0018_credit_checkout_reservation";
  }
  if (state.kind === "complete") return "0019_credit_offer_v2";
  return null;
}

export function bridgeArtifactPrivilegeProfileForState(state) {
  const phase = stableSchemaPhase(state);
  if (phase === "0016_expand") return "runtime";
  if (phase === "0018_credit_checkout_reservation") {
    return "credit-runtime";
  }
  return null;
}

export function transitionInspectionPhase(state, options = {}) {
  if (
    options.inspectExpandTransition === true &&
    state.kind === "resume-0016" &&
    state.phase > 0
  ) {
    return `0016_partial_${state.phase}`;
  }
  if (
    options.inspectCreditWalletTransition === true &&
    state.kind === "resume-0017" &&
    state.nextStatement > 0
  ) {
    return `0017_partial_${state.nextStatement}`;
  }
  if (
    options.inspectCreditWalletTransition === true &&
    state.kind === "resume-0018" &&
    state.nextStatement > 0
  ) {
    return `0018_partial_${state.nextStatement}`;
  }
  return null;
}

function assertMigrationTarget(target, verifyOnly) {
  if (
    !new Set(["compatible", "expand", "credit-wallet", "credit-offer"]).has(
      target
    )
  ) {
    throw new Error(
      "migration target must be compatible, expand, credit-wallet, or credit-offer"
    );
  }
  if (target === "compatible" && !verifyOnly) {
    throw new Error("compatible is a verification-only migration target");
  }
}

export function assertVerifiedPhase(
  target,
  phase,
  bridgeArtifactVerification = false,
  inspectCreditWalletTransition = false
) {
  if (bridgeArtifactVerification) {
    if (
      phase !== "0016_expand" &&
      phase !== "0018_credit_checkout_reservation"
    ) {
      throw new Error(
        `schema is at ${phase ?? "an interrupted migration"}; bridge artifact verification refused`
      );
    }
    return;
  }
  if (inspectCreditWalletTransition) {
    if (
      target !== "expand" ||
      !new Set([
        "0016_expand",
        "0017_credit_wallet_expand",
        "0018_credit_checkout_reservation",
      ]).has(phase)
    ) {
      throw new Error(
        `schema is at ${phase ?? "an interrupted migration"}; credit transition inspection refused`
      );
    }
    return;
  }
  const accepted =
    (target === "compatible" &&
      (phase === "0015_base" || phase === "0016_expand")) ||
    (target === "expand" && phase === "0016_expand") ||
    (target === "credit-wallet" &&
      phase === "0018_credit_checkout_reservation") ||
    (target === "credit-offer" && phase === "0019_credit_offer_v2");
  if (!accepted) {
    throw new Error(
      `schema is at ${phase ?? "an interrupted migration"}; ${target} verification refused`
    );
  }
}

export function schemaCapturePlanForPrivilege(fullContract, privilegeProfile) {
  const includePrivilegedObjects = new Set([
    "bootstrap",
    "credit-bootstrap",
    "credit-expand",
    "credit-expand-pregrant",
  ]).has(privilegeProfile);
  const privilegedObjectNamePrefix =
    privilegeProfile === "credit-expand" ||
    privilegeProfile === "credit-expand-pregrant"
      ? "credit_"
      : "";
  const schemaCaptureOptions = {
    includePrivilegedObjects,
    privilegedObjectNamePrefix,
  };
  return {
    contract: includePrivilegedObjects
      ? privilegedObjectNamePrefix
        ? contractWithPrivilegedObjectFilter(
            fullContract,
            privilegedObjectNamePrefix
          )
        : fullContract
      : contractWithPrivilegedObjectFilter(fullContract),
    schemaCaptureOptions,
  };
}

function contractWithPrivilegedObjectFilter(contract, namePrefix = null) {
  if (Array.isArray(contract)) {
    return contract.map(value =>
      contractWithPrivilegedObjectFilter(value, namePrefix)
    );
  }
  if (!contract || typeof contract !== "object") return contract;
  const mapped = Object.fromEntries(
    Object.entries(contract).map(([key, value]) => [
      key,
      contractWithPrivilegedObjectFilter(value, namePrefix),
    ])
  );
  if (
    Object.hasOwn(mapped, "tables") &&
    Object.hasOwn(mapped, "views") &&
    Object.hasOwn(mapped, "triggers") &&
    Object.hasOwn(mapped, "routines")
  ) {
    const keep = entries =>
      namePrefix === null
        ? {}
        : Object.fromEntries(
            Object.entries(entries).filter(([name]) =>
              name.startsWith(namePrefix)
            )
          );
    mapped.triggers = keep(mapped.triggers);
    mapped.routines = keep(mapped.routines);
  }
  return mapped;
}

async function verifyFinalState(
  connection,
  contract,
  plan,
  schemaCaptureOptions,
  target
) {
  const history = await captureMigrationHistory(connection);
  assertAppliedMigrationPrefix(history?.rows ?? [], plan.all);
  const finalState =
    target === "credit-offer"
      ? {
          history: contract.history0019,
          schema: contract.final0019,
          label: "0019 credit offer v2",
          appliedCount: plan.through0019.length,
        }
      : target === "credit-wallet"
        ? {
            history: contract.history0018,
            schema: contract.final0018,
            label: "0018 credit checkout reservation",
            appliedCount: plan.through0018.length,
          }
        : {
            history: contract.history0016,
            schema: contract.final0016,
            label: "0016 expand",
            appliedCount: plan.through0016.length,
          };
  assertExactHistory(history, finalState.history, finalState.label);
  const schema = await captureProductionSchemaState(
    connection,
    schemaCaptureOptions
  );
  assertExactSchemaState(schema, finalState.schema, finalState.label);
  return finalState.appliedCount;
}

async function bootstrapExactProductionPlan(connection, plan, target) {
  await connection.query(
    "CREATE TABLE `__drizzle_migrations` (`id` serial PRIMARY KEY,`hash` text NOT NULL,`created_at` bigint)"
  );
  const migrations =
    target === "credit-offer"
      ? plan.through0019
      : target === "credit-wallet"
        ? plan.through0018
        : plan.through0016;
  for (const migration of migrations) {
    await applyStatements(connection, await readMigrationStatements(migration));
    await insertMigrationHistory(connection, migration);
  }
}

export async function runProductionMigrations(options = {}) {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const verifyOnly = options.verifyOnly ?? false;
  if (typeof verifyOnly !== "boolean") {
    throw new Error("migration verify-only option must be boolean");
  }
  const target = options.target;
  assertMigrationTarget(target, verifyOnly);
  const allowEmptyBootstrap = options.allowEmptyBootstrap ?? false;
  if (typeof allowEmptyBootstrap !== "boolean") {
    throw new Error("empty bootstrap option must be boolean");
  }
  const inspectExpandTransition = options.inspectExpandTransition ?? false;
  if (typeof inspectExpandTransition !== "boolean") {
    throw new Error("expand-transition inspection option must be boolean");
  }
  if (inspectExpandTransition && (!verifyOnly || target !== "compatible")) {
    throw new Error(
      "expand-transition inspection must be compatible and verify-only"
    );
  }
  const inspectCreditWalletTransition =
    options.inspectCreditWalletTransition ?? false;
  if (typeof inspectCreditWalletTransition !== "boolean") {
    throw new Error(
      "credit-wallet-transition inspection option must be boolean"
    );
  }
  if (
    inspectCreditWalletTransition &&
    (!verifyOnly || target !== "expand" || inspectExpandTransition)
  ) {
    throw new Error(
      "credit-wallet-transition inspection must be expand and verify-only"
    );
  }
  const bridgeArtifactVerification =
    options.bridgeArtifactVerification ?? false;
  if (typeof bridgeArtifactVerification !== "boolean") {
    throw new Error("bridge artifact verification option must be boolean");
  }
  const privilegeProfile = options.privilegeProfile ?? "bootstrap";
  if (!productionDatabasePrivilegeProfiles.includes(privilegeProfile)) {
    throw new Error("production database privilege profile is unsupported");
  }
  if (
    privilegeProfile === "phase-bound-runtime" &&
    (!verifyOnly || !bridgeArtifactVerification || target !== "compatible")
  ) {
    throw new Error(
      "phase-bound runtime privileges require bridge artifact verification"
    );
  }
  if (
    bridgeArtifactVerification &&
    privilegeProfile !== "phase-bound-runtime"
  ) {
    throw new Error(
      "bridge artifact verification requires phase-bound runtime privileges"
    );
  }
  const lockTimeoutSeconds = options.lockTimeoutSeconds ?? 30;
  if (
    !Number.isInteger(lockTimeoutSeconds) ||
    lockTimeoutSeconds < 0 ||
    lockTimeoutSeconds > 300
  ) {
    throw new Error("migration lock timeout must be an integer from 0 to 300");
  }
  const { migrationPlan, productionContract: fullContract } =
    await loadAndVerifyMigrationManifest();
  let { contract, schemaCaptureOptions } = schemaCapturePlanForPrivilege(
    fullContract,
    privilegeProfile === "phase-bound-runtime" ? "runtime" : privilegeProfile
  );
  const connection = await mysql.createConnection(databaseUrl);
  let lockName;
  let lockHeld = false;
  let result;
  let operationError;
  const startedAt = Date.now();
  try {
    let runtime;
    let beforeState;
    if (privilegeProfile === "phase-bound-runtime") {
      // The bridge deliberately supports two fully stable schemas with two
      // different least-privilege runtime principals. Determine that phase
      // using only schema/history reads while holding the migration lock; do
      // not try one principal and fall back to the other.
      await configureProductionSchemaSession(connection);
      const [[identity]] = await connection.query(
        "SELECT DATABASE() AS databaseName"
      );
      if (!identity.databaseName) {
        throw new Error("migration database must be selected");
      }
      lockName = migrationLockName(identity.databaseName);
      const [[lock]] = await connection.query(
        "SELECT GET_LOCK(?,?) AS acquired",
        [lockName, lockTimeoutSeconds]
      );
      if (Number(lock.acquired) !== 1) {
        throw new Error("migration singleton lock is unavailable");
      }
      lockHeld = true;
      beforeState = await inspectBeforeState(
        connection,
        contract,
        migrationPlan,
        schemaCaptureOptions
      );
      const resolvedPrivilegeProfile =
        bridgeArtifactPrivilegeProfileForState(beforeState);
      if (!resolvedPrivilegeProfile) {
        throw new Error(
          "release verification requires an exact stable bridge schema phase"
        );
      }
      runtime = await assertProductionMigrationRuntime(
        connection,
        resolvedPrivilegeProfile
      );
      ({ contract, schemaCaptureOptions } = schemaCapturePlanForPrivilege(
        fullContract,
        resolvedPrivilegeProfile
      ));
    } else {
      runtime = await assertProductionMigrationRuntime(
        connection,
        privilegeProfile
      );
    }
    lockName = migrationLockName(runtime.databaseName);
    if (!lockHeld) {
      const [[lock]] = await connection.query(
        "SELECT GET_LOCK(?,?) AS acquired",
        [lockName, lockTimeoutSeconds]
      );
      if (Number(lock.acquired) !== 1) {
        throw new Error("migration singleton lock is unavailable");
      }
      lockHeld = true;
    }

    beforeState ??= await inspectBeforeState(
      connection,
      contract,
      migrationPlan,
      schemaCaptureOptions
    );
    const initialStablePhase = stableSchemaPhase(beforeState);
    if (verifyOnly) {
      if (!initialStablePhase) {
        const inspectedPhase = transitionInspectionPhase(beforeState, {
          inspectExpandTransition,
          inspectCreditWalletTransition,
        });
        if (inspectedPhase) {
          result = {
            appliedCount: inspectedPhase.startsWith("0016_partial_")
              ? migrationPlan.through0015.length
              : inspectedPhase.startsWith("0017_partial_")
                ? migrationPlan.through0016.length
                : migrationPlan.through0017.length,
            schemaPhase: inspectedPhase,
            inspectionOnly: true,
            lockWaitMs: Date.now() - startedAt,
          };
        }
      }
      if (!initialStablePhase && !result) {
        throw new Error(
          "release verification requires an exact stable schema phase"
        );
      }
      if (initialStablePhase) {
        assertVerifiedPhase(
          target,
          initialStablePhase,
          bridgeArtifactVerification,
          inspectCreditWalletTransition
        );
        result = {
          appliedCount:
            initialStablePhase === "0015_base"
              ? migrationPlan.through0015.length
              : initialStablePhase === "0016_expand"
                ? migrationPlan.through0016.length
                : initialStablePhase === "0017_credit_wallet_expand"
                  ? migrationPlan.through0017.length
                  : initialStablePhase === "0018_credit_checkout_reservation"
                    ? migrationPlan.through0018.length
                    : migrationPlan.through0019.length,
          schemaPhase: initialStablePhase,
          inspectionOnly:
            inspectExpandTransition || inspectCreditWalletTransition,
          lockWaitMs: Date.now() - startedAt,
        };
      }
    } else {
      if (beforeState.kind === "fresh") {
        if (
          !allowEmptyBootstrap ||
          !new Set(["expand", "credit-wallet", "credit-offer"]).has(target)
        ) {
          throw new Error(
            "empty database bootstrap requires an explicit bounded bootstrap"
          );
        }
        await assertPreparedStatementCapacity(connection);
        await bootstrapExactProductionPlan(connection, migrationPlan, target);
      } else if (beforeState.kind === "complete") {
        if (target !== "credit-offer") {
          throw new Error("schema is ahead of the requested migration target");
        }
        result = {
          appliedCount: migrationPlan.through0019.length,
          schemaPhase: "0019_credit_offer_v2",
          lockWaitMs: Date.now() - startedAt,
        };
      } else if (beforeState.kind === "resume-0016") {
        if (
          target === "expand" ||
          target === "credit-wallet" ||
          target === "credit-offer"
        ) {
          await resume0016(
            connection,
            contract,
            migrationPlan.expand0016,
            beforeState.phase,
            schemaCaptureOptions
          );
          beforeState = { kind: "resume-0017", nextStatement: 0 };
        } else {
          throw new Error(
            "expand migration requires the completed 0015 base schema"
          );
        }
      } else if (
        beforeState.kind !== "resume-0017" &&
        beforeState.kind !== "resume-0018" &&
        beforeState.kind !== "resume-0019"
      ) {
        throw new Error(
          "expand migration requires the completed 0015 base schema"
        );
      }
      if (
        !result &&
        (target === "credit-wallet" || target === "credit-offer") &&
        beforeState.kind === "resume-0017"
      ) {
        await resume0017(
          connection,
          contract,
          migrationPlan.creditWallet0017,
          beforeState.nextStatement,
          schemaCaptureOptions
        );
        beforeState = { kind: "resume-0018", nextStatement: 0 };
      }
      if (
        !result &&
        (target === "credit-wallet" || target === "credit-offer") &&
        beforeState.kind === "resume-0018"
      ) {
        await resume0018(
          connection,
          contract,
          migrationPlan.creditCheckout0018,
          beforeState.nextStatement,
          schemaCaptureOptions
        );
        beforeState = { kind: "resume-0019", nextStatement: 0 };
      }
      if (
        !result &&
        target === "credit-offer" &&
        beforeState.kind === "resume-0019"
      ) {
        await resume0019(
          connection,
          contract,
          migrationPlan.creditOffer0019,
          beforeState.nextStatement,
          schemaCaptureOptions
        );
      }
      if (!result) {
        const appliedCount = await verifyFinalState(
          connection,
          contract,
          migrationPlan,
          schemaCaptureOptions,
          target
        );
        result = {
          appliedCount,
          schemaPhase:
            target === "credit-offer"
              ? "0019_credit_offer_v2"
              : target === "credit-wallet"
                ? "0018_credit_checkout_reservation"
                : "0016_expand",
          lockWaitMs: Date.now() - startedAt,
        };
      }
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
