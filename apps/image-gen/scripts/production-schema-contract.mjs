import crypto from "node:crypto";

export const productionSchemaContractVersion = 8;
export const creditWalletRoutineNames = Object.freeze([
  "credit_apply_chargeback_debit",
  "credit_apply_chargeback_restore",
  "credit_apply_refund_debit",
  "credit_commit_reservation",
  "credit_consume_checkout_capability",
  "credit_create_reservation_hold",
  "credit_reserve_checkout_intent",
  "credit_erase_wallet",
  "credit_expire_pristine_checkout",
  "credit_expire_reservation",
  "credit_freeze_wallet_for_review",
  "credit_grant_purchase",
  "credit_mark_reservation_provider_accepted",
  "credit_mark_reservation_transport_started",
  "credit_release_rejected_reservation",
  "credit_release_reservation",
  "credit_scrub_terminal_reservation",
]);
export const productionRuntimeWritableTableNames = Object.freeze([
  "users",
  "workspaces",
  "workspaceMembers",
  "aiIdentities",
  "channelConnections",
  "messenger_privacy_subjects",
  "workspaceKnowledgeSources",
  "workspacePrivacySettings",
  "workspacePrivacyRequests",
  "workspaceUpgradeRequests",
  "portalHandoffTokens",
  "auditLog",
  "billing_customers",
  "workspace_billing_profiles",
  "billing_execution_controls",
  "billing_profile_operator_actions",
  "billing_scheduler_tenants",
  "billing_notification_scheduler_tenants",
  "billing_scheduler_process_heartbeats",
  "messenger_provider_attempt_fences",
  "billing_intents",
  "billing_provider_operations",
  "billing_subscriptions",
  "billing_invoice_sequences",
  "payment_ledger",
  "webhook_deliveries",
  "workspace_entitlements",
  "workspace_entitlement_usage",
  "workspace_entitlement_usage_reservations",
  "billing_outbox",
  "billing_webhook_routes",
  "billing_notification_receipts",
  "billing_accounting_import_runs",
  "billing_accounting_import_cursors",
  "billing_accounting_provider_events",
  "billing_accounting_event_links",
  "billing_notification_receiver_outbox",
  "billing_notification_inbox",
  "billing_handoff_recovery_events",
  "billing_reconciliation_runs",
  "billing_reconciliation_anomalies",
]);
export const creditWalletTableNames = Object.freeze([
  "credit_wallets",
  "credit_reservations",
  "credit_ledger",
]);
export const creditWalletMigrationTablePrivileges = Object.freeze({
  billing_intents: Object.freeze(["DELETE"]),
  credit_wallets: Object.freeze(["CREATE", "DELETE"]),
});
const creditWalletMigrationRoutineNames = Object.freeze([
  ...creditWalletRoutineNames,
  "credit_create_wallet",
]);
export const productionSchemaSqlMode =
  "ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION";

export async function configureProductionSchemaSession(connection) {
  await connection.query(`SET SESSION sql_mode='${productionSchemaSqlMode}'`);
  await connection.query("SET SESSION time_zone='+00:00'");
  await connection.query("SET SESSION transaction_isolation='READ-COMMITTED'");
  await connection.query("SET SESSION default_storage_engine='InnoDB'");
  await connection.query("SET SESSION auto_increment_increment=1");
  await connection.query("SET SESSION auto_increment_offset=1");
  await connection.query("SET SESSION information_schema_stats_expiry=0");
  await connection.query("SET SESSION sql_quote_show_create=1");
  await connection.query("SET SESSION show_create_table_verbosity=1");
  await connection.query("SET SESSION sql_safe_updates=0");
  await connection.query("SET SESSION unique_checks=1");
  await connection.query("SET SESSION transaction_read_only=0");
  await connection.query("SET SESSION timestamp=DEFAULT");
  await connection.query("SET SESSION sql_select_limit=DEFAULT");
  await connection.query("SET SESSION sql_big_selects=1");
  await connection.query("SET NAMES utf8mb4 COLLATE utf8mb4_0900_ai_ci");
}

