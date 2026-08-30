#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  CREDIT_PROVISIONER_LOCK_NAME,
  parseManagedProvisionerAccounts,
  quoteManagedAccount,
} from "./image-gen-credit-provisioner-bootstrap-contract.mjs";
import { RootMysqlSession } from "./provision-image-gen-credit-provisioner.mjs";

const REPOSITORY = "Dj-Shortcut/openclaw-facebook";
const DATABASE_APP = "leaderbot-portal-mysql";
const DATABASE_NAME = "leaderbot";
const SCHEMA_PHASE = "0018_credit_checkout_reservation";
const CONTRACT_VERSION = 1;
const CONTRACT_DOMAIN = "leaderbot-credit-provisioner-retirement-v1";
const ATTRIBUTE_KEY = "leaderbot_credit_provisioner_retirement_v1";
const MAX_MANAGED_ACCOUNTS = 16;
const MIN_DROP_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_DROP_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_ATTRIBUTE_BYTES = 16 * 1_024;
const EVIDENCE_FILE_NAME = "evidence.json";

export const CREDIT_PROVISIONER_RETIREMENT_LOCKED_MARKER =
  "credit_provisioners_locked";
export const CREDIT_PROVISIONER_RETIREMENT_UNLOCKED_MARKER =
  "credit_provisioners_unlocked";
export const CREDIT_PROVISIONER_RETIREMENT_DROPPED_MARKER =
  "credit_provisioners_dropped";
export const CREDIT_PROVISIONER_RETIREMENT_FAILURE_MARKER =
  "credit_provisioner_retirement_failed";
export const CREDIT_PROVISIONER_RETIREMENT_ATTRIBUTE_KEY = ATTRIBUTE_KEY;
export const CREDIT_PROVISIONER_RETIREMENT_MAX_ACCOUNTS = MAX_MANAGED_ACCOUNTS;
export const CREDIT_PROVISIONER_RETIREMENT_LOCK_NAME =
  CREDIT_PROVISIONER_LOCK_NAME;
export const CREDIT_PROVISIONER_RETIREMENT_INVENTORY_QUERY =
  "SELECT CONCAT(User,0x09,Host,0x09,account_locked,0x09,HEX(COALESCE(CAST(User_attributes AS CHAR),''))) FROM mysql.user WHERE User LIKE 'lbcp\\\\_%' ESCAPE '\\\\' ORDER BY User,Host";
export const CREDIT_PROVISIONER_RETIREMENT_DATABASE_TIME_QUERY =
  "SELECT DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ')";
export const CREDIT_PROVISIONER_RETIREMENT_ACTIVE_SESSION_QUERY =
  "SELECT PROCESSLIST_USER FROM performance_schema.threads WHERE TYPE='FOREGROUND' AND PROCESSLIST_USER LIKE 'lbcp\\\\_%' ESCAPE '\\\\' ORDER BY PROCESSLIST_USER,PROCESSLIST_ID";

const EVIDENCE_KEYS = Object.freeze([
  "cohortSha256",
  "contractVersion",
  "deploymentIdentity",
  "lockedAt",
  "managedAccountCountAfter",
  "managedAccountCountBefore",
  "membersSha256",
  "mutationAt",
  "obsoletePrincipalSha256",
  "operation",
  "runtimePrincipalSha256",
  "schemaPhase",
  "sourceHead",
]);
const ATTRIBUTE_KEYS = Object.freeze([
  "cohortSha256",
  "contractVersion",
  "lockedAt",
  "membersSha256",
  "state",
  "unlockedAt",
]);
const OBSOLETE_DROP_EVIDENCE_KEYS = Object.freeze([
  "deploymentIdentity",
  "mutationAt",
  "obsoletePrincipalSha256",
  "operation",
  "runtimePrincipalSha256",
  "schemaPhase",
]);
const OPERATIONS = new Set(["lock", "unlock", "drop"]);
const ATTRIBUTE_STATES = new Set([
  "locking",
  "locked",
  "unlocking",
  "unlocked",
]);

function fail() {
  throw new Error("credit provisioner retirement rejected");
}

function assertExactKeys(value, expected) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected)
  ) {
    fail();
  }
}

function requireSha256(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail();
  return value;
}

