import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CREDIT_PROVISIONER_CLEANUP_FAILURE_MARKER,
  CREDIT_PROVISIONER_FAILURE_MARKER,
  CREDIT_PROVISIONER_LOCK_NAME,
  CREDIT_PROVISIONER_SECRET_NAME,
  CREDIT_PROVISIONER_SUCCESS_MARKER,
  assertBootstrapManifest,
  assertProvisionerGrants,
  assertRecoverySnapshot,
  buildProvisionerSql,
  buildProvisionerUrl,
  githubSecretSetArgs,
  parseManagedProvisionerAccounts,
  quoteManagedAccount,
  selectReviewedDatabaseTarget,
} from "./image-gen-credit-provisioner-bootstrap-contract.mjs";

const REPOSITORY = "Dj-Shortcut/openclaw-facebook";
const ENVIRONMENT = "production";
const MAIN_BRANCH = "main";
export const PINNED_FLYCTL_VERSION = "0.4.94";
const COMMAND_OUTPUT_LIMIT = 2 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const MYSQL_QUERY_TIMEOUT_MS = 45_000;
const CLEANUP_TIMEOUT_MS = 2 * 60 * 1000;
const PROXY_START_TIMEOUT_MS = 20_000;
const PROXY_STOP_TIMEOUT_MS = 5_000;
const SECRET_RECONCILIATION_TIMEOUT_MS = 45_000;
const SECRET_STABILIZATION_WINDOW_MS = 15_000;
export const MANAGED_ACCOUNT_INVENTORY_QUERY =
  "SELECT CONCAT(User,0x09,Host) FROM mysql.user WHERE User LIKE 'lbcp\\\\_%' ESCAPE '\\\\' ORDER BY User,Host";
export const ROOT_MYSQL_REMOTE_COMMAND =
  "/bin/sh -lc 'exec env MYSQL_PWD=\"$MYSQL_ROOT_PASSWORD\" mysql --protocol=socket --batch --raw --skip-column-names --silent --unbuffered -uroot leaderbot'";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.dirname(path.dirname(scriptPath));
const manifestPath = path.join(repositoryRoot, "deploy/production/apps.json");

function fail() {
  throw new Error("credit provisioner bootstrap rejected");
}

function requireExactSha(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) fail();
  return value;
}

function throwIfAborted(signal) {
  if (signal?.aborted) fail();
}

function parseJsonArray(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail();
  }
  if (!Array.isArray(parsed)) fail();
  return parsed;
}

export function parseCliArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 4) fail();
  const expectedHeadIndex = argv.indexOf("--expected-head");
  const snapshotIndex = argv.indexOf("--recovery-snapshot-id");
  if (
    expectedHeadIndex < 0 ||
    snapshotIndex < 0 ||
    expectedHeadIndex % 2 !== 0 ||
    snapshotIndex % 2 !== 0 ||
    expectedHeadIndex === snapshotIndex
  ) {
    fail();
  }
  const expectedHead = requireExactSha(argv[expectedHeadIndex + 1]);
  const snapshotId = argv[snapshotIndex + 1];
  if (
    typeof snapshotId !== "string" ||
    !/^[A-Za-z0-9_-]{16,80}$/.test(snapshotId)
  ) {
    fail();
  }
  return Object.freeze({ expectedHead, snapshotId });
}

export function buildFlyProxyArgs(context) {
  if (
    !/^fdaa:[0-9a-f:]+$/.test(context?.machine?.private_ip ?? "") ||
    context?.recovery?.app !== "leaderbot-portal-mysql"
  ) {
    fail();
  }
  return Object.freeze([
    "proxy",
    "0:3306",
    context.machine.private_ip,
    "--app",
    context.recovery.app,
    "--bind-addr",
    "127.0.0.1",
    "--quiet",
  ]);
}

