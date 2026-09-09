import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  CREDIT_MIGRATION_PRINCIPAL_REPAIR_LOCK,
  CreditMigrationPrincipalCleanupError,
  assertCreditMigrationSuperCleanupBoundary,
  buildCreditMigrationPrivilegeStatement,
  parseCreditMigrationAccount,
} from "./image-gen-credit-migration-principal-repair-contract.mjs";

const DATABASE_APP = "leaderbot-portal-mysql";
const API_ORIGIN = "https://api.machines.dev";
const HANDSHAKE_SECONDS = 12;
const EXEC_SECONDS = 40;
const DEADLINE_MS = 45_000;
const MAX_STDIN_BYTES = 16_384;
const MAX_RESPONSE_BYTES = 4_096;
const LOCK = CREDIT_MIGRATION_PRINCIPAL_REPAIR_LOCK;

function fail() {
  throw new CreditMigrationPrincipalCleanupError();
}

function assertTarget(app, machineId) {
  if (
    app !== DATABASE_APP ||
    typeof machineId !== "string" ||
    !/^[a-f0-9]{14}$/.test(machineId)
  )
    fail();
}

function assertNonce(nonce) {
  if (typeof nonce !== "string" || !/^[a-f0-9]{32}$/.test(nonce)) fail();
}

function quote(value) {
  if (typeof value !== "string" || /[\\\u0000\r\n]/.test(value)) fail();
  return `'${value.replaceAll("'", "''")}'`;
}

export function superCleanupLockNames(nonce) {
  assertNonce(nonce);
  return Object.freeze(
    Object.fromEntries(
      ["ready", "preWait", "preApprove", "done", "postWait", "postApprove"].map(
        (name) => [name, `lbsc_${nonce}_${name}`],
      ),
    ),
  );
}

function resultMarker(nonce, result) {
  return `__lb_super_cleanup_${nonce}:${result}\n`;
}