function requireSourceHead(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) fail();
  return value;
}

function requireDeploymentIdentity(value) {
  if (
    typeof value !== "string" ||
    !/^deploy-[1-9][0-9]*-[1-9][0-9]*$/.test(value)
  ) {
    fail();
  }
  return value;
}

function requireDatabaseTimestamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail();
  }
  return value;
}

function requireEvidenceTimestamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail();
  }
  return value;
}

function requireCount(value, { allowZero = true } = {}) {
  if (
    !Number.isInteger(value) ||
    value < (allowZero ? 0 : 1) ||
    value > MAX_MANAGED_ACCOUNTS
  ) {
    fail();
  }
  return value;
}

function throwIfAborted(signal) {
  if (signal?.aborted) fail();
}

export function deriveRetirementCohortSha256({
  deploymentIdentity,
  obsoletePrincipalSha256,
  runtimePrincipalSha256,
}) {
  const current = requireSha256(runtimePrincipalSha256);
  const obsolete = requireSha256(obsoletePrincipalSha256);
  const identity = requireDeploymentIdentity(deploymentIdentity);
  if (current === obsolete) fail();
  return createHash("sha256")
    .update(
      [
        CONTRACT_DOMAIN,
        REPOSITORY,
        SCHEMA_PHASE,
        current,
        identity,
        obsolete,
      ].join("\0"),
    )
    .digest("hex");
}

export function deriveRetirementMembersSha256(accounts) {
  if (
    !Array.isArray(accounts) ||
    accounts.length < 1 ||
    accounts.length > MAX_MANAGED_ACCOUNTS
  ) {
    fail();
  }
  const identities = accounts
    .map((account) => {
      quoteManagedAccount(account);
      return `${account.username}\0${account.hostname}`;
    })
    .sort();
  if (new Set(identities).size !== identities.length) fail();
  return createHash("sha256")
    .update(`${CONTRACT_DOMAIN}-members\0`)
    .update(identities.join("\0"))
    .digest("hex");
}

function parseAttribute(value) {
  if (value === undefined) return undefined;
  assertExactKeys(value, ATTRIBUTE_KEYS);
  if (
    value.contractVersion !== CONTRACT_VERSION ||
    !ATTRIBUTE_STATES.has(value.state) ||
    (value.lockedAt !== null &&
      requireDatabaseTimestamp(value.lockedAt) !== value.lockedAt) ||
    (value.unlockedAt !== null &&
      requireDatabaseTimestamp(value.unlockedAt) !== value.unlockedAt)
  ) {
    fail();
  }
  requireSha256(value.cohortSha256);
  requireSha256(value.membersSha256);
  if (
    (new Set(["locking", "locked"]).has(value.state) &&
      value.unlockedAt !== null) ||
    (value.state === "locked" && value.lockedAt === null) ||
    (new Set(["unlocking", "unlocked"]).has(value.state) &&
      value.lockedAt === null) ||
    (value.state === "unlocking" && value.unlockedAt !== null) ||
    (value.state === "unlocked" && value.unlockedAt === null)
  ) {
    fail();
  }
  return Object.freeze({ ...value });
}