export async function assertProductionMigrationRuntime(
  connection,
  privilegeProfile = "bootstrap"
) {
  if (
    !new Set([
      "inspection",
      "runtime",
      "credit-runtime",
      "expand",
      "credit-expand-pregrant",
      "credit-expand",
      "bootstrap",
      "credit-bootstrap",
    ]).has(privilegeProfile)
  ) {
    throw new Error("production database privilege profile is unsupported");
  }
  await configureProductionSchemaSession(connection);
  const [[runtime]] = await connection.query(
    "SELECT VERSION() AS version,DATABASE() AS databaseName,CURRENT_USER() AS currentUser,@@SESSION.sql_mode AS sqlMode,@@SESSION.time_zone AS timeZone,@@SESSION.transaction_isolation AS transactionIsolation,@@SESSION.foreign_key_checks AS foreignKeyChecks,@@SESSION.default_storage_engine AS defaultStorageEngine,@@GLOBAL.innodb_default_row_format AS innodbDefaultRowFormat,@@GLOBAL.innodb_page_size AS innodbPageSize,@@GLOBAL.innodb_force_recovery AS innodbForceRecovery,@@GLOBAL.innodb_read_only AS innodbReadOnly,@@GLOBAL.read_only AS readOnly,@@GLOBAL.super_read_only AS superReadOnly,@@GLOBAL.disabled_storage_engines AS disabledStorageEngines,@@SESSION.innodb_strict_mode AS innodbStrictMode,@@lower_case_table_names AS lowerCaseTableNames,@@SESSION.explicit_defaults_for_timestamp AS explicitTimestampDefaults,@@SESSION.auto_increment_increment AS autoIncrementIncrement,@@SESSION.auto_increment_offset AS autoIncrementOffset,@@SESSION.information_schema_stats_expiry AS informationSchemaStatsExpiry,@@SESSION.sql_quote_show_create AS sqlQuoteShowCreate,@@SESSION.show_create_table_verbosity AS showCreateTableVerbosity,@@SESSION.sql_safe_updates AS sqlSafeUpdates,@@SESSION.unique_checks AS uniqueChecks,@@SESSION.transaction_read_only AS transactionReadOnly,(ABS(@@SESSION.timestamp-UNIX_TIMESTAMP()) <= 1) AS timestampIsDefault,@@SESSION.insert_id AS insertId,(@@SESSION.sql_select_limit = 18446744073709551615) AS sqlSelectLimitIsDefault,@@SESSION.sql_big_selects AS sqlBigSelects,@@GLOBAL.log_bin AS logBin,@@GLOBAL.log_bin_trust_function_creators AS logBinTrustFunctionCreators,@@GLOBAL.binlog_format AS binlogFormat,@@GLOBAL.automatic_sp_privileges AS automaticSpPrivileges"
  );
  const [[schema]] = await connection.query(
    "SELECT DEFAULT_CHARACTER_SET_NAME AS characterSet,DEFAULT_COLLATION_NAME AS collationName,DEFAULT_ENCRYPTION AS defaultEncryption,(SELECT EXISTS(SELECT 1 FROM information_schema.SCHEMATA_EXTENSIONS se WHERE se.SCHEMA_NAME=DATABASE() AND UPPER(COALESCE(se.OPTIONS,'')) LIKE '%READ ONLY=1%')) AS schemaReadOnly FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=DATABASE()"
  );
  assertProductionRuntimeValues({ ...runtime, ...schema });
  const grants = await currentUserGrants(connection);
  if (privilegeProfile === "inspection") {
    assertProductionInspectionGrantScope(grants, runtime.databaseName);
  } else if (privilegeProfile === "runtime") {
    assertProductionRuntimeGrantScope(grants, runtime.databaseName);
  } else if (privilegeProfile === "credit-runtime") {
    assertCreditWalletRuntimeGrantScope(grants, runtime.databaseName);
  } else if (privilegeProfile === "expand") {
    assertExpandMigrationGrantScope(grants, runtime.databaseName);
    await assertCheckConstraintsEnforced(connection);
  } else if (
    privilegeProfile === "credit-expand" ||
    privilegeProfile === "credit-expand-pregrant"
  ) {
    assertCreditWalletMigrationGrantScope(
      grants,
      runtime.databaseName,
      Number(runtime.logBin) === 1 &&
        Number(runtime.logBinTrustFunctionCreators) !== 1,
      privilegeProfile === "credit-expand-pregrant"
    );
    const [existingCreditRoutines] = await connection.query(
      `SELECT ROUTINE_NAME AS name,DEFINER AS definer FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE() AND ROUTINE_TYPE='PROCEDURE' AND ROUTINE_NAME IN (${creditWalletMigrationRoutineNames.map(() => "?").join(",")}) ORDER BY ROUTINE_NAME`,
      creditWalletMigrationRoutineNames
    );
    assertCreditWalletMigrationRoutineOwnership({
      automaticSpPrivileges: runtime.automaticSpPrivileges,
      currentUser: runtime.currentUser,
      databaseName: runtime.databaseName,
      grants,
      routines: existingCreditRoutines,
    });
    assertCreditWalletBinlogFormat(runtime);
    await assertCheckConstraintsEnforced(connection);
  } else {
    await assertCheckConstraintsEnforced(connection);
    assertTriggerGrantScope(
      grants,
      runtime.databaseName,
      Number(runtime.logBin) === 1 &&
        Number(runtime.logBinTrustFunctionCreators) !== 1
    );
    if (privilegeProfile === "credit-bootstrap") {
      assertCreditWalletBinlogFormat(runtime);
    }
  }
  return { databaseName: runtime.databaseName };
}

export async function assertPreparedStatementCapacity(connection) {
  const [[limit]] = await connection.query(
    "SELECT @@GLOBAL.max_prepared_stmt_count AS maximum"
  );
  const [[used]] = await connection.query(
    "SHOW GLOBAL STATUS LIKE 'Prepared_stmt_count'"
  );
  if (Number(limit.maximum) - Number(used.Value) < 2) {
    throw new Error("MySQL prepared statement capacity is exhausted");
  }
}

async function currentUserGrants(connection) {
  const [rows] = await connection.query("SHOW GRANTS FOR CURRENT_USER()");
  return rows.flatMap(row => Object.values(row)).map(String);
}

function decodeGrantIdentifier(value) {
  const token = String(value).trim();
  if (token === "*") return { value: token, wildcard: true };
  const quoted = /^`((?:``|[^`])*)`$/.exec(token);
  if (quoted) {
    return { value: quoted[1].replaceAll("``", "`"), wildcard: false };
  }
  return /^[A-Za-z0-9_$]+$/.test(token)
    ? { value: token, wildcard: false }
    : null;
}

function splitGrantScope(value) {
  let quoted = false;
  let separator = -1;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "`") {
      if (quoted && value[index + 1] === "`") {
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (value[index] === "." && !quoted) {
      if (separator >= 0) return null;
      separator = index;
    }
  }
  if (quoted || separator <= 0 || separator === value.length - 1) return null;
  return [value.slice(0, separator), value.slice(separator + 1)];
}

function parseGrantScope(rawScope) {
  let value = String(rawScope).trim();
  let kind = "object";
  const procedure = /^PROCEDURE\s+(.+)$/i.exec(value);
  if (procedure) {
    kind = "procedure";
    value = procedure[1];
  }
  const components = splitGrantScope(value);
  if (!components) return null;
  const database = decodeGrantIdentifier(components[0]);
  const object = decodeGrantIdentifier(components[1]);
  if (database === null || object === null) return null;
  return {
    databaseName: database.value,
    databaseWildcard: database.wildcard,
    kind,
    objectName: object.value,
    objectWildcard: object.wildcard,
  };
}