export function buildSuperCleanupExecBatch({
  account,
  databaseName,
  controllerId,
  nonce,
}) {
  const parsed = parseCreditMigrationAccount(
    `${account?.username}@${account?.hostname}`,
  );
  if (
    databaseName !== "leaderbot" ||
    !Number.isSafeInteger(controllerId) ||
    controllerId <= 0
  )
    fail();
  const locks = superCleanupLockNames(nonce);
  const user = quote(parsed.username);
  const host = quote(parsed.hostname);
  const ownsLock = `IS_USED_LOCK(${quote(LOCK)})=@root_id AND CONNECTION_ID()=@root_id`;
  const accountExists = `(SELECT COUNT(*) FROM mysql.user WHERE User=${user} AND Host=${host})=1`;
  const superCount = `(SELECT COUNT(*) FROM mysql.user WHERE User=${user} AND Host=${host} AND Super_priv='Y')`;
  const aggregate =
    "(SELECT COUNT(*) FROM mysql.user WHERE Super_priv='Y' AND User NOT IN ('root','mysql.infoschema','mysql.session','mysql.sys'))";
  const revoke = buildCreditMigrationPrivilegeStatement({
    account: parsed,
    databaseName,
    operation: "revoke",
    privileges: ["SUPER"],
  });
  // All decisions begin false. A released wait lock is NOT approval: a separate
  // approval lock must still belong to the exact live verifier connection.
  // Approval authorizes this operation; a later disconnect cannot cancel an
  // already accepted REVOKE. Missing post-approval can never produce success.
  const statements = [
    "SET @root_id=CONNECTION_ID(), @allowed=0, @passed=0, @did_mutation=0",
    "SET SESSION lock_wait_timeout=5",
    `SET @main=GET_LOCK(${quote(LOCK)},0)`,
    `SET @ready=IF(@main=1,GET_LOCK(${quote(locks.ready)},0),0)`,
    `SET @pre_wait=IF(@ready=1,GET_LOCK(${quote(locks.preWait)},${HANDSHAKE_SECONDS}),0)`,
    `SET @allowed=COALESCE(@main=1 AND @ready=1 AND @pre_wait=1 AND ${ownsLock} AND DATABASE()='leaderbot' AND ${accountExists} AND IS_USED_LOCK(${quote(locks.preApprove)})=${controllerId},0)`,
    `SET @had_super=${superCount}`,
    `SET @statement=IF(@allowed=1 AND @had_super=1,${quote(revoke)},'DO 0')`,
    "PREPARE cleanup_statement FROM @statement",
    "EXECUTE cleanup_statement",
    "DEALLOCATE PREPARE cleanup_statement",
    "SET @did_mutation=IF(@allowed=1 AND @had_super=1,1,0)",
    `SET @done=IF(@allowed=1,GET_LOCK(${quote(locks.done)},0),0)`,
    `SET @post_wait=IF(@done=1,GET_LOCK(${quote(locks.postWait)},${HANDSHAKE_SECONDS}),0)`,
    `SET @passed=COALESCE(@allowed=1 AND @done=1 AND @post_wait=1 AND ${ownsLock} AND DATABASE()='leaderbot' AND ${accountExists} AND ${superCount}=0 AND ${aggregate}=0 AND IS_USED_LOCK(${quote(locks.preApprove)})=${controllerId} AND IS_USED_LOCK(${quote(locks.postApprove)})=${controllerId},0)`,
    `SET @released_pre=IF(@pre_wait=1,RELEASE_LOCK(${quote(locks.preWait)}),0)`,
    `SET @released_post=IF(@post_wait=1,RELEASE_LOCK(${quote(locks.postWait)}),0)`,
    `SET @released_ready=IF(@ready=1,RELEASE_LOCK(${quote(locks.ready)}),0)`,
    `SET @released_done=IF(@done=1,RELEASE_LOCK(${quote(locks.done)}),0)`,
    `SET @released_main=IF(@main=1,RELEASE_LOCK(${quote(LOCK)}),0)`,
    `SELECT IF(COALESCE(@passed=1 AND @released_pre=1 AND @released_post=1 AND @released_ready=1 AND @released_done=1 AND @released_main=1,0),IF(@did_mutation=1,${quote(resultMarker(nonce, "revoked").trimEnd())},${quote(resultMarker(nonce, "already_revoked").trimEnd())}),'cleanup_incomplete')`,
  ];
  return `${statements.join(";\n")};\n`;
}

async function readBoundedBody(response) {
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)
  )
    fail();
  if (!response.body) fail();
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) fail();
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function parseSuperCleanupExecResponse(value, nonce) {
  assertNonce(nonce);
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  // Older Fly response models omit an unused signal field. If present it must
  // be numeric zero; an explicit own numeric exit_code is always required.
  if (
    !Object.hasOwn(value, "exit_code") ||
    value.exit_code !== 0 ||
    (Object.hasOwn(value, "exit_signal") && value.exit_signal !== 0) ||
    value.stderr !== ""
  )
    fail();
  for (const result of ["revoked", "already_revoked"]) {
    if (value.stdout === resultMarker(nonce, result)) return result;
  }
  fail();
}

// The target Machine accepts Exec command arguments but drops API stdin.
// SQL is one positional argument, never interpolated into shell source.
const CLEANUP_SHELL_SOURCE =
  'test "$#" -eq 1 || exit 64; exec env MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql --protocol=socket --batch --raw --skip-column-names --silent --unbuffered -uroot leaderbot --execute="$1"';
export const SUPER_CLEANUP_EXEC_COMMAND = `/bin/sh -lc '${CLEANUP_SHELL_SOURCE}' leaderbot-super-cleanup`;
export const SUPER_CLEANUP_EXEC_COMMAND_FLYCTL_CSV = `"${SUPER_CLEANUP_EXEC_COMMAND.replaceAll('"', '""')}"`;

export function buildSuperCleanupExecCommand(sql) {
  buildSuperCleanupExecArgv(sql);
  return `${SUPER_CLEANUP_EXEC_COMMAND} '${sql.replaceAll("'", "'\\''")}'`;
}

