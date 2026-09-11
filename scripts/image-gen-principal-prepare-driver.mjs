import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  CREDIT_MIGRATION_PRINCIPAL_REPAIR_LOCK,
  CREDIT_MIGRATION_PRINCIPAL_REPAIR_PRIVILEGES,
  CreditMigrationPrincipalCleanupError,
  detectMissingCreditMigrationPrivileges,
  parseCreditMigrationAccount,
} from "./image-gen-credit-migration-principal-repair-contract.mjs";
import {
  buildPrincipalPrepareExecBatch,
  principalPrepareLockNames,
  requestPrincipalPrepareExec,
} from "./image-gen-principal-prepare-exec.mjs";
import {
  PREPARE_HANDSHAKE_SECONDS as WAIT_SECONDS,
  PREPARE_DEADLINE_MS as DEADLINE_MS,
} from "./provision-image-gen-credit-provisioner-exec.mjs";

// The controller half of the single-connection prepare protocol.
//
// The root batch runs inside one Exec request and cannot be interrupted or
// inspected mid-flight. This live connection is what makes that safe: it
// decides which privileges may be granted by holding approval locks, watches
// the batch pass each stage, verifies the result, and withholds acceptance to
// force the batch to roll its own grants back.
const QUERY_TIMEOUT_MS = 2_000;
const LOCK = CREDIT_MIGRATION_PRINCIPAL_REPAIR_LOCK;
const PRIVILEGES = CREDIT_MIGRATION_PRINCIPAL_REPAIR_PRIVILEGES;

function fail() {
  throw new CreditMigrationPrincipalCleanupError();
}

