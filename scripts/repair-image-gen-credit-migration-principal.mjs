import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertCreditWalletMigrationGrantScope,
  assertProductionMigrationRuntime,
  canonicalJson,
  captureMigrationHistory,
  configureProductionSchemaSession,
} from "../apps/image-gen/scripts/production-schema-contract.mjs";
import { revokeTemporaryCreditMigrationSuperViaExec } from "./image-gen-super-cleanup-exec.mjs";
import { prepareCreditMigrationPrincipalViaExec } from "./image-gen-principal-prepare-driver.mjs";
import {
  CREDIT_MIGRATION_PRINCIPAL_CLEANUP_FAILURE_MARKER,
  CREDIT_MIGRATION_PRINCIPAL_FAILURE_MARKER,
  CREDIT_MIGRATION_PRINCIPAL_READY_MARKER,
  CREDIT_MIGRATION_PRINCIPAL_SUPER_REVOKED_MARKER,
  CreditMigrationPrincipalCleanupError,
  assertCreditMigrationSuperCleanupBoundary,
  detectMissingCreditMigrationPrivileges,
  hasCreditMigrationGlobalSuper,
  parseCreditMigrationAccount,
} from "./image-gen-credit-migration-principal-repair-contract.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.dirname(path.dirname(scriptPath));
const contractPath = path.join(
  repositoryRoot,
  "apps/image-gen/drizzle/production-schema-contract.json",
);

function fail() {
  throw new Error("credit migration principal repair rejected");
}

const FAILURE_STAGES = new Set([
  "arguments",
  "migration_url",
  "migration_connect",
  "migration_history",
  "migration_identity",
  "migration_grants",
  "root_connect",
  "root_initialize",
  "root_exec_request",
  "root_lock",
  "root_exec_response",
  "principal_repair",
  "super_cleanup",
  "verification",
  "rollback_verification",
  "connection_close",
]);

function normalizeFailureStage(value) {
  return FAILURE_STAGES.has(value) ? value : "unknown";
}

export function buildRootFlyctlEnvironment(environment = process.env) {
  if (
    !environment ||
    typeof environment !== "object" ||
    Array.isArray(environment)
  ) {
    fail();
  }
  const required = ["PATH", "HOME", "FLY_API_TOKEN"];
  if (
    required.some(
      (name) =>
        typeof environment[name] !== "string" ||
        environment[name].trim().length === 0,
    )
  ) {
    fail();
  }
  const names = [
    ...required,
    ...["TMPDIR", "NO_COLOR"].filter(
      (name) => typeof environment[name] === "string",
    ),
  ];
  return Object.freeze(
    Object.fromEntries(names.map((name) => [name, environment[name]])),
  );
}

export function parseCliArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 6) fail();
  const appIndex = argv.indexOf("--database-app");
  const machineIndex = argv.indexOf("--database-machine-id");
  const operationIndex = argv.indexOf("--operation");
  if (
    appIndex < 0 ||
    machineIndex < 0 ||
    operationIndex < 0 ||
    appIndex % 2 !== 0 ||
    machineIndex % 2 !== 0 ||
    operationIndex % 2 !== 0 ||
    appIndex === machineIndex ||
    appIndex === operationIndex ||
    machineIndex === operationIndex ||
    argv[appIndex + 1] !== "leaderbot-portal-mysql" ||
    !/^[a-f0-9]{14}$/.test(argv[machineIndex + 1] ?? "") ||
    !new Set(["prepare", "revoke-super"]).has(argv[operationIndex + 1])
  ) {
    fail();
  }
  return Object.freeze({
    app: argv[appIndex + 1],
    machineId: argv[machineIndex + 1],
    operation: argv[operationIndex + 1],
  });
}

function loadMysqlPromiseClient() {
  const requireFromImageGen = createRequire(
    path.join(repositoryRoot, "apps/image-gen/package.json"),
  );
  return requireFromImageGen("mysql2/promise");
}

function assertMigrationUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail();
  }
  if (
    !new Set(["mysql:", "mysql2:"]).has(url.protocol) ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "13306" ||
    url.pathname !== "/leaderbot" ||
    !url.username ||
    !url.password ||
    url.search ||
    url.hash
  ) {
    fail();
  }
  return url.toString();
}

async function readCurrentState(connection) {
  await configureProductionSchemaSession(connection);
  const [[identity]] = await connection.query(
    "SELECT CURRENT_USER() AS currentUser,DATABASE() AS databaseName,@@GLOBAL.log_bin AS logBin,@@GLOBAL.log_bin_trust_function_creators AS logBinTrustFunctionCreators",
  );
  if (identity?.databaseName !== "leaderbot") fail();
  const account = parseCreditMigrationAccount(identity.currentUser);
  const [grantRows] = await connection.query("SHOW GRANTS FOR CURRENT_USER()");
  const grants = grantRows.flatMap((row) => Object.values(row).map(String));
  const requireSuper =
    Number(identity.logBin) === 1 &&
    Number(identity.logBinTrustFunctionCreators) !== 1;
  return { account, databaseName: identity.databaseName, grants, requireSuper };
}

