/* global process, URL */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import mysql from "mysql2/promise";

const value = process.env.MYSQL_REHEARSAL_URL?.trim();
if (!value) throw new Error("MYSQL_REHEARSAL_URL is required");
const adminUrl = new URL(value);
const drizzleDirectory = path.resolve("drizzle");
const files = (await fs.readdir(drizzleDirectory))
  .filter(name => /^\d{4}_.+[.]sql$/.test(name))
  .sort();
const through0017 = files.filter(name => Number(name.slice(0, 4)) <= 17);
const migration0018 = files.filter(name =>
  name.startsWith("0018_credit_checkout_reservation")
);
assert(
  through0017.at(-1)?.startsWith("0017_") === true,
  "0017 baseline is required"
);
assert(migration0018.length === 1, "exactly one 0018 migration is required");
const statements0018 = await readStatements(migration0018[0]);
const expectedRoutines = [
  "credit_apply_chargeback_debit",
  "credit_apply_chargeback_restore",
  "credit_apply_refund_debit",
  "credit_commit_reservation",
  "credit_consume_checkout_capability",
  "credit_create_reservation_hold",
  "credit_erase_wallet",
  "credit_expire_pristine_checkout",
  "credit_expire_reservation",
  "credit_freeze_wallet_for_review",
  "credit_grant_purchase",
  "credit_mark_reservation_provider_accepted",
  "credit_mark_reservation_transport_started",
  "credit_release_rejected_reservation",
  "credit_release_reservation",
  "credit_reserve_checkout_intent",
  "credit_scrub_terminal_reservation",
].sort();
assert(
  statements0018.length === 5,
  "0018 must contain five reviewed statements"
);
assert(
  statements0018[0] === "DROP PROCEDURE IF EXISTS `credit_create_wallet`;",
  "0018 must retire standalone wallet creation first"
);
assert(
  statements0018[1].includes(
    "CREATE PROCEDURE `credit_reserve_checkout_intent`"
  ) && statements0018[1].includes("SQL SECURITY DEFINER"),
  "0018 must install the narrow definer routine"
);
assert(
  statements0018[2] ===
    "DROP PROCEDURE IF EXISTS `credit_expire_pristine_checkout`;" &&
    statements0018[3].includes(
      "CREATE PROCEDURE `credit_expire_pristine_checkout`"
    ) &&
    statements0018[3].includes("SQL SECURITY DEFINER"),
  "0018 must install the pristine checkout retention routine"
);
assert(
  statements0018[4] ===
    "CREATE INDEX `billing_intents_credit_capability_expiry_idx` ON `billing_intents` (`kind`,`status`,`checkout_capability_expires_at`,`intent_id`);",
  "0018 must install the bounded pristine checkout discovery index"
);

const databases = {
  fresh: "leaderbot_0018_credit_checkout_fresh_rehearsal",
  upgrade: "leaderbot_0018_credit_checkout_upgrade_rehearsal",
};
const admin = await mysql.createConnection(options());
try {
  const [[server]] = await admin.query(
    "SELECT VERSION() AS version,@@innodb_page_size AS pageSize,@@GLOBAL.binlog_format AS binlogFormat"
  );
  assert(String(server.version) === "8.4.11", "MySQL 8.4.11 is required");
  assert(
    [8192, 16384].includes(Number(server.pageSize)),
    "8KB or 16KB pages are required"
  );
  assert(
    String(server.binlogFormat) === "ROW",
    "binlog_format=ROW is required"
  );
  for (const database of Object.values(databases)) {
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.query(
      `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`
    );
  }

  await withDatabase(databases.fresh, async connection => {
    await applyFiles(connection, [...through0017, migration0018[0]]);
    await verify(connection, "fresh");
  });
  await withDatabase(databases.upgrade, async connection => {
    await applyFiles(connection, through0017);
    const [[before]] = await connection.query(
      "SELECT COUNT(*) AS count FROM information_schema.routines WHERE routine_schema=DATABASE() AND routine_name='credit_create_wallet'"
    );
    assert(
      Number(before.count) === 1,
      "0017 baseline must expose credit_create_wallet"
    );
    await applyStatements(connection, statements0018);
    await verify(connection, "upgrade");
  });

  console.log(
    `0018 checkout reservation rehearsal passed on ${String(server.version)} with ${String(server.pageSize)} byte pages: fresh and exact 0017 upgrade, ${String(expectedRoutines.length)} routines, atomic wallet+intent reservation.`
  );
} finally {
  for (const database of Object.values(databases)) {
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
  }
  await admin.end();
}

