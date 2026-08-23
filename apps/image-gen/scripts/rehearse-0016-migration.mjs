/* global process, URL */
import fs from "node:fs/promises";
import path from "node:path";

import mysql from "mysql2/promise";

const urlValue = process.env.MYSQL_REHEARSAL_URL?.trim();
if (!urlValue) throw new Error("MYSQL_REHEARSAL_URL is required");
const adminUrl = new URL(urlValue);
const drizzleDirectory = path.resolve("drizzle");
const migrationFiles = (await fs.readdir(drizzleDirectory))
  .filter(name => /^\d{4}_.+\.sql$/.test(name))
  .sort();
const through0015 = migrationFiles.filter(
  name => Number(name.slice(0, 4)) <= 15
);
const migration0016 = await readStatements("0016_static_epoch_scope_fks.sql");
const migration0017 = await readStatements("0017_handoff_privacy_scope.sql");
const databases = {
  upgrade: "leaderbot_0016_epoch_upgrade_rehearsal",
  preflight: "leaderbot_0016_epoch_preflight_rehearsal",
  rollout: "leaderbot_0016_epoch_rollout_rehearsal",
  fresh: "leaderbot_0016_epoch_fresh_rehearsal",
};
const admin = await mysql.createConnection({
  host: adminUrl.hostname,
  port: Number(adminUrl.port || 3306),
  user: decodeURIComponent(adminUrl.username),
  password: decodeURIComponent(adminUrl.password),
  socketPath: adminUrl.searchParams.get("socket") || undefined,
});