function decodeUserAttributes(value) {
  if (value === "") return {};
  if (
    typeof value !== "string" ||
    value.length > MAX_ATTRIBUTE_BYTES * 2 ||
    value.length % 2 !== 0 ||
    !/^[a-fA-F0-9]+$/.test(value)
  ) {
    fail();
  }
  let parsed;
  try {
    const json = Buffer.from(value, "hex").toString("utf8");
    if (Buffer.byteLength(json) > MAX_ATTRIBUTE_BYTES) fail();
    parsed = JSON.parse(json);
  } catch {
    fail();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail();
  return parsed;
}

export function parseRetirementInventoryRows(lines) {
  if (!Array.isArray(lines)) fail();
  const identityLines = [];
  const parsedRows = [];
  for (const line of lines) {
    if (typeof line !== "string" || !line) fail();
    const [username, hostname, accountLocked, attributesHex, extra] =
      line.split("\t");
    if (
      extra !== undefined ||
      !new Set(["Y", "N"]).has(accountLocked) ||
      attributesHex === undefined
    ) {
      fail();
    }
    identityLines.push(`${username}\t${hostname}`);
    const attributes = decodeUserAttributes(attributesHex);
    parsedRows.push({
      accountLocked,
      attributes,
      retirement: parseAttribute(attributes[ATTRIBUTE_KEY]),
    });
  }
  const accounts = parseManagedProvisionerAccounts(identityLines);
  if (accounts.length > MAX_MANAGED_ACCOUNTS) fail();
  const usernames = accounts.map((account) => account.username);
  if (new Set(usernames).size !== usernames.length) fail();
  return Object.freeze(
    accounts.map((account, index) =>
      Object.freeze({ account, ...parsedRows[index] }),
    ),
  );
}

function buildRetirementAttribute({
  cohortSha256,
  lockedAt = null,
  membersSha256,
  state,
  unlockedAt = null,
}) {
  const value = {
    cohortSha256: requireSha256(cohortSha256),
    contractVersion: CONTRACT_VERSION,
    lockedAt,
    membersSha256: requireSha256(membersSha256),
    state,
    unlockedAt,
  };
  return parseAttribute(value);
}

export function buildRetirementAttributeSql(account, value) {
  const quoted = quoteManagedAccount(account);
  const retirement = parseAttribute(value);
  const patch = JSON.stringify({ [ATTRIBUTE_KEY]: retirement });
  if (patch.includes("'") || Buffer.byteLength(patch) > MAX_ATTRIBUTE_BYTES) {
    fail();
  }
  return `ALTER USER ${quoted} ATTRIBUTE '${patch}'`;
}

function buildEvidence({
  context,
  lockedAt,
  managedAccountCountAfter,
  managedAccountCountBefore,
  membersSha256,
  mutationAt,
  operation,
}) {
  const evidence = {
    cohortSha256: context.cohortSha256,
    contractVersion: CONTRACT_VERSION,
    deploymentIdentity: context.deploymentIdentity,
    lockedAt,
    managedAccountCountAfter: requireCount(managedAccountCountAfter),
    managedAccountCountBefore: requireCount(managedAccountCountBefore),
    membersSha256: requireSha256(membersSha256),
    mutationAt: requireDatabaseTimestamp(mutationAt),
    obsoletePrincipalSha256: context.obsoletePrincipalSha256,
    operation,
    runtimePrincipalSha256: context.runtimePrincipalSha256,
    schemaPhase: SCHEMA_PHASE,
    sourceHead: context.sourceHead,
  };
  return assertRetirementEvidence(evidence);
}

export function assertRetirementEvidence(value) {
  assertExactKeys(value, EVIDENCE_KEYS);
  if (
    value.contractVersion !== CONTRACT_VERSION ||
    !OPERATIONS.has(value.operation) ||
    value.schemaPhase !== SCHEMA_PHASE
  ) {
    fail();
  }
  const context = buildContext(value);
  if (value.cohortSha256 !== context.cohortSha256) fail();
  requireCount(value.managedAccountCountBefore, { allowZero: false });
  requireCount(value.managedAccountCountAfter);
  requireSha256(value.membersSha256);
  requireDatabaseTimestamp(value.mutationAt);
  if (value.operation === "lock") {
    requireDatabaseTimestamp(value.lockedAt);
    if (
      value.lockedAt !== value.mutationAt ||
      value.managedAccountCountAfter !== value.managedAccountCountBefore
    ) {
      fail();
    }
  } else if (value.operation === "unlock") {
    if (
      value.lockedAt !== null ||
      value.managedAccountCountAfter !== value.managedAccountCountBefore
    ) {
      fail();
    }
  } else if (
    value.lockedAt === null ||
    requireDatabaseTimestamp(value.lockedAt) !== value.lockedAt ||
    value.managedAccountCountAfter !== 0
  ) {
    fail();
  }
  return Object.freeze({ ...value });
}

export function assertLockEvidence(value, context) {
  const evidence = assertRetirementEvidence(value);
  if (
    evidence.operation !== "lock" ||
    evidence.runtimePrincipalSha256 !== context.runtimePrincipalSha256 ||
    evidence.deploymentIdentity !== context.deploymentIdentity ||
    evidence.obsoletePrincipalSha256 !== context.obsoletePrincipalSha256 ||
    evidence.cohortSha256 !== context.cohortSha256
  ) {
    fail();
  }
  return evidence;
}

export function assertObsoletePrincipalDropEvidence(
  value,
  { deploymentIdentity, runtimePrincipalSha256 },
) {
  assertExactKeys(value, OBSOLETE_DROP_EVIDENCE_KEYS);
  if (
    value.operation !== "drop" ||
    value.schemaPhase !== SCHEMA_PHASE ||
    value.deploymentIdentity !==
      requireDeploymentIdentity(deploymentIdentity) ||
    value.runtimePrincipalSha256 !== requireSha256(runtimePrincipalSha256)
  ) {
    fail();
  }
  requireSha256(value.obsoletePrincipalSha256);
  requireEvidenceTimestamp(value.mutationAt);
  if (value.obsoletePrincipalSha256 === value.runtimePrincipalSha256) fail();
  return Object.freeze({ ...value });
}

function buildContext(input) {
  if (input?.databaseApp !== undefined && input.databaseApp !== DATABASE_APP) {
    fail();
  }
  if (
    input?.databaseName !== undefined &&
    input.databaseName !== DATABASE_NAME
  ) {
    fail();
  }
  const context = {
    databaseApp: input?.databaseApp ?? DATABASE_APP,
    databaseMachineId: input?.databaseMachineId,
    databaseName: input?.databaseName ?? DATABASE_NAME,
    deploymentIdentity: requireDeploymentIdentity(input?.deploymentIdentity),
    obsoletePrincipalSha256: requireSha256(input?.obsoletePrincipalSha256),
    runtimePrincipalSha256: requireSha256(input?.runtimePrincipalSha256),
    sourceHead: requireSourceHead(input?.sourceHead),
  };
  if (
    context.runtimePrincipalSha256 === context.obsoletePrincipalSha256 ||
    (context.databaseMachineId !== undefined &&
      !/^[a-f0-9]{14}$/.test(context.databaseMachineId))
  ) {
    fail();
  }
  return Object.freeze({
    ...context,
    cohortSha256: deriveRetirementCohortSha256(context),
  });
}

function parseArgumentPairs(argv) {
  if (!Array.isArray(argv) || argv.length % 2 !== 0) fail();
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!/^--[a-z][a-z0-9-]*$/.test(name ?? "") || values.has(name)) fail();
    values.set(name, value);
  }
  return values;
}

