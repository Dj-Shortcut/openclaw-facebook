import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  buildCreditMigrationPrivilegeStatement,
  CREDIT_MIGRATION_PRINCIPAL_REPAIR_LOCK,
  CREDIT_MIGRATION_PRINCIPAL_REPAIR_PRIVILEGES,
  CreditMigrationPrincipalCleanupError,
  detectMissingCreditMigrationPrivileges,
  parseCreditMigrationAccount,
} from "./image-gen-credit-migration-principal-repair-contract.mjs";
import { requestPrepareRootExec } from "./provision-image-gen-credit-provisioner-exec.mjs";

// Mutating prepare over a restricted machine-exec credential.
//
// `RootMysqlSession` holds one SSH connection open across many statements, so
// the repair lock survives between them. One Exec request is one connection,
// so the whole grant/verify/rollback protocol has to live in a single batch:
// the root connection takes the lock, applies only what the controller
// approved, and releases the lock, without ever reconnecting.
//
// A second live connection acts as the controller. It approves each privilege
// by holding a lock the batch reads, so the batch can never grant a right the
// controller did not ask for, and it can withhold acceptance to force the
// batch to roll its own grants back.
const WAIT_SECONDS = 12;
const DEADLINE_MS = 60_000;
const LOCK = CREDIT_MIGRATION_PRINCIPAL_REPAIR_LOCK;
const PRIVILEGES = CREDIT_MIGRATION_PRINCIPAL_REPAIR_PRIVILEGES;
const SCHEMA_COUNT = 4;
const SCHEMA_MASK = (1 << SCHEMA_COUNT) - 1;
const SUPER_BIT = 1 << SCHEMA_COUNT;
const COLUMNS = Object.freeze([
  "Create_priv",
  "Trigger_priv",
  "Create_routine_priv",
  "Alter_routine_priv",
]);

function fail() {
  throw new CreditMigrationPrincipalCleanupError();
}

function assertNonce(nonce) {
  if (typeof nonce !== "string" || !/^[a-f0-9]{32}$/.test(nonce)) fail();
}

