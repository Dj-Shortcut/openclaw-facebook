import { assertCreditWalletMigrationGrantScope } from "../apps/image-gen/scripts/production-schema-contract.mjs";

export const CREDIT_MIGRATION_PRINCIPAL_REPAIR_LOCK =
  "leaderbot_credit_migration_principal_repair_v1";
export const CREDIT_MIGRATION_PRINCIPAL_REPAIR_PRIVILEGES = Object.freeze([
  "CREATE",
  "TRIGGER",
  "CREATE ROUTINE",
  "ALTER ROUTINE",
  "SUPER",
]);
export const CREDIT_MIGRATION_PRINCIPAL_READY_MARKER =
  "credit_migration_principal_ready";
export const CREDIT_MIGRATION_PRINCIPAL_SUPER_REVOKED_MARKER =
  "credit_migration_principal_super_revoked";
export const CREDIT_MIGRATION_PRINCIPAL_FAILURE_MARKER =
  "credit_migration_principal_repair_failed";
export const CREDIT_MIGRATION_PRINCIPAL_CLEANUP_FAILURE_MARKER =
  "credit_migration_principal_repair_cleanup_incomplete";

function fail(message = "credit migration principal repair rejected") {
  throw new Error(message);
}

export class CreditMigrationPrincipalCleanupError extends Error {
  constructor() {
    super("credit migration principal repair cleanup incomplete");
    this.name = "CreditMigrationPrincipalCleanupError";
  }
}

export function parseCreditMigrationAccount(value) {
  const match = /^([A-Za-z0-9_]{1,32})@(%{1})$/.exec(String(value ?? ""));
  if (
    !match ||
    new Set(["root", "mysql.infoschema", "mysql.session", "mysql.sys"]).has(
      match[1],
    )
  ) {
    fail("credit migration account identity is unsupported");
  }
  return Object.freeze({ hostname: match[2], username: match[1] });
}

function quoteAccount(account) {
  const parsed = parseCreditMigrationAccount(
    `${account?.username ?? ""}@${account?.hostname ?? ""}`,
  );
  return `'${parsed.username}'@'${parsed.hostname}'`;
}

function quoteDatabase(databaseName) {
  if (databaseName !== "leaderbot") {
    fail("credit migration database identity is unsupported");
  }
  return "`leaderbot`";
}

function combinations(values, size, offset = 0, selected = []) {
  if (selected.length === size) return [selected];
  const results = [];
  for (let index = offset; index < values.length; index += 1) {
    results.push(
      ...combinations(values, size, index + 1, [...selected, values[index]]),
    );
  }
  return results;
}

function grantsWithSyntheticRepair(grants, databaseName, privileges) {
  if (privileges.length === 0) return grants;
  const schemaPrivileges = privileges.filter(
    (privilege) => privilege !== "SUPER",
  );
  return [
    ...grants,
    ...(schemaPrivileges.length > 0
      ? [
          `GRANT ${schemaPrivileges.join(", ")} ON \`${databaseName}\`.* TO \`credit_migration_repair_probe\`@\`%\``,
        ]
      : []),
    ...(privileges.includes("SUPER")
      ? ["GRANT SUPER ON *.* TO `credit_migration_repair_probe`@`%`"]
      : []),
  ];
}

export function detectMissingCreditMigrationPrivileges({
  databaseName,
  grants,
  requireSuper = false,
}) {
  if (
    databaseName !== "leaderbot" ||
    !Array.isArray(grants) ||
    grants.length === 0 ||
    grants.some((grant) => typeof grant !== "string") ||
    typeof requireSuper !== "boolean"
  ) {
    fail();
  }
  for (
    let size = 0;
    size <= CREDIT_MIGRATION_PRINCIPAL_REPAIR_PRIVILEGES.length;
    size += 1
  ) {
    const accepted = [];
    for (const privileges of combinations(
      CREDIT_MIGRATION_PRINCIPAL_REPAIR_PRIVILEGES,
      size,
    )) {
      try {
        assertCreditWalletMigrationGrantScope(
          grantsWithSyntheticRepair(grants, databaseName, privileges),
          databaseName,
          requireSuper,
        );
        accepted.push(privileges);
      } catch {
        // Only an exact completion of the approved four-right repair is valid.
      }
    }
    if (accepted.length === 1) return Object.freeze([...accepted[0]]);
    if (accepted.length > 1) fail();
  }
  fail();
}