export function buildSuperCleanupExecArgv(sql) {
  if (
    typeof sql !== "string" ||
    !sql ||
    sql.includes("\0") ||
    Buffer.byteLength(sql) > MAX_STDIN_BYTES
  )
    fail();
  return [
    "/bin/sh",
    "-lc",
    CLEANUP_SHELL_SOURCE,
    "leaderbot-super-cleanup",
    sql,
  ];
}

export async function requestSuperCleanupExec(
  { app, machineId, stdin, nonce, signal },
  { fetchImpl = globalThis.fetch, token = process.env.FLY_API_TOKEN } = {},
) {
  assertTarget(app, machineId);
  assertNonce(nonce);
  if (
    !(signal instanceof AbortSignal) ||
    signal.aborted ||
    typeof stdin !== "string" ||
    stdin.length === 0 ||
    Buffer.byteLength(stdin) > MAX_STDIN_BYTES ||
    typeof token !== "string" ||
    !token.trim() ||
    typeof fetchImpl !== "function"
  )
    fail();
  const url = `${API_ORIGIN}/v1/apps/${DATABASE_APP}/machines/${machineId}/exec`;
  try {
    // The command-scoped token must match SUPER_CLEANUP_EXEC_COMMAND, not the
    // older stdin-based command. No fallback or second request is permitted.
    const response = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        command: buildSuperCleanupExecArgv(stdin),
        timeout: EXEC_SECONDS,
      }),
    });
    if (
      response.status !== 200 ||
      response.redirected ||
      (response.url && response.url !== url)
    )
      fail();
    return parseSuperCleanupExecResponse(
      JSON.parse(await readBoundedBody(response)),
      nonce,
    );
  } catch {
    // Never surface the request, provider response, raw stderr, or token.
    fail();
  }
}

async function scalar(connection, sql, values = []) {
  const [rows] = await connection.query({ sql, timeout: 2_000 }, values);
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    Object.keys(rows[0]).length !== 1
  )
    fail();
  return Object.values(rows[0])[0];
}