async function verify(connection, label) {
  const [routines] = await connection.query(
    "SELECT routine_name FROM information_schema.routines WHERE routine_schema=DATABASE() AND routine_type='PROCEDURE' ORDER BY routine_name"
  );
  const names = routines.map(row => row.ROUTINE_NAME ?? row.routine_name);
  assert(
    JSON.stringify(names.sort()) === JSON.stringify(expectedRoutines),
    `${label} must expose the exact reviewed ${String(expectedRoutines.length)}-procedure inventory`
  );
  const suffix = `${label}-${Date.now()}`;
  const [workspace] = await connection.query(
    "INSERT INTO `workspaces` (`name`,`slug`) VALUES (?,?)",
    ["0018 rehearsal", `credit-${suffix}`]
  );
  await connection.query(
    "INSERT INTO `billing_execution_controls` (`workspace_id`,`mode`,`commercial_enabled`,`authorization_epoch`) VALUES (?,'test',true,2)",
    [workspace.insertId]
  );
  const [channel] = await connection.query(
    "INSERT INTO `channelConnections` (`workspaceId`,`channel`,`status`,`externalId`,`bindingEpoch`) VALUES (?,'facebook_messenger','connected',?,1)",
    [workspace.insertId, `page-${suffix}`]
  );
  const userKey = "a".repeat(64);
  await connection.query(
    "INSERT INTO `messenger_privacy_subjects` (`workspace_id`,`channel_connection_id`,`user_key`,`privacy_epoch`,`status`) VALUES (?,?,?,1,'active')",
    [workspace.insertId, channel.insertId, userKey]
  );
  const intentId = randomUUID();
  const walletId = randomUUID();
  const sha = input => createHash("sha256").update(input).digest("hex");
  const [result] = await connection.query(
    "CALL `credit_reserve_checkout_intent`(?,?,?,'test',?,1,1,?,?,2,'premium_images_8_medium_v1','4.99',8,'Leaderbot - 8 premium beeldcredits',?,?,?,?,TIMESTAMPADD(MINUTE,10,CURRENT_TIMESTAMP))",
    [
      intentId,
      walletId,
      workspace.insertId,
      channel.insertId,
      userKey,
      sha(`financial:${suffix}`),
      sha(`metadata:${suffix}`),
      `credit-payment:${intentId}`,
      `credit-checkout:v1:${sha(`scope:${suffix}`)}`,
      sha(`capability:${suffix}`),
    ]
  );
  assert(result[0][0].result === "applied", `${label} reservation must apply`);
  const [[counts]] = await connection.query(
    "SELECT (SELECT COUNT(*) FROM credit_wallets WHERE wallet_id=?) AS wallets,(SELECT COUNT(*) FROM billing_intents WHERE intent_id=? AND kind='credit_purchase') AS intents",
    [walletId, intentId]
  );
  assert(
    Number(counts.wallets) === 1 && Number(counts.intents) === 1,
    `${label} must atomically persist wallet and intent`
  );
}

async function withDatabase(database, action) {
  const connection = await mysql.createConnection({ ...options(), database });
  try {
    await connection.query("SET SESSION sql_require_primary_key=ON");
    await connection.query(
      "SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED"
    );
    await action(connection);
  } finally {
    await connection.end();
  }
}

function options() {
  return {
    host: adminUrl.hostname,
    port: Number(adminUrl.port || 3306),
    user: decodeURIComponent(adminUrl.username),
    password: decodeURIComponent(adminUrl.password),
    socketPath: adminUrl.searchParams.get("socket") || undefined,
  };
}

async function readStatements(filename) {
  return (await fs.readFile(path.join(drizzleDirectory, filename), "utf8"))
    .split("--> statement-breakpoint")
    .map(statement => statement.trim())
    .filter(Boolean);
}

async function applyFiles(connection, filenames) {
  for (const filename of filenames)
    await applyStatements(connection, await readStatements(filename));
}

async function applyStatements(connection, statements) {
  for (const statement of statements) await connection.query(statement);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