export async function prepareCreditMigrationPrincipalViaExec(
  {
    app,
    machineId,
    connection,
    account,
    databaseName,
    requireSuper,
    superOnly = false,
    allowIncompleteDefinerTablePrivileges = false,
    readState,
    verify,
    verifyRollback,
    signal,
    onStage = () => {},
  },
  {
    request = requestPrincipalPrepareExec,
    nonce = randomBytes(16).toString("hex"),
    pause = delay,
  } = {},
) {
  parseCreditMigrationAccount(`${account?.username}@${account?.hostname}`);
  if (
    databaseName !== "leaderbot" ||
    typeof requireSuper !== "boolean" ||
    typeof superOnly !== "boolean" ||
    typeof allowIncompleteDefinerTablePrivileges !== "boolean" ||
    (superOnly && allowIncompleteDefinerTablePrivileges) ||
    typeof connection?.query !== "function" ||
    typeof connection?.destroy !== "function" ||
    typeof readState !== "function" ||
    typeof verify !== "function" ||
    typeof verifyRollback !== "function" ||
    !(signal instanceof AbortSignal) ||
    signal.aborted
  )
    fail();
  const locks = principalPrepareLockNames(nonce);
  const operation = new AbortController();
  const combined = AbortSignal.any([
    signal,
    operation.signal,
    AbortSignal.timeout(DEADLINE_MS),
  ]);
  const held = new Set();
  let pending;
  let terminal;
  let failed = false;
  let destroyed = false;
  let rolledBack = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    try {
      connection.destroy();
    } catch {
      /* Closure stays unproven; the caller never reuses this connection. */
    }
  };
  const active = () => {
    if (combined.aborted) fail();
  };
  const bounded = async (action) => {
    active();
    let abort;
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          active();
          return action();
        }),
        new Promise((_, reject) => {
          abort = () => {
            destroy();
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
  const query = (sql, values = []) =>
    bounded(async () => {
      const [rows] = await connection.query(
        { sql, timeout: QUERY_TIMEOUT_MS },
        values,
      );
      if (
        !Array.isArray(rows) ||
        rows.length !== 1 ||
        Object.keys(rows[0]).length !== 1
      )
        fail();
      return Number(Object.values(rows[0])[0]);
    });
  const acquire = async (name) => {
    if ((await query("SELECT GET_LOCK(?,0)", [name])) !== 1) fail();
    held.add(name);
  };
  const release = async (name) => {
    if ((await query("SELECT RELEASE_LOCK(?)", [name])) !== 1) fail();
    held.delete(name);
  };
  const owner = () => query("SELECT IS_USED_LOCK(?)", [LOCK]);
  const wait = async (name) => {
    const deadline = Date.now() + WAIT_SECONDS * 1_000;
    while (Date.now() < deadline) {
      active();
      const id = await query("SELECT IS_USED_LOCK(?)", [name]);
      if (Number.isSafeInteger(id) && id > 0) return id;
      // A batch that already finished can never reach the next stage.
      if (terminal) fail();
      await pause(50, undefined, { signal: combined });
    }
    fail();
  };
  try {
    const controllerId = await query("SELECT CONNECTION_ID()");
    if (!Number.isSafeInteger(controllerId) || controllerId <= 0) fail();
    for (const key of ["preWait", "decisionWait", "finishWait"])
      await acquire(locks[key]);
    const sql = buildPrincipalPrepareExecBatch({
      account,
      databaseName,
      controllerId,
      nonce,
      requireSuper,
      superOnly,
    });
    onStage("root_exec_request");
    pending = Promise.resolve()
      .then(() => {
        active();
        return request({ app, machineId, sql, nonce, signal: combined });
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
    const rootId = await wait(locks.ready);
    // The batch must be a different connection that actually holds the lock.
    if (rootId === controllerId || (await owner()) !== rootId) fail();
    onStage("principal_repair");
    const state = await bounded(readState);
    if (
      state?.account?.username !== account.username ||
      state?.account?.hostname !== account.hostname ||
      state?.databaseName !== databaseName ||
      state?.requireSuper !== requireSuper
    )
      fail();
    const missing = detectMissingCreditMigrationPrivileges({
      ...state,
      allowIncompleteDefinerTablePrivileges,
    });
    if (superOnly && missing.some((privilege) => privilege !== "SUPER")) fail();
    if ((await owner()) !== rootId) fail();
    // Approve exactly the missing privileges, one lock each, then let the
    // batch proceed. It can grant nothing that is not approved here.
    for (const privilege of missing)
      await acquire(locks[`delta${PRIVILEGES.indexOf(privilege)}`]);
    await acquire(locks.preApprove);
    await release(locks.preWait);
    if ((await wait(locks.applied)) !== rootId || (await owner()) !== rootId)
      fail();
    let verificationFailed = false;
    try {
      await bounded(verify);
    } catch {
      active();
      verificationFailed = true;
    }
    if ((await owner()) !== rootId) fail();
    if (!verificationFailed) await acquire(locks.accept);
    await release(locks.decisionWait);
    if ((await wait(locks.settled)) !== rootId || (await owner()) !== rootId)
      fail();
    if (verificationFailed) await bounded(() => verifyRollback(missing));
    if ((await owner()) !== rootId) fail();
    await acquire(locks.finishApprove);
    await release(locks.finishWait);
    onStage("root_exec_response");
    const completed = await bounded(() => pending);
    if (completed.failed) fail();
    active();
    if (verificationFailed) {
      if (completed.result !== "rolled_back") fail();
      rolledBack = true;
      throw new Error("credit migration principal repair rejected");
    }
    if (completed.result !== (missing.length ? "repaired" : "already_ready"))
      fail();
    return completed.result;
  } catch {
    failed = true;
    // A rolled-back run is a proven rejection, not an unknown outcome.
    if (rolledBack)
      throw new Error("credit migration principal repair rejected");
    // A dead session cannot prove which actor added a right, so a second
    // mutating request is never opened.
    fail();
  } finally {
    try {
      if (failed) destroy();
      else for (const name of [...held]) await release(name);
    } catch {
      destroy();
      fail();
    } finally {
      operation.abort();
      if (pending) void pending.catch(() => undefined);
    }
  }
}