try {
  for (const database of Object.values(databases)) {
    if (!/^leaderbot_0016_epoch_[a-z]+_rehearsal$/.test(database)) {
      throw new Error("unsafe 0016 rehearsal database name");
    }
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.query(
      `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`
    );
  }

  await withDatabase(databases.upgrade, async connection => {
    await applyFiles(connection, through0015);
    await insertEpochFixtures(connection);
    await expectFailure(
      connection.query(
        "UPDATE `channelConnections` SET `bindingEpoch`=2 WHERE `id`=11"
      ),
      "0015 connection epoch is pinned by historical rows"
    );
    await expectFailure(
      connection.query(
        "UPDATE `messenger_privacy_subjects` SET `privacy_epoch`=2 WHERE `workspace_id`=1 AND `channel_connection_id`=11 AND `user_key`='subject-active'"
      ),
      "0015 privacy epoch is pinned by historical rows"
    );

    await applyStatements(connection, migration0016);
    await connection.query(
      "INSERT INTO `billing_intents` (`intent_id`,`workspace_id`,`mode`,`plan_code`,`kind`,`expected_amount`,`currency`,`interval`,`entitlements`,`mollie_description`,`status`,`idempotency_key`,`checkout_scope_key`,`messenger_sender_user_key`,`messenger_page_id`,`billing_profile_version`,`authorization_epoch`) VALUES ('11111111-1111-4111-8111-111111111112',1,'test','startpilot','startpilot_purchase','19.00','EUR','one-time',JSON_OBJECT('aiAnswers',300),'Old writer after expand','paid','epoch-old-writer-key','epoch-old-writer-scope','subject-active','page-a',0,1)"
    );
    await connection.query(
      "INSERT INTO `portalHandoffTokens` (`workspaceId`,`tokenHash`,`messengerSenderUserKey`,`facebookPageId`,`purpose`,`status`,`expiresAt`) VALUES (1,'epoch-old-writer-token','subject-active','page-a','workspace_onboarding','pending',DATE_ADD(NOW(),INTERVAL 1 HOUR))"
    );
    const [[oldWriter]] = await connection.query(
      "SELECT (SELECT `messenger_channel_connection_id` FROM `billing_intents` WHERE `intent_id`='11111111-1111-4111-8111-111111111112') AS intentConnectionId,(SELECT `messenger_channel_connection_id` FROM `portalHandoffTokens` WHERE `tokenHash`='epoch-old-writer-token') AS tokenConnectionId"
    );
    assert(
      oldWriter.intentConnectionId === null &&
        oldWriter.tokenConnectionId === null,
      "0015-shaped writers remain accepted during expand"
    );
    await connection.query(
      "UPDATE `channelConnections` SET `bindingEpoch`=2 WHERE `id`=11"
    );
    await connection.query(
      "UPDATE `messenger_privacy_subjects` SET `privacy_epoch`=2,`status`='erased',`erased_at`='2026-08-23 12:00:00',`last_erased_at`='2026-08-23 12:00:00.123' WHERE `workspace_id`=1 AND `channel_connection_id`=11 AND `user_key`='subject-active'"
    );

    const [[snapshots]] = await connection.query(
      "SELECT `fence`.`binding_epoch` AS fenceBinding,`fence`.`privacy_epoch` AS fencePrivacy,`reservation`.`binding_epoch` AS reservationBinding FROM `messenger_provider_attempt_fences` AS `fence` JOIN `workspace_entitlement_usage_reservations` AS `reservation` ON `reservation`.`reservation_id`='22222222-2222-4222-8222-222222222222' WHERE `fence`.`attempt_key_hash`=REPEAT('a',64)"
    );
    assert(
      snapshots.fenceBinding === 1 &&
        snapshots.fencePrivacy === 1 &&
        snapshots.reservationBinding === 1,
      "historical epochs remain immutable snapshots"
    );
    const [[deletedSubject]] = await connection.query(
      "SELECT `privacy_epoch` AS privacyEpoch,`status`,DATE_FORMAT(`last_erased_at`,'%Y-%m-%d %H:%i:%s.%f') AS lastErasedAt FROM `messenger_privacy_subjects` WHERE `workspace_id`=1 AND `channel_connection_id`=11 AND `user_key`='subject-active'"
    );
    assert(
      deletedSubject.privacyEpoch === 2 &&
        deletedSubject.status === "erased" &&
        deletedSubject.lastErasedAt === "2026-08-23 12:00:00.123000",
      "privacy erasure may advance its epoch after a historical fence"
    );
    const [[erasure]] = await connection.query(
      "SELECT `erased_at` AS erasedAt,`last_erased_at` AS lastErasedAt FROM `messenger_privacy_subjects` WHERE `user_key`='subject-erased'"
    );
    assert(
      erasure.erasedAt?.getTime() === erasure.lastErasedAt?.getTime(),
      "existing erasure boundary is preserved"
    );
    await expectFailure(
      connection.query(
        "INSERT INTO `messenger_provider_attempt_fences` (`attempt_key_hash`,`workspace_id`,`channel_connection_id`,`binding_epoch`,`user_key`,`privacy_epoch`,`provider_operation`,`attempt_number`,`status`,`lease_token`,`lease_until`) VALUES (REPEAT('b',64),2,11,2,'subject-active',2,'image',1,'reserved','33333333-3333-4333-8333-333333333333',DATE_ADD(NOW(),INTERVAL 5 MINUTE))"
      ),
      "static provider fence scope rejects another tenant"
    );
    await assertStaticForeignKeyColumns(connection);
    await assertExpandHasNoHandoffFence(connection);
  });

  await withDatabase(databases.preflight, async connection => {
    await applyFiles(connection, through0015);
    await connection.query(
      "INSERT INTO `workspaces` (`id`,`name`,`slug`) VALUES (1,'Preflight','preflight')"
    );
    await connection.query("SET SESSION foreign_key_checks=0");
    await connection.query(
      "INSERT INTO `messenger_provider_attempt_fences` (`attempt_key_hash`,`workspace_id`,`channel_connection_id`,`binding_epoch`,`user_key`,`privacy_epoch`,`provider_operation`,`attempt_number`,`status`,`lease_token`,`lease_until`) VALUES (REPEAT('c',64),1,999,1,'orphan-subject',1,'image',1,'reserved','44444444-4444-4444-8444-444444444444',DATE_ADD(NOW(),INTERVAL 5 MINUTE))"
    );
    await connection.query("SET SESSION foreign_key_checks=1");
    await connection.query(migration0016[0]);
    await expectFailure(
      connection.query(migration0016[1]),
      "0016 preflight rejects a static-scope orphan"
    );
    const [[column]] = await connection.query(
      "SELECT COUNT(*) AS count FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='messenger_privacy_subjects' AND COLUMN_NAME='last_erased_at'"
    );
    assert(Number(column.count) === 0, "preflight precedes permanent DDL");
    await connection.query(
      "DROP TEMPORARY TABLE `_0016_static_scope_preflight`"
    );
  });

  await withDatabase(databases.rollout, async connection => {
    await applyFiles(connection, through0015);
    await connection.query(
      "INSERT INTO `workspaces` (`id`,`name`,`slug`) VALUES (31,'Rollout','rollout')"
    );
    await connection.query(
      "INSERT INTO `channelConnections` (`id`,`workspaceId`,`channel`,`status`,`externalId`) VALUES (32,31,'facebook_messenger','connected','rollout-page')"
    );
    await connection.query(
      "INSERT INTO `messenger_privacy_subjects` (`workspace_id`,`channel_connection_id`,`user_key`,`privacy_epoch`,`status`) VALUES (31,32,'rollout-user',4,'active')"
    );
    await applyStatements(connection, migration0016);
    await connection.query(
      "INSERT INTO `billing_intents` (`intent_id`,`workspace_id`,`mode`,`plan_code`,`kind`,`expected_amount`,`currency`,`interval`,`entitlements`,`mollie_description`,`status`,`idempotency_key`,`checkout_scope_key`,`messenger_sender_user_key`,`messenger_page_id`,`billing_profile_version`,`authorization_epoch`) VALUES ('31000000-0000-4000-8000-000000000001',31,'test','startpilot','startpilot_purchase','19.00','EUR','one-time',JSON_OBJECT('aiAnswers',300),'Expand writer','paid','rollout-expand-key','rollout-expand-scope','rollout-user','rollout-page',0,1)"
    );
    await applyStatements(connection, migration0017);
    const [[repaired]] = await connection.query(
      "SELECT `messenger_channel_connection_id` AS connectionId,`messenger_privacy_epoch` AS privacyEpoch FROM `billing_intents` WHERE `intent_id`='31000000-0000-4000-8000-000000000001'"
    );
    assert(
      repaired.connectionId === 32 && repaired.privacyEpoch === 4,
      "contract repairs a row written by the old shape during expand"
    );
    await expectFailure(
      connection.query(
        "INSERT INTO `billing_intents` (`intent_id`,`workspace_id`,`mode`,`plan_code`,`kind`,`expected_amount`,`currency`,`interval`,`entitlements`,`mollie_description`,`status`,`idempotency_key`,`checkout_scope_key`,`messenger_sender_user_key`,`messenger_page_id`,`billing_profile_version`,`authorization_epoch`) VALUES ('31000000-0000-4000-8000-000000000002',31,'test','startpilot','startpilot_purchase','19.00','EUR','one-time',JSON_OBJECT('aiAnswers',300),'Contract writer','paid','rollout-contract-key','rollout-contract-scope','rollout-user','rollout-page',0,1)"
      ),
      "0017 contract fences the old write shape"
    );
  });

  await withDatabase(databases.fresh, async connection => {
    await applyFiles(connection, migrationFiles);
    await assertStaticForeignKeyColumns(connection);
  });

  process.stdout.write(
    "0016/0017 staged rehearsal passed: expand accepts old writers and contract fences them after repair.\n"
  );
} finally {
  for (const database of Object.values(databases)) {
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
  }
  await admin.end();
}

