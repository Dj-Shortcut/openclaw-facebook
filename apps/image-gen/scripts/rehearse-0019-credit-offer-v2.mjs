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
const through0018 = files.filter(name => Number(name.slice(0, 4)) <= 18);
const migration0019 = files.filter(name => name === "0019_credit_offer_v2.sql");
assert(
  through0018.at(-1)?.startsWith("0018_") === true,
  "0018 baseline is required"
);
assert(migration0019.length === 1, "exactly one 0019 migration is required");
const statements0019 = await readStatements(migration0019[0]);
assert(
  statements0019.length === 4,
  "0019 must contain four reviewed statements"
);
assert(
  statements0019[0] ===
    "DROP PROCEDURE IF EXISTS `credit_reserve_checkout_intent`;" &&
    statements0019[1].includes(
      "CREATE PROCEDURE `credit_reserve_checkout_intent`"
    ) &&
    statements0019[1].includes("premium_images_8_medium_v1") &&
    statements0019[1].includes("premium_images_9_medium_v2"),
  "0019 must install the dual-version checkout reservation"
);
assert(
  statements0019[2] ===
    "DROP PROCEDURE IF EXISTS `credit_freeze_wallet_for_review`;" &&
    statements0019[3].includes(
      "CREATE PROCEDURE `credit_freeze_wallet_for_review`"
    ) &&
    statements0019[3].includes(
      "payment.`gross_amount`=intent.`expected_amount`"
    ) &&
    !statements0019[3].includes("payment.`gross_amount`=4.99"),
  "0019 review evidence must be driven by the immutable intent amount"
);

const v1 = Object.freeze({
  code: "premium_images_8_medium_v1",
  amount: "4.99",
  credits: 8,
  description: "Leaderbot - 8 premium beeldcredits",
});
const v2 = Object.freeze({
  code: "premium_images_9_medium_v2",
  amount: "5.00",
  credits: 9,
  description: "Leaderbot - 9 premium beeldcredits",
});

const databases = {
  fresh: "leaderbot_0019_credit_offer_fresh_rehearsal",
  upgrade: "leaderbot_0019_credit_offer_upgrade_rehearsal",
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
    await applyFiles(connection, [...through0018, migration0019[0]]);
    await verifyOfferReservation(connection, "fresh");
  });
  await withDatabase(databases.upgrade, async connection => {
    await applyFiles(connection, through0018);
    const historicalV1 = await seedHistoricalV1Reservation(
      connection,
      "upgrade"
    );
    await applyStatements(connection, statements0019);
    await verifyOfferReservation(connection, "upgrade", historicalV1);
  });

  console.log(
    `0019 credit offer v2 rehearsal passed on ${String(server.version)} with ${String(server.pageSize)} byte pages: fresh and exact 0018 upgrade, immutable pre-0019 v1 replay, fresh v1 rejection, exact v2 reservation, and mixed-snapshot rejection.`
  );
} finally {
  for (const database of Object.values(databases)) {
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
  }
  await admin.end();
}

async function createReservationScope(connection, label) {
  const suffix = `${label}-${Date.now()}`;
  const [workspace] = await connection.query(
    "INSERT INTO `workspaces` (`name`,`slug`) VALUES (?,?)",
    ["0019 rehearsal", `credit-${suffix}`]
  );
  await connection.query(
    "INSERT INTO `billing_execution_controls` (`workspace_id`,`mode`,`commercial_enabled`,`authorization_epoch`) VALUES (?,'test',true,2)",
    [workspace.insertId]
  );
  const [channel] = await connection.query(
    "INSERT INTO `channelConnections` (`workspaceId`,`channel`,`status`,`externalId`,`bindingEpoch`) VALUES (?,'facebook_messenger','connected',?,1)",
    [workspace.insertId, `page-${suffix}`]
  );
  await connection.query(
    "INSERT INTO `messenger_privacy_subjects` (`workspace_id`,`channel_connection_id`,`user_key`,`privacy_epoch`,`status`) VALUES (?,?,?,1,'active'),(?,?,?,1,'active'),(?,?,?,1,'active')",
    [
      workspace.insertId,
      channel.insertId,
      "a".repeat(64),
      workspace.insertId,
      channel.insertId,
      "b".repeat(64),
      workspace.insertId,
      channel.insertId,
      "c".repeat(64),
    ]
  );

  return {
    workspaceId: workspace.insertId,
    channelConnectionId: channel.insertId,
    suffix,
  };
}

async function seedHistoricalV1Reservation(connection, label) {
  const scope = await createReservationScope(connection, label);
  const reservation = await reserve(connection, {
    workspaceId: scope.workspaceId,
    channelConnectionId: scope.channelConnectionId,
    suffix: `${scope.suffix}-historical-v1`,
    userKey: "a".repeat(64),
    offer: v1,
  });
  assert(
    reservation.result === "applied",
    `${label} pre-0019 v1 reservation must apply under 0018`
  );
  return { scope, reservation };
}