function requireAbsoluteEvidencePath(value) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    path.basename(value) !== EVIDENCE_FILE_NAME
  ) {
    fail();
  }
  return path.normalize(value);
}

export function parseRetirementCliArguments(argv) {
  const values = parseArgumentPairs(argv);
  const operation = values.get("--operation");
  if (!OPERATIONS.has(operation)) fail();
  const expectedNames = new Set([
    "--database-app",
    "--database-machine",
    "--evidence-out",
    "--expected-deployment-identity",
    "--expected-head",
    "--expected-runtime-principal-sha256",
    "--obsolete-drop-evidence",
    "--operation",
    ...(operation === "drop" ? ["--lock-evidence"] : []),
  ]);
  if (
    values.size !== expectedNames.size ||
    [...values.keys()].some((name) => !expectedNames.has(name))
  ) {
    fail();
  }
  const databaseApp = values.get("--database-app");
  const databaseMachineId = values.get("--database-machine");
  const deploymentIdentity = requireDeploymentIdentity(
    values.get("--expected-deployment-identity"),
  );
  const runtimePrincipalSha256 = requireSha256(
    values.get("--expected-runtime-principal-sha256"),
  );
  const sourceHead = requireSourceHead(values.get("--expected-head"));
  if (
    databaseApp !== DATABASE_APP ||
    !/^[a-f0-9]{14}$/.test(databaseMachineId ?? "")
  ) {
    fail();
  }
  return Object.freeze({
    databaseApp,
    databaseMachineId,
    databaseName: DATABASE_NAME,
    deploymentIdentity,
    evidenceOutput: requireAbsoluteEvidencePath(values.get("--evidence-out")),
    lockEvidence:
      operation === "drop"
        ? requireAbsoluteEvidencePath(values.get("--lock-evidence"))
        : undefined,
    obsoleteDropEvidence: requireAbsoluteEvidencePath(
      values.get("--obsolete-drop-evidence"),
    ),
    operation,
    runtimePrincipalSha256,
    sourceHead,
  });
}