function scopedPrivileges(grants, databaseName) {
  const schemaPrivileges = new Set();
  const revokedSchemaPrivileges = new Set();
  const unexpected = [];
  for (const grant of grants) {
    const parsed = /^(GRANT|REVOKE) (.+) ON (.+) (?:TO|FROM) /i.exec(grant);
    if (!parsed) {
      unexpected.push(grant);
      continue;
    }
    const operation = parsed[1].toUpperCase();
    const privileges = parsed[2]
      .split(",")
      .map(value => value.trim().toUpperCase());
    const scope = parseGrantScope(parsed[3]);
    if (
      scope?.kind === "object" &&
      scope.databaseWildcard &&
      scope.objectWildcard &&
      privileges.length === 1 &&
      privileges[0] === "USAGE"
    ) {
      continue;
    }
    if (
      scope?.kind !== "object" ||
      scope.databaseWildcard ||
      scope.databaseName !== databaseName ||
      !scope.objectWildcard ||
      /\bWITH GRANT OPTION\b/i.test(grant)
    ) {
      unexpected.push(grant);
      continue;
    }
    const target =
      operation === "REVOKE" ? revokedSchemaPrivileges : schemaPrivileges;
    for (const privilege of privileges) target.add(privilege);
  }
  for (const privilege of revokedSchemaPrivileges) {
    schemaPrivileges.delete(privilege);
  }
  return { schemaPrivileges, unexpected };
}

function assertExactScopedPrivileges(
  grants,
  databaseName,
  requiredPrivileges,
  label
) {
  const { schemaPrivileges, unexpected } = scopedPrivileges(
    grants,
    databaseName
  );
  const required = new Set(requiredPrivileges);
  const missing = [...required].filter(
    privilege => !schemaPrivileges.has(privilege)
  );
  const excessive = [...schemaPrivileges].filter(
    privilege => !required.has(privilege)
  );
  if (unexpected.length > 0 || missing.length > 0 || excessive.length > 0) {
    throw new Error(
      `${label} privilege boundary mismatch` +
        (missing.length > 0 ? `; missing ${missing.join(",")}` : "") +
        (excessive.length > 0 ? `; excessive ${excessive.join(",")}` : "")
    );
  }
}

export function assertProductionRuntimeGrantScope(grants, databaseName) {
  assertExactScopedPrivileges(
    grants,
    databaseName,
    ["SELECT", "INSERT", "UPDATE", "DELETE"],
    "runtime principal"
  );
}

export function assertCreditWalletRuntimeGrantScope(grants, databaseName) {
  const schemaPrivileges = new Set();
  const revokedSchemaPrivileges = new Set();
  const grantedTablePrivileges = new Map();
  const revokedTablePrivileges = new Map();
  const grantedRoutines = new Set();
  const revokedRoutines = new Set();
  const unexpected = [];
  const expectedTables = new Set(productionRuntimeWritableTableNames);
  const expectedRoutines = new Set(creditWalletRoutineNames);
  for (const grant of grants) {
    const parsed = /^(GRANT|REVOKE) (.+) ON (.+) (?:TO|FROM) /i.exec(grant);
    if (!parsed) {
      unexpected.push(grant);
      continue;
    }
    const operation = parsed[1].toUpperCase();
    const privileges = parsed[2]
      .split(",")
      .map(value => value.trim().toUpperCase());
    const scope = parseGrantScope(parsed[3]);
    if (
      privileges.length === 0 ||
      privileges.some(privilege =>
        new Set(["ALL", "ALL PRIVILEGES"]).has(privilege)
      ) ||
      /\bWITH GRANT OPTION\b/i.test(grant)
    ) {
      unexpected.push(grant);
      continue;
    }
    if (
      operation === "GRANT" &&
      scope?.kind === "object" &&
      scope.databaseWildcard &&
      scope.objectWildcard &&
      privileges.length === 1 &&
      privileges[0] === "USAGE"
    ) {
      continue;
    }
    if (scope?.kind === "procedure") {
      if (
        scope.databaseName !== databaseName ||
        !expectedRoutines.has(scope.objectName) ||
        privileges.length !== 1 ||
        privileges[0] !== "EXECUTE"
      ) {
        unexpected.push(grant);
        continue;
      }
      (operation === "REVOKE" ? revokedRoutines : grantedRoutines).add(
        scope.objectName
      );
      continue;
    }

    if (
      scope?.kind === "object" &&
      !scope.databaseWildcard &&
      scope.databaseName === databaseName &&
      scope.objectWildcard
    ) {
      if (privileges.some(privilege => privilege !== "SELECT")) {
        unexpected.push(grant);
        continue;
      }
      const target =
        operation === "REVOKE" ? revokedSchemaPrivileges : schemaPrivileges;
      for (const privilege of privileges) target.add(privilege);
      continue;
    }

    if (
      scope?.kind !== "object" ||
      scope.databaseName !== databaseName ||
      !expectedTables.has(scope.objectName) ||
      privileges.some(
        privilege => !new Set(["INSERT", "UPDATE", "DELETE"]).has(privilege)
      )
    ) {
      unexpected.push(grant);
      continue;
    }
    const target =
      operation === "REVOKE" ? revokedTablePrivileges : grantedTablePrivileges;
    const tablePrivileges = target.get(scope.objectName) ?? new Set();
    for (const privilege of privileges) tablePrivileges.add(privilege);
    target.set(scope.objectName, tablePrivileges);
  }

  for (const privilege of revokedSchemaPrivileges) {
    schemaPrivileges.delete(privilege);
  }
  const schemaBoundaryMismatch =
    schemaPrivileges.size !== 1 || !schemaPrivileges.has("SELECT");

  const requiredTablePrivileges = new Set(["INSERT", "UPDATE", "DELETE"]);
  const missingTablePrivileges = [];
  for (const tableName of productionRuntimeWritableTableNames) {
    const effective = new Set(grantedTablePrivileges.get(tableName) ?? []);
    for (const privilege of revokedTablePrivileges.get(tableName) ?? []) {
      effective.delete(privilege);
    }
    const missing = [...requiredTablePrivileges].filter(
      privilege => !effective.has(privilege)
    );
    if (missing.length > 0) {
      missingTablePrivileges.push(`${tableName}:${missing.join("+")}`);
    }
  }

  for (const name of revokedRoutines) grantedRoutines.delete(name);
  const missingRoutines = [...expectedRoutines].filter(
    name => !grantedRoutines.has(name)
  );
  const excessiveRoutines = [...grantedRoutines].filter(
    name => !expectedRoutines.has(name)
  );
  if (
    unexpected.length > 0 ||
    schemaBoundaryMismatch ||
    missingTablePrivileges.length > 0 ||
    missingRoutines.length > 0 ||
    excessiveRoutines.length > 0
  ) {
    throw new Error(
      "credit runtime privilege boundary mismatch" +
        (schemaBoundaryMismatch ? "; schema SELECT mismatch" : "") +
        (missingTablePrivileges.length > 0
          ? `; missing table privileges ${missingTablePrivileges.join(",")}`
          : "") +
        (missingRoutines.length > 0
          ? `; missing routines ${missingRoutines.join(",")}`
          : "") +
        (excessiveRoutines.length > 0
          ? `; excessive routines ${excessiveRoutines.join(",")}`
          : "") +
        (unexpected.length > 0 ? "; unexpected grant scope" : "")
    );
  }
}

