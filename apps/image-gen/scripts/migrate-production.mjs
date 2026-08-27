/* global process */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import {
  assertExactSchemaState,
  assertProductionMigrationRuntime,
  assertPreparedStatementCapacity,
  captureMigrationHistory,
  captureProductionSchemaState,
  canonicalJson,
  productionSchemaContractVersion,
  productionMigrationSetSha256,
} from "./production-schema-contract.mjs";
import { resolveProductionMigrationPlan } from "./production-migration-plan.mjs";

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
  if (manifest.schemaSnapshot !== "meta/0016_snapshot.json") {
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
    Object.hasOwn(productionContract, "partial0017BillingConstraints") ||
    Object.hasOwn(productionContract, "final0017") ||
    Object.hasOwn(productionContract, "finalHistory")
  ) {
    throw new Error("production schema contract format is unsupported");
  }
  assertProductionSchemaContractManifest(
    productionContract,
    manifest.migrations
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
    contract.normalization !== "show-create-and-trigger-v1" ||
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
  if (
    contract.legacyHistory.nextId !== 9 ||
    JSON.stringify(contract.legacyHistory.rows) !==
      JSON.stringify(legacyRows) ||
    contract.baseHistory.nextId !== plan.through0014.length + 1 ||
    contract.history0015.nextId !== plan.through0015.length + 1 ||
    contract.history0016.nextId !== plan.through0016.length + 1 ||
    JSON.stringify(contract.baseHistory.rows) !==
      JSON.stringify(expected0014Rows) ||
    JSON.stringify(contract.history0015.rows) !==
      JSON.stringify(expected0015Rows) ||
    JSON.stringify(contract.history0016.rows) !==
      JSON.stringify(expected0016Rows)
  ) {
    throw new Error(
      "production schema contract history does not match manifest"
    );
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
      { tables: {}, views: {}, triggers: {} },
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
    assertExactSchemaState(schema, contract.final0016, "0016");
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

export const productionSchemaPhases = Object.freeze([
  "0015_base",
  "0016_expand",
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
  "apply-empty-bootstrap": {
    verifyOnly: false,
    target: "expand",
    allowEmptyBootstrap: true,
  },
});

export function productionMigrationOptionsForMode(mode, artifactKind = "") {
  if (mode === "apply-expand") {
    return artifactKind === "migration-bridge"
      ? {
          verifyOnly: false,
          target: "expand",
          privilegeProfile: "expand",
        }
      : null;
  }
  if (mode === "verify-artifact") {
    if (artifactKind === "migration-bridge") {
      return {
        verifyOnly: true,
        target: "compatible",
        privilegeProfile: "runtime",
      };
    }
    if (artifactKind === "runtime") {
      return {
        verifyOnly: true,
        target: "expand",
        privilegeProfile: "runtime",
      };
    }
    return null;
  }
  const options = productionMigrationModes[mode];
  return options ? { ...options } : null;
}

function stableSchemaPhase(state) {
  if (state.kind === "resume-0016" && state.phase === 0) return "0015_base";
  if (state.kind === "complete") return "0016_expand";
  return null;
}

function assertMigrationTarget(target, verifyOnly) {
  if (!new Set(["compatible", "expand"]).has(target)) {
    throw new Error("migration target must be compatible or expand");
  }
  if (target === "compatible" && !verifyOnly) {
    throw new Error("compatible is a verification-only migration target");
  }
}

function assertVerifiedPhase(target, phase) {
  const accepted =
    (target === "compatible" &&
      (phase === "0015_base" || phase === "0016_expand")) ||
    (target === "expand" && phase === "0016_expand");
  if (!accepted) {
    throw new Error(
      `schema is at ${phase ?? "an interrupted migration"}; ${target} verification refused`
    );
  }
}

function contractWithoutPrivilegedObjects(contract) {
  return Object.fromEntries(
    Object.entries(contract).map(([key, value]) => {
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.hasOwn(value, "triggers")
      ) {
        return [key, { ...value, triggers: {} }];
      }
      return [key, value];
    })
  );
}

async function verifyFinalState(
  connection,
  contract,
  plan,
  schemaCaptureOptions
) {
  const history = await captureMigrationHistory(connection);
  assertAppliedMigrationPrefix(history?.rows ?? [], plan.all);
  assertExactHistory(history, contract.history0016, "0016 expand");
  const schema = await captureProductionSchemaState(
    connection,
    schemaCaptureOptions
  );
  assertExactSchemaState(schema, contract.final0016, "0016 expand");
  return plan.through0016.length;
}

async function bootstrapExactProductionPlan(connection, plan) {
  await connection.query(
    "CREATE TABLE `__drizzle_migrations` (`id` serial PRIMARY KEY,`hash` text NOT NULL,`created_at` bigint)"
  );
  for (const migration of plan.through0016) {
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
  const privilegeProfile = options.privilegeProfile ?? "bootstrap";
  if (
    !new Set(["inspection", "runtime", "expand", "bootstrap"]).has(
      privilegeProfile
    )
  ) {
    throw new Error("production database privilege profile is unsupported");
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
  const includePrivilegedObjects = privilegeProfile === "bootstrap";
  const schemaCaptureOptions = { includePrivilegedObjects };
  const contract = includePrivilegedObjects
    ? fullContract
    : contractWithoutPrivilegedObjects(fullContract);
  const connection = await mysql.createConnection(databaseUrl);
  let lockName;
  let lockHeld = false;
  let result;
  let operationError;
  const startedAt = Date.now();
  try {
    const runtime = await assertProductionMigrationRuntime(
      connection,
      privilegeProfile
    );
    lockName = migrationLockName(runtime.databaseName);
    const [[lock]] = await connection.query(
      "SELECT GET_LOCK(?,?) AS acquired",
      [lockName, lockTimeoutSeconds]
    );
    if (Number(lock.acquired) !== 1) {
      throw new Error("migration singleton lock is unavailable");
    }
    lockHeld = true;

    let beforeState = await inspectBeforeState(
      connection,
      contract,
      migrationPlan,
      schemaCaptureOptions
    );
    const initialStablePhase = stableSchemaPhase(beforeState);
    if (verifyOnly) {
      if (!initialStablePhase) {
        if (
          inspectExpandTransition &&
          beforeState.kind === "resume-0016" &&
          beforeState.phase > 0
        ) {
          result = {
            appliedCount: migrationPlan.through0015.length,
            schemaPhase: `0016_partial_${beforeState.phase}`,
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
        assertVerifiedPhase(target, initialStablePhase);
        result = {
          appliedCount:
            initialStablePhase === "0015_base"
              ? migrationPlan.through0015.length
              : migrationPlan.through0016.length,
          schemaPhase: initialStablePhase,
          inspectionOnly: inspectExpandTransition,
          lockWaitMs: Date.now() - startedAt,
        };
      }
    } else {
      if (beforeState.kind === "fresh") {
        if (!allowEmptyBootstrap || target !== "expand") {
          throw new Error(
            "empty database bootstrap requires an explicit expand bootstrap"
          );
        }
        await assertPreparedStatementCapacity(connection);
        await bootstrapExactProductionPlan(connection, migrationPlan);
      } else if (beforeState.kind === "complete") {
        result = {
          appliedCount: migrationPlan.through0016.length,
          schemaPhase: "0016_expand",
          lockWaitMs: Date.now() - startedAt,
        };
      } else {
        if (beforeState.kind !== "resume-0016") {
          throw new Error(
            "expand migration requires the completed 0015 base schema"
          );
        }
        await resume0016(
          connection,
          contract,
          migrationPlan.expand0016,
          beforeState.phase,
          schemaCaptureOptions
        );
      }
      if (!result) {
        const appliedCount = await verifyFinalState(
          connection,
          contract,
          migrationPlan,
          schemaCaptureOptions
        );
        result = {
          appliedCount,
          schemaPhase: "0016_expand",
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