async function readInventory(rootSession, signal) {
  const lines = await rootSession.execute(
    CREDIT_PROVISIONER_RETIREMENT_INVENTORY_QUERY,
    { signal },
  );
  return parseRetirementInventoryRows(lines);
}

async function readDatabaseTime(rootSession, signal) {
  const lines = await rootSession.execute(
    CREDIT_PROVISIONER_RETIREMENT_DATABASE_TIME_QUERY,
    { signal },
  );
  if (lines.length !== 1) fail();
  return requireDatabaseTimestamp(lines[0]);
}

async function assertNoActiveManagedSessions(rootSession, signal) {
  const lines = await rootSession.execute(
    CREDIT_PROVISIONER_RETIREMENT_ACTIVE_SESSION_QUERY,
    { signal },
  );
  if (!Array.isArray(lines) || lines.length !== 0) fail();
}

async function executeMutation(rootSession, sql, signal) {
  throwIfAborted(signal);
  await rootSession.assertLockHeld(signal);
  await rootSession.execute(sql, { signal });
}

function assertInventoryCohort(
  inventory,
  context,
  { allowMissing = false, membersSha256 } = {},
) {
  requireSha256(membersSha256);
  for (const row of inventory) {
    if (!row.retirement) {
      if (allowMissing && row.accountLocked === "N") continue;
      fail();
    }
    if (
      row.retirement.cohortSha256 !== context.cohortSha256 ||
      row.retirement.membersSha256 !== membersSha256
    ) {
      fail();
    }
  }
}

async function lockAccounts({ context, inventory, rootSession, signal }) {
  if (inventory.length === 0) fail();
  const membersSha256 = deriveRetirementMembersSha256(
    inventory.map((row) => row.account),
  );
  assertInventoryCohort(inventory, context, {
    allowMissing: true,
    membersSha256,
  });
  const priorLockedAtValues = inventory
    .map((row) => row.retirement?.lockedAt)
    .filter(Boolean);
  for (const row of inventory) {
    const locking = buildRetirementAttribute({
      cohortSha256: context.cohortSha256,
      lockedAt: row.retirement?.lockedAt ?? null,
      membersSha256,
      state: "locking",
    });
    const account = quoteManagedAccount(row.account);
    await executeMutation(
      rootSession,
      buildRetirementAttributeSql(row.account, locking),
      signal,
    );
    await executeMutation(
      rootSession,
      `ALTER USER ${account} ACCOUNT LOCK`,
      signal,
    );
  }
  const lockedAt = await readDatabaseTime(rootSession, signal);
  if (
    priorLockedAtValues.some(
      (priorLockedAt) => Date.parse(lockedAt) <= Date.parse(priorLockedAt),
    )
  ) {
    fail();
  }
  const locked = buildRetirementAttribute({
    cohortSha256: context.cohortSha256,
    lockedAt,
    membersSha256,
    state: "locked",
  });
  for (const row of inventory) {
    await executeMutation(
      rootSession,
      buildRetirementAttributeSql(row.account, locked),
      signal,
    );
  }
  const remaining = await readInventory(rootSession, signal);
  if (
    remaining.length !== inventory.length ||
    remaining.some(
      (row) =>
        row.accountLocked !== "Y" ||
        row.retirement?.cohortSha256 !== context.cohortSha256 ||
        row.retirement?.membersSha256 !== membersSha256 ||
        row.retirement?.state !== "locked" ||
        row.retirement?.lockedAt !== lockedAt,
    )
  ) {
    fail();
  }
  await assertNoActiveManagedSessions(rootSession, signal);
  return buildEvidence({
    context,
    lockedAt,
    managedAccountCountAfter: remaining.length,
    managedAccountCountBefore: inventory.length,
    membersSha256,
    mutationAt: lockedAt,
    operation: "lock",
  });
}