export function classifyCreditMigrationHistory(contract, history) {
  if (contract?.version !== 8 || !history) fail();
  for (const [phase, key] of [
    ["0016_expand", "history0016"],
    ["0017_credit_wallet_expand", "history0017"],
    ["0018_credit_checkout_reservation", "history0018"],
  ]) {
    if (
      contract[key] &&
      canonicalJson(history) === canonicalJson(contract[key])
    ) {
      return phase;
    }
  }
  fail();
}

export async function readExactCreditMigrationPhase(connection) {
  // Fingerprint SHOW CREATE with the same session settings used to generate
  // the reviewed contract, including explicit ROW_FORMAT and fresh statistics.
  await configureProductionSchemaSession(connection);
  const contract = JSON.parse(await fs.readFile(contractPath, "utf8"));
  return classifyCreditMigrationHistory(
    contract,
    await captureMigrationHistory(connection),
  );
}

function isPregrantPhase(phase) {
  if (
    !new Set([
      "0016_expand",
      "0017_credit_wallet_expand",
      "0018_credit_checkout_reservation",
    ]).has(phase)
  )
    fail();
  return phase === "0016_expand";
}

async function closeConnection(connection) {
  if (!connection) return;
  let timeout;
  try {
    await Promise.race([
      connection.end(),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("database close failed")),
          5_000,
        );
        timeout.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export async function executeRepair(
  { app, machineId, operation = "prepare" },
  {
    migrationUrl = process.env.DATABASE_MIGRATION_URL?.trim(),
    mysql = loadMysqlPromiseClient(),
    runPrepare = prepareCreditMigrationPrincipalViaExec,
    readPhase = readExactCreditMigrationPhase,
    readState = readCurrentState,
    verifyRuntime = assertProductionMigrationRuntime,
    onStage = () => {},
    signal,
  } = {},
) {
  onStage("arguments");
  if (!signal || signal.aborted || operation !== "prepare") fail();
  onStage("migration_url");
  const url = assertMigrationUrl(migrationUrl);
  let connection;
  let operationError;
  try {
    onStage("migration_connect");
    connection = await mysql.createConnection(url);
    onStage("migration_history");
    const initialPhase = await readPhase(connection);
    const pregrant = isPregrantPhase(initialPhase);
    onStage("migration_identity");
    const initial = await readState(connection);
    const postDdl = !pregrant;
    const verify = async (requireSuper = initial.requireSuper) => {
      onStage("verification");
      const current = await readState(connection);
      if (
        current.account.username !== initial.account.username ||
        current.account.hostname !== initial.account.hostname ||
        current.databaseName !== initial.databaseName ||
        current.requireSuper !== initial.requireSuper
      ) {
        fail();
      }
      assertCreditWalletMigrationGrantScope(
        current.grants,
        current.databaseName,
        requireSuper,
        pregrant,
      );
      await verifyRuntime(
        connection,
        pregrant
          ? "credit-expand-pregrant"
          : !requireSuper
            ? "credit-expand-postddl"
            : "credit-expand",
      );
      if ((await readPhase(connection)) !== initialPhase) fail();
    };

    // The immutable bridge still requires conditional SUPER for inspection.
    // A resumed history must already have every schema/table/routine right;
    // only missing SUPER may be prepared, never post-DDL schema rights.
    if (postDdl) {
      const superPresent = hasCreditMigrationGlobalSuper(initial.grants);
      await verify(initial.requireSuper && superPresent);
      if (!initial.requireSuper || superPresent) return "already_ready";
    }

    onStage("principal_repair");
    return await runPrepare({
      app,
      machineId,
      connection,
      account: initial.account,
      databaseName: initial.databaseName,
      requireSuper: initial.requireSuper,
      superOnly: postDdl,
      allowIncompleteDefinerTablePrivileges: pregrant,
      readState: async () => {
        if ((await readPhase(connection)) !== initialPhase) fail();
        return readState(connection);
      },
      verify,
      verifyRollback: async (expectedMissing) => {
        onStage("rollback_verification");
        const rolledBack = await readState(connection);
        const observedMissing = detectMissingCreditMigrationPrivileges({
          ...rolledBack,
          allowIncompleteDefinerTablePrivileges: pregrant,
        });
        if (canonicalJson(observedMissing) !== canonicalJson(expectedMissing)) {
          fail();
        }
        if ((await readPhase(connection)) !== initialPhase) fail();
      },
      signal,
      onStage,
    });
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      if (!operationError) onStage("connection_close");
      await closeConnection(connection);
    } catch (closeError) {
      if (operationError instanceof CreditMigrationPrincipalCleanupError) {
        throw operationError;
      }
      if (operationError) {
        throw new AggregateError(
          [operationError, closeError],
          "credit migration principal repair and connection cleanup failed",
          { cause: operationError },
        );
      }
      throw closeError;
    }
  }
}

export async function executeSuperCleanup(
  { app, machineId, operation = "revoke-super" },
  {
    migrationUrl = process.env.DATABASE_MIGRATION_URL?.trim(),
    mysql = loadMysqlPromiseClient(),
    runCleanup = revokeTemporaryCreditMigrationSuperViaExec,
    readPhase = readExactCreditMigrationPhase,
    readState = readCurrentState,
    onStage = () => {},
    signal,
  } = {},
) {
  onStage("arguments");
  if (!signal || signal.aborted || operation !== "revoke-super") fail();
  onStage("migration_url");
  const url = assertMigrationUrl(migrationUrl);
  let connection;
  let operationError;
  try {
    onStage("migration_connect");
    connection = await mysql.createConnection(url);
    onStage("migration_history");
    const initialPhase = await readPhase(connection);
    const pregrant = isPregrantPhase(initialPhase);
    onStage("migration_identity");
    const initial = await readState(connection);
    onStage("migration_grants");
    // Definer table rights are granted only after the 0016 recovery proof.
    assertCreditMigrationSuperCleanupBoundary(initial, pregrant);
    const verify = async () => {
      onStage("verification");
      const current = await readState(connection);
      if (
        current.account.username !== initial.account.username ||
        current.account.hostname !== initial.account.hostname ||
        current.databaseName !== initial.databaseName
      ) {
        fail();
      }
      assertCreditMigrationSuperCleanupBoundary(current, pregrant);
      if (hasCreditMigrationGlobalSuper(current.grants)) fail();
      if ((await readPhase(connection)) !== initialPhase) fail();
    };
    return await runCleanup({
      app,
      machineId,
      connection,
      account: initial.account,
      databaseName: initial.databaseName,
      allowIncompleteDefinerTablePrivileges: pregrant,
      readState: async () => {
        if ((await readPhase(connection)) !== initialPhase) fail();
        return readState(connection);
      },
      verify,
      signal,
      onStage,
    });
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      if (!operationError) onStage("connection_close");
      await closeConnection(connection);
    } catch (closeError) {
      if (operationError instanceof CreditMigrationPrincipalCleanupError) {
        throw operationError;
      }
      if (operationError) {
        throw new AggregateError(
          [operationError, closeError],
          "temporary SUPER revocation and connection cleanup failed",
          { cause: operationError },
        );
      }
      throw closeError;
    }
  }
}

