import { assertCreditWalletMigrationGrantScope } from "../apps/image-gen/scripts/production-schema-contract.mjs";

export const CREDIT_MIGRATION_PRINCIPAL_REPAIR_LOCK =
  "leaderbot_credit_migration_principal_repair_v1";
export const CREDIT_MIGRATION_PRINCIPAL_REPAIR_PRIVILEGES = Object.freeze([
  "CREATE",
  "TRIGGER",
  "CREATE ROUTINE",
  "ALTER ROUTINE",
]);
export const CREDIT_MIGRATION_PRINCIPAL_READY_MARKER =
  "credit_migration_principal_ready";
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
  return [
    ...grants,
    `GRANT ${privileges.join(", ")} ON \`${databaseName}\`.* TO \`credit_migration_repair_probe\`@\`%\``,
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
    )
  ) {
    fail();
  }
  const verb = operation === "grant" ? "GRANT" : "REVOKE";
  const preposition = operation === "grant" ? "TO" : "FROM";
  return `${verb} ${privileges.join(", ")} ON ${quoteDatabase(databaseName)}.* ${preposition} ${quoteAccount(account)}`;
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
    await activeRoot.execute(
      buildCreditMigrationPrivilegeStatement({
        account,
        databaseName,
        operation: "grant",
        privileges: attemptedPrivileges,
      }),
    );
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
          await activeRoot.execute(
            buildCreditMigrationPrivilegeStatement({
              account,
              databaseName,
              operation: "revoke",
              privileges: addedPrivileges,
            }),
          );
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