async function unlockAccounts({ context, inventory, rootSession, signal }) {
  if (inventory.length === 0) fail();
  const membersSha256 = deriveRetirementMembersSha256(
    inventory.map((row) => row.account),
  );
  assertInventoryCohort(inventory, context, { membersSha256 });
  const lockedAtValues = new Set(
    inventory.map((row) => row.retirement?.lockedAt).filter(Boolean),
  );
  if (lockedAtValues.size !== 1) fail();
  const [lockedAt] = lockedAtValues;
  const unlocking = buildRetirementAttribute({
    cohortSha256: context.cohortSha256,
    lockedAt,
    membersSha256,
    state: "unlocking",
  });
  for (const row of inventory) {
    await executeMutation(
      rootSession,
      buildRetirementAttributeSql(row.account, unlocking),
      signal,
    );
    await executeMutation(
      rootSession,
      `ALTER USER ${quoteManagedAccount(row.account)} ACCOUNT UNLOCK`,
      signal,
    );
  }
  const unlockedAt = await readDatabaseTime(rootSession, signal);
  const unlocked = buildRetirementAttribute({
    cohortSha256: context.cohortSha256,
    lockedAt,
    membersSha256,
    state: "unlocked",
    unlockedAt,
  });
  for (const row of inventory) {
    await executeMutation(
      rootSession,
      buildRetirementAttributeSql(row.account, unlocked),
      signal,
    );
  }
  const remaining = await readInventory(rootSession, signal);
  if (
    remaining.length !== inventory.length ||
    remaining.some(
      (row) =>
        row.accountLocked !== "N" ||
        row.retirement?.cohortSha256 !== context.cohortSha256 ||
        row.retirement?.membersSha256 !== membersSha256 ||
        row.retirement?.state !== "unlocked" ||
        row.retirement?.unlockedAt !== unlockedAt,
    )
  ) {
    fail();
  }
  return buildEvidence({
    context,
    lockedAt: null,
    managedAccountCountAfter: remaining.length,
    managedAccountCountBefore: inventory.length,
    membersSha256,
    mutationAt: unlockedAt,
    operation: "unlock",
  });
}

function assertDropWindow(lockedAt, databaseNow, { enforceMaximum }) {
  const age = Date.parse(databaseNow) - Date.parse(lockedAt);
  if (
    !Number.isFinite(age) ||
    age < MIN_DROP_AGE_MS ||
    (enforceMaximum && age > MAX_DROP_AGE_MS)
  ) {
    fail();
  }
}

async function dropAccounts({
  context,
  inventory,
  lockEvidence,
  rootSession,
  signal,
}) {
  const databaseNow = await readDatabaseTime(rootSession, signal);
  assertDropWindow(lockEvidence.lockedAt, databaseNow, {
    enforceMaximum: inventory.length !== 0,
  });
  if (inventory.length !== 0) {
    if (inventory.length !== lockEvidence.managedAccountCountAfter) fail();
    const membersSha256 = deriveRetirementMembersSha256(
      inventory.map((row) => row.account),
    );
    if (membersSha256 !== lockEvidence.membersSha256) fail();
    assertInventoryCohort(inventory, context, { membersSha256 });
    if (
      inventory.some(
        (row) =>
          row.accountLocked !== "Y" ||
          row.retirement?.state !== "locked" ||
          row.retirement?.lockedAt !== lockEvidence.lockedAt,
      )
    ) {
      fail();
    }
    const accounts = inventory
      .map((row) => quoteManagedAccount(row.account))
      .join(", ");
    await executeMutation(rootSession, `DROP USER ${accounts}`, signal);
  }
  const remaining = await readInventory(rootSession, signal);
  if (remaining.length !== 0) fail();
  await assertNoActiveManagedSessions(rootSession, signal);
  const mutationAt = await readDatabaseTime(rootSession, signal);
  return buildEvidence({
    context,
    lockedAt: lockEvidence.lockedAt,
    managedAccountCountAfter: 0,
    managedAccountCountBefore: lockEvidence.managedAccountCountAfter,
    membersSha256: lockEvidence.membersSha256,
    mutationAt,
    operation: "drop",
  });
}

async function readEvidenceFile(filePath, readFile) {
  let source;
  try {
    source = await readFile(filePath, "utf8");
  } catch {
    fail();
  }
  if (
    typeof source !== "string" ||
    Buffer.byteLength(source) > MAX_ATTRIBUTE_BYTES
  ) {
    fail();
  }
  try {
    return JSON.parse(source);
  } catch {
    fail();
  }
}