export function hasCreditMigrationGlobalSuper(grants) {
  if (
    !Array.isArray(grants) ||
    grants.length === 0 ||
    grants.some((grant) => typeof grant !== "string")
  ) {
    fail();
  }
  let hasSuper = false;
  for (const grant of grants) {
    const parsed = /^(GRANT|REVOKE) (.+) ON \*\.\* (?:TO|FROM) /i.exec(
      grant,
    );
    const privileges = parsed?.[2]
      ?.split(",")
      .map((privilege) => privilege.trim().toUpperCase());
    if (!privileges?.includes("SUPER")) continue;
    if (/\bWITH GRANT OPTION\b/i.test(grant)) fail();
    hasSuper = parsed[1].toUpperCase() === "GRANT";
  }
  return hasSuper;
}

export function buildCreditMigrationPrivilegeStatement({
  account,
  databaseName,
  operation,
  privileges,
}) {
  if (
    !new Set(["grant", "revoke"]).has(operation) ||
    !Array.isArray(privileges) ||
    privileges.length === 0 ||
    new Set(privileges).size !== privileges.length ||
    privileges.some(
      (privilege) =>
        !CREDIT_MIGRATION_PRINCIPAL_REPAIR_PRIVILEGES.includes(privilege),
    ) ||
    privileges.some(
      (privilege, index) =>
        index > 0 &&
        CREDIT_MIGRATION_PRINCIPAL_REPAIR_PRIVILEGES.indexOf(
          privileges[index - 1],
        ) >= CREDIT_MIGRATION_PRINCIPAL_REPAIR_PRIVILEGES.indexOf(privilege),
    ) ||
    (privileges.includes("SUPER") && privileges.length !== 1)
  ) {
    fail();
  }
  const verb = operation === "grant" ? "GRANT" : "REVOKE";
  const preposition = operation === "grant" ? "TO" : "FROM";
  const scope =
    privileges[0] === "SUPER" ? "*.*" : `${quoteDatabase(databaseName)}.*`;
  return `${verb} ${privileges.join(", ")} ON ${scope} ${preposition} ${quoteAccount(account)}`;
}

export function buildCreditMigrationPrivilegeStatements(input) {
  if (
    !Array.isArray(input?.privileges) ||
    input.privileges.length === 0 ||
    new Set(input.privileges).size !== input.privileges.length ||
    input.privileges.some(
      (privilege) =>
        !CREDIT_MIGRATION_PRINCIPAL_REPAIR_PRIVILEGES.includes(privilege),
    ) ||
    input.privileges.some(
      (privilege, index) =>
        index > 0 &&
        CREDIT_MIGRATION_PRINCIPAL_REPAIR_PRIVILEGES.indexOf(
          input.privileges[index - 1],
        ) >= CREDIT_MIGRATION_PRINCIPAL_REPAIR_PRIVILEGES.indexOf(privilege),
    )
  ) {
    fail();
  }
  const schemaPrivileges = input.privileges.filter(
    (privilege) => privilege !== "SUPER",
  );
  const superPrivileges = input.privileges.includes("SUPER") ? ["SUPER"] : [];
  const groups =
    input.operation === "grant"
      ? [schemaPrivileges, superPrivileges]
      : [superPrivileges, schemaPrivileges];
  return Object.freeze(
    groups
      .filter((privileges) => privileges.length > 0)
      .map((privileges) =>
        buildCreditMigrationPrivilegeStatement({ ...input, privileges }),
      ),
  );
}