async function insertEpochFixtures(connection) {
  await connection.query(
    "INSERT INTO `workspaces` (`id`,`name`,`slug`) VALUES (1,'Workspace A','workspace-a'),(2,'Workspace B','workspace-b')"
  );
  await connection.query(
    "INSERT INTO `channelConnections` (`id`,`workspaceId`,`channel`,`status`,`externalId`,`encryptedAccessToken`,`bindingEpoch`) VALUES (11,1,'facebook_messenger','connected','page-a','sealed-token',1)"
  );
  await connection.query(
    "INSERT INTO `billing_intents` (`intent_id`,`workspace_id`,`mode`,`plan_code`,`kind`,`expected_amount`,`currency`,`interval`,`entitlements`,`mollie_description`,`status`,`idempotency_key`,`checkout_scope_key`,`billing_profile_version`,`authorization_epoch`) VALUES ('11111111-1111-4111-8111-111111111111',1,'test','startpilot','startpilot_purchase','19.00','EUR','one-time',JSON_OBJECT('aiAnswers',300),'Epoch fixture','contained','epoch-intent-key','epoch-scope-key',0,1)"
  );
  await connection.query(
    "INSERT INTO `workspace_entitlements` (`id`,`workspace_id`,`mode`,`plan_code`,`status`,`quota`,`source_intent_id`) VALUES (21,1,'test','startpilot','active',JSON_OBJECT('aiAnswersTotal',300),'11111111-1111-4111-8111-111111111111')"
  );
  await connection.query(
    "INSERT INTO `workspace_entitlement_usage` (`workspace_id`,`mode`,`entitlement_id`,`plan_code`,`source_intent_id`,`period_started_at`,`period_ends_at`,`ai_answers_reserved`) VALUES (1,'test',21,'startpilot','11111111-1111-4111-8111-111111111111',NOW(),DATE_ADD(NOW(),INTERVAL 1 MONTH),1)"
  );
  await connection.query(
    "INSERT INTO `workspace_entitlement_usage_reservations` (`reservation_id`,`workspace_id`,`mode`,`entitlement_id`,`channel_connection_id`,`binding_epoch`,`kind`,`status`,`idempotency_key`,`owner_token_hash`,`owner_lease_until`,`expires_at`,`resolution_due_at`) VALUES ('22222222-2222-4222-8222-222222222222',1,'test',21,11,1,'ai_answer','reserved','epoch-reservation',REPEAT('2',64),DATE_ADD(NOW(),INTERVAL 4 MINUTE),DATE_ADD(NOW(),INTERVAL 5 MINUTE),DATE_ADD(NOW(),INTERVAL 5 MINUTE))"
  );
  await connection.query(
    "INSERT INTO `messenger_privacy_subjects` (`workspace_id`,`channel_connection_id`,`user_key`,`privacy_epoch`,`status`,`erased_at`) VALUES (1,11,'subject-active',1,'active',NULL),(1,11,'subject-erased',3,'erased','2026-08-22 12:00:00')"
  );
  await connection.query(
    "INSERT INTO `messenger_provider_attempt_fences` (`attempt_key_hash`,`workspace_id`,`channel_connection_id`,`binding_epoch`,`user_key`,`privacy_epoch`,`provider_operation`,`attempt_number`,`status`,`lease_token`,`lease_until`) VALUES (REPEAT('a',64),1,11,1,'subject-active',1,'image',1,'reserved','11111111-1111-4111-8111-111111111111',DATE_ADD(NOW(),INTERVAL 5 MINUTE))"
  );
}