export function assertProductionInspectionGrantScope(grants, databaseName) {
  assertExactScopedPrivileges(
    grants,
    databaseName,
    ["SELECT"],
    "inspection principal"
  );
}

export function assertExpandMigrationGrantScope(grants, databaseName) {
  assertExactScopedPrivileges(
    grants,
    databaseName,
    [
      "CREATE TEMPORARY TABLES",
      "ALTER",
      "INDEX",
      "REFERENCES",
      "SELECT",
      "INSERT",
      "UPDATE",
    ],
    "expand migration principal"
  );
}

export function assertCreditWalletMigrationGrantScope(
  grants,
  databaseName,
  requireSuper = false,
  allowIncompleteDefinerTablePrivileges = false
) {
  const schemaGrants = [];
  const grantedTablePrivileges = new Map();
  const revokedTablePrivileges = new Map();
  let globalSuper = false;
  let revokedGlobalSuper = false;
  const expectedTablePrivileges = new Map(
    Object.entries(creditWalletMigrationTablePrivileges).map(
      ([tableName, privileges]) => [tableName, new Set(privileges)]
    )
  );
  const expectedRoutines = new Set(creditWalletMigrationRoutineNames);
  for (const grant of grants) {
    const parsed = /^(GRANT|REVOKE) (.+) ON (.+) (?:TO|FROM) /i.exec(grant);
    const privileges = parsed?.[2]
      ?.split(",")
      .map(value => value.trim().toUpperCase());
    const scope = parsed ? parseGrantScope(parsed[3]) : null;
    if (
      parsed &&
      scope?.kind === "object" &&
      scope.databaseWildcard &&
      scope.objectWildcard &&
      privileges.length === 1 &&
      privileges[0] === "SUPER" &&
      !/\bWITH GRANT OPTION\b/i.test(grant)
    ) {
      if (parsed[1].toUpperCase() === "REVOKE") revokedGlobalSuper = true;
      else globalSuper = true;
      continue;
    }
    if (scope?.kind === "procedure") {
      const allowedRoutinePrivilege =
        parsed[1].toUpperCase() === "GRANT" &&
        scope.databaseName === databaseName &&
        expectedRoutines.has(scope.objectName) &&
        privileges.length > 0 &&
        privileges.every(privilege =>
          new Set(["ALTER ROUTINE", "EXECUTE"]).has(privilege)
        ) &&
        !/\bWITH GRANT OPTION\b/i.test(grant);
      if (!allowedRoutinePrivilege) schemaGrants.push(grant);
      continue;
    }
    if (
      parsed &&
      scope?.kind === "object" &&
      scope.databaseName === databaseName &&
      expectedTablePrivileges.has(scope.objectName) &&
      privileges.length > 0 &&
      privileges.every(privilege =>
        expectedTablePrivileges.get(scope.objectName).has(privilege)
      ) &&
      !/\bWITH GRANT OPTION\b/i.test(grant)
    ) {
      const target =
        parsed[1].toUpperCase() === "REVOKE"
          ? revokedTablePrivileges
          : grantedTablePrivileges;
      const tablePrivileges = target.get(scope.objectName) ?? new Set();
      for (const privilege of privileges) tablePrivileges.add(privilege);
      target.set(scope.objectName, tablePrivileges);
      continue;
    }
    schemaGrants.push(grant);
  }
  assertExactScopedPrivileges(
    schemaGrants,
    databaseName,
    [
      "CREATE",
      "CREATE TEMPORARY TABLES",
      "ALTER",
      "INDEX",
      "REFERENCES",
      "SELECT",
      "INSERT",
      "UPDATE",
      "TRIGGER",
      "CREATE ROUTINE",
      "ALTER ROUTINE",
    ],
    "credit wallet migration principal"
  );
  const tablePrivilegeMismatches = [];
  for (const [tableName, required] of expectedTablePrivileges) {
    const revoked = revokedTablePrivileges.get(tableName) ?? new Set();
    const effective = new Set(grantedTablePrivileges.get(tableName) ?? []);
    for (const privilege of revoked) effective.delete(privilege);
    const missing = [...required].filter(
      privilege => !effective.has(privilege)
    );
    const excessive = [...effective].filter(
      privilege => !required.has(privilege)
    );
    if (
      revoked.size > 0 ||
      excessive.length > 0 ||
      (!allowIncompleteDefinerTablePrivileges && missing.length > 0)
    ) {
      tablePrivilegeMismatches.push(
        `${tableName}:` +
          [
            ...(revoked.size > 0 ? ["contains revoke"] : []),
            ...(!allowIncompleteDefinerTablePrivileges && missing.length > 0
              ? [`missing ${missing.join("+")}`]
              : []),
            ...(excessive.length > 0
              ? [`excessive ${excessive.join("+")}`]
              : []),
          ].join("+")
      );
    }
  }
  if (tablePrivilegeMismatches.length > 0) {
    throw new Error(
      `credit wallet migration principal table privilege boundary mismatch; ${tablePrivilegeMismatches.join(",")}`
    );
  }
  const hasSuper = globalSuper && !revokedGlobalSuper;
  if (requireSuper && !hasSuper) {
    throw new Error(
      "credit wallet migration principal lacks global SUPER for triggers"
    );
  }
  if (!requireSuper && hasSuper) {
    throw new Error(
      "credit wallet migration principal has excessive global SUPER"
    );
  }
}