export async function repairCreditMigrationPrincipal({
  account,
  databaseName,
  requireSuper,
  root,
  readState,
  recoverRoot,
  verify,
  verifyRollback,
}) {
  if (
    !root ||
    typeof root.execute !== "function" ||
    typeof readState !== "function" ||
    typeof recoverRoot !== "function" ||
    typeof verify !== "function" ||
    typeof verifyRollback !== "function"
  ) {
    fail();
  }
  quoteAccount(account);
  let attemptedPrivileges = [];
  let activeRoot = root;
  let repairVerified = false;
  let lockHeld = false;
  const acquireAndValidateLock = async () => {
    const lock = await activeRoot.execute(
      `SELECT GET_LOCK('${CREDIT_MIGRATION_PRINCIPAL_REPAIR_LOCK}',0)`,
    );
    if (lock.length !== 1 || lock[0] !== "1") fail();
    lockHeld = true;
    const accountRows = await activeRoot.execute(
      `SELECT COUNT(*) FROM mysql.user WHERE User='${account.username}' AND Host='${account.hostname}'`,
    );
    if (accountRows.length !== 1 || accountRows[0] !== "1") fail();
    const currentLock = await activeRoot.execute(
      `SELECT IS_USED_LOCK('${CREDIT_MIGRATION_PRINCIPAL_REPAIR_LOCK}')=CONNECTION_ID()`,
    );
    if (currentLock.length !== 1 || currentLock[0] !== "1") fail();
  };
  const ensureActiveLock = async () => {
    try {
      const currentLock = await activeRoot.execute(
        `SELECT IS_USED_LOCK('${CREDIT_MIGRATION_PRINCIPAL_REPAIR_LOCK}')=CONNECTION_ID()`,
      );
      if (currentLock.length !== 1 || currentLock[0] !== "1") fail();
    } catch {
      lockHeld = false;
      const recovered = await recoverRoot(activeRoot);
      if (!recovered || typeof recovered.execute !== "function") fail();
      activeRoot = recovered;
      await acquireAndValidateLock();
    }
  };
  try {
    await acquireAndValidateLock();

    // Re-read the effective grants only after the private repair lock is held.
    // The pre-lock observation is identity context, never a mutation decision.
    const lockedState = await readState();
    if (
      lockedState?.account?.username !== account.username ||
      lockedState?.account?.hostname !== account.hostname ||
      lockedState?.databaseName !== databaseName ||
      lockedState?.requireSuper !== requireSuper
    ) {
      fail();
    }
    const missing = detectMissingCreditMigrationPrivileges(lockedState);
    if (missing.length === 0) {
      await verify();
      return "already_ready";
    }

    // Mark the exact attempted delta before sending GRANT. If transport fails
    // after MySQL commits, the catch path observes real grants before deciding
    // whether anything must be revoked.
    attemptedPrivileges = [...missing];
    for (const statement of buildCreditMigrationPrivilegeStatements({
      account,
      databaseName,
      operation: "grant",
      privileges: attemptedPrivileges,
    })) {
      await activeRoot.execute(statement);
    }
    await verify();
    repairVerified = true;
    return "repaired";
  } catch (error) {
    if (attemptedPrivileges.length > 0 && !repairVerified) {
      try {
        await ensureActiveLock();
        const observed = await readState();
        if (
          observed?.account?.username !== account.username ||
          observed?.account?.hostname !== account.hostname ||
          observed?.databaseName !== databaseName ||
          observed?.requireSuper !== requireSuper
        ) {
          fail();
        }
        const stillMissing = detectMissingCreditMigrationPrivileges(observed);
        if (
          stillMissing.some(
            (privilege) => !attemptedPrivileges.includes(privilege),
          )
        ) {
          fail();
        }
        const addedPrivileges = attemptedPrivileges.filter(
          (privilege) => !stillMissing.includes(privilege),
        );
        if (addedPrivileges.length > 0) {
          for (const statement of buildCreditMigrationPrivilegeStatements({
            account,
            databaseName,
            operation: "revoke",
            privileges: addedPrivileges,
          })) {
            await activeRoot.execute(statement);
          }
        }
        await verifyRollback(attemptedPrivileges);
      } catch {
        throw new CreditMigrationPrincipalCleanupError();
      }
    }
    throw error;
  } finally {
    if (lockHeld) {
      try {
        await activeRoot.execute(
          `SELECT RELEASE_LOCK('${CREDIT_MIGRATION_PRINCIPAL_REPAIR_LOCK}')`,
        );
      } catch {
        if (attemptedPrivileges.length > 0) {
          throw new CreditMigrationPrincipalCleanupError();
        }
        fail();
      }
    }
  }
}