export async function revokeTemporaryCreditMigrationSuperViaExec(
  {
    app,
    machineId,
    connection,
    account,
    databaseName,
    allowIncompleteDefinerTablePrivileges = false,
    readState,
    verify,
    signal,
    onStage = () => {},
  },
  {
    request = requestSuperCleanupExec,
    nonce = randomBytes(16).toString("hex"),
    pause = delay,
  } = {},
) {
  assertTarget(app, machineId);
  parseCreditMigrationAccount(`${account?.username}@${account?.hostname}`);
  if (
    databaseName !== "leaderbot" ||
    typeof connection?.query !== "function" ||
    typeof connection?.destroy !== "function" ||
    typeof allowIncompleteDefinerTablePrivileges !== "boolean" ||
    typeof readState !== "function" ||
    typeof verify !== "function" ||
    !(signal instanceof AbortSignal) ||
    signal.aborted
  )
    fail();
  const locks = superCleanupLockNames(nonce);
  const operation = new AbortController();
  const combined = AbortSignal.any([
    signal,
    operation.signal,
    AbortSignal.timeout(DEADLINE_MS),
  ]);
  const held = new Set();
  let pending;
  let terminal;
  let verifiedBefore = false;
  let verifiedAfter = false;
  let operationError;
  let destroyed = false;
  const destroyVerifier = () => {
    if (destroyed) return;
    destroyed = true;
    try {
      connection.destroy();
    } catch {
      // Destruction is best effort after failure, never proof that the session
      // ended. A driver teardown error must not escape an abort listener or
      // leave its pending verification promise unbounded.
    }
  };
  const checkActive = () => {
    if (combined.aborted) fail();
  };
  const bounded = async (action) => {
    checkActive();
    let abort;
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          checkActive();
          return action();
        }),
        new Promise((_, reject) => {
          abort = () => {
            destroyVerifier();
            reject(new CreditMigrationPrincipalCleanupError());
          };
          combined.addEventListener("abort", abort, { once: true });
          if (combined.aborted) abort();
        }),
      ]);
    } finally {
      combined.removeEventListener("abort", abort);
    }
  };
  const query = (sql, values) => bounded(() => scalar(connection, sql, values));
  const acquire = async (name) => {
    checkActive();
    if (Number(await query("SELECT GET_LOCK(?,0)", [name])) !== 1) fail();
    held.add(name);
  };
  const release = async (name) => {
    if (Number(await query("SELECT RELEASE_LOCK(?)", [name])) !== 1) fail();
    held.delete(name);
  };
  const currentLockOwner = async () =>
    Number(await query("SELECT IS_USED_LOCK(?)", [LOCK]));
  const waitForStage = async (name) => {
    const deadline = Date.now() + HANDSHAKE_SECONDS * 1_000;
    while (Date.now() < deadline) {
      checkActive();
      const owner = Number(await query("SELECT IS_USED_LOCK(?)", [name]));
      if (Number.isSafeInteger(owner) && owner > 0) return owner;
      if (terminal) fail();
      await pause(50, undefined, { signal: combined });
    }
    fail();
  };
  try {
    const controllerId = Number(await query("SELECT CONNECTION_ID()"));
    if (!Number.isSafeInteger(controllerId) || controllerId <= 0) fail();
    await acquire(locks.preWait);
    await acquire(locks.postWait);
    const stdin = buildSuperCleanupExecBatch({
      account,
      databaseName,
      controllerId,
      nonce,
    });
    onStage("root_exec_request");
    pending = Promise.resolve()
      .then(() => {
        checkActive();
        return request({ app, machineId, stdin, nonce, signal: combined });
      })
      .then(
        (result) => {
          terminal = { result };
          return terminal;
        },
        () => {
          terminal = { failed: true };
          return terminal;
        },
      );
    onStage("root_lock");
    const rootId = await waitForStage(locks.ready);
    if (rootId === controllerId || (await currentLockOwner()) !== rootId)
      fail();
    onStage("super_cleanup");
    const current = await bounded(readState);
    if (
      current?.account?.username !== account.username ||
      current?.account?.hostname !== account.hostname ||
      current?.databaseName !== databaseName
    )
      fail();
    assertCreditMigrationSuperCleanupBoundary(
      current,
      allowIncompleteDefinerTablePrivileges,
    );
    if ((await currentLockOwner()) !== rootId) fail();
    await acquire(locks.preApprove);
    verifiedBefore = true;
    await release(locks.preWait);
    if (
      (await waitForStage(locks.done)) !== rootId ||
      (await currentLockOwner()) !== rootId
    )
      fail();
    await bounded(verify);
    checkActive();
    if ((await currentLockOwner()) !== rootId) fail();
    await acquire(locks.postApprove);
    verifiedAfter = true;
    await release(locks.postWait);
    onStage("root_exec_response");
    const completed = await bounded(() => pending);
    if (
      completed.failed ||
      !verifiedBefore ||
      !verifiedAfter ||
      !new Set(["revoked", "already_revoked"]).has(completed.result)
    )
      fail();
    checkActive();
    return completed.result;
  } catch {
    operationError = new CreditMigrationPrincipalCleanupError();
    throw operationError;
  } finally {
    // Revoke our approval before releasing waits on any failure. Cancelling the
    // HTTP request does NOT prove the remote process ended; never auto-retry.
    try {
      if (operationError) {
        // Closing the exact verifier session cancels pending reads and removes
        // every approval/wait lock. Never issue follow-up queries concurrently
        // with an unknown or timed-out verification query.
        destroyVerifier();
      } else {
        for (const name of [
          locks.preApprove,
          locks.postApprove,
          locks.preWait,
          locks.postWait,
        ]) {
          if (held.has(name)) await release(name);
        }
      }
    } catch {
      destroyVerifier();
      if (!operationError) fail();
    } finally {
      operation.abort();
    }
    // A rejection is always consumed, including a late transport failure.
    if (pending) void pending.catch(() => undefined);
  }
}