export function assertCreditProvisionerGrantScope(grants, databaseName) {
  const expectedTablePrivileges = new Map(
    productionRuntimeWritableTableNames.map(tableName => [
      tableName,
      new Set(["INSERT", "UPDATE", "DELETE"]),
    ])
  );
  for (const [tableName, privileges] of Object.entries(
    creditWalletMigrationTablePrivileges
  )) {
    const expected = expectedTablePrivileges.get(tableName) ?? new Set();
    for (const privilege of privileges) expected.add(privilege);
    expectedTablePrivileges.set(tableName, expected);
  }
  const observedTables = new Set();
  let hasCreateUser = false;
  let hasSchemaDelegation = false;
  let hasMigrationSchemaDelegation = false;
  let hasMysqlUserRead = false;
  const unexpected = [];

  for (const rawGrant of grants) {
    const grant = String(rawGrant);
    const parsed = /^GRANT (.+) ON (.+) TO /i.exec(grant);
    const hasGrantOption = /\bWITH GRANT OPTION\b/i.test(grant);
    if (!parsed) {
      unexpected.push(grant);
      continue;
    }
    const privileges = new Set(
      parsed[1].split(",").map(value => value.trim().toUpperCase())
    );
    const scope = parseGrantScope(parsed[2]);
    if (
      scope?.kind === "object" &&
      scope.databaseWildcard &&
      scope.objectWildcard &&
      privileges.size === 1 &&
      privileges.has("USAGE") &&
      !hasGrantOption
    ) {
      continue;
    }
    if (
      scope?.kind === "object" &&
      scope.databaseWildcard &&
      scope.objectWildcard &&
      privileges.size === 1 &&
      privileges.has("CREATE USER") &&
      !hasGrantOption
    ) {
      hasCreateUser = true;
      continue;
    }
    if (
      scope?.kind === "object" &&
      !scope.databaseWildcard &&
      scope.databaseName === "mysql" &&
      !scope.objectWildcard &&
      scope.objectName === "user" &&
      privileges.size === 1 &&
      privileges.has("SELECT") &&
      !hasGrantOption
    ) {
      hasMysqlUserRead = true;
      continue;
    }
    if (
      scope?.kind === "object" &&
      !scope.databaseWildcard &&
      scope.databaseName === databaseName &&
      scope.objectWildcard &&
      privileges.size === 2 &&
      privileges.has("SELECT") &&
      privileges.has("EXECUTE") &&
      hasGrantOption
    ) {
      hasSchemaDelegation = true;
      continue;
    }
    if (
      scope?.kind === "object" &&
      !scope.databaseWildcard &&
      scope.databaseName === databaseName &&
      scope.objectWildcard &&
      privileges.size === 4 &&
      privileges.has("CREATE") &&
      privileges.has("TRIGGER") &&
      privileges.has("CREATE ROUTINE") &&
      privileges.has("ALTER ROUTINE") &&
      hasGrantOption
    ) {
      hasMigrationSchemaDelegation = true;
      continue;
    }
    const expected =
      scope?.kind === "object" && scope.databaseName === databaseName
        ? expectedTablePrivileges.get(scope.objectName)
        : undefined;
    if (
      scope?.kind === "object" &&
      expected &&
      privileges.size === expected.size &&
      [...privileges].every(privilege => expected.has(privilege)) &&
      hasGrantOption
    ) {
      observedTables.add(scope.objectName);
      continue;
    }
    unexpected.push(grant);
  }

  const missingTables = [...expectedTablePrivileges.keys()].filter(
    tableName => !observedTables.has(tableName)
  );
  if (
    !hasCreateUser ||
    !hasSchemaDelegation ||
    !hasMigrationSchemaDelegation ||
    !hasMysqlUserRead ||
    missingTables.length > 0 ||
    unexpected.length > 0
  ) {
    throw new Error("credit provisioner privilege boundary mismatch");
  }
}