function stripKnownFlyctlControlSequences(value) {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

export function parseFlyProxyPort(output, expectedPrivateIp) {
  if (
    typeof output !== "string" ||
    output.length > COMMAND_OUTPUT_LIMIT ||
    !/^fdaa:[0-9a-f:]+$/.test(expectedPrivateIp ?? "")
  ) {
    fail();
  }
  const lines = stripKnownFlyctlControlSequences(output)
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) fail();
  const escapedPrivateIp = expectedPrivateIp.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const match = new RegExp(
    `^Proxying localhost:([0-9]{1,5}) to remote \\[${escapedPrivateIp}\\]:3306$`,
  ).exec(lines[0]);
  const port = Number(match?.[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) fail();
  return port;
}

export function buildRootMysqlSshArgs({ app, machineId }) {
  if (
    app !== "leaderbot-portal-mysql" ||
    typeof machineId !== "string" ||
    !/^[a-f0-9]{14}$/.test(machineId)
  ) {
    fail();
  }
  return Object.freeze([
    "ssh",
    "console",
    "--app",
    app,
    "--machine",
    machineId,
    "--quiet",
    "--command",
    ROOT_MYSQL_REMOTE_COMMAND,
  ]);
}

export function normalizeBootstrapMarker(value) {
  return new Set([
    CREDIT_PROVISIONER_SUCCESS_MARKER,
    CREDIT_PROVISIONER_FAILURE_MARKER,
    CREDIT_PROVISIONER_CLEANUP_FAILURE_MARKER,
  ]).has(value)
    ? value
    : CREDIT_PROVISIONER_FAILURE_MARKER;
}

export function githubAuthTokenArgs() {
  return Object.freeze(["auth", "token", "--hostname", "github.com"]);
}

export function buildSourceCiEnvironment(token, baseEnvironment = process.env) {
  if (
    typeof token !== "string" ||
    token.length < 20 ||
    token.length > 500 ||
    /\s/.test(token)
  ) {
    fail();
  }
  return Object.freeze({
    ...baseEnvironment,
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_TOKEN: token,
  });
}

export function attachChildStdinFailureHandler(child, onFailure) {
  if (!child?.stdin || typeof onFailure !== "function") fail();
  child.stdin.on("error", onFailure);
}

function appendBounded(chunks, chunk, state) {
  state.bytes += chunk.length;
  if (state.bytes > COMMAND_OUTPUT_LIMIT) fail();
  chunks.push(chunk);
}

function runCommand(
  command,
  args,
  {
    acceptedExitCodes = [0],
    cwd = repositoryRoot,
    environment,
    envOverrides = {},
    input,
    signal,
    timeoutMs = COMMAND_TIMEOUT_MS,
  } = {},
) {
  if (
    typeof command !== "string" ||
    !Array.isArray(args) ||
    !Array.isArray(acceptedExitCodes) ||
    acceptedExitCodes.length === 0 ||
    acceptedExitCodes.some(
      (code) => !Number.isInteger(code) || code < 0 || code > 255,
    ) ||
    (environment !== undefined &&
      (!environment ||
        typeof environment !== "object" ||
        Array.isArray(environment) ||
        Object.entries(environment).some(
          ([key, value]) =>
            !/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof value !== "string",
        ))) ||
    !envOverrides ||
    typeof envOverrides !== "object" ||
    Array.isArray(envOverrides) ||
    Object.entries(envOverrides).some(
      ([key, value]) =>
        !/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof value !== "string",
    ) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1
  ) {
    fail();
  }
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: environment ?? { ...process.env, ...envOverrides },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    const stdoutState = { bytes: 0 };
    const stderrState = { bytes: 0 };
    let forcedFailure = false;
    let settled = false;
    let killTimer;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const terminate = () => {
      forcedFailure = true;
      if (child.exitCode != null || child.killed) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimer.unref?.();
    };
    const abort = () => terminate();
    const timeout = setTimeout(terminate, timeoutMs);
    timeout.unref?.();
    signal?.addEventListener("abort", abort, { once: true });
    attachChildStdinFailureHandler(child, terminate);
    child.stdout.on("data", (chunk) => {
      try {
        appendBounded(stdout, chunk, stdoutState);
      } catch {
        terminate();
      }
    });
    child.stderr.on("data", (chunk) => {
      try {
        appendBounded(stderr, chunk, stderrState);
      } catch {
        terminate();
      }
    });
    child.once("error", () =>
      finish(() => reject(new Error("command failed"))),
    );
    child.once("close", (code) => {
      finish(() => {
        if (
          !acceptedExitCodes.includes(code) ||
          signal?.aborted ||
          forcedFailure
        ) {
          reject(new Error("command failed"));
          return;
        }
        resolve(Buffer.concat(stdout).toString("utf8"));
      });
    });
    try {
      if (typeof input === "string") child.stdin.end(input);
      else child.stdin.end();
    } catch {
      terminate();
    }
  });
}