function normalizeMarker(value) {
  return new Set([
    CREDIT_MIGRATION_PRINCIPAL_READY_MARKER,
    CREDIT_MIGRATION_PRINCIPAL_SUPER_REVOKED_MARKER,
    CREDIT_MIGRATION_PRINCIPAL_FAILURE_MARKER,
    CREDIT_MIGRATION_PRINCIPAL_CLEANUP_FAILURE_MARKER,
  ]).has(value)
    ? value
    : CREDIT_MIGRATION_PRINCIPAL_FAILURE_MARKER;
}

export async function runCli(
  argv,
  { execute = executeRepair, cleanup = executeSuperCleanup } = {},
) {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  let marker = CREDIT_MIGRATION_PRINCIPAL_FAILURE_MARKER;
  let stage = "arguments";
  let operation = "unknown";
  const onStage = (value) => {
    stage = normalizeFailureStage(value);
  };
  try {
    const input = parseCliArguments(argv);
    operation = input.operation;
    stage = "unknown";
    if (input.operation === "prepare") {
      await execute(input, { signal: controller.signal, onStage });
      marker = CREDIT_MIGRATION_PRINCIPAL_READY_MARKER;
    } else {
      await cleanup(input, { signal: controller.signal, onStage });
      marker = CREDIT_MIGRATION_PRINCIPAL_SUPER_REVOKED_MARKER;
    }
  } catch (error) {
    if (error instanceof CreditMigrationPrincipalCleanupError) {
      marker = CREDIT_MIGRATION_PRINCIPAL_CLEANUP_FAILURE_MARKER;
    }
    // Stage is the last entered boundary, not proof of the cause or of rollback.
    // Never serialize the caught error, its cause, grants, identifiers or URLs.
    process.stderr.write(
      `${JSON.stringify({
        event: "credit_migration_principal_operation_failed",
        operation,
        stage,
      })}\n`,
    );
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
  process.stdout.write(`${normalizeMarker(marker)}\n`);
  return marker;
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const marker = await runCli(process.argv.slice(2));
  process.exitCode = new Set([
    CREDIT_MIGRATION_PRINCIPAL_READY_MARKER,
    CREDIT_MIGRATION_PRINCIPAL_SUPER_REVOKED_MARKER,
  ]).has(marker)
    ? 0
    : 1;
}