export function assertCreditWalletMigrationRoutineOwnership({
  automaticSpPrivileges,
  currentUser,
  databaseName,
  grants,
  routines,
}) {
  if (Number(automaticSpPrivileges) !== 1) {
    throw new Error(
      "credit wallet migration requires automatic stored-routine privileges"
    );
  }
  const expectedRoutines = new Set(creditWalletMigrationRoutineNames);
  const effectivePrivileges = new Map();
  for (const grant of grants) {
    const parsed = /^(GRANT|REVOKE) (.+) ON (.+) (?:TO|FROM) /i.exec(grant);
    if (!parsed) continue;
    const scope = parseGrantScope(parsed[3]);
    if (
      scope?.kind !== "procedure" ||
      scope.databaseWildcard ||
      scope.objectWildcard ||
      scope.databaseName !== databaseName ||
      !expectedRoutines.has(scope.objectName)
    ) {
      continue;
    }
    const privileges = effectivePrivileges.get(scope.objectName) ?? new Set();
    for (const privilege of parsed[2]
      .split(",")
      .map(value => value.trim().toUpperCase())) {
      if (parsed[1].toUpperCase() === "REVOKE") privileges.delete(privilege);
      else privileges.add(privilege);
    }
    effectivePrivileges.set(scope.objectName, privileges);
  }
  for (const routine of routines) {
    if (
      !expectedRoutines.has(routine.name) ||
      String(routine.definer) !== String(currentUser)
    ) {
      throw new Error(
        "credit wallet migration routine definer boundary mismatch"
      );
    }
    const privileges = effectivePrivileges.get(routine.name) ?? new Set();
    // Schema-level ALTER ROUTINE is already enforced by
    // assertCreditWalletMigrationGrantScope. With automatic_sp_privileges,
    // MySQL adds only the creator privilege that is not already effective, so
    // the per-procedure grant may legitimately contain EXECUTE alone.
    if (!privileges.has("EXECUTE")) {
      throw new Error(
        `credit wallet migration routine ${routine.name} lacks creator execute privilege`
      );
    }
  }
}

export function assertTriggerGrantScope(grants, databaseName, requireSuper) {
  const required = new Set([
    "CREATE",
    "CREATE TEMPORARY TABLES",
    "ALTER",
    "INDEX",
    "REFERENCES",
    "SELECT",
    "INSERT",
    "UPDATE",
    "TRIGGER",
    "CREATE ROUTINE",
  ]);
  const allowed = new Set();
  const revoked = new Set();
  let globalSuper = false;
  for (const grant of grants) {
    const revoke = /^REVOKE (.+) ON (.+) FROM /i.exec(grant);
    if (revoke) {
      const privileges = revoke[1]
        .split(",")
        .map(value => value.trim().toUpperCase());
      const scope = parseGrantScope(revoke[2]);
      if (
        scope?.kind === "object" &&
        scope.objectWildcard &&
        (scope.databaseWildcard ||
          (!scope.databaseWildcard && scope.databaseName === databaseName))
      ) {
        for (const privilege of required) {
          if (
            privileges.includes("ALL PRIVILEGES") ||
            privileges.includes(privilege)
          ) {
            revoked.add(privilege);
          }
        }
      }
      continue;
    }
    const match = /^GRANT (.+) ON (.+) TO /i.exec(grant);
    if (!match) continue;
    const privileges = match[1]
      .split(",")
      .map(value => value.trim().toUpperCase());
    const scope = parseGrantScope(match[2]);
    const global =
      scope?.kind === "object" &&
      scope.databaseWildcard &&
      scope.objectWildcard;
    const currentSchema =
      scope?.kind === "object" &&
      !scope.databaseWildcard &&
      scope.databaseName === databaseName &&
      scope.objectWildcard;
    const all = privileges.includes("ALL PRIVILEGES");
    if (global || currentSchema) {
      for (const privilege of required) {
        if (all || privileges.includes(privilege)) allowed.add(privilege);
      }
    }
    globalSuper ||= global && (all || privileges.includes("SUPER"));
  }
  const missing = [...required].filter(
    privilege => !allowed.has(privilege) || revoked.has(privilege)
  );
  if (missing.length > 0) {
    throw new Error(
      `migration principal lacks scoped privileges: ${missing.join(",")}`
    );
  }
  if (requireSuper && !globalSuper) {
    throw new Error("migration principal lacks global SUPER for triggers");
  }
}

export function assertCreditWalletBinlogFormat(runtime) {
  if (String(runtime.binlogFormat).toUpperCase() !== "ROW") {
    throw new Error("credit wallet migration requires ROW binary logging");
  }
}

export function assertProductionRuntimeValues(runtime) {
  if (runtime.version !== "8.4.11") {
    throw new Error("production migration requires MySQL 8.4.11");
  }
  if (!runtime.databaseName) {
    throw new Error("migration database must be selected");
  }
  if (
    runtime.characterSet !== "utf8mb4" ||
    runtime.collationName !== "utf8mb4_0900_ai_ci"
  ) {
    throw new Error("migration database default charset/collation mismatch");
  }
  if (
    runtime.sqlMode !== productionSchemaSqlMode ||
    runtime.timeZone !== "+00:00" ||
    runtime.transactionIsolation !== "READ-COMMITTED" ||
    Number(runtime.foreignKeyChecks) !== 1 ||
    String(runtime.defaultStorageEngine).toLowerCase() !== "innodb" ||
    String(runtime.innodbDefaultRowFormat).toLowerCase() !== "dynamic" ||
    Number(runtime.innodbPageSize) < 8192 ||
    Number(runtime.innodbForceRecovery) !== 0 ||
    Number(runtime.innodbReadOnly) !== 0 ||
    Number(runtime.readOnly) !== 0 ||
    Number(runtime.superReadOnly) !== 0 ||
    String(runtime.disabledStorageEngines)
      .toLowerCase()
      .split(",")
      .map(value => value.trim())
      .includes("innodb") ||
    Number(runtime.innodbStrictMode) !== 1 ||
    Number(runtime.lowerCaseTableNames) !== 0 ||
    Number(runtime.explicitTimestampDefaults) !== 1 ||
    Number(runtime.autoIncrementIncrement) !== 1 ||
    Number(runtime.autoIncrementOffset) !== 1 ||
    Number(runtime.informationSchemaStatsExpiry) !== 0 ||
    Number(runtime.sqlQuoteShowCreate) !== 1 ||
    Number(runtime.showCreateTableVerbosity) !== 1 ||
    Number(runtime.sqlSafeUpdates) !== 0 ||
    Number(runtime.uniqueChecks) !== 1 ||
    Number(runtime.transactionReadOnly) !== 0 ||
    Number(runtime.timestampIsDefault) !== 1 ||
    Number(runtime.insertId) !== 0 ||
    Number(runtime.sqlSelectLimitIsDefault) !== 1 ||
    Number(runtime.sqlBigSelects) !== 1 ||
    Number(runtime.schemaReadOnly) !== 0 ||
    runtime.defaultEncryption !== "NO"
  ) {
    throw new Error("production migration session contract mismatch");
  }
}

