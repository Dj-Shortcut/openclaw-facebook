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
import { RootMysqlSession } from "./provision-image-gen-credit-provisioner.mjs";
import {
  CREDIT_MIGRATION_PRINCIPAL_CLEANUP_FAILURE_MARKER,
  CREDIT_MIGRATION_PRINCIPAL_FAILURE_MARKER,
  CREDIT_MIGRATION_PRINCIPAL_READY_MARKER,
  CreditMigrationPrincipalCleanupError,
  detectMissingCreditMigrationPrivileges,
  parseCreditMigrationAccount,
  repairCreditMigrationPrincipal,
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

export function parseCliArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 4) fail();
  const appIndex = argv.indexOf("--database-app");
  const machineIndex = argv.indexOf("--database-machine-id");
  if (
    appIndex < 0 ||
    machineIndex < 0 ||
    appIndex % 2 !== 0 ||
    machineIndex % 2 !== 0 ||
    appIndex === machineIndex ||
    argv[appIndex + 1] !== "leaderbot-portal-mysql" ||
    !/^[a-f0-9]{14}$/.test(argv[machineIndex + 1] ?? "")
  ) {
    fail();
  }
  return Object.freeze({
    app: argv[appIndex + 1],
    machineId: argv[machineIndex + 1],
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

async function readExactCreditMigrationPhase(connection) {
  const contract = JSON.parse(await fs.readFile(contractPath, "utf8"));
  return classifyCreditMigrationHistory(
    contract,
    await captureMigrationHistory(connection),
  );
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
  { app, machineId },
  {
    migrationUrl = process.env.DATABASE_MIGRATION_URL?.trim(),
    mysql = loadMysqlPromiseClient(),
    openRoot = ({ signal }) =>
      new RootMysqlSession({
        app,
        machineId,
        signal,
        env: Object.fromEntries(
          ["PATH", "FLY_API_TOKEN", "TMPDIR", "NO_COLOR"]
            .filter((name) => typeof process.env[name] === "string")
            .map((name) => [name, process.env[name]]),
        ),
      }),
    readPhase = readExactCreditMigrationPhase,
    readState = readCurrentState,
    verifyRuntime = assertProductionMigrationRuntime,
    signal,
  } = {},
) {
  if (!signal || signal.aborted) fail();
  const url = assertMigrationUrl(migrationUrl);
  let connection;
  const roots = [];
  let root;
  const createRoot = async () => {
    const next = await openRoot({ signal });
    if (!next || typeof next.initialize !== "function") fail();
    roots.push(next);
    await next.initialize(signal);
    return next;
  };
  try {
    connection = await mysql.createConnection(url);
    const initialPhase = await readPhase(connection);
    const initial = await readState(connection);
    const verify = async () => {
      const current = await readState(connection);
      if (
        current.account.username !== initial.account.username ||
        current.account.hostname !== initial.account.hostname
      ) {
        fail();
      }
      assertCreditWalletMigrationGrantScope(
        current.grants,
        current.databaseName,
        current.requireSuper,
      );
      await verifyRuntime(connection, "credit-expand");
      if ((await readPhase(connection)) !== initialPhase) fail();
    };

    // A resumed transition may already have recorded 0017 or 0018. Those
    // phases are verification-only: never reopen the root mutation path.
    if (initialPhase !== "0016_expand") {
      await verify();
      return "already_ready";
    }

    root = await createRoot();
    return await repairCreditMigrationPrincipal({
      account: initial.account,
      databaseName: initial.databaseName,
      requireSuper: initial.requireSuper,
      root,
      readState: () => readState(connection),
      recoverRoot: async (failedRoot) => {
        await failedRoot.close({ releaseLock: false, signal });
        return createRoot();
      },
      verify,
      verifyRollback: async (expectedMissing) => {
        const rolledBack = await readState(connection);
        const observedMissing =
          detectMissingCreditMigrationPrivileges(rolledBack);
        if (canonicalJson(observedMissing) !== canonicalJson(expectedMissing)) {
          fail();
        }
        if ((await readPhase(connection)) !== initialPhase) fail();
      },
    });
  } finally {
    for (const openedRoot of roots.reverse()) {
      await openedRoot
        .close({ releaseLock: false, signal })
        .catch(() => undefined);
    }
    await closeConnection(connection);
  }
}

function normalizeMarker(value) {
  return new Set([
    CREDIT_MIGRATION_PRINCIPAL_READY_MARKER,
    CREDIT_MIGRATION_PRINCIPAL_FAILURE_MARKER,
    CREDIT_MIGRATION_PRINCIPAL_CLEANUP_FAILURE_MARKER,
  ]).has(value)
    ? value
    : CREDIT_MIGRATION_PRINCIPAL_FAILURE_MARKER;
}

export async function runCli(argv, { execute = executeRepair } = {}) {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  let marker = CREDIT_MIGRATION_PRINCIPAL_FAILURE_MARKER;
  try {
    const input = parseCliArguments(argv);
    await execute(input, { signal: controller.signal });
    marker = CREDIT_MIGRATION_PRINCIPAL_READY_MARKER;
  } catch (error) {
    if (error instanceof CreditMigrationPrincipalCleanupError) {
      marker = CREDIT_MIGRATION_PRINCIPAL_CLEANUP_FAILURE_MARKER;
    }
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
  process.exitCode = marker === CREDIT_MIGRATION_PRINCIPAL_READY_MARKER ? 0 : 1;
}