async function verifyOfferReservation(connection, label, historicalV1) {
  const scope =
    historicalV1?.scope ?? (await createReservationScope(connection, label));
  if (historicalV1) {
    const replay = await reserve(connection, historicalV1.reservation);
    assert(
      replay.result === "already_applied",
      `${label} immutable pre-0019 v1 reservation must replay`
    );
  }

  const rejectedV1WalletId = randomUUID();
  let freshV1Rejected = false;
  let freshV1Result = "no_result";
  try {
    const result = await reserve(connection, {
      workspaceId: scope.workspaceId,
      channelConnectionId: scope.channelConnectionId,
      suffix: `${scope.suffix}-fresh-v1`,
      walletId: rejectedV1WalletId,
      userKey: "c".repeat(64),
      offer: v1,
    });
    freshV1Result = String(result.result);
  } catch (error) {
    freshV1Result = String(error?.sqlMessage ?? error?.message ?? error);
    freshV1Rejected = String(
      error?.sqlMessage ?? error?.message ?? error
    ).includes("legacy credit offer is replay-only");
  }
  assert(
    freshV1Rejected,
    `${label} must reject a fresh v1 reservation after 0019 (${freshV1Result})`
  );
  const [[rejectedV1Wallet]] = await connection.query(
    "SELECT COUNT(*) AS count FROM credit_wallets WHERE wallet_id=?",
    [rejectedV1WalletId]
  );
  assert(
    Number(rejectedV1Wallet.count) === 0,
    `${label} fresh v1 rejection must not create an empty wallet`
  );

  const second = await reserve(connection, {
    workspaceId: scope.workspaceId,
    channelConnectionId: scope.channelConnectionId,
    suffix: `${scope.suffix}-v2`,
    userKey: "b".repeat(64),
    offer: v2,
  });
  assert(second.result === "applied", `${label} v2 reservation must apply`);
  const [[storedV2]] = await connection.query(
    "SELECT plan_code,expected_amount,credit_count,mollie_description FROM billing_intents WHERE intent_id=?",
    [second.intentId]
  );
  assert(
    storedV2.plan_code === v2.code &&
      String(storedV2.expected_amount) === v2.amount &&
      Number(storedV2.credit_count) === v2.credits &&
      storedV2.mollie_description === v2.description,
    `${label} v2 intent must preserve the exact server-owned snapshot`
  );

  let mixedRejected = false;
  try {
    await reserve(connection, {
      workspaceId: scope.workspaceId,
      channelConnectionId: scope.channelConnectionId,
      suffix: `${scope.suffix}-mixed`,
      userKey: "c".repeat(64),
      offer: { ...v2, amount: v1.amount },
    });
  } catch (error) {
    mixedRejected = error?.sqlState === "45000";
  }
  assert(mixedRejected, `${label} must reject a mixed v1/v2 snapshot`);
}

async function reserve(connection, input) {
  const intentId = input.intentId ?? randomUUID();
  const walletId = input.walletId ?? randomUUID();
  const sha = text => createHash("sha256").update(text).digest("hex");
  const financialSubjectRef =
    input.financialSubjectRef ?? sha(`financial:${input.suffix}`);
  const metadataHash = input.metadataHash ?? sha(`metadata:${input.suffix}`);
  const scopeHash = input.scopeHash ?? sha(`scope:${input.suffix}`);
  const capabilityHash =
    input.capabilityHash ?? sha(`capability:${input.suffix}`);
  const [result] = await connection.query(
    "CALL `credit_reserve_checkout_intent`(?,?,?,'test',?,1,1,?,?,2,?,?,?,?,?,?,?,?,TIMESTAMPADD(MINUTE,10,CURRENT_TIMESTAMP))",
    [
      intentId,
      walletId,
      input.workspaceId,
      input.channelConnectionId,
      input.userKey,
      financialSubjectRef,
      input.offer.code,
      input.offer.amount,
      input.offer.credits,
      input.offer.description,
      metadataHash,
      `credit-payment:${intentId}`,
      `credit-checkout:v1:${scopeHash}`,
      capabilityHash,
    ]
  );
  return {
    ...input,
    intentId,
    walletId,
    financialSubjectRef,
    metadataHash,
    scopeHash,
    capabilityHash,
    result: result[0][0].result,
  };
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
  for (const filename of filenames) {
    await applyStatements(connection, await readStatements(filename));
  }
}

async function applyStatements(connection, statements) {
  for (const statement of statements) await connection.query(statement);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