async function assertCheckConstraintsEnforced(connection) {
  await connection.query(
    "CREATE TEMPORARY TABLE `_leaderbot_check_enforcement_probe` (`value` int PRIMARY KEY, CONSTRAINT `_leaderbot_check_probe_positive` CHECK (`value` > 0))"
  );
  let enforced = false;
  try {
    await connection.query(
      "INSERT INTO `_leaderbot_check_enforcement_probe` (`value`) VALUES (-1)"
    );
  } catch (error) {
    enforced =
      error?.code === "ER_CHECK_CONSTRAINT_VIOLATED" ||
      Number(error?.errno) === 3819;
  } finally {
    await connection.query(
      "DROP TEMPORARY TABLE `_leaderbot_check_enforcement_probe`"
    );
  }
  if (!enforced) {
    throw new Error("MySQL CHECK constraint enforcement is unavailable");
  }
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function productionMigrationSetSha256(migrations) {
  return sha256(
    JSON.stringify(
      migrations.map(migration => ({
        idx: migration.idx,
        when: Number(migration.when),
        tag: migration.tag,
        sha256: migration.sha256,
      }))
    )
  );
}

export function normalizeShowCreate(value) {
  const normalizedWhitespace = String(value)
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map(line => line.trimEnd())
    .join("\n")
    .trimEnd();
  return stripVolatileTableAutoIncrement(normalizedWhitespace);
}

function stripVolatileTableAutoIncrement(value) {
  if (!/^CREATE TABLE\b/i.test(value)) return value;
  const bodyEnd = findCreateBodyEnd(value);
  if (bodyEnd < 0) return value;
  const prefix = value.slice(0, bodyEnd + 1);
  const tableOptions = value.slice(bodyEnd + 1);
  let output = "";
  let quote = null;
  for (let index = 0; index < tableOptions.length; index += 1) {
    const character = tableOptions[index];
    if (quote) {
      output += character;
      if (character === "\\" && quote !== "`") {
        index += 1;
        if (index < tableOptions.length) output += tableOptions[index];
        continue;
      }
      if (character === quote) {
        if (tableOptions[index + 1] === quote) {
          index += 1;
          output += tableOptions[index];
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      output += character;
      continue;
    }
    const volatileOption = tableOptions
      .slice(index)
      .match(/^\s+AUTO_INCREMENT=\d+(?=\s|$)/i)?.[0];
    if (volatileOption) {
      index += volatileOption.length - 1;
      continue;
    }
    output += character;
  }
  return `${prefix}${output}`;
}

function findCreateBodyEnd(value) {
  let quote = null;
  let depth = 0;
  let bodyStarted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === "\\" && quote !== "`") {
        index += 1;
        continue;
      }
      if (character === quote) {
        if (value[index + 1] === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") {
      depth += 1;
      bodyStarted = true;
    } else if (character === ")" && bodyStarted) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

export function normalizeSqlOutsideQuotedValues(value) {
  const input = String(value).replaceAll("\r\n", "\n").trim();
  let output = "";
  let quote = null;
  let pendingWhitespace = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quote) {
      output += character;
      if (character === "\\" && quote !== "`") {
        index += 1;
        if (index < input.length) output += input[index];
        continue;
      }
      if (character === quote) {
        if (input[index + 1] === quote) {
          index += 1;
          output += input[index];
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      if (pendingWhitespace && output) output += " ";
      pendingWhitespace = false;
      quote = character;
      output += character;
      continue;
    }
    if (/\s/.test(character)) {
      pendingWhitespace = true;
      continue;
    }
    if (pendingWhitespace && output) output += " ";
    pendingWhitespace = false;
    output += character;
  }
  if (quote)
    throw new Error("unterminated quoted SQL value in schema contract");
  return output;
}

export async function captureProductionSchemaState(
  connection,
  { includePrivilegedObjects = true, privilegedObjectNamePrefix = "" } = {}
) {
  const [objects] = await connection.query(
    "SELECT `TABLE_NAME` AS name,`TABLE_TYPE` AS objectType FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY `TABLE_TYPE`,`TABLE_NAME`"
  );
  const tables = {};
  const views = {};
  for (const object of objects) {
    if (object.name === "__drizzle_migrations") continue;
    const escapedName = object.name.replaceAll("`", "``");
    if (object.objectType === "BASE TABLE") {
      const [[created]] = await connection.query(
        `SHOW CREATE TABLE \`${escapedName}\``
      );
      tables[object.name] = sha256(
        normalizeShowCreate(created["Create Table"])
      );
      continue;
    }
    if (object.objectType === "VIEW") {
      const [[created]] = await connection.query(
        `SHOW CREATE VIEW \`${escapedName}\``
      );
      views[object.name] = sha256(normalizeShowCreate(created["Create View"]));
      continue;
    }
    throw new Error(`unsupported database object type ${object.objectType}`);
  }

  const triggers = {};
  const routines = {};
  if (includePrivilegedObjects) {
    const [[identity]] = await connection.query(
      "SELECT CURRENT_USER() AS currentUser"
    );
    const [triggerRows] = await connection.query(
      "SELECT `TRIGGER_NAME` AS name,`DEFINER` AS definer,`ACTION_TIMING` AS timing,`EVENT_MANIPULATION` AS eventName,`EVENT_OBJECT_TABLE` AS tableName,`ACTION_ORIENTATION` AS orientation,`ACTION_ORDER` AS actionOrder,`ACTION_CONDITION` AS actionCondition,`ACTION_STATEMENT` AS actionStatement,`SQL_MODE` AS sqlMode,`CHARACTER_SET_CLIENT` AS characterSetClient,`COLLATION_CONNECTION` AS collationConnection,`DATABASE_COLLATION` AS databaseCollation FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY `TRIGGER_NAME`"
    );
    for (const trigger of triggerRows) {
      if (
        privilegedObjectNamePrefix &&
        !trigger.name.startsWith(privilegedObjectNamePrefix)
      ) {
        continue;
      }
      triggers[trigger.name] = sha256(
        JSON.stringify(canonicalTriggerTuple(trigger, identity.currentUser))
      );
    }

    const [routineRows] = await connection.query(
      "SELECT `ROUTINE_NAME` AS name,`ROUTINE_TYPE` AS routineType,`DEFINER` AS definer,`SECURITY_TYPE` AS securityType,`IS_DETERMINISTIC` AS isDeterministic,`SQL_DATA_ACCESS` AS sqlDataAccess,`SQL_MODE` AS sqlMode,`CHARACTER_SET_CLIENT` AS characterSetClient,`COLLATION_CONNECTION` AS collationConnection,`DATABASE_COLLATION` AS databaseCollation FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE() ORDER BY `ROUTINE_NAME`"
    );
    for (const routine of routineRows) {
      if (
        privilegedObjectNamePrefix &&
        !routine.name.startsWith(privilegedObjectNamePrefix)
      ) {
        continue;
      }
      if (routine.routineType !== "PROCEDURE") {
        throw new Error(
          `unsupported production routine type ${routine.routineType}`
        );
      }
      const escapedName = routine.name.replaceAll("`", "``");
      const [[created]] = await connection.query(
        `SHOW CREATE PROCEDURE \`${escapedName}\``
      );
      routines[routine.name] = sha256(
        JSON.stringify(
          canonicalRoutineTuple(
            routine,
            created["Create Procedure"],
            identity.currentUser
          )
        )
      );
    }

    const [[programmable]] = await connection.query(
      "SELECT COUNT(*) AS eventCount FROM information_schema.EVENTS WHERE EVENT_SCHEMA=DATABASE()"
    );
    if (Number(programmable.eventCount) !== 0) {
      throw new Error("production schema contract requires no events");
    }
  }

  return { tables, views, triggers, routines };
}

export function canonicalTriggerTuple(trigger, currentUser) {
  if (!currentUser || trigger.definer !== currentUser) {
    throw new Error("trigger definer does not match the migration principal");
  }
  return {
    definer: "$MIGRATION_USER",
    timing: trigger.timing,
    eventName: trigger.eventName,
    tableName: trigger.tableName,
    orientation: trigger.orientation,
    actionOrder: Number(trigger.actionOrder),
    actionCondition: trigger.actionCondition,
    actionStatement: normalizeSqlOutsideQuotedValues(trigger.actionStatement),
    sqlMode: trigger.sqlMode,
    characterSetClient: trigger.characterSetClient,
    collationConnection: trigger.collationConnection,
    databaseCollation: trigger.databaseCollation,
  };
}

export function canonicalRoutineTuple(routine, showCreate, currentUser) {
  if (!currentUser || routine.definer !== currentUser) {
    throw new Error("routine definer does not match the migration principal");
  }
  const normalizedCreate = normalizeShowCreate(showCreate).replace(
    /^CREATE DEFINER=`(?:``|[^`])+`@`(?:``|[^`])+` PROCEDURE\b/i,
    "CREATE DEFINER=$MIGRATION_USER PROCEDURE"
  );
  if (
    !normalizedCreate.startsWith("CREATE DEFINER=$MIGRATION_USER PROCEDURE")
  ) {
    throw new Error("routine SHOW CREATE definer is unsupported");
  }
  return {
    definer: "$MIGRATION_USER",
    routineType: routine.routineType,
    securityType: routine.securityType,
    isDeterministic: routine.isDeterministic,
    sqlDataAccess: routine.sqlDataAccess,
    sqlMode: routine.sqlMode,
    characterSetClient: routine.characterSetClient,
    collationConnection: routine.collationConnection,
    databaseCollation: routine.databaseCollation,
    createStatement: normalizeSqlOutsideQuotedValues(normalizedCreate),
  };
}

export async function captureMigrationHistory(connection) {
  const [[exists]] = await connection.query(
    "SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='__drizzle_migrations'"
  );
  if (Number(exists.count) === 0) return null;
  const [[created]] = await connection.query(
    "SHOW CREATE TABLE `__drizzle_migrations`"
  );
  const [[table]] = await connection.query(
    "SELECT `AUTO_INCREMENT` AS nextId FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='__drizzle_migrations'"
  );
  const [rows] = await connection.query(
    "SELECT `id`,`hash`,`created_at` AS createdAt FROM `__drizzle_migrations` ORDER BY `id`"
  );
  return {
    showCreateSha256: sha256(normalizeShowCreate(created["Create Table"])),
    nextId: Number(table.nextId),
    rows: rows.map(row => ({
      id: Number(row.id),
      hash: row.hash,
      createdAt: Number(row.createdAt),
    })),
  };
}

export function assertExactSchemaState(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} schema fingerprint mismatch`);
  }
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalPrettyJson(value) {
  const serialized = JSON.stringify(
    value,
    (_key, nestedValue) => {
      if (
        !nestedValue ||
        typeof nestedValue !== "object" ||
        Array.isArray(nestedValue)
      ) {
        return nestedValue;
      }
      return Object.fromEntries(
        Object.keys(nestedValue)
          .sort()
          .map(key => [key, nestedValue[key]])
      );
    },
    2
  );
  if (serialized === undefined) {
    throw new Error("production schema contract must be JSON-serializable");
  }
  return serialized;
}
