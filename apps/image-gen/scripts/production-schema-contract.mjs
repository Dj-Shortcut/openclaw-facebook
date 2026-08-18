import crypto from "node:crypto";

export const productionSchemaContractVersion = 1;
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
  await connection.query("SET NAMES utf8mb4 COLLATE utf8mb4_0900_ai_ci");
}

export async function assertProductionMigrationRuntime(connection) {
  await configureProductionSchemaSession(connection);
  const [[runtime]] = await connection.query(
    "SELECT VERSION() AS version,DATABASE() AS databaseName,@@SESSION.sql_mode AS sqlMode,@@SESSION.time_zone AS timeZone,@@SESSION.transaction_isolation AS transactionIsolation,@@SESSION.foreign_key_checks AS foreignKeyChecks,@@SESSION.default_storage_engine AS defaultStorageEngine,@@GLOBAL.innodb_default_row_format AS innodbDefaultRowFormat,@@lower_case_table_names AS lowerCaseTableNames,@@SESSION.explicit_defaults_for_timestamp AS explicitTimestampDefaults,@@SESSION.auto_increment_increment AS autoIncrementIncrement,@@SESSION.auto_increment_offset AS autoIncrementOffset,@@SESSION.information_schema_stats_expiry AS informationSchemaStatsExpiry,@@SESSION.sql_quote_show_create AS sqlQuoteShowCreate,@@SESSION.show_create_table_verbosity AS showCreateTableVerbosity"
  );
  const [[schema]] = await connection.query(
    "SELECT DEFAULT_CHARACTER_SET_NAME AS characterSet,DEFAULT_COLLATION_NAME AS collationName,DEFAULT_ENCRYPTION AS defaultEncryption FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=DATABASE()"
  );
  assertProductionRuntimeValues({ ...runtime, ...schema });
  await assertCheckConstraintsEnforced(connection);
  return { databaseName: runtime.databaseName };
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
    Number(runtime.lowerCaseTableNames) !== 0 ||
    Number(runtime.explicitTimestampDefaults) !== 1 ||
    Number(runtime.autoIncrementIncrement) !== 1 ||
    Number(runtime.autoIncrementOffset) !== 1 ||
    Number(runtime.informationSchemaStatsExpiry) !== 0 ||
    Number(runtime.sqlQuoteShowCreate) !== 1 ||
    Number(runtime.showCreateTableVerbosity) !== 1 ||
    runtime.defaultEncryption !== "NO"
  ) {
    throw new Error("production migration session contract mismatch");
  }
}

async function assertCheckConstraintsEnforced(connection) {
  await connection.query(
    "CREATE TEMPORARY TABLE `_leaderbot_check_enforcement_probe` (`value` int, CONSTRAINT `_leaderbot_check_probe_positive` CHECK (`value` > 0))"
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

export async function captureProductionSchemaState(connection) {
  const [[identity]] = await connection.query(
    "SELECT CURRENT_USER() AS currentUser"
  );
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

  const [triggerRows] = await connection.query(
    "SELECT `TRIGGER_NAME` AS name,`DEFINER` AS definer,`ACTION_TIMING` AS timing,`EVENT_MANIPULATION` AS eventName,`EVENT_OBJECT_TABLE` AS tableName,`ACTION_ORIENTATION` AS orientation,`ACTION_ORDER` AS actionOrder,`ACTION_CONDITION` AS actionCondition,`ACTION_STATEMENT` AS actionStatement,`SQL_MODE` AS sqlMode,`CHARACTER_SET_CLIENT` AS characterSetClient,`COLLATION_CONNECTION` AS collationConnection,`DATABASE_COLLATION` AS databaseCollation FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() ORDER BY `TRIGGER_NAME`"
  );
  const triggers = {};
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