export function waitForFlyProxyStartup({
  child,
  expectedPrivateIp,
  signal,
  startupTimeoutMs = PROXY_START_TIMEOUT_MS,
}) {
  if (
    !child?.stdout ||
    !child?.stderr ||
    !Number.isInteger(startupTimeoutMs) ||
    startupTimeoutMs < 1
  ) {
    fail();
  }
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    const stdoutState = { bytes: 0 };
    const stderrState = { bytes: 0 };
    let validationTimer;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimer);
      clearTimeout(validationTimer);
      child.removeListener("close", closed);
      child.removeListener("error", closed);
      child.stdout.removeListener("data", consumeStdout);
      child.stderr.removeListener("data", consumeStderr);
      signal?.removeEventListener("abort", aborted);
      callback();
    };
    const closed = () => finish(() => reject(new Error("proxy failed")));
    const aborted = () => {
      child.kill("SIGTERM");
      finish(() => reject(new Error("proxy failed")));
    };
    const validateOutput = () => {
      try {
        const output = [
          Buffer.concat(stdout).toString("utf8"),
          Buffer.concat(stderr).toString("utf8"),
        ]
          .filter(Boolean)
          .join("\n");
        const port = parseFlyProxyPort(output, expectedPrivateIp);
        if (child.exitCode != null || child.killed || signal?.aborted) fail();
        finish(() => {
          child.stdout.resume();
          child.stderr.resume();
          resolve(port);
        });
      } catch {
        finish(() => reject(new Error("proxy failed")));
      }
    };
    const scheduleValidation = () => {
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      if (!/[\r\n]/.test(stdoutText) && !/[\r\n]/.test(stderrText)) return;
      clearTimeout(validationTimer);
      validationTimer = setTimeout(validateOutput, 100);
    };
    const consume = (target, state, chunk) => {
      try {
        appendBounded(target, chunk, state);
        scheduleValidation();
      } catch {
        finish(() => reject(new Error("proxy failed")));
      }
    };
    const consumeStdout = (chunk) => consume(stdout, stdoutState, chunk);
    const consumeStderr = (chunk) => consume(stderr, stderrState, chunk);
    const startupTimer = setTimeout(closed, startupTimeoutMs);
    child.once("close", closed);
    child.once("error", closed);
    child.stdout.on("data", consumeStdout);
    child.stderr.on("data", consumeStderr);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

async function stopChild(child, timeoutMs = PROXY_STOP_TIMEOUT_MS) {
  if (!child || child.exitCode != null) return;
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(hardTimer);
      child.removeListener("close", closed);
      callback();
    };
    const closed = () => finish(resolve);
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    const hardTimer = setTimeout(
      () => finish(() => reject(new Error("process stop failed"))),
      timeoutMs,
    );
    killTimer.unref?.();
    hardTimer.unref?.();
    child.once("close", closed);
    child.kill("SIGTERM");
  });
}

