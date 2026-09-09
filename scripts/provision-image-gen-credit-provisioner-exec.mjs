import { parseManagedProvisionerAccounts } from "./image-gen-credit-provisioner-bootstrap-contract.mjs";
import { MANAGED_ACCOUNT_INVENTORY_QUERY } from "./provision-image-gen-credit-provisioner.mjs";

// The prepare batch and read-only definer inventory use Machines Exec under
// a command-restricted credential. Mutating definer bootstrap remains a
// separate operator-only operation. Each request uses the fixed-command
// argument shape the cleanup path already proved on an isolated Machine.
//
// The wrapper's `$0` is deliberately different from the cleanup wrapper, so a
// credential scoped to one command prefix can never run the other.
const DATABASE_APP = "leaderbot-portal-mysql";
const API_ORIGIN = "https://api.machines.dev";
// Leave time for all three controller waits, four potentially blocking DCL
// statements (grant and compensation), and a response margin. Keep these
// budgets shared with the batch/controller so they cannot drift independently.
export const PREPARE_HANDSHAKE_SECONDS = 8;
export const PREPARE_SQL_LOCK_WAIT_SECONDS = 5;
export const PREPARE_EXEC_SECONDS = 55;
export const PREPARE_DEADLINE_MS = 65_000;
const MAX_SQL_BYTES = 16_384;
const MAX_RESPONSE_BYTES = 65_536;

function fail() {
  throw new Error("credit provisioner exec rejected");
}

function assertTarget(app, machineId) {
  if (
    app !== DATABASE_APP ||
    typeof machineId !== "string" ||
    !/^[a-f0-9]{14}$/.test(machineId)
  )
    fail();
}

// `test "$#" -eq 1 || exit 64` runs on the Machine inside the pinned prefix, so
// a credential holder cannot append a second argument. SQL is never shell source.
const PREPARE_ROOT_SHELL_SOURCE =
  'test "$#" -eq 1 || exit 64; exec env MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql --protocol=socket --batch --raw --skip-column-names --silent --unbuffered -uroot leaderbot --execute="$1"';
export const PREPARE_ROOT_EXEC_COMMAND = `/bin/sh -lc '${PREPARE_ROOT_SHELL_SOURCE}' leaderbot-prepare-root`;
export const PREPARE_ROOT_EXEC_COMMAND_FLYCTL_CSV = `"${PREPARE_ROOT_EXEC_COMMAND.replaceAll('"', '""')}"`;

// One short-lived repair credential, two complete fixed wrappers.
//
// The schema-transition workflow runs `--operation prepare` and
// `--operation revoke-super` under a single secret. The pinned flyctl accepts
// repeated `--command-prefix` values, so that one credential can carry both
// full wrappers without a shorter shell prefix and without a second secret.
// Each prefix is the entire `/bin/sh -lc <source> <argv0>` head, so a token
// minted this way still cannot run any other shell source.
export const RESTRICTED_EXEC_SECRET = "FLY_DATABASE_REPAIR_EXEC_TOKEN";
export const RESTRICTED_EXEC_OPERATIONS = Object.freeze({
  prepare: Object.freeze({
    operation: "prepare",
    wrapperArgv0: "leaderbot-prepare-root",
  }),
  revokeSuper: Object.freeze({
    operation: "revoke-super",
    wrapperArgv0: "leaderbot-super-cleanup",
  }),
});

export function buildPrepareRootExecArgv(sql) {
  if (
    typeof sql !== "string" ||
    !sql.trim() ||
    sql.includes("\0") ||
    Buffer.byteLength(sql) > MAX_SQL_BYTES
  )
    fail();
  return Object.freeze([
    "/bin/sh",
    "-lc",
    PREPARE_ROOT_SHELL_SOURCE,
    "leaderbot-prepare-root",
    sql,
  ]);
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

export function parsePrepareRootExecResponse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  // An own numeric zero exit code is always required. A present signal field
  // must be zero; `exit 64` from the wrapper can never read as success.
  if (
    !Object.hasOwn(value, "exit_code") ||
    value.exit_code !== 0 ||
    (Object.hasOwn(value, "exit_signal") && value.exit_signal !== 0) ||
    value.stderr !== "" ||
    typeof value.stdout !== "string"
  )
    fail();
  return value.stdout;
}

export async function requestPrepareRootExec(
  { app, machineId, sql, signal },
  { fetchImpl = globalThis.fetch, token = process.env.FLY_API_TOKEN } = {},
) {
  assertTarget(app, machineId);
  const command = buildPrepareRootExecArgv(sql);
  if (
    !(signal instanceof AbortSignal) ||
    signal.aborted ||
    typeof token !== "string" ||
    !token.trim() ||
    typeof fetchImpl !== "function"
  )
    fail();
  const combined = AbortSignal.any([
    signal,
    AbortSignal.timeout(PREPARE_DEADLINE_MS),
  ]);
  const url = `${API_ORIGIN}/v1/apps/${DATABASE_APP}/machines/${machineId}/exec`;
  // One request only. An ambiguous transport rejection is never retried: a
  // second attempt could repeat a statement whose first outcome is unknown.
  const response = await fetchImpl(url, {
    method: "POST",
    redirect: "error",
    signal: combined,
    headers: {
      Authorization: `Bearer ${token.trim()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ command, timeout: PREPARE_EXEC_SECONDS }),
  });
  if (
    response.status !== 200 ||
    response.redirected ||
    (response.url && response.url !== url)
  )
    fail();
  return parsePrepareRootExecResponse(
    JSON.parse(await readBoundedBody(response)),
  );
}

// Read-only definer inventory needs no advisory lock. Principal prepare uses
// the separate single-connection batch/controller protocol, while mutating
// definer bootstrap is not authorized by this read-only helper.
export async function listManagedProvisionerAccountsViaExec(target, options) {
  const stdout = await requestPrepareRootExec(
    { ...target, sql: MANAGED_ACCOUNT_INVENTORY_QUERY },
    options,
  );
  return parseManagedProvisionerAccounts(
    stdout.split("\n").filter((line) => line !== ""),
  );
}