export async function retireImageGenCreditProvisioners(
  input,
  {
    createRootSession = (options) => new RootMysqlSession(options),
    readFile = fs.readFile,
  } = {},
) {
  if (!OPERATIONS.has(input?.operation)) fail();
  if (
    typeof createRootSession !== "function" ||
    typeof readFile !== "function"
  ) {
    fail();
  }
  const obsoleteDropEvidencePath = requireAbsoluteEvidencePath(
    input.obsoleteDropEvidence,
  );
  const obsoleteDropEvidence = assertObsoletePrincipalDropEvidence(
    await readEvidenceFile(obsoleteDropEvidencePath, readFile),
    input,
  );
  const context = buildContext({
    ...input,
    obsoletePrincipalSha256: obsoleteDropEvidence.obsoletePrincipalSha256,
  });
  const lockEvidence =
    input.operation === "drop"
      ? assertLockEvidence(
          await readEvidenceFile(input.lockEvidence, readFile),
          context,
        )
      : undefined;
  if (
    (input.operation === "drop" &&
      requireAbsoluteEvidencePath(input.lockEvidence) !== input.lockEvidence) ||
    (input.operation !== "drop" && input.lockEvidence !== undefined)
  ) {
    fail();
  }
  throwIfAborted(input.signal);
  const rootSession = createRootSession({
    app: context.databaseApp,
    machineId: context.databaseMachineId,
    signal: input.signal,
  });
  try {
    await rootSession.initialize(input.signal);
    await rootSession.acquireLock(input.signal);
    await rootSession.assertLockHeld(input.signal);
    await assertNoActiveManagedSessions(rootSession, input.signal);
    const inventory = await readInventory(rootSession, input.signal);
    let evidence;
    if (input.operation === "lock") {
      evidence = await lockAccounts({
        context,
        inventory,
        rootSession,
        signal: input.signal,
      });
    } else if (input.operation === "unlock") {
      evidence = await unlockAccounts({
        context,
        inventory,
        rootSession,
        signal: input.signal,
      });
    } else {
      evidence = await dropAccounts({
        context,
        inventory,
        lockEvidence,
        rootSession,
        signal: input.signal,
      });
    }
    await rootSession.assertLockHeld(input.signal);
    return evidence;
  } finally {
    await rootSession.close({ releaseLock: true, signal: input.signal });
  }
}

function successMarker(operation) {
  return {
    drop: CREDIT_PROVISIONER_RETIREMENT_DROPPED_MARKER,
    lock: CREDIT_PROVISIONER_RETIREMENT_LOCKED_MARKER,
    unlock: CREDIT_PROVISIONER_RETIREMENT_UNLOCKED_MARKER,
  }[operation];
}

async function writeEvidenceFile(filePath, evidence) {
  const parent = path.dirname(filePath);
  const parentStat = await fs.lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) fail();
  await fs.writeFile(filePath, `${JSON.stringify(evidence)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

function writeMarker(marker) {
  process.stdout.write(`${marker}\n`);
}

export async function runRetirementCli(
  argv,
  {
    output = writeMarker,
    retire = retireImageGenCreditProvisioners,
    writeEvidence = writeEvidenceFile,
  } = {},
) {
  let marker = CREDIT_PROVISIONER_RETIREMENT_FAILURE_MARKER;
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    const input = parseRetirementCliArguments(argv);
    const evidence = await retire({ ...input, signal: controller.signal });
    await writeEvidence(input.evidenceOutput, evidence);
    marker = successMarker(input.operation);
  } catch {
    marker = CREDIT_PROVISIONER_RETIREMENT_FAILURE_MARKER;
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
  const marker = await runRetirementCli(process.argv.slice(2));
  process.exitCode = new Set([
    CREDIT_PROVISIONER_RETIREMENT_LOCKED_MARKER,
    CREDIT_PROVISIONER_RETIREMENT_UNLOCKED_MARKER,
    CREDIT_PROVISIONER_RETIREMENT_DROPPED_MARKER,
  ]).has(marker)
    ? 0
    : 1;
}