class RootMysqlSession {
  constructor({ app, machineId, signal }) {
    this.buffer = "";
    this.child = spawn("flyctl", buildRootMysqlSshArgs({ app, machineId }), {
      cwd: repositoryRoot,
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.pending = null;
    this.closed = false;
    this.stderrBytes = 0;
    this.signal = signal;
    this.aborted = () => this.child.kill("SIGTERM");
    signal?.addEventListener("abort", this.aborted, { once: true });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.#consume(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > COMMAND_OUTPUT_LIMIT) this.child.kill("SIGTERM");
    });
    attachChildStdinFailureHandler(this.child, () => {
      this.child.kill("SIGTERM");
      this.#rejectPending();
    });
    this.child.once("error", () => this.#rejectPending());
    this.child.once("close", () => {
      this.closed = true;
      this.#rejectPending();
    });
  }

  #consume(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > COMMAND_OUTPUT_LIMIT) {
      this.child.kill("SIGTERM");
      this.#rejectPending();
      return;
    }
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!this.pending) continue;
      if (line === this.pending.marker) {
        const { abort, lines, resolve, signal, timer } = this.pending;
        this.pending = null;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        resolve(lines);
      } else if (line) {
        this.pending.lines.push(line);
      }
    }
  }

  #rejectPending() {
    if (!this.pending) return;
    const { abort, reject, signal, timer } = this.pending;
    this.pending = null;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    reject(new Error("database command failed"));
  }

  execute(sql, { signal, timeoutMs = MYSQL_QUERY_TIMEOUT_MS } = {}) {
    if (
      this.closed ||
      this.pending ||
      typeof sql !== "string" ||
      !sql.trim() ||
      signal?.aborted
    ) {
      fail();
    }
    const marker = `__lbcp_${randomBytes(16).toString("hex")}__`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGTERM");
        this.#rejectPending();
      }, timeoutMs);
      timer.unref?.();
      const abort = () => {
        this.child.kill("SIGTERM");
        this.#rejectPending();
      };
      this.pending = {
        abort,
        lines: [],
        marker,
        reject,
        resolve,
        signal,
        timer,
      };
      signal?.addEventListener("abort", abort, { once: true });
      const statement = `${sql.trim().replace(/;?$/, ";")}\nSELECT '${marker}';\n`;
      this.child.stdin.write(statement, (error) => {
        if (error) this.#rejectPending();
      });
    });
  }

  async initialize(signal) {
    const lines = await this.execute("SELECT 1", { signal });
    if (lines.length !== 1 || lines[0] !== "1") fail();
  }

  async acquireLock(signal) {
    const lines = await this.execute(
      `SELECT GET_LOCK('${CREDIT_PROVISIONER_LOCK_NAME}',0)`,
      { signal },
    );
    if (lines.length !== 1 || lines[0] !== "1") fail();
  }

  async assertLockHeld(signal) {
    const lines = await this.execute(
      `SELECT IS_USED_LOCK('${CREDIT_PROVISIONER_LOCK_NAME}')=CONNECTION_ID()`,
      { signal },
    );
    if (lines.length !== 1 || lines[0] !== "1") fail();
  }

  async listManagedAccounts(signal) {
    const lines = await this.execute(MANAGED_ACCOUNT_INVENTORY_QUERY, {
      signal,
    });
    return parseManagedProvisionerAccounts(lines);
  }

  async assertNoUnexpectedCreateUserPrincipal(signal) {
    const lines = await this.execute(
      "SELECT COUNT(*) FROM mysql.user WHERE Create_user_priv='Y' AND User NOT IN ('root','mysql.infoschema','mysql.session','mysql.sys') AND NOT (User REGEXP '^lbcp_[0-9a-f]{16}$' AND Host='%')",
      { signal },
    );
    if (lines.length !== 1 || lines[0] !== "0") fail();
  }

  async accountExists(account, signal) {
    const lines = await this.execute(
      `SELECT COUNT(*) FROM mysql.user WHERE User='${account.username}' AND Host='%'`,
      { signal },
    );
    if (lines.length !== 1 || !new Set(["0", "1"]).has(lines[0])) fail();
    return lines[0] === "1";
  }

  async showGrants(account, signal) {
    return this.execute(`SHOW GRANTS FOR ${quoteManagedAccount(account)}`, {
      signal,
    });
  }

  async disableAndDrop(account, signal) {
    const quoted = quoteManagedAccount(account);
    await this.execute(`ALTER USER IF EXISTS ${quoted} ACCOUNT LOCK`, {
      signal,
    });
    await this.execute(`DROP USER IF EXISTS ${quoted}`, { signal });
  }

  async close({ releaseLock = true, signal } = {}) {
    if (!this.closed && releaseLock) {
      try {
        await this.execute(
          `SELECT RELEASE_LOCK('${CREDIT_PROVISIONER_LOCK_NAME}')`,
          { signal, timeoutMs: 10_000 },
        );
      } catch {
        // The caller independently proves cleanup before this best-effort close.
      }
    }
    this.signal?.removeEventListener("abort", this.aborted);
    if (!this.closed) this.child.stdin.end("\\q\n");
    await stopChild(this.child);
    this.closed = true;
  }
}