async function assertStaticForeignKeyColumns(connection) {
  const [rows] = await connection.query(
    "SELECT `CONSTRAINT_NAME` AS name,`COLUMN_NAME` AS columnName,`ORDINAL_POSITION` AS position FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND `CONSTRAINT_NAME` IN ('messenger_provider_fence_static_connection_fk','messenger_provider_fence_static_subject_fk','weur_static_connection_workspace_fk') ORDER BY `CONSTRAINT_NAME`,`ORDINAL_POSITION`"
  );
  const shape = rows.reduce((result, row) => {
    (result[row.name] ??= []).push(row.columnName);
    return result;
  }, {});
  assert(
    JSON.stringify(shape.messenger_provider_fence_static_connection_fk) ===
      JSON.stringify(["channel_connection_id", "workspace_id"]),
    "provider connection FK uses static scope"
  );
  assert(
    JSON.stringify(shape.messenger_provider_fence_static_subject_fk) ===
      JSON.stringify(["workspace_id", "channel_connection_id", "user_key"]),
    "provider privacy FK uses static scope"
  );
  assert(
    JSON.stringify(shape.weur_static_connection_workspace_fk) ===
      JSON.stringify(["channel_connection_id", "workspace_id"]),
    "reservation connection FK uses static scope"
  );
}

async function assertExpandHasNoHandoffFence(connection) {
  const [[constraints]] = await connection.query(
    "SELECT COUNT(*) AS count FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND CONSTRAINT_NAME IN ('billing_intents_messenger_identity_scope','portal_handoff_tokens_messenger_identity_scope','billing_intents_static_messenger_connection_fk','billing_intents_static_messenger_subject_fk','portal_handoff_tokens_static_connection_fk','portal_handoff_tokens_static_subject_fk')"
  );
  assert(
    Number(constraints.count) === 0,
    "expand does not install the old-writer handoff fence"
  );
}

async function withDatabase(database, action) {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  const connection = await mysql.createConnection(url.toString());
  try {
    await action(connection);
  } finally {
    await connection.end();
  }
}

async function readStatements(filename) {
  const sql = await fs.readFile(path.join(drizzleDirectory, filename), "utf8");
  return sql
    .split("--> statement-breakpoint")
    .map(statement => statement.trim())
    .filter(Boolean);
}

async function applyFiles(connection, files) {
  for (const file of files) {
    await applyStatements(connection, await readStatements(file));
  }
}

async function applyStatements(connection, statements) {
  for (const statement of statements) await connection.query(statement);
}

async function expectFailure(promise, label) {
  try {
    await promise;
  } catch {
    return;
  }
  throw new Error(`expected failure: ${label}`);
}

function assert(condition, label) {
  if (!condition) throw new Error(`0016 rehearsal invariant failed: ${label}`);
}