export async function revokeTemporaryCreditMigrationSuper({
  account,
  databaseName,
  root,
  readState,
  recoverRoot,
  verify,
}) {
  if (
    !root ||
    typeof root.execute !== "function" ||
    typeof readState !== "function" ||
    typeof recoverRoot !== "function" ||
    typeof verify !== "function"
  ) {
    fail();
  }
  quoteAccount(account);
  let activeRoot = root;
  let lockHeld = false;
  const acquireAndValidateLock = async () => {
    const lock = await activeRoot.execute(
      `SELECT GET_LOCK('${CREDIT_MIGRATION_PRINCIPAL_REPAIR_LOCK}',0)`,
    );
    if (lock.length !== 1 || lock[0] !== "1") fail();
    lockHeld = true;
    const accountRows = await activeRoot.execute(
      `SELECT COUNT(*) FROM mysql.user WHERE User='${account.username}' AND Host='${account.hostname}'`,
    );
    if (accountRows.length !== 1 || accountRows[0] !== "1") fail();
    const currentLock = await activeRoot.execute(
      `SELECT IS_USED_LOCK('${CREDIT_MIGRATION_PRINCIPAL_REPAIR_LOCK}')=CONNECTION_ID()`,
    );
    if (currentLock.length !== 1 || currentLock[0] !== "1") fail();
  };
  const assertIdentity = (state) => {
    if (
      state?.account?.username !== account.username ||
      state?.account?.hostname !== account.hostname ||
      state?.databaseName !== databaseName ||
      state?.requireSuper !== true
    ) {
      fail();
    }
  };
  try {
    await acquireAndValidateLock();
    const current = await readState();
    assertIdentity(current);
    if (!hasCreditMigrationGlobalSuper(current.grants)) {
      await verify();
      return "already_revoked";
    }
    try {
      await activeRoot.execute(
        buildCreditMigrationPrivilegeStatement({
          account,
          databaseName,
          operation: "revoke",
          privileges: ["SUPER"],
        }),
      );
    } catch {
      lockHeld = false;
      const recovered = await recoverRoot(activeRoot);
      if (!recovered || typeof recovered.execute !== "function") {
        throw new CreditMigrationPrincipalCleanupError();
      }
      activeRoot = recovered;
      await acquireAndValidateLock();
    }
    const observed = await readState();
    assertIdentity(observed);
    if (hasCreditMigrationGlobalSuper(observed.grants)) {
      throw new CreditMigrationPrincipalCleanupError();
    }
    await verify();
    return "revoked";
  } catch (error) {
    if (error instanceof CreditMigrationPrincipalCleanupError) throw error;
    throw new CreditMigrationPrincipalCleanupError();
  } finally {
    if (lockHeld) {
      try {
        await activeRoot.execute(
          `SELECT RELEASE_LOCK('${CREDIT_MIGRATION_PRINCIPAL_REPAIR_LOCK}')`,
        );
      } catch {
        throw new CreditMigrationPrincipalCleanupError();
      }
    }
  }
}