function sameContext(left, right) {
  return (
    left.machine.id === right.machine.id &&
    left.machine.private_ip === right.machine.private_ip &&
    left.volume.id === right.volume.id &&
    left.snapshot.id === right.snapshot.id &&
    left.snapshot.digest === right.snapshot.digest &&
    left.snapshot.createdAt === right.snapshot.createdAt
  );
}

async function verifyExactRepositoryState(expectedHead, signal) {
  const [branch, head, status, remote] = await Promise.all([
    runCommand("git", ["branch", "--show-current"], { signal }),
    runCommand("git", ["rev-parse", "HEAD"], { signal }),
    runCommand("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      signal,
    }),
    runCommand("git", ["ls-remote", "origin", "refs/heads/main"], {
      signal,
    }),
  ]);
  const exactHead = requireExactSha(head.trim());
  const remoteFields = remote.trim().split(/\s+/);
  if (
    branch.trim() !== MAIN_BRANCH ||
    status !== "" ||
    exactHead !== expectedHead ||
    remoteFields.length !== 2 ||
    remoteFields[0] !== expectedHead ||
    remoteFields[1] !== "refs/heads/main"
  ) {
    fail();
  }
}

async function verifyRepositoryState(expectedHead, signal) {
  await verifyExactRepositoryState(expectedHead, signal);
  await runCommand("npm", ["run", "production:validate"], { signal });
  const githubToken = (
    await runCommand("gh", githubAuthTokenArgs(), {
      signal,
      timeoutMs: 60_000,
    })
  ).trim();
  const sourceCiEnvironment = buildSourceCiEnvironment(githubToken, {});
  await runCommand(
    process.execPath,
    [
      "scripts/validate-production-deployment.mjs",
      "--verify-source-ci",
      expectedHead,
    ],
    { environment: sourceCiEnvironment, signal },
  );
}

async function readManifest() {
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch {
    fail();
  }
  return manifest;
}

async function secretNames(signal) {
  const output = await runCommand(
    "gh",
    [
      "secret",
      "list",
      "--repo",
      REPOSITORY,
      "--env",
      ENVIRONMENT,
      "--json",
      "name",
    ],
    { signal },
  );
  const rows = parseJsonArray(output);
  if (rows.some((row) => typeof row?.name !== "string")) fail();
  return rows.map((row) => row.name);
}

async function assertSecretPresence(expected, signal) {
  const names = await secretNames(signal);
  const count = names.filter(
    (name) => name === CREDIT_PROVISIONER_SECRET_NAME,
  ).length;
  if (count !== (expected ? 1 : 0)) fail();
}

async function inspectProductionContext({ expectedHead, snapshotId, signal }) {
  await verifyRepositoryState(expectedHead, signal);
  const manifest = await readManifest();
  const { recovery } = assertBootstrapManifest(manifest);
  const version = await runCommand("flyctl", ["version"], { signal });
  if (
    !new RegExp(
      `^flyctl v${PINNED_FLYCTL_VERSION.replaceAll(".", "\\.")}(?:\\s|$)`,
    ).test(version)
  ) {
    fail();
  }
  const [machinesOutput, volumesOutput, snapshotsOutput] = await Promise.all([
    runCommand("flyctl", ["machine", "list", "--app", recovery.app, "--json"], {
      signal,
    }),
    runCommand("flyctl", ["volumes", "list", "--app", recovery.app, "--json"], {
      signal,
    }),
    runCommand(
      "flyctl",
      [
        "volumes",
        "snapshots",
        "list",
        recovery.volumeId,
        "--app",
        recovery.app,
        "--json",
      ],
      { signal },
    ),
  ]);
  const { machine, volume } = selectReviewedDatabaseTarget({
    machines: parseJsonArray(machinesOutput),
    recovery,
    volumes: parseJsonArray(volumesOutput),
  });
  const snapshot = assertRecoverySnapshot(parseJsonArray(snapshotsOutput), {
    recovery,
    snapshotId,
  });
  await assertSecretPresence(false, signal);
  return Object.freeze({ machine, recovery, snapshot, volume });
}

