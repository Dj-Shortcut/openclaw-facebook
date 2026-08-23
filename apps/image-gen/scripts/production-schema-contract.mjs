import crypto from "node:crypto";

export const productionSchemaContractVersion = 4;
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
    !new Set(["inspection", "runtime", "expand", "bootstrap"]).has(
      privilegeProfile
    )
  ) {
    throw new Error("production database privilege profile is unsupported");
  }
  await configureProductionSchemaSession(connection);
  const [[runtime]] = await connection.query(
    "SELECT VERSION() AS version,DATABASE() AS databaseName,@@SESSION.sql_mode AS sqlMode,@@SESSION.time_zone AS timeZone,@@SESSION.transaction_isolation AS transactionIsolation,@@SESSION.foreign_key_checks AS foreignKeyChecks,@@SESSION.default_storage_engine AS defaultStorageEngine,@@GLOBAL.innodb_default_row_format AS innodbDefaultRowFormat,@@GLOBAL.innodb_page_size AS innodbPageSize,@@GLOBAL.innodb_force_recovery AS innodbForceRecovery,@@GLOBAL.innodb_read_only AS innodbReadOnly,@@GLOBAL.read_only AS readOnly,@@GLOBAL.super_read_only AS superReadOnly,@@GLOBAL.disabled_storage_engines AS disabledStorageEngines,@@SESSION.innodb_strict_mode AS innodbStrictMode,@@lower_case_table_names AS lowerCaseTableNames,@@SESSION.explicit_defaults_for_timestamp AS explicitTimestampDefaults,@@SESSION.auto_increment_increment AS autoIncrementIncrement,@@SESSION.auto_increment_offset AS autoIncrementOffset,@@SESSION.information_schema_stats_expiry AS informationSchemaStatsExpiry,@@SESSION.sql_quote_show_create AS sqlQuoteShowCreate,@@SESSION.show_create_table_verbosity AS showCreateTableVerbosity,@@SESSION.sql_safe_updates AS sqlSafeUpdates,@@SESSION.unique_checks AS uniqueChecks,@@SESSION.transaction_read_only AS transactionReadOnly,(ABS(@@SESSION.timestamp-UNIX_TIMESTAMP()) <= 1) AS timestampIsDefault,@@SESSION.insert_id AS insertId,(@@SESSION.sql_select_limit = 18446744073709551615) AS sqlSelectLimitIsDefault,@@SESSION.sql_big_selects AS sqlBigSelects,@@GLOBAL.log_bin AS logBin,@@GLOBAL.log_bin_trust_function_creators AS logBinTrustFunctionCreators"
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
  } else if (privilegeProfile === "expand") {
    assertExpandMigrationGrantScope(grants, runtime.databaseName);
    await assertCheckConstraintsEnforced(connection);
  } else {
    await assertCheckConstraintsEnforced(connection);
    assertTriggerGrantScope(
      grants,
      runtime.databaseName,
      Number(runtime.logBin) === 1 &&
        Number(runtime.logBinTrustFunctionCreators) !== 1
    );
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
    const scope = parsed[3].replaceAll("`", "");
    if (
      scope === "*.*" &&
      privileges.length === 1 &&
      privileges[0] === "USAGE"
    ) {
      continue;
    }
    if (scope !== `${databaseName}.*` || /\bWITH GRANT OPTION\b/i.test(grant)) {
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
      const scope = revoke[2].replaceAll("`", "");
      if (scope === "*.*" || scope === `${databaseName}.*`) {
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
    const scope = match[2].replaceAll("`", "");
    const global = scope === "*.*";
    const currentSchema = scope === `${databaseName}.*`;
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
  { includePrivilegedObjects = true } = {}
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
  if (includePrivilegedObjects) {
    const [[identity]] = await connection.query(
      "SELECT CURRENT_USER() AS currentUser"
    );
    const [triggerRows] = await connection.query(
      "SELECT `TRIGGER_NAME` AS name,`DEFINER` AS definer,`ACTION_TIMING` AS timing,`EVENT_MANIPULATION` AS eventName,`EVENT_OBJECT_TABLE` AS tableName,`ACTION_ORIENTATION` AS orientation,`ACTION_ORDER` AS actionOrder,`ACTION_CONDITION` AS actionCondition,`ACTION_STATEMENT` AS actionStatement,`SQL_MODE` AS sqlMode,`CHARACTER_SET_CLIENT` AS characterSetClient,`COLLATION_CONNECTION` AS collationConnection,`DATABASE_COLLATION` AS databaseCollation FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY `TRIGGER_NAME`"
    );
    for (const trigger of triggerRows) {
      triggers[trigger.name] = sha256(
        JSON.stringify(canonicalTriggerTuple(trigger, identity.currentUser))
      );
    }

    const [[programmable]] = await connection.query(
      "SELECT (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE()) AS routineCount,(SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA=DATABASE()) AS eventCount"
    );
    if (
      Number(programmable.routineCount) !== 0 ||
      Number(programmable.eventCount) !== 0
    ) {
      throw new Error(
        "production schema contract requires no routines or events"
      );
    }
  }

  return { tables, views, triggers };
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
