import fs from "node:fs/promises";
import path from "node:path";
import mysql from "mysql2/promise";

const identifiersOnly = process.argv.includes("--check-identifiers-only");
const urlValue = process.env.MYSQL_REHEARSAL_URL?.trim();
if (!urlValue && !identifiersOnly) {
  throw new Error("MYSQL_REHEARSAL_URL is required");
}
const adminUrl = urlValue ? new URL(urlValue) : null;
const databaseNames = {
  preflight: "leaderbot_0015_preflight_rehearsal",
  quotaUnder: "leaderbot_0015_quota_under_rehearsal",
  quotaOver: "leaderbot_0015_quota_over_rehearsal",
  quotaOrphan: "leaderbot_0015_quota_orphan_rehearsal",
  corruptOutbox: "leaderbot_0015_corrupt_outbox_rehearsal",
  upgrade: "leaderbot_0015_upgrade_rehearsal",
  partial: "leaderbot_0015_partial_rehearsal",
  fresh: "leaderbot_0015_fresh_rehearsal",
};
for (const name of Object.values(databaseNames)) {
  if (!/^leaderbot_0015_[a-z_]+_rehearsal$/.test(name)) {
    throw new Error("unsafe rehearsal database name");
  }
}

const drizzleDirectory = path.resolve("drizzle");
const migrationFiles = (await fs.readdir(drizzleDirectory))
  .filter(name => /^\d{4}_.+\.sql$/.test(name))
  .sort();
const through0014 = migrationFiles.filter(
  name => Number(name.slice(0, 4)) <= 14
);
const migration0015 = await readStatements(
  "0015_production_readiness_registry.sql"
);
await assertMySqlIdentifierContract();
if (identifiersOnly) {
  process.stdout.write("MySQL identifier contract passed (maximum 64 bytes).\n");
  process.exit(0);
}

const admin = await mysql.createConnection({
  host: adminUrl.hostname,
  port: Number(adminUrl.port || 3306),
  user: decodeURIComponent(adminUrl.username),
  password: decodeURIComponent(adminUrl.password),
});

try {
  for (const name of Object.values(databaseNames)) {
    await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await admin.query(
      `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`
    );
  }

  await withDatabase(databaseNames.preflight, async connection => {
    await applyFiles(connection, through0014);
    await insertRepresentative0014Rows(connection, {
      includeScopeMismatch: true,
    });
    await connection.query(migration0015[0]);
    await expectFailure(
      connection.query(migration0015[1]),
      "preflight rejects cross-mode entitlement before permanent DDL"
    );
    const [[permanentTable]] = await connection.query(
      "SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='billing_accounting_event_links'"
    );
    assert(Number(permanentTable.count) === 0, "preflight precedes permanent DDL");
    await connection.query("DROP TEMPORARY TABLE `_0015_scope_preflight`");
    await connection.query(
      "UPDATE `workspace_entitlements` SET `source_intent_id`=NULL WHERE `id`=22"
    );
    await applyStatements(connection, migration0015);
    await assertUpgradeInvariants(connection);
  });

  for (const [database, mutation, label] of [
    [
      databaseNames.quotaUnder,
      "UPDATE `workspace_entitlement_usage` SET `ai_answers_reserved`=0 WHERE `entitlement_id`=21",
      "quota reservation counter undercount",
    ],
    [
      databaseNames.quotaOver,
      "UPDATE `workspace_entitlement_usage` SET `ai_answers_reserved`=2 WHERE `entitlement_id`=21",
      "quota reservation counter overcount",
    ],
    [
      databaseNames.quotaOrphan,
      "DELETE FROM `workspace_entitlement_usage` WHERE `entitlement_id`=21",
      "quota reservation missing usage row",
    ],
    [
      databaseNames.corruptOutbox,
      "UPDATE `billing_outbox` SET `attempt_count`=-1,`max_attempts`=0 WHERE `deduplication_key`='migration-handoff'",
      "legacy outbox invalid attempt counters",
    ],
  ]) {
    await withDatabase(database, async connection => {
      await applyFiles(connection, through0014);
      await insertRepresentative0014Rows(connection);
      await connection.query(mutation);
      await assertPreflightRejects(connection, label);
    });
  }

  await withDatabase(databaseNames.partial, async connection => {
    await applyFiles(connection, through0014);
    await insertRepresentative0014Rows(connection);
    for (const statement of migration0015.slice(0, 10)) {
      await connection.query(statement);
    }
    await expectFailure(
      connection.query(
        "ALTER TABLE `definitely_missing_0015_table` ADD `x` int"
      ),
      "partial migration fault injection"
    );
  });

  // MySQL DDL auto-commits. Recovery is restore-from-backup, never blind rerun.
  await admin.query(`DROP DATABASE \`${databaseNames.partial}\``);
  await admin.query(
    `CREATE DATABASE \`${databaseNames.partial}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`
  );
  await withDatabase(databaseNames.partial, async connection => {
    await applyFiles(connection, through0014);
    await insertRepresentative0014Rows(connection);
    await applyStatements(connection, migration0015);
    await assertUpgradeInvariants(connection);
  });

  await withDatabase(databaseNames.upgrade, async connection => {
    await applyFiles(connection, through0014);
    await insertRepresentative0014Rows(connection);
    await applyStatements(connection, migration0015);
    await assertUpgradeInvariants(connection);
    await assertReadOnlyRollbackContract(connection);
  });

  await withDatabase(databaseNames.fresh, async connection => {
    await applyFiles(connection, migrationFiles);
    await assertSchemaContract(connection);
  });

  process.stdout.write(
    "0015 rehearsal passed: fresh, 0014 upgrade, partial-failure restore, backfills and tenant constraints.\n"
  );
} finally {
  for (const name of Object.values(databaseNames)) {
    await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
  }
  await admin.end();
}