async function startProxy(context, signal) {
  const child = spawn("flyctl", buildFlyProxyArgs(context), {
    cwd: repositoryRoot,
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const abort = () => child.kill("SIGTERM");
  child.on("error", abort);
  signal?.addEventListener("abort", abort, { once: true });
  let port;
  try {
    port = await waitForFlyProxyStartup({
      child,
      expectedPrivateIp: context.machine.private_ip,
      signal,
    });
  } catch {
    await stopChild(child);
    fail();
  }
  return Object.freeze({
    port,
    stop: async () => {
      signal?.removeEventListener("abort", abort);
      child.removeListener("error", abort);
      await stopChild(child);
    },
  });
}

function loadMysqlPromiseClient() {
  const requireFromImageGen = createRequire(
    path.join(repositoryRoot, "apps/image-gen/package.json"),
  );
  return requireFromImageGen("mysql2/promise");
}

async function verifyProvisionerConnection({
  databaseName,
  mysql,
  signal,
  url,
  username,
}) {
  throwIfAborted(signal);
  const connection = await mysql.createConnection(url);
  try {
    const [identityRows] = await connection.query({
      sql: "SELECT CURRENT_USER() AS currentUser,DATABASE() AS databaseName",
      timeout: 10_000,
    });
    if (
      identityRows.length !== 1 ||
      identityRows[0]?.currentUser !== `${username}@%` ||
      identityRows[0]?.databaseName !== databaseName
    ) {
      fail();
    }
    const [grantRows] = await connection.query({
      sql: "SHOW GRANTS FOR CURRENT_USER()",
      timeout: 10_000,
    });
    const grants = grantRows.flatMap((row) => Object.values(row)).map(String);
    assertProvisionerGrants(grants, databaseName);
  } finally {
    await Promise.race([
      connection.end(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("database close failed")), 5_000),
      ),
    ]);
  }
}

async function setSecret(storedProvisionerUrl, signal) {
  await runCommand("gh", githubSecretSetArgs(REPOSITORY, ENVIRONMENT), {
    input: storedProvisionerUrl,
    signal,
  });
}