function quote(value) {
  if (typeof value !== "string" || /[\\'\0\r\n]/.test(value)) fail();
  return `'${value}'`;
}

function quoteStatement(value) {
  if (typeof value !== "string" || /[\\\0\r\n]/.test(value)) fail();
  return `'${value.replaceAll("'", "''")}'`;
}

export function principalPrepareLockNames(nonce) {
  assertNonce(nonce);
  return Object.freeze(
    Object.fromEntries(
      [
        "ready",
        "preWait",
        "preApprove",
        "applied",
        "decisionWait",
        "accept",
        "settled",
        "finishWait",
        "finishApprove",
        ...PRIVILEGES.map((_, index) => `delta${index}`),
      ].map((name) => [name, `lbpp_${nonce}_${name}`]),
    ),
  );
}

function marker(nonce, result) {
  return `__lb_principal_prepare_${nonce}:${result}`;
}

// One case per approved combination. The mask decides which case runs, so no
// privilege name is ever concatenated from a runtime value.
function schemaStatementCases(account, databaseName, operation, expression) {
  const cases = [];
  for (let mask = 1; mask <= SCHEMA_MASK; mask += 1) {
    const privileges = PRIVILEGES.slice(0, SCHEMA_COUNT).filter(
      (_, index) => mask & (1 << index),
    );
    cases.push(
      `WHEN ${mask} THEN ${quoteStatement(
        buildCreditMigrationPrivilegeStatement({
          account,
          databaseName,
          operation,
          privileges,
        }),
      )}`,
    );
  }
  return `CASE (${expression} & ${SCHEMA_MASK}) ${cases.join(" ")} ELSE 'DO 0' END`;
}

export function buildPrincipalPrepareExecBatch({
  account,
  databaseName,
  controllerId,
  nonce,
  requireSuper,
  superOnly,
}) {
  const parsed = parseCreditMigrationAccount(
    `${account?.username}@${account?.hostname}`,
  );
  if (
    databaseName !== "leaderbot" ||
    !Number.isSafeInteger(controllerId) ||
    controllerId <= 0 ||
    typeof requireSuper !== "boolean" ||
    typeof superOnly !== "boolean"
  )
    fail();
  const locks = principalPrepareLockNames(nonce);
  const predicate = `User=${quote(parsed.username)} AND Host=${quote(parsed.hostname)}`;
  // Every decision is re-checked against the same live connection that took
  // the lock. A reconnect can never satisfy CONNECTION_ID()=@root_id.
  const owns = `CONNECTION_ID()=@root_id AND IS_USED_LOCK(${quote(LOCK)})=@root_id`;
  const accountExists = `(SELECT COUNT(*) FROM mysql.user WHERE ${predicate})=1`;
  const currentMask = `(${COLUMNS.map(
    (column, index) =>
      `COALESCE((SELECT IF(${column}='Y',${1 << index},0) FROM mysql.db WHERE ${predicate} AND Db=${quote(databaseName)}),0)`,
  )
    .concat(
      `COALESCE((SELECT IF(Super_priv='Y',${SUPER_BIT},0) FROM mysql.user WHERE ${predicate}),0)`,
    )
    .join("+")})`;
  const grantSuper = quoteStatement(
    buildCreditMigrationPrivilegeStatement({
      account: parsed,
      databaseName,
      operation: "grant",
      privileges: ["SUPER"],
    }),
  );
  const revokeSuper = quoteStatement(
    buildCreditMigrationPrivilegeStatement({
      account: parsed,
      databaseName,
      operation: "revoke",
      privileges: ["SUPER"],
    }),
  );
  const approved = (name) =>
    `IS_USED_LOCK(${quote(locks[name])})=${controllerId}`;
  const statements = [
    "SET @root_id=CONNECTION_ID(), @allowed=0, @accepted=0, @passed=0, @delta=0, @before_mask=0, @added=0",
    "SET SESSION lock_wait_timeout=5",
    `SET @main=GET_LOCK(${quote(LOCK)},0)`,
    `SET @ready=IF(@main=1,GET_LOCK(${quote(locks.ready)},0),0)`,
    `SET @pre_wait=IF(@ready=1,GET_LOCK(${quote(locks.preWait)},${WAIT_SECONDS}),0)`,
    // The delta is read from the controller's approval locks, never from a
    // value this batch could have chosen for itself.
    `SET @delta=${PRIVILEGES.map((_, index) => `IF(COALESCE(${approved(`delta${index}`)},0),${1 << index},0)`).join("+")}`,
    `SET @before_mask=${currentMask}`,
    `SET @allowed=COALESCE(@main=1 AND @ready=1 AND @pre_wait=1 AND ${owns} AND DATABASE()=${quote(databaseName)} AND ${accountExists} AND ${approved("preApprove")} AND (@delta & @before_mask)=0 AND ${superOnly ? `(@delta & ${SCHEMA_MASK})=0` : "1=1"} AND ${requireSuper ? "1=1" : `(@delta & ${SUPER_BIT})=0`},0)`,
    `SET @statement=IF(@allowed=1,${schemaStatementCases(parsed, databaseName, "grant", "@delta")},'DO 0')`,
    "PREPARE prepare_statement FROM @statement",
    "EXECUTE prepare_statement",
    "DEALLOCATE PREPARE prepare_statement",
    `SET @statement=IF(@allowed=1 AND (@delta & ${SUPER_BIT})=${SUPER_BIT},${grantSuper},'DO 0')`,
    "PREPARE prepare_statement FROM @statement",
    "EXECUTE prepare_statement",
    "DEALLOCATE PREPARE prepare_statement",
    `SET @applied=IF(@allowed=1 AND ${owns},GET_LOCK(${quote(locks.applied)},0),0)`,
    `SET @decision_wait=IF(@applied=1,GET_LOCK(${quote(locks.decisionWait)},${WAIT_SECONDS}),0)`,
    `SET @accepted=COALESCE(@allowed=1 AND @applied=1 AND @decision_wait=1 AND ${owns} AND ${accountExists} AND ${approved("accept")} AND ${currentMask}=(@before_mask | @delta),0)`,
    // Compensation is valid only while the original root still owns its
    // uninterrupted lock, and only for rights this batch actually added.
    `SET @added=IF(@allowed=1 AND @accepted=0 AND ${owns} AND ${accountExists},@delta & ${currentMask},0)`,
    `SET @statement=IF((@added & ${SUPER_BIT})=${SUPER_BIT},${revokeSuper},'DO 0')`,
    "PREPARE prepare_statement FROM @statement",
    "EXECUTE prepare_statement",
    "DEALLOCATE PREPARE prepare_statement",
    `SET @statement=${schemaStatementCases(parsed, databaseName, "revoke", "@added")}`,
    "PREPARE prepare_statement FROM @statement",
    "EXECUTE prepare_statement",
    "DEALLOCATE PREPARE prepare_statement",
    `SET @settled=IF(@allowed=1 AND ${owns},GET_LOCK(${quote(locks.settled)},0),0)`,
    `SET @finish_wait=IF(@settled=1,GET_LOCK(${quote(locks.finishWait)},${WAIT_SECONDS}),0)`,
    `SET @passed=COALESCE(@allowed=1 AND @settled=1 AND @finish_wait=1 AND ${owns} AND DATABASE()=${quote(databaseName)} AND ${accountExists} AND ${approved("finishApprove")} AND ${currentMask}=IF(@accepted=1,@before_mask | @delta,@before_mask),0)`,
  ];
  for (const [key, variable] of [
    ["preWait", "pre_wait"],
    ["decisionWait", "decision_wait"],
    ["finishWait", "finish_wait"],
    ["ready", "ready"],
    ["applied", "applied"],
    ["settled", "settled"],
  ]) {
    statements.push(
      `SET @released_${variable}=IF(@${variable}=1,RELEASE_LOCK(${quote(locks[key])}),1)`,
    );
  }
  statements.push(
    `SET @released_main=IF(@main=1,RELEASE_LOCK(${quote(LOCK)}),0)`,
  );
  // A single result line. Anything short of full success, including a lock
  // this batch could not release, reports incomplete rather than a result.
  statements.push(
    `SELECT IF(COALESCE(@passed=1 AND @released_main=1 AND @released_pre_wait=1 AND @released_decision_wait=1 AND @released_finish_wait=1 AND @released_ready=1 AND @released_applied=1 AND @released_settled=1,0),IF(@accepted=0,${quoteStatement(marker(nonce, "rolled_back"))},IF(@delta=0,${quoteStatement(marker(nonce, "already_ready"))},${quoteStatement(marker(nonce, "repaired"))})),'prepare_incomplete')`,
  );
  return `${statements.join(";\n")};\n`;
}

export function parsePrincipalPrepareExecStdout(stdout, nonce) {
  assertNonce(nonce);
  if (typeof stdout !== "string") fail();
  for (const result of ["repaired", "already_ready", "rolled_back"]) {
    if (stdout === `${marker(nonce, result)}\n`) return result;
  }
  fail();
}

export async function requestPrincipalPrepareExec(
  { app, machineId, sql, nonce, signal },
  options = {},
) {
  assertNonce(nonce);
  if (!(signal instanceof AbortSignal) || signal.aborted) fail();
  let stdout;
  try {
    // One request. An unavailable response is never evidence that the GRANT
    // did not happen, so this is never replayed.
    stdout = await requestPrepareRootExec(
      { app, machineId, sql, signal },
      options,
    );
  } catch {
    fail();
  }
  return parsePrincipalPrepareExecStdout(stdout, nonce);
}