async function withDatabase(database, action) {
  const connection = await mysql.createConnection({
    host: adminUrl.hostname,
    port: Number(adminUrl.port || 3306),
    user: decodeURIComponent(adminUrl.username),
    password: decodeURIComponent(adminUrl.password),
    database,
  });
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

async function assertMySqlIdentifierContract() {
  const sql = await fs.readFile(
    path.join(drizzleDirectory, "0015_production_readiness_registry.sql"),
    "utf8"
  );
  const sqlNames = [
    ...sql.matchAll(/(?:CONSTRAINT|(?:UNIQUE )?INDEX|TRIGGER)\s+`([^`]+)`/g),
  ].map(match => match[1]);
  const snapshot = JSON.parse(
    await fs.readFile(
      path.join(drizzleDirectory, "meta", "0015_snapshot.json"),
      "utf8"
    )
  );
  const snapshotNames = Object.values(snapshot.tables).flatMap(table =>
    [
      table.indexes,
      table.foreignKeys,
      table.compositePrimaryKeys,
      table.uniqueConstraints,
      table.checkConstraint,
    ].flatMap(collection => Object.keys(collection ?? {}))
  );
  const tooLong = [...new Set([...sqlNames, ...snapshotNames])]
    .filter(name => Buffer.byteLength(name, "utf8") > 64)
    .sort();
  assert(
    tooLong.length === 0,
    `MySQL identifiers exceed 64 bytes: ${tooLong.join(", ")}`
  );
}

async function applyFiles(connection, files) {
  for (const file of files) {
    await applyStatements(connection, await readStatements(file));
  }
}

async function applyStatements(connection, statements) {
  for (const statement of statements) await connection.query(statement);
}

async function insertRepresentative0014Rows(
  connection,
  options = { includeScopeMismatch: false }
) {
  await connection.query(
    "INSERT INTO `users` (`id`,`openId`,`role`) VALUES (1,'migration-admin','admin')"
  );
  await connection.query(
    "INSERT INTO `workspaces` (`id`,`name`,`slug`) VALUES (1,'Migration A','migration-a'),(2,'Migration B','migration-b')"
  );
  await connection.query(
    "INSERT INTO `channelConnections` (`id`,`workspaceId`,`channel`,`status`,`externalId`,`encryptedAccessToken`) VALUES (11,1,'facebook_messenger','connected','page-migration-a','sealed-test-token')"
  );
  await connection.query(
    "INSERT INTO `billing_customers` (`workspace_id`,`mode`,`mollie_customer_id`,`external_reference`,`idempotency_key`,`status`) VALUES (1,'test','cst_migration123','migration-customer','migration-customer-key','active')"
  );
  await connection.query(
    "INSERT INTO `billing_intents` (`intent_id`,`workspace_id`,`mode`,`plan_code`,`kind`,`expected_amount`,`currency`,`interval`,`entitlements`,`mollie_description`,`status`,`mollie_payment_id`,`idempotency_key`,`checkout_scope_key`) VALUES ('11111111-1111-4111-8111-111111111111',1,'test','startpilot','startpilot_purchase','19.00','EUR','one-time',JSON_OBJECT('aiAnswers',100),'Migration fixture','open','tr_migration123','migration-intent-key','migration-scope-key')"
  );
  await connection.query(
    "INSERT INTO `billing_subscriptions` (`workspace_id`,`mode`,`plan_code`,`mollie_customer_id`,`mollie_subscription_id`,`mollie_mandate_id`,`source_intent_id`,`idempotency_key`,`status`,`interval`,`recurring_amount`,`currency`,`entitlements`,`mollie_description`) VALUES (1,'test','legacy','cst_migration123','sub_migration123','mdt_migration123','11111111-1111-4111-8111-111111111111','migration-subscription-key','active','1 month','19.00','EUR',JSON_OBJECT('aiAnswers',100),'Legacy containment fixture')"
  );
  await connection.query(
    "INSERT INTO `workspace_entitlements` (`id`,`workspace_id`,`mode`,`plan_code`,`status`,`quota`,`source_intent_id`) VALUES (21,1,'test','legacy','active',JSON_OBJECT('aiAnswers',100),'11111111-1111-4111-8111-111111111111'),(22,1,'live','unrelated-live','active',JSON_OBJECT('aiAnswers',50),'11111111-1111-4111-8111-111111111111')"
  );
  if (!options.includeScopeMismatch) {
    await connection.query(
      "UPDATE `workspace_entitlements` SET `source_intent_id`=NULL WHERE `id`=22"
    );
  }
  await connection.query(
    "INSERT INTO `workspace_entitlement_usage` (`workspace_id`,`mode`,`entitlement_id`,`plan_code`,`source_intent_id`,`period_started_at`,`period_ends_at`,`ai_answers_reserved`) VALUES (1,'test',21,'legacy','11111111-1111-4111-8111-111111111111',NOW(),DATE_ADD(NOW(),INTERVAL 1 MONTH),1)"
  );
  await connection.query(
    "INSERT INTO `workspace_entitlement_usage_reservations` (`reservation_id`,`workspace_id`,`mode`,`entitlement_id`,`kind`,`status`,`idempotency_key`,`expires_at`) VALUES ('22222222-2222-4222-8222-222222222222',1,'test',21,'ai_answer','reserved','migration-ai-answer',DATE_ADD(NOW(),INTERVAL 5 MINUTE))"
  );
  await connection.query(
    "INSERT INTO `payment_ledger` (`id`,`mollie_payment_id`,`workspace_id`,`mode`,`gross_amount`,`currency`,`status`,`refunds`,`chargebacks`,`observed_snapshot_hash`,`occurred_at`) VALUES (31,'tr_migration123',1,'test','19.00','EUR','open',JSON_ARRAY(),JSON_ARRAY(),REPEAT('a',64),NOW())"
  );
  await connection.query(
    "INSERT INTO `billing_outbox` (`workspace_id`,`mode`,`event_type`,`deduplication_key`,`payload`,`status`) VALUES (1,'test','send_portal_handoff','migration-handoff',JSON_OBJECT('intentId','11111111-1111-4111-8111-111111111111'),'pending')"
  );
  await connection.query(
    "INSERT INTO `billing_outbox` (`workspace_id`,`mode`,`event_type`,`deduplication_key`,`payload`,`status`,`attempt_count`,`locked_at`,`lease_token`) VALUES (1,'test','send_portal_handoff','migration-attempted-handoff',JSON_OBJECT('intentId','11111111-1111-4111-8111-111111111111'),'processing',1,NOW(),'legacy-lease')"
  );
  await connection.query(
    "INSERT INTO `portalHandoffTokens` (`workspaceId`,`tokenHash`,`messengerSenderUserKey`,`purpose`,`status`,`expiresAt`,`facebookPageId`,`deliveryIdempotencyKeyHash`) VALUES (1,'migration-token-hash',REPEAT('b',64),'workspace_onboarding','pending',DATE_ADD(NOW(),INTERVAL 1 DAY),'page-migration-a','migration-delivery-key')"
  );
}

async function assertUpgradeInvariants(connection) {
  await assertSchemaContract(connection);
  const [[intent]] = await connection.query(
    "SELECT `status`,`billing_profile_version` AS profileVersion FROM `billing_intents` WHERE `intent_id`='11111111-1111-4111-8111-111111111111'"
  );
  assert(
    intent.status === "contained" && intent.profileVersion === 0,
    "legacy intent containment"
  );
  const [[reservation]] = await connection.query(
    "SELECT `owner_token_hash` AS ownerHash,`owner_lease_until` AS leaseUntil,`resolution_due_at` AS dueAt FROM `workspace_entitlement_usage_reservations` WHERE `reservation_id`='22222222-2222-4222-8222-222222222222'"
  );
  assert(
    /^[a-f0-9]{64}$/.test(reservation.ownerHash),
    "legacy reservation owner hash"
  );
  assert(
    reservation.leaseUntil && reservation.dueAt,
    "legacy reservation deadlines"
  );
  const [[reservedFence]] = await connection.query(
    "SELECT `status`,`delivery_started_at` AS deliveryStartedAt FROM `workspace_entitlement_usage_reservations` WHERE `reservation_id`='22222222-2222-4222-8222-222222222222'"
  );
  assert(
    reservedFence.status === "reserved" && reservedFence.deliveryStartedAt,
    "legacy unknown reservation is conservative, never auto-release"
  );
  const [[outbox]] = await connection.query(
    "SELECT COUNT(*) AS total,COUNT(DISTINCT `delivery_id`) AS uniqueIds,SUM(`delivery_id` REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$') AS validIds FROM `billing_outbox`"
  );
  assert(
    outbox.total === outbox.uniqueIds &&
      outbox.total === Number(outbox.validIds),
    "outbox delivery identities"
  );
  const [[scheduler]] = await connection.query(
    "SELECT COUNT(*) AS count,SUM(`enabled`=true) AS enabledCount FROM `billing_scheduler_tenants` WHERE `workspace_id`=1 AND `mode`='test'"
  );
  assert(
    scheduler.count === 4 && Number(scheduler.enabledCount) === 1,
    "four scheduler lanes backfilled with only the safety outbox enabled"
  );
  const [[attemptedHandoff]] = await connection.query(
    "SELECT `status`,`delivery_state` AS deliveryState,`last_error_code` AS lastErrorCode FROM `billing_outbox` WHERE `deduplication_key`='migration-attempted-handoff'"
  );
  assert(
    attemptedHandoff.status === "failed" &&
      attemptedHandoff.deliveryState === "ambiguous" &&
      attemptedHandoff.lastErrorCode === "legacy_transport_ambiguous",
    "legacy attempted handoff cannot auto-resend"
  );
  const [[route]] = await connection.query(
    "SELECT `workspace_id` AS workspaceId FROM `billing_webhook_routes` WHERE `mode`='test' AND `mollie_payment_id`='tr_migration123'"
  );
  assert(route.workspaceId === 1, "webhook route backfill");
  const [[subscription]] = await connection.query(
    "SELECT `status` FROM `billing_subscriptions` WHERE `workspace_id`=1 AND `mode`='test'"
  );
  assert(
    subscription.status === "manual_review",
    "legacy subscription containment"
  );
  const [[liveEntitlement]] = await connection.query(
    "SELECT `status` FROM `workspace_entitlements` WHERE `workspace_id`=1 AND `mode`='live'"
  );
  assert(
    liveEntitlement.status === "active",
    "test subscription must not contain live entitlement"
  );
  await connection.query(
    "INSERT INTO `billing_outbox` (`delivery_id`,`workspace_id`,`mode`,`event_type`,`deduplication_key`,`payload`,`status`,`available_at`) VALUES ('55555555-5555-4555-8555-555555555555',1,'test','manual_review','disabled-containment',JSON_OBJECT('reason','billing_profile_revoked'),'pending','2000-01-01 00:00:00')"
  );
  const [[disabledContainment]] = await connection.query(
    "SELECT `enabled`,YEAR(`next_due_at`) AS dueYear FROM `billing_scheduler_tenants` WHERE `workspace_id`=1 AND `mode`='test' AND `kind`='outbox'"
  );
  assert(
    Boolean(disabledContainment.enabled) && disabledContainment.dueYear === 2000,
    "containment persists and wakes the safety lane without activating commercial rollout"
  );
  await connection.query(
    "UPDATE `billing_scheduler_tenants` SET `enabled`=true,`execution_epoch`=2,`operator_request_id`='66666666-6666-4666-8666-666666666666',`operator_request_fingerprint`=REPEAT('6',64),`enabled_by_user_id`=1,`enabled_at`=NOW() WHERE `workspace_id`=1 AND `mode`='test' AND `execution_epoch`=1"
  );
  const [[enabledScheduler]] = await connection.query(
    "SELECT COUNT(*) AS count,MIN(`execution_epoch`) AS minEpoch,MAX(`execution_epoch`) AS maxEpoch FROM `billing_scheduler_tenants` WHERE `workspace_id`=1 AND `mode`='test' AND `enabled`=true"
  );
  assert(
    enabledScheduler.count === 4 &&
      enabledScheduler.minEpoch === 2 &&
      enabledScheduler.maxEpoch === 2,
    "explicit operator enable bumps all lane epochs"
  );
  await connection.query(
    "INSERT INTO `billing_accounting_provider_events` (`provider_account_id`,`mode`,`provider_event_id`,`provider_type`,`event_type`,`event_digest`,`amount`,`net_amount`,`currency`,`occurred_at`,`mollie_payment_id`,`status`) VALUES ('org:migration','test','baltr_migration','payment','payment',REPEAT('c',64),'19.00','19.00','EUR',NOW(),'tr_migration123','staged')"
  );
  await expectFailure(
    connection.query(
      "INSERT INTO `billing_accounting_event_links` (`provider_event_id`,`mode`,`workspace_id`,`payment_ledger_id`,`link_status`) VALUES (1,'test',2,31,'linked')"
    ),
    "accounting cross-tenant composite FK"
  );
  await connection.query(
    "INSERT INTO `messenger_privacy_subjects` (`workspace_id`,`channel_connection_id`,`user_key`,`privacy_epoch`,`status`) VALUES (1,11,'migration-user-key',1,'active')"
  );
  await expectFailure(
    connection.query(
      "INSERT INTO `messenger_provider_attempt_fences` (`attempt_key_hash`,`workspace_id`,`channel_connection_id`,`binding_epoch`,`user_key`,`privacy_epoch`,`provider_operation`,`attempt_number`,`status`,`lease_token`,`lease_until`) VALUES (REPEAT('d',64),2,11,1,'migration-user-key',1,'image',1,'reserved','33333333-3333-4333-8333-333333333333',DATE_ADD(NOW(),INTERVAL 5 MINUTE))"
    ),
    "provider fence cross-tenant composite FK"
  );
  const [[handoffOutbox]] = await connection.query(
    "SELECT `id` FROM `billing_outbox` WHERE `deduplication_key`='migration-handoff'"
  );
  await expectFailure(
    connection.query(
      "INSERT INTO `billing_handoff_recovery_events` (`outbox_id`,`workspace_id`,`event_id_hash`,`source`,`event_timestamp`) VALUES (?,2,REPEAT('e',64),'migration',NOW())",
      [handoffOutbox.id]
    ),
    "handoff recovery cross-tenant composite FK"
  );
  await connection.query(
    "INSERT INTO `billing_notification_receipts` (`id`,`source_id`,`mode`,`delivery_id`,`workspace_id`,`audience`,`body_digest`) VALUES (41,'migration-source','test','44444444-4444-4444-8444-444444444444',1,'operator',REPEAT('f',64))"
  );
  await expectFailure(
    connection.query(
      "INSERT INTO `billing_notification_receiver_outbox` (`receipt_id`,`workspace_id`,`mode`,`audience`,`event_type`,`reason`) VALUES (41,2,'test','operator','manual_review','billing_profile_revoked')"
    ),
    "notification receiver cross-tenant composite FK"
  );
  await expectFailure(
    connection.query(
      "INSERT INTO `billing_notification_receiver_outbox` (`receipt_id`,`workspace_id`,`mode`,`audience`,`event_type`,`reason`) VALUES (41,1,'live','operator','manual_review','billing_profile_revoked')"
    ),
    "notification receiver cross-mode composite FK"
  );
  await expectFailure(
    connection.query(
      "INSERT INTO `billing_notification_receiver_outbox` (`receipt_id`,`workspace_id`,`mode`,`audience`,`event_type`,`reason`) VALUES (41,1,'test','customer','manual_review','billing_profile_revoked')"
    ),
    "notification receiver cross-audience composite FK"
  );
  await connection.query(
    "INSERT INTO `billing_intents` (`intent_id`,`workspace_id`,`mode`,`plan_code`,`kind`,`expected_amount`,`currency`,`interval`,`entitlements`,`mollie_description`,`status`,`idempotency_key`,`checkout_scope_key`,`billing_profile_version`,`authorization_epoch`) VALUES ('77777777-7777-4777-8777-777777777777',2,'test','startpilot','startpilot_purchase','19.00','EUR','one-time',JSON_OBJECT('aiAnswers',100),'Missing usage fixture','contained','missing-usage-intent-key','missing-usage-scope-key',0,1)"
  );
  await connection.query(
    "INSERT INTO `workspace_entitlements` (`id`,`workspace_id`,`mode`,`plan_code`,`status`,`quota`,`source_intent_id`) VALUES (23,2,'test','missing-usage','manual_review',JSON_OBJECT('aiAnswers',100),'77777777-7777-4777-8777-777777777777')"
  );
  await expectFailure(
    connection.query(
      "INSERT INTO `workspace_entitlement_usage_reservations` (`reservation_id`,`workspace_id`,`mode`,`entitlement_id`,`kind`,`status`,`idempotency_key`,`owner_token_hash`,`owner_lease_until`,`expires_at`,`resolution_due_at`) VALUES ('88888888-8888-4888-8888-888888888888',2,'test',23,'ai_answer','reserved','missing-usage-reservation',REPEAT('8',64),DATE_ADD(NOW(),INTERVAL 5 MINUTE),DATE_ADD(NOW(),INTERVAL 5 MINUTE),DATE_ADD(NOW(),INTERVAL 6 MINUTE))"
    ),
    "reservation requires an exact usage row"
  );
  await connection.query(
    "INSERT INTO `workspace_entitlement_usage` (`workspace_id`,`mode`,`entitlement_id`,`plan_code`,`source_intent_id`,`period_started_at`,`period_ends_at`) VALUES (2,'test',23,'missing-usage','77777777-7777-4777-8777-777777777777',NOW(),DATE_ADD(NOW(),INTERVAL 1 MONTH))"
  );
  await expectFailure(
    connection.query(
      "INSERT INTO `workspace_entitlement_usage_reservations` (`reservation_id`,`workspace_id`,`mode`,`entitlement_id`,`kind`,`status`,`idempotency_key`,`owner_token_hash`,`owner_lease_until`,`expires_at`,`resolution_due_at`) VALUES ('99999999-9999-4999-8999-999999999999',1,'test',23,'ai_answer','reserved','wrong-usage-scope-reservation',REPEAT('9',64),DATE_ADD(NOW(),INTERVAL 5 MINUTE),DATE_ADD(NOW(),INTERVAL 5 MINUTE),DATE_ADD(NOW(),INTERVAL 6 MINUTE))"
    ),
    "reservation rejects a wrong-scope usage row"
  );
}

async function assertSchemaContract(connection) {
  const requiredTables = [
    "billing_accounting_event_links",
    "billing_accounting_import_cursors",
    "billing_accounting_import_runs",
    "billing_accounting_provider_events",
    "billing_handoff_recovery_events",
    "billing_notification_inbox",
    "billing_notification_receipts",
    "billing_notification_receiver_outbox",
    "billing_notification_scheduler_tenants",
    "billing_profile_operator_actions",
    "billing_provider_operations",
    "billing_scheduler_process_heartbeats",
    "billing_scheduler_tenants",
    "billing_webhook_routes",
    "messenger_privacy_subjects",
    "messenger_provider_attempt_fences",
    "workspace_billing_profiles",
  ];
  const [tables] = await connection.query(
    "SELECT `TABLE_NAME` AS tableName FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()"
  );
  const existing = new Set(tables.map(row => row.tableName));
  for (const table of requiredTables)
    assert(existing.has(table), `missing table ${table}`);
  const [columns] = await connection.query(
    "SELECT `TABLE_NAME` AS tableName,`COLUMN_NAME` AS columnName FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()"
  );
  const shape = new Set(
    columns.map(row => `${row.tableName}.${row.columnName}`)
  );
  for (const column of [
    "billing_intents.billing_profile_version",
    "billing_outbox.delivery_id",
    "billing_outbox.delivery_state",
    "billing_accounting_event_links.mode",
    "billing_notification_receiver_outbox.mode",
    "billing_notification_scheduler_tenants.next_due_at",
    "billing_scheduler_process_heartbeats.last_poll_at",
    "billing_scheduler_tenants.execution_epoch",
    "billing_scheduler_tenants.operator_request_fingerprint",
    "billing_scheduler_tenants.pending_work_count",
    "billing_scheduler_tenants.dead_letter_count",
    "channelConnections.bindingEpoch",
    "portalHandoffTokens.capability_generation",
    "workspace_entitlement_usage_reservations.owner_token_hash",
    "workspace_entitlement_usage_reservations.resolution_due_at",
  ]) {
    assert(shape.has(column), `missing column ${column}`);
  }
  assert(
    !shape.has("billing_scheduler_tenants.last_heartbeat_at"),
    "obsolete tenant heartbeat column must be absent"
  );
  const [constraints] = await connection.query(
    "SELECT `CONSTRAINT_NAME` AS constraintName FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE()"
  );
  const constraintNames = new Set(
    constraints.map(row => row.constraintName)
  );
  for (const constraint of [
    "billing_accounting_event_links_provider_event_mode_fk",
    "billing_accounting_event_links_ledger_workspace_fk",
    "billing_intents_scope_profile_unique",
    "billing_intents_scope_unique",
    "billing_notification_inbox_receipt_workspace_fk",
    "billing_notification_receiver_outbox_receipt_workspace_fk",
    "billing_notification_scheduler_workspace_fk",
    "billing_provider_operations_intent_scope_fk",
    "billing_subscriptions_source_intent_scope_fk",
    "billing_webhook_routes_intent_scope_fk",
    "channelConnections_workspaceId_workspaces_id_fk",
    "channelConnections_id_workspace_binding_unique",
    "messenger_provider_fence_connection_workspace_fk",
    "messenger_provider_fence_privacy_subject_fk",
    "weu_entitlement_scope_fk",
    "weu_source_intent_scope_fk",
    "weur_connection_workspace_fk",
    "weur_entitlement_scope_fk",
    "weur_usage_scope_fk",
    "workspace_entitlement_usage_scope_unique",
    "workspace_entitlements_source_intent_scope_fk",
  ]) {
    assert(constraintNames.has(constraint), `missing constraint ${constraint}`);
  }
  const [indexes] = await connection.query(
    "SELECT DISTINCT `INDEX_NAME` AS indexName FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE()"
  );
  const indexNames = new Set(indexes.map(row => row.indexName));
  for (const indexName of [
    "payment_ledger_workspace_mode_occurred_idx",
    "workspace_entitlement_reservations_expiry_idx",
    "billing_notification_scheduler_due_idx",
  ]) {
    assert(indexNames.has(indexName), `missing index ${indexName}`);
  }
  const [triggers] = await connection.query(
    "SELECT `TRIGGER_NAME` AS triggerName FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()"
  );
  const triggerNames = new Set(triggers.map(row => row.triggerName));
  assert(
    triggerNames.has("billing_outbox_wake_scheduler_after_insert") &&
      triggerNames.has("billing_outbox_wake_scheduler_after_update") &&
      triggerNames.has("billing_scheduler_execution_epoch_before_update"),
    "outbox scheduler wake triggers"
  );
}

async function assertReadOnlyRollbackContract(connection) {
  await connection.query(
    "SELECT `intent_id`,`workspace_id`,`mode`,`status`,`mollie_payment_id` FROM `billing_intents` LIMIT 1"
  );
  await connection.query(
    "SELECT `id`,`workspace_id`,`mode`,`event_type`,`status` FROM `billing_outbox` LIMIT 1"
  );
  await connection.query(
    "SELECT `reservation_id`,`workspace_id`,`mode`,`status`,`expires_at` FROM `workspace_entitlement_usage_reservations` LIMIT 1"
  );
}

async function assertPreflightRejects(connection, label) {
  await connection.query(migration0015[0]);
  await expectFailure(connection.query(migration0015[1]), label);
  const [[permanentTable]] = await connection.query(
    "SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='billing_accounting_event_links'"
  );
  assert(Number(permanentTable.count) === 0, `${label} precedes permanent DDL`);
  await connection.query("DROP TEMPORARY TABLE `_0015_scope_preflight`");
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
  if (!condition) throw new Error(`0015 rehearsal invariant failed: ${label}`);
}