function waitBounded(milliseconds, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    const abort = () => finish(new Error("wait aborted"));
    function finish(error) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function reconcileSecretAbsence({
  deleteSecret,
  listSecretNames,
  now = Date.now,
  signal,
  stabilizationWindowMs = SECRET_STABILIZATION_WINDOW_MS,
  timeoutMs = SECRET_RECONCILIATION_TIMEOUT_MS,
  wait = waitBounded,
}) {
  if (
    typeof deleteSecret !== "function" ||
    typeof listSecretNames !== "function" ||
    typeof now !== "function" ||
    typeof wait !== "function" ||
    !Number.isInteger(stabilizationWindowMs) ||
    stabilizationWindowMs < 1 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < stabilizationWindowMs
  ) {
    fail();
  }
  const startedAt = now();
  let absentSince;
  while (now() - startedAt <= timeoutMs) {
    throwIfAborted(signal);
    const names = await listSecretNames(signal);
    if (
      !Array.isArray(names) ||
      names.some((name) => typeof name !== "string")
    ) {
      fail();
    }
    const count = names.filter(
      (name) => name === CREDIT_PROVISIONER_SECRET_NAME,
    ).length;
    if (count > 1) fail();
    if (count === 1) {
      absentSince = undefined;
      await deleteSecret(signal);
    } else {
      absentSince ??= now();
      if (now() - absentSince >= stabilizationWindowMs) return;
    }
    await wait(1_000, signal);
  }
  fail();
}

async function deleteSecretIfPresent(signal) {
  await reconcileSecretAbsence({
    deleteSecret: async (cleanupSignal) => {
      await runCommand(
        "gh",
        [
          "secret",
          "delete",
          CREDIT_PROVISIONER_SECRET_NAME,
          "--repo",
          REPOSITORY,
          "--env",
          ENVIRONMENT,
        ],
        {
          acceptedExitCodes: [0, 1],
          signal: cleanupSignal,
          timeoutMs: 60_000,
        },
      );
    },
    listSecretNames: secretNames,
    signal,
  });
  await assertSecretPresence(false, signal);
}

function createProductionDependencies() {
  const mysql = loadMysqlPromiseClient();
  return Object.freeze({
    assertExactRepository: verifyExactRepositoryState,
    assertSecretPresence,
    createCleanupSignal: () => AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
    deleteSecretIfPresent,
    inspectProductionContext,
    openRootSession: async (context, signal) => {
      const session = new RootMysqlSession({
        app: context.recovery.app,
        machineId: context.machine.id,
        signal,
      });
      try {
        await session.initialize(signal);
        return session;
      } catch {
        try {
          await session.close({ releaseLock: false, signal });
        } catch {
          // The bounded close already attempted TERM and KILL before rejecting.
        }
        fail();
      }
    },
    randomHex: (bytes) => randomBytes(bytes).toString("hex"),
    setSecret,
    startProxy,
    verifyProvisionerConnection: (input) =>
      verifyProvisionerConnection({ ...input, mysql }),
  });
}

async function cleanupFailedBootstrap({
  account,
  accountMayExist,
  context,
  deps,
  rootSession,
  secretMayExist,
}) {
  let cleanupComplete = true;
  const databaseSignal = deps.createCleanupSignal();
  let cleanupRoot = rootSession;
  try {
    if (cleanupRoot && !cleanupRoot.closed) {
      try {
        await cleanupRoot.assertLockHeld(databaseSignal);
      } catch {
        try {
          await cleanupRoot.close({
            releaseLock: false,
            signal: databaseSignal,
          });
        } catch {
          // Absence proofs below still decide whether cleanup is complete.
        }
        cleanupRoot = undefined;
      }
    }
    if (!cleanupRoot) {
      cleanupRoot = await deps.openRootSession(context, databaseSignal);
      await cleanupRoot.acquireLock(databaseSignal);
    }
    if (accountMayExist) {
      const managed = await cleanupRoot.listManagedAccounts(databaseSignal);
      for (const existing of managed) {
        await cleanupRoot.disableAndDrop(existing, databaseSignal);
      }
      if (
        account &&
        (await cleanupRoot.accountExists(account, databaseSignal))
      ) {
        fail();
      }
    }
    if ((await cleanupRoot.listManagedAccounts(databaseSignal)).length !== 0) {
      fail();
    }
  } catch {
    cleanupComplete = false;
  }
  try {
    await cleanupRoot?.close({ releaseLock: true, signal: databaseSignal });
  } catch {
    cleanupComplete = false;
  }
  const secretSignal = deps.createCleanupSignal();
  try {
    if (secretMayExist) await deps.deleteSecretIfPresent(secretSignal);
    await deps.assertSecretPresence(false, secretSignal);
  } catch {
    cleanupComplete = false;
  }
  return cleanupComplete;
}

export async function bootstrapCreditProvisioner(
  { expectedHead, signal, snapshotId },
  deps = createProductionDependencies(),
) {
  let account;
  let accountMayExist = false;
  let context;
  let proxy;
  let rootSession;
  let secretMayExist = false;
  let secretSetSettled = false;
  let succeeded = false;
  let marker = CREDIT_PROVISIONER_FAILURE_MARKER;
  try {
    context = await deps.inspectProductionContext({
      expectedHead,
      signal,
      snapshotId,
    });
    rootSession = await deps.openRootSession(context, signal);
    await rootSession.acquireLock(signal);
    await rootSession.assertNoUnexpectedCreateUserPrincipal(signal);
    const orphans = await rootSession.listManagedAccounts(signal);
    if (orphans.length) accountMayExist = true;
    for (const orphan of orphans) {
      await rootSession.disableAndDrop(orphan, signal);
    }
    if ((await rootSession.listManagedAccounts(signal)).length !== 0) fail();

    account = Object.freeze({
      hostname: "%",
      username: `lbcp_${deps.randomHex(8)}`,
    });
    const password = `Aa1!${deps.randomHex(48)}`;
    const sql = buildProvisionerSql({
      databaseName: context.recovery.databaseName,
      password,
      username: account.username,
    });
    accountMayExist = true;
    await rootSession.execute(sql.createStatement, { signal });
    for (const statement of sql.grantStatements) {
      await rootSession.execute(statement, { signal });
    }
    const grants = await rootSession.showGrants(account, signal);
    assertProvisionerGrants(grants, context.recovery.databaseName);
    const managedAfterCreate = await rootSession.listManagedAccounts(signal);
    if (
      managedAfterCreate.length !== 1 ||
      managedAfterCreate[0].username !== account.username
    ) {
      fail();
    }

    proxy = await deps.startProxy(context, signal);
    const verificationUrl = buildProvisionerUrl({
      databaseName: context.recovery.databaseName,
      password,
      port: proxy.port,
      username: account.username,
    });
    const storedProvisionerUrl = buildProvisionerUrl({
      databaseName: context.recovery.databaseName,
      password,
      username: account.username,
    });
    await deps.verifyProvisionerConnection({
      databaseName: context.recovery.databaseName,
      signal,
      url: verificationUrl,
      username: account.username,
    });

    const rechecked = await deps.inspectProductionContext({
      expectedHead,
      signal,
      snapshotId,
    });
    if (!sameContext(context, rechecked)) fail();
    await rootSession.assertLockHeld(signal);
    assertProvisionerGrants(
      await rootSession.showGrants(account, signal),
      context.recovery.databaseName,
    );
    await deps.verifyProvisionerConnection({
      databaseName: context.recovery.databaseName,
      signal,
      url: verificationUrl,
      username: account.username,
    });
    await deps.assertExactRepository(expectedHead, signal);

    secretMayExist = true;
    await deps.setSecret(storedProvisionerUrl, signal);
    secretSetSettled = true;
    await deps.assertSecretPresence(true, signal);
    await deps.assertExactRepository(expectedHead, signal);
    await rootSession.assertLockHeld(signal);
    assertProvisionerGrants(
      await rootSession.showGrants(account, signal),
      context.recovery.databaseName,
    );
    await deps.verifyProvisionerConnection({
      databaseName: context.recovery.databaseName,
      signal,
      url: verificationUrl,
      username: account.username,
    });
    succeeded = true;
    marker = CREDIT_PROVISIONER_SUCCESS_MARKER;
  } catch {
    succeeded = false;
  } finally {
    try {
      await proxy?.stop();
    } catch {
      succeeded = false;
    }
    if (succeeded) {
      try {
        await rootSession?.close({ releaseLock: true, signal });
      } catch {
        succeeded = false;
      }
    }
    if (!succeeded && context) {
      let cleaned = false;
      try {
        cleaned = await cleanupFailedBootstrap({
          account,
          accountMayExist,
          context,
          deps,
          rootSession,
          secretMayExist,
        });
      } catch {
        cleaned = false;
      }
      const secretPublicationAmbiguous = secretMayExist && !secretSetSettled;
      if (!cleaned || secretPublicationAmbiguous) {
        marker = CREDIT_PROVISIONER_CLEANUP_FAILURE_MARKER;
      } else {
        marker = CREDIT_PROVISIONER_FAILURE_MARKER;
      }
    }
  }
  return marker;
}

function writeMarker(marker) {
  process.stdout.write(`${marker}\n`);
}

export async function runCli(
  argv,
  { bootstrap = bootstrapCreditProvisioner, output = writeMarker } = {},
) {
  let marker = CREDIT_PROVISIONER_FAILURE_MARKER;
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    const input = parseCliArguments(argv);
    const result = await bootstrap({
      ...input,
      signal: controller.signal,
    });
    marker = normalizeBootstrapMarker(result);
  } catch {
    marker = CREDIT_PROVISIONER_FAILURE_MARKER;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
  output(marker);
  return marker;
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const marker = await runCli(process.argv.slice(2));
  process.exitCode = marker === CREDIT_PROVISIONER_SUCCESS_MARKER ? 0 : 1;
}
