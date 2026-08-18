-- Mandatory 0014 data preflight. This session-local guard is deliberately the
-- first migration statement so an ownership mismatch aborts before any
-- permanent MySQL DDL can auto-commit.
CREATE TEMPORARY TABLE `_0015_scope_preflight` (
	`violation` tinyint NOT NULL PRIMARY KEY,
	CONSTRAINT `_0015_scope_preflight_must_be_empty` CHECK (`violation` = 0)
);--> statement-breakpoint
INSERT INTO `_0015_scope_preflight` (`violation`)
SELECT 1 FROM DUAL
WHERE
	EXISTS (
		SELECT 1 FROM `channelConnections` AS `connection`
		LEFT JOIN `workspaces` AS `workspace` ON `workspace`.`id`=`connection`.`workspaceId`
		WHERE `workspace`.`id` IS NULL
	)
	OR EXISTS (
		SELECT 1 FROM `billing_subscriptions` AS `subscription`
		JOIN `billing_intents` AS `intent` ON `intent`.`intent_id`=`subscription`.`source_intent_id`
		WHERE `intent`.`workspace_id`<>`subscription`.`workspace_id` OR `intent`.`mode`<>`subscription`.`mode`
	)
	OR EXISTS (
		SELECT 1 FROM `workspace_entitlements` AS `entitlement`
		JOIN `billing_intents` AS `intent` ON `intent`.`intent_id`=`entitlement`.`source_intent_id`
		WHERE `entitlement`.`source_intent_id` IS NOT NULL
			AND (`intent`.`workspace_id`<>`entitlement`.`workspace_id` OR `intent`.`mode`<>`entitlement`.`mode`)
	)
	OR EXISTS (
		SELECT 1 FROM `workspace_entitlement_usage` AS `usage`
		JOIN `workspace_entitlements` AS `entitlement` ON `entitlement`.`id`=`usage`.`entitlement_id`
		WHERE `entitlement`.`workspace_id`<>`usage`.`workspace_id` OR `entitlement`.`mode`<>`usage`.`mode`
	)
	OR EXISTS (
		SELECT 1 FROM `workspace_entitlement_usage` AS `usage`
		JOIN `billing_intents` AS `intent` ON `intent`.`intent_id`=`usage`.`source_intent_id`
		WHERE `intent`.`workspace_id`<>`usage`.`workspace_id` OR `intent`.`mode`<>`usage`.`mode`
	)
	OR EXISTS (
		SELECT 1 FROM `workspace_entitlement_usage_reservations` AS `reservation`
		JOIN `workspace_entitlements` AS `entitlement` ON `entitlement`.`id`=`reservation`.`entitlement_id`
		WHERE `entitlement`.`workspace_id`<>`reservation`.`workspace_id` OR `entitlement`.`mode`<>`reservation`.`mode`
	)
	OR EXISTS (
		SELECT 1
		FROM `workspace_entitlement_usage` AS `usage`
		LEFT JOIN (
			SELECT `workspace_id`,`mode`,`entitlement_id`,COUNT(*) AS `reserved_count`
			FROM `workspace_entitlement_usage_reservations`
			WHERE `kind`='ai_answer' AND `status`='reserved'
			GROUP BY `workspace_id`,`mode`,`entitlement_id`
		) AS `reservation_count`
			ON `reservation_count`.`workspace_id`=`usage`.`workspace_id`
			AND `reservation_count`.`mode`=`usage`.`mode`
			AND `reservation_count`.`entitlement_id`=`usage`.`entitlement_id`
		WHERE `usage`.`ai_answers_reserved`<>COALESCE(`reservation_count`.`reserved_count`,0)
	)
	OR EXISTS (
		SELECT 1
		FROM `workspace_entitlement_usage_reservations` AS `reservation`
		LEFT JOIN `workspace_entitlement_usage` AS `usage`
			ON `usage`.`workspace_id`=`reservation`.`workspace_id`
			AND `usage`.`mode`=`reservation`.`mode`
			AND `usage`.`entitlement_id`=`reservation`.`entitlement_id`
		WHERE `reservation`.`kind`='ai_answer' AND `reservation`.`status`='reserved'
			AND `usage`.`id` IS NULL
	)
	OR EXISTS (
		SELECT 1
		FROM `billing_outbox`
		WHERE `attempt_count` < 0 OR `max_attempts` <= 0
	);--> statement-breakpoint
DROP TEMPORARY TABLE `_0015_scope_preflight`;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `messengerState` (
	`id` int AUTO_INCREMENT NOT NULL,
	`psid` varchar(64) NOT NULL,
	`userKey` varchar(64) NOT NULL,
	`stage` enum('IDLE','AWAITING_PHOTO','AWAITING_STYLE','PROCESSING','RESULT_READY','FAILURE') DEFAULT 'IDLE' NOT NULL,
	`lastPhotoUrl` varchar(2048),
	`selectedStyle` varchar(64),
	`preferredLang` varchar(10) DEFAULT 'nl' NOT NULL,
	`lastGeneratedUrl` varchar(2048),
	`updatedAt` timestamp DEFAULT (now()) NOT NULL ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `messengerState_id` PRIMARY KEY(`id`),
	CONSTRAINT `messengerState_psid_unique` UNIQUE(`psid`),
	CONSTRAINT `messengerState_userKey_unique` UNIQUE(`userKey`)
);
--> statement-breakpoint
CREATE TABLE `billing_accounting_event_links` (
	`id` int AUTO_INCREMENT NOT NULL,
	`provider_event_id` int NOT NULL,
	`mode` enum('test','live') NOT NULL,
	`workspace_id` int,
	`payment_ledger_id` int,
	`link_status` enum('linked','unknown','conflict','account_level') NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `billing_accounting_event_links_id` PRIMARY KEY(`id`),
	CONSTRAINT `billing_accounting_event_links_event_unique` UNIQUE(`provider_event_id`),
	CONSTRAINT `billing_accounting_event_links_status_target_check` CHECK((`billing_accounting_event_links`.`link_status` = 'linked' AND `billing_accounting_event_links`.`workspace_id` IS NOT NULL AND `billing_accounting_event_links`.`payment_ledger_id` IS NOT NULL) OR (`billing_accounting_event_links`.`link_status` <> 'linked' AND `billing_accounting_event_links`.`payment_ledger_id` IS NULL))
);
--> statement-breakpoint
CREATE TABLE `billing_accounting_import_cursors` (
	`provider_account_id` varchar(96) NOT NULL,
	`mode` enum('test','live') NOT NULL,
	`cursor` varchar(255),
	`high_water_provider_event_id` varchar(96),
	`pending_high_water_provider_event_id` varchar(96),
	`lease_token` varchar(36),
	`lease_until` timestamp,
	`consecutive_failures` int NOT NULL DEFAULT 0,
	`last_successful_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `billing_accounting_import_cursors_provider_account_id_mode_pk` PRIMARY KEY(`provider_account_id`,`mode`)
);
--> statement-breakpoint
CREATE TABLE `billing_accounting_import_runs` (
	`run_id` varchar(36) NOT NULL,
	`provider_account_id` varchar(96) NOT NULL,
	`mode` enum('test','live') NOT NULL,
	`status` enum('pending','fetching','staged','applied','manual_review') NOT NULL,
	`cursor` varchar(255),
	`error_code` varchar(80),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`completed_at` timestamp,
	CONSTRAINT `billing_accounting_import_runs_run_id` PRIMARY KEY(`run_id`)
);
--> statement-breakpoint
CREATE TABLE `billing_accounting_provider_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`provider_account_id` varchar(96) NOT NULL,
	`mode` enum('test','live') NOT NULL,
	`provider_event_id` varchar(96) NOT NULL,
	`provider_type` varchar(64) NOT NULL,
	`event_type` enum('payment','refund','chargeback','fee','settlement','unknown') NOT NULL,
	`event_digest` varchar(64) NOT NULL,
	`amount` decimal(12,2) NOT NULL,
	`net_amount` decimal(12,2) NOT NULL,
	`deduction_amount` decimal(12,2),
	`currency` varchar(3) NOT NULL,
	`occurred_at` timestamp NOT NULL,
	`mollie_payment_id` varchar(64),
	`settlement_id` varchar(96),
	`status` enum('staged','applied','quarantined') NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `billing_accounting_provider_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `billing_accounting_provider_events_account_mode_id_unique` UNIQUE(`provider_account_id`,`mode`,`provider_event_id`),
	CONSTRAINT `billing_accounting_provider_events_id_mode_unique` UNIQUE(`id`,`mode`)
);
--> statement-breakpoint
CREATE TABLE `billing_handoff_recovery_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`outbox_id` int NOT NULL,
	`workspace_id` int NOT NULL,
	`event_id_hash` varchar(64) NOT NULL,
	`source` varchar(48) NOT NULL,
	`event_timestamp` timestamp NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `billing_handoff_recovery_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `billing_handoff_recovery_events_outbox_event_unique` UNIQUE(`outbox_id`,`event_id_hash`)
);
--> statement-breakpoint
CREATE TABLE `billing_notification_inbox` (
	`id` int AUTO_INCREMENT NOT NULL,
	`receipt_id` int NOT NULL,
	`workspace_id` int NOT NULL,
	`audience` enum('customer','operator') NOT NULL,
	`event_type` varchar(48) NOT NULL,
	`reason` varchar(96) NOT NULL,
	`occurred_at` timestamp NOT NULL DEFAULT (now()),
	`read_at` timestamp,
	CONSTRAINT `billing_notification_inbox_id` PRIMARY KEY(`id`),
	CONSTRAINT `billing_notification_inbox_receipt_unique` UNIQUE(`receipt_id`)
);
--> statement-breakpoint
CREATE TABLE `billing_notification_receipts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`source_id` varchar(64) NOT NULL,
	`mode` enum('test','live') NOT NULL,
	`delivery_id` varchar(36) NOT NULL,
	`workspace_id` int NOT NULL,
	`audience` enum('customer','operator') NOT NULL,
	`body_digest` varchar(64) NOT NULL,
	`received_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `billing_notification_receipts_id` PRIMARY KEY(`id`),
	CONSTRAINT `billing_notification_receipts_source_mode_delivery_unique` UNIQUE(`source_id`,`mode`,`delivery_id`),
	CONSTRAINT `billing_notification_receipts_id_scope_unique` UNIQUE(`id`,`workspace_id`,`audience`),
	CONSTRAINT `billing_notification_receipts_id_mode_scope_unique` UNIQUE(`id`,`workspace_id`,`mode`,`audience`)
);
--> statement-breakpoint
CREATE TABLE `billing_notification_receiver_outbox` (
	`id` int AUTO_INCREMENT NOT NULL,
	`receipt_id` int NOT NULL,
	`workspace_id` int NOT NULL,
	`mode` enum('test','live') NOT NULL,
	`audience` enum('customer','operator') NOT NULL,
	`event_type` varchar(48) NOT NULL,
	`reason` varchar(96) NOT NULL,
	`status` enum('pending','processing','delivered','dead_letter') NOT NULL DEFAULT 'pending',
	`attempt_count` int NOT NULL DEFAULT 0,
	`max_attempts` int NOT NULL DEFAULT 8,
	`available_at` timestamp NOT NULL DEFAULT (now()),
	`locked_at` timestamp,
	`lease_token` varchar(36),
	`last_error_code` varchar(80),
	`delivered_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `billing_notification_receiver_outbox_id` PRIMARY KEY(`id`),
	CONSTRAINT `billing_notification_receiver_outbox_receipt_unique` UNIQUE(`receipt_id`),
	CONSTRAINT `billing_notification_receiver_attempts_valid` CHECK (`attempt_count` >= 0 AND `max_attempts` > 0 AND `attempt_count` <= `max_attempts`),
	CONSTRAINT `billing_notification_receiver_lease_state` CHECK ((`status`='processing' AND `locked_at` IS NOT NULL AND `lease_token` IS NOT NULL) OR (`status`<>'processing' AND `locked_at` IS NULL AND `lease_token` IS NULL)),
	CONSTRAINT `billing_notification_receiver_delivery_state` CHECK ((`status`='delivered' AND `delivered_at` IS NOT NULL) OR (`status`<>'delivered' AND `delivered_at` IS NULL))
);
--> statement-breakpoint
CREATE TABLE `billing_profile_operator_actions` (
	`request_id` varchar(36) NOT NULL,
	`workspace_id` int NOT NULL,
	`actor_user_id` int NOT NULL,
	`action` enum('attest','revoke') NOT NULL,
	`expected_version` int NOT NULL,
	`resulting_version` int NOT NULL,
	`request_fingerprint` varchar(64) NOT NULL,
	`reason` varchar(160),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `billing_profile_operator_actions_request_id` PRIMARY KEY(`request_id`)
);
--> statement-breakpoint
CREATE TABLE `billing_execution_controls` (
	`workspace_id` int NOT NULL,
	`mode` enum('test','live') NOT NULL,
	`commercial_enabled` boolean NOT NULL DEFAULT false,
	`authorization_epoch` int NOT NULL DEFAULT 1,
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `billing_execution_controls_workspace_id_mode_pk` PRIMARY KEY(`workspace_id`,`mode`),
	CONSTRAINT `billing_execution_controls_epoch_positive` CHECK (`authorization_epoch` > 0)
);
--> statement-breakpoint
CREATE TABLE `billing_provider_operations` (
	`operation_id` varchar(36) NOT NULL,
	`workspace_id` int NOT NULL,
	`mode` enum('test','live') NOT NULL,
	`operation_type` enum('create_customer','create_payment','create_subscription','cancel_payment','cancel_subscription') NOT NULL,
	`operation_key` varchar(160) NOT NULL,
	`intent_id` varchar(36) NOT NULL,
	`billing_profile_version` int NOT NULL,
	`authorization_epoch` int NOT NULL,
	`state` enum('reserved','transport_started','succeeded','known_failed','ambiguous','reconciliation_only','contained') NOT NULL,
	`request_fingerprint` varchar(64) NOT NULL,
	`idempotency_key_hash` varchar(64) NOT NULL,
	`credential_generation_id` varchar(64) NOT NULL,
	`provider_resource_id` varchar(64),
	`provider_customer_id` varchar(64),
	`attempt_count` int NOT NULL DEFAULT 0,
	`lease_token` varchar(36) NOT NULL,
	`lease_until` timestamp NOT NULL,
	`first_started_at` timestamp,
	`retry_before` timestamp,
	`resolution_due_at` timestamp NOT NULL,
	`completed_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `billing_provider_operations_operation_id` PRIMARY KEY(`operation_id`),
	CONSTRAINT `billing_provider_operations_mode_type_key_unique` UNIQUE(`mode`,`operation_type`,`operation_key`),
	CONSTRAINT `billing_provider_operations_attempt_nonnegative` CHECK (`attempt_count` >= 0),
	CONSTRAINT `billing_provider_operations_started_timestamp` CHECK (`state` NOT IN ('transport_started','ambiguous','succeeded') OR `first_started_at` IS NOT NULL),
	CONSTRAINT `billing_provider_operations_success_result` CHECK (`state` <> 'succeeded' OR (`provider_resource_id` IS NOT NULL AND `completed_at` IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `billing_scheduler_tenants` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspace_id` int NOT NULL,
	`mode` enum('test','live') NOT NULL,
	`kind` enum('outbox','reconciliation','profile_expiry','ai_finalization') NOT NULL,
	`enabled` boolean NOT NULL DEFAULT false,
	`execution_epoch` int NOT NULL DEFAULT 1,
	`operator_request_id` varchar(36),
	`operator_request_fingerprint` varchar(64),
	`enabled_by_user_id` int,
	`enabled_at` timestamp,
	`pending_work_count` int NOT NULL DEFAULT 0,
	`dead_letter_count` int NOT NULL DEFAULT 0,
	`next_due_at` timestamp NOT NULL DEFAULT (now()),
	`lease_token` varchar(36),
	`lease_until` timestamp,
	`last_served_at` timestamp,
	`consecutive_failures` int NOT NULL DEFAULT 0,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `billing_scheduler_tenants_id` PRIMARY KEY(`id`),
	CONSTRAINT `billing_scheduler_tenants_workspace_mode_kind_unique` UNIQUE(`workspace_id`,`mode`,`kind`),
	CONSTRAINT `billing_scheduler_execution_epoch_positive` CHECK (`execution_epoch` > 0),
	CONSTRAINT `billing_scheduler_counters_nonnegative` CHECK (`pending_work_count` >= 0 AND `dead_letter_count` >= 0),
	CONSTRAINT `billing_scheduler_enabled_audit_required` CHECK (`enabled` = false OR `kind` = 'outbox' OR (`operator_request_id` IS NOT NULL AND `operator_request_fingerprint` IS NOT NULL AND `enabled_by_user_id` IS NOT NULL AND `enabled_at` IS NOT NULL)),
	CONSTRAINT `billing_scheduler_lease_pair` CHECK ((`lease_token` IS NULL AND `lease_until` IS NULL) OR (`lease_token` IS NOT NULL AND `lease_until` IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `billing_scheduler_process_heartbeats` (
	`process_id` varchar(96) NOT NULL,
	`mode` enum('test','live') NOT NULL,
	`kind` enum('outbox','reconciliation','profile_expiry','ai_finalization','notification_receiver') NOT NULL,
	`status` enum('starting','polling','stopped') NOT NULL DEFAULT 'starting',
	`started_at` timestamp NOT NULL DEFAULT (now()),
	`last_poll_at` timestamp NOT NULL,
	CONSTRAINT `billing_scheduler_process_heartbeats_process_id_mode_kind_pk` PRIMARY KEY(`process_id`,`mode`,`kind`)
);
--> statement-breakpoint
CREATE TABLE `billing_notification_scheduler_tenants` (
	`workspace_id` int NOT NULL,
	`mode` enum('test','live') NOT NULL,
	`next_due_at` timestamp NOT NULL DEFAULT (now()),
	`lease_token` varchar(36),
	`lease_until` timestamp,
	`last_served_at` timestamp,
	`pending_work_count` int NOT NULL DEFAULT 0,
	`dead_letter_count` int NOT NULL DEFAULT 0,
	CONSTRAINT `billing_notification_scheduler_tenants_workspace_id_mode_pk` PRIMARY KEY(`workspace_id`,`mode`),
	CONSTRAINT `billing_notification_scheduler_pending_nonnegative` CHECK (`pending_work_count` >= 0),
	CONSTRAINT `billing_notification_scheduler_dead_nonnegative` CHECK (`dead_letter_count` >= 0)
);
--> statement-breakpoint
CREATE TABLE `billing_webhook_routes` (
	`mode` enum('test','live') NOT NULL,
	`mollie_payment_id` varchar(64) NOT NULL,
	`workspace_id` int NOT NULL,
	`intent_id` varchar(36) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `billing_webhook_routes_mode_mollie_payment_id_pk` PRIMARY KEY(`mode`,`mollie_payment_id`)
);
--> statement-breakpoint
CREATE TABLE `messenger_privacy_subjects` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspace_id` int NOT NULL,
	`channel_connection_id` int NOT NULL,
	`user_key` varchar(96) NOT NULL,
	`privacy_epoch` int NOT NULL DEFAULT 1,
	`status` enum('active','erasing','erased') NOT NULL DEFAULT 'active',
	`erased_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `messenger_privacy_subjects_id` PRIMARY KEY(`id`),
	CONSTRAINT `messenger_privacy_subject_scope_unique` UNIQUE(`workspace_id`,`channel_connection_id`,`user_key`),
	CONSTRAINT `messenger_privacy_subject_epoch_positive` CHECK (`privacy_epoch` > 0),
	CONSTRAINT `messenger_privacy_subject_erased_timestamp` CHECK ((`status`='erased' AND `erased_at` IS NOT NULL) OR (`status`<>'erased' AND `erased_at` IS NULL))
);
--> statement-breakpoint
CREATE TABLE `messenger_provider_attempt_fences` (
	`id` int AUTO_INCREMENT NOT NULL,
	`attempt_key_hash` varchar(64) NOT NULL,
	`workspace_id` int NOT NULL,
	`channel_connection_id` int NOT NULL,
	`binding_epoch` int NOT NULL,
	`user_key` varchar(96) NOT NULL,
	`privacy_epoch` int NOT NULL,
	`provider_operation` varchar(48) NOT NULL,
	`attempt_number` int NOT NULL,
	`status` enum('reserved','started','known_failed','succeeded','ambiguous','contained','abandoned') NOT NULL,
	`lease_token` varchar(36) NOT NULL,
	`lease_until` timestamp NOT NULL,
	`started_at` timestamp,
	`completed_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `messenger_provider_attempt_fences_id` PRIMARY KEY(`id`),
	CONSTRAINT `messenger_provider_attempt_fences_attempt_unique` UNIQUE(`attempt_key_hash`),
	CONSTRAINT `messenger_provider_attempt_epochs_positive` CHECK (`binding_epoch` > 0 AND `privacy_epoch` > 0 AND `attempt_number` > 0),
	CONSTRAINT `messenger_provider_attempt_started_timestamp` CHECK (`status` NOT IN ('started','ambiguous','succeeded') OR `started_at` IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE `workspace_billing_profiles` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspace_id` int NOT NULL,
	`country_code` varchar(2) NOT NULL,
	`customer_type` enum('consumer','business') NOT NULL,
	`verification_status` enum('unverified','verified','rejected','revoked') NOT NULL DEFAULT 'unverified',
	`verification_method` varchar(48),
	`evidence_reference_hash` varchar(96),
	`verified_at` timestamp,
	`verification_expires_at` timestamp,
	`revoked_at` timestamp,
	`verified_by_user_id` int,
	`peppol_ready` boolean NOT NULL DEFAULT false,
	`eligibility_version` int NOT NULL DEFAULT 1,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workspace_billing_profiles_id` PRIMARY KEY(`id`),
	CONSTRAINT `workspace_billing_profiles_workspace_unique` UNIQUE(`workspace_id`)
);
--> statement-breakpoint
ALTER TABLE `billing_intents` MODIFY COLUMN `status` enum('created','creating_payment','open','paid','failed','canceled','expired','mismatch','contained','api_unknown') NOT NULL DEFAULT 'created';--> statement-breakpoint
ALTER TABLE `billing_outbox` MODIFY COLUMN `event_type` enum('ensure_subscription','cancel_subscription','cancel_payment','payment_warning','manual_review','send_portal_handoff') NOT NULL;--> statement-breakpoint
-- Release contract: all legacy billing, AI quota, handoff and provider writers
-- are stopped before this migration. Existing rows are contained with version
-- 0 / expired owner leases; rollback is read-only until 0015 is restored.
ALTER TABLE `billing_intents` ADD `billing_profile_version` int;--> statement-breakpoint
UPDATE `billing_intents` SET `billing_profile_version` = 0 WHERE `billing_profile_version` IS NULL;--> statement-breakpoint
ALTER TABLE `billing_intents` MODIFY COLUMN `billing_profile_version` int NOT NULL;--> statement-breakpoint
ALTER TABLE `billing_intents` ADD `authorization_epoch` int;--> statement-breakpoint
ALTER TABLE `billing_intents` ADD `url_exposed_at` timestamp;--> statement-breakpoint
ALTER TABLE `billing_outbox` ADD `delivery_id` varchar(36);--> statement-breakpoint
UPDATE `billing_outbox`
SET `delivery_id` = LOWER(CONCAT(
	SUBSTR(SHA2(CONCAT('leaderbot-outbox-v1:', `id`, ':', `workspace_id`, ':', `mode`), 256), 1, 8), '-',
	SUBSTR(SHA2(CONCAT('leaderbot-outbox-v1:', `id`, ':', `workspace_id`, ':', `mode`), 256), 9, 4), '-4',
	SUBSTR(SHA2(CONCAT('leaderbot-outbox-v1:', `id`, ':', `workspace_id`, ':', `mode`), 256), 14, 3), '-8',
	SUBSTR(SHA2(CONCAT('leaderbot-outbox-v1:', `id`, ':', `workspace_id`, ':', `mode`), 256), 18, 3), '-',
	SUBSTR(SHA2(CONCAT('leaderbot-outbox-v1:', `id`, ':', `workspace_id`, ':', `mode`), 256), 21, 12)
))
WHERE `delivery_id` IS NULL;--> statement-breakpoint
ALTER TABLE `billing_outbox` MODIFY COLUMN `delivery_id` varchar(36) NOT NULL;--> statement-breakpoint
ALTER TABLE `billing_outbox` ADD `delivery_epoch` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `billing_outbox` ADD `delivery_state` enum('idle','preparing','transport_started','transport_succeeded','ambiguous') DEFAULT 'idle' NOT NULL;--> statement-breakpoint
UPDATE `billing_outbox`
SET
	`status`='failed',
	`delivery_state`='ambiguous',
	`last_error_code`='legacy_transport_ambiguous',
	`locked_at`=NULL,
	`lease_token`=NULL
WHERE `event_type`='send_portal_handoff'
	AND (`status`='processing' OR `attempt_count`>0);--> statement-breakpoint
ALTER TABLE `billing_outbox` ADD `privacy_erased_at` timestamp;--> statement-breakpoint
ALTER TABLE `channelConnections` ADD `bindingEpoch` int DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `portalHandoffTokens` ADD `capability_generation` int DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_entitlement_usage_reservations` ADD `channel_connection_id` int;--> statement-breakpoint
ALTER TABLE `workspace_entitlement_usage_reservations` ADD `binding_epoch` int;--> statement-breakpoint
ALTER TABLE `workspace_entitlement_usage_reservations` ADD `owner_token_hash` varchar(64);--> statement-breakpoint
ALTER TABLE `workspace_entitlement_usage_reservations` ADD `owner_lease_until` timestamp;--> statement-breakpoint
ALTER TABLE `workspace_entitlement_usage_reservations` ADD `delivery_started_at` timestamp;--> statement-breakpoint
ALTER TABLE `workspace_entitlement_usage_reservations` ADD `delivery_known_rejected_at` timestamp;--> statement-breakpoint
ALTER TABLE `workspace_entitlement_usage_reservations` ADD `delivery_attempt_token_hash` varchar(64);--> statement-breakpoint
ALTER TABLE `workspace_entitlement_usage_reservations` ADD `resolution_due_at` timestamp;--> statement-breakpoint
UPDATE `workspace_entitlement_usage_reservations`
SET
	`owner_token_hash` = COALESCE(`owner_token_hash`, SHA2(CONCAT('legacy-contained:', `reservation_id`), 256)),
	`owner_lease_until` = COALESCE(`owner_lease_until`, CURRENT_TIMESTAMP),
	`resolution_due_at` = COALESCE(`resolution_due_at`, CURRENT_TIMESTAMP),
	-- Legacy reserved usage may already have crossed transport. Mark the
	-- unknown boundary conservatively so the finalizer commits, never refunds.
	`delivery_started_at` = CASE
		WHEN `status`='reserved' THEN COALESCE(`delivery_started_at`,CURRENT_TIMESTAMP)
		ELSE `delivery_started_at`
	END,
	`delivery_attempt_token_hash` = CASE
		WHEN `status`='reserved' THEN COALESCE(`delivery_attempt_token_hash`,SHA2(CONCAT('legacy-ambiguous:',`reservation_id`),256))
		ELSE `delivery_attempt_token_hash`
	END
WHERE `owner_token_hash` IS NULL OR `owner_lease_until` IS NULL OR `resolution_due_at` IS NULL;--> statement-breakpoint
ALTER TABLE `workspace_entitlement_usage_reservations` MODIFY COLUMN `owner_token_hash` varchar(64) NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_entitlement_usage_reservations` MODIFY COLUMN `owner_lease_until` timestamp NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_entitlement_usage_reservations` MODIFY COLUMN `resolution_due_at` timestamp NOT NULL;--> statement-breakpoint
UPDATE `billing_intents`
SET `status` = 'contained'
WHERE `billing_profile_version` = 0
	AND `status` IN ('created','creating_payment','open','api_unknown');--> statement-breakpoint
INSERT INTO `billing_outbox` (`delivery_id`,`workspace_id`,`mode`,`event_type`,`deduplication_key`,`payload`,`status`,`available_at`)
SELECT
	LOWER(CONCAT(SUBSTR(`source`.`digest`,1,8),'-',SUBSTR(`source`.`digest`,9,4),'-4',SUBSTR(`source`.`digest`,14,3),'-8',SUBSTR(`source`.`digest`,18,3),'-',SUBSTR(`source`.`digest`,21,12))),
	`source`.`workspace_id`,
	`source`.`mode`,
	'cancel_payment',
	`source`.`deduplication_key`,
	JSON_OBJECT('reason','billing_profile_revoked','intentId',`source`.`intent_id`,'targetPaymentId',`source`.`mollie_payment_id`),
	'pending',
	CURRENT_TIMESTAMP
FROM (
	SELECT
		`workspace_id`,`mode`,`intent_id`,`mollie_payment_id`,
		CONCAT('legacy_profile_payment_cancel:',`workspace_id`,':',`mollie_payment_id`) AS `deduplication_key`,
		SHA2(CONCAT('leaderbot-outbox-v1:legacy-payment:',`workspace_id`,':',`mode`,':',`mollie_payment_id`),256) AS `digest`
	FROM `billing_intents`
	WHERE `billing_profile_version` = 0 AND `status` = 'contained' AND `mollie_payment_id` IS NOT NULL
) AS `source`
ON DUPLICATE KEY UPDATE `deduplication_key` = VALUES(`deduplication_key`);--> statement-breakpoint
INSERT INTO `billing_outbox` (`delivery_id`,`workspace_id`,`mode`,`event_type`,`deduplication_key`,`payload`,`status`,`available_at`)
SELECT
	LOWER(CONCAT(SUBSTR(`source`.`digest`,1,8),'-',SUBSTR(`source`.`digest`,9,4),'-4',SUBSTR(`source`.`digest`,14,3),'-8',SUBSTR(`source`.`digest`,18,3),'-',SUBSTR(`source`.`digest`,21,12))),
	`source`.`workspace_id`,
	`source`.`mode`,
	'cancel_subscription',
	`source`.`deduplication_key`,
	JSON_OBJECT('reason','billing_profile_revoked','expectedSourceIntentId',`source`.`source_intent_id`,'targetCustomerId',`source`.`mollie_customer_id`,'targetSubscriptionId',`source`.`mollie_subscription_id`),
	'pending',
	CURRENT_TIMESTAMP
FROM (
	SELECT
		`workspace_id`,`mode`,`source_intent_id`,`mollie_customer_id`,`mollie_subscription_id`,
		CONCAT('legacy_profile_subscription_cancel:',`workspace_id`,':',`mollie_subscription_id`) AS `deduplication_key`,
		SHA2(CONCAT('leaderbot-outbox-v1:legacy-subscription:',`workspace_id`,':',`mode`,':',`mollie_subscription_id`),256) AS `digest`
	FROM `billing_subscriptions`
	WHERE `status` IN ('provisioning','active','past_due','manual_review')
		AND `mollie_customer_id` IS NOT NULL AND `mollie_subscription_id` IS NOT NULL
) AS `source`
ON DUPLICATE KEY UPDATE `deduplication_key` = VALUES(`deduplication_key`);--> statement-breakpoint
UPDATE `workspace_entitlements`
SET `status` = 'manual_review'
WHERE (`workspace_id`,`mode`) IN (
	SELECT `workspace_id`,`mode` FROM `billing_subscriptions`
	WHERE `status` IN ('provisioning','active','past_due','manual_review')
);--> statement-breakpoint
UPDATE `billing_subscriptions`
SET `status` = 'manual_review'
WHERE `status` IN ('provisioning','active','past_due');--> statement-breakpoint
INSERT INTO `billing_webhook_routes` (`mode`,`mollie_payment_id`,`workspace_id`,`intent_id`,`created_at`)
SELECT `mode`,`mollie_payment_id`,`workspace_id`,`intent_id`,CURRENT_TIMESTAMP
FROM `billing_intents`
WHERE `mollie_payment_id` IS NOT NULL;--> statement-breakpoint
INSERT INTO `billing_scheduler_tenants` (`workspace_id`,`mode`,`kind`,`enabled`,`next_due_at`)
SELECT
	`source`.`workspace_id`,
	`source`.`mode`,
	`kinds`.`kind`,
	`kinds`.`kind` = 'outbox',
	CASE `kinds`.`kind`
		WHEN 'outbox' THEN COALESCE((
			SELECT MIN(`available_at`) FROM `billing_outbox`
			WHERE `workspace_id` = `source`.`workspace_id` AND `mode` = `source`.`mode` AND `status` IN ('pending','processing')
		), DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 24 HOUR))
		WHEN 'reconciliation' THEN COALESCE((
			SELECT MIN(`next_reconciliation_at`) FROM `billing_customers`
			WHERE `workspace_id` = `source`.`workspace_id` AND `mode` = `source`.`mode`
		), CURRENT_TIMESTAMP)
		WHEN 'ai_finalization' THEN COALESCE((
			SELECT MIN(`resolution_due_at`) FROM `workspace_entitlement_usage_reservations`
			WHERE `workspace_id` = `source`.`workspace_id` AND `mode` = `source`.`mode` AND `status` = 'reserved'
		), DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 24 HOUR))
		ELSE DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 24 HOUR)
	END
FROM (
	SELECT `workspace_id`,`mode` FROM `billing_customers`
	UNION SELECT `workspace_id`,`mode` FROM `billing_outbox`
	UNION SELECT `workspace_id`,`mode` FROM `billing_intents`
	UNION SELECT `workspace_id`,`mode` FROM `workspace_entitlement_usage_reservations`
) AS `source`
CROSS JOIN (
	SELECT 'outbox' AS `kind`
	UNION ALL SELECT 'reconciliation'
	UNION ALL SELECT 'profile_expiry'
	UNION ALL SELECT 'ai_finalization'
) AS `kinds`;--> statement-breakpoint
INSERT INTO `billing_execution_controls` (`workspace_id`,`mode`,`commercial_enabled`,`authorization_epoch`)
SELECT
	`scheduler`.`workspace_id`,
	`scheduler`.`mode`,
	false,
	MIN(`scheduler`.`execution_epoch`)
FROM `billing_scheduler_tenants` AS `scheduler`
GROUP BY `scheduler`.`workspace_id`,`scheduler`.`mode`
HAVING COUNT(*)=4
	AND COUNT(DISTINCT `scheduler`.`kind`)=4
	AND COUNT(DISTINCT `scheduler`.`execution_epoch`)=1;--> statement-breakpoint
CREATE TEMPORARY TABLE `_0015_control_preflight` (
	`violation` tinyint NOT NULL PRIMARY KEY,
	CONSTRAINT `_0015_control_preflight_must_be_empty` CHECK (`violation` = 0)
);--> statement-breakpoint
INSERT INTO `_0015_control_preflight` (`violation`)
SELECT 1 FROM DUAL WHERE EXISTS (
	SELECT 1
	FROM (
		SELECT `workspace_id`,`mode` FROM `billing_customers`
		UNION SELECT `workspace_id`,`mode` FROM `billing_outbox`
		UNION SELECT `workspace_id`,`mode` FROM `billing_intents`
		UNION SELECT `workspace_id`,`mode` FROM `workspace_entitlement_usage_reservations`
	) AS `source`
	LEFT JOIN `billing_execution_controls` AS `control`
		ON `control`.`workspace_id`=`source`.`workspace_id` AND `control`.`mode`=`source`.`mode`
	LEFT JOIN (
		SELECT `workspace_id`,`mode`,COUNT(*) AS `lane_count`,COUNT(DISTINCT `kind`) AS `kind_count`,COUNT(DISTINCT `execution_epoch`) AS `epoch_count`,MIN(`execution_epoch`) AS `lane_epoch`
		FROM `billing_scheduler_tenants`
		GROUP BY `workspace_id`,`mode`
	) AS `lanes`
		ON `lanes`.`workspace_id`=`source`.`workspace_id` AND `lanes`.`mode`=`source`.`mode`
	WHERE `control`.`workspace_id` IS NULL
		OR `lanes`.`lane_count`<>4
		OR `lanes`.`kind_count`<>4
		OR `lanes`.`epoch_count`<>1
		OR `lanes`.`lane_epoch`<>`control`.`authorization_epoch`
);--> statement-breakpoint
DROP TEMPORARY TABLE `_0015_control_preflight`;--> statement-breakpoint
UPDATE `billing_intents` AS `intent`
JOIN `billing_execution_controls` AS `control`
	ON `control`.`workspace_id`=`intent`.`workspace_id` AND `control`.`mode`=`intent`.`mode`
SET `intent`.`authorization_epoch`=`control`.`authorization_epoch`
WHERE `intent`.`authorization_epoch` IS NULL;--> statement-breakpoint
ALTER TABLE `billing_intents` MODIFY COLUMN `authorization_epoch` int NOT NULL;--> statement-breakpoint
UPDATE `billing_scheduler_tenants` AS `scheduler`
SET
	`scheduler`.`pending_work_count` = CASE WHEN `scheduler`.`kind`='outbox' THEN (
		SELECT COUNT(*) FROM `billing_outbox` AS `outbox`
		WHERE `outbox`.`workspace_id`=`scheduler`.`workspace_id`
			AND `outbox`.`mode`=`scheduler`.`mode`
			AND `outbox`.`status` IN ('pending','processing')
	) ELSE 0 END,
	`scheduler`.`dead_letter_count` = CASE WHEN `scheduler`.`kind`='outbox' THEN (
		SELECT COUNT(*) FROM `billing_outbox` AS `outbox`
		WHERE `outbox`.`workspace_id`=`scheduler`.`workspace_id`
			AND `outbox`.`mode`=`scheduler`.`mode`
			AND `outbox`.`status`='failed'
	) ELSE 0 END;--> statement-breakpoint
ALTER TABLE `billing_outbox`
	ADD CONSTRAINT `billing_outbox_id_workspace_unique` UNIQUE(`id`,`workspace_id`),
	ADD CONSTRAINT `billing_outbox_attempts_nonnegative` CHECK (`attempt_count` >= 0 AND `max_attempts` > 0),
	ADD CONSTRAINT `billing_outbox_delivery_epoch_nonnegative` CHECK (`delivery_epoch` >= 0),
	ADD CONSTRAINT `billing_outbox_delivery_state_status` CHECK ((`delivery_state` NOT IN ('preparing','transport_started') OR `status`='processing') AND (`delivery_state`<>'transport_succeeded' OR `status` IN ('processing','completed')) AND (`delivery_state`<>'ambiguous' OR `status`='failed'));--> statement-breakpoint
ALTER TABLE `billing_outbox` ADD CONSTRAINT `billing_outbox_delivery_id_unique` UNIQUE(`delivery_id`);--> statement-breakpoint
ALTER TABLE `channelConnections`
	ADD CONSTRAINT `channelConnections_workspaceId_workspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE restrict ON UPDATE no action,
	ADD CONSTRAINT `channelConnections_id_workspace_unique` UNIQUE(`id`,`workspaceId`),
	ADD CONSTRAINT `channelConnections_id_workspace_binding_unique` UNIQUE(`id`,`workspaceId`,`bindingEpoch`);--> statement-breakpoint
ALTER TABLE `billing_intents`
	ADD CONSTRAINT `billing_intents_scope_profile_unique` UNIQUE(`intent_id`,`workspace_id`,`mode`,`billing_profile_version`,`authorization_epoch`),
	ADD CONSTRAINT `billing_intents_scope_unique` UNIQUE(`intent_id`,`workspace_id`,`mode`);--> statement-breakpoint
ALTER TABLE `billing_subscriptions`
	DROP FOREIGN KEY `billing_subscriptions_source_intent_fk`,
	ADD CONSTRAINT `billing_subscriptions_source_intent_scope_fk` FOREIGN KEY (`source_intent_id`,`workspace_id`,`mode`) REFERENCES `billing_intents`(`intent_id`,`workspace_id`,`mode`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payment_ledger`
	DROP INDEX `payment_ledger_workspace_mode_occurred_idx`,
	ADD CONSTRAINT `payment_ledger_id_workspace_mode_unique` UNIQUE(`id`,`workspace_id`,`mode`),
	ADD INDEX `payment_ledger_workspace_mode_occurred_idx` (`workspace_id`,`mode`,`occurred_at`,`id`);--> statement-breakpoint
ALTER TABLE `workspace_entitlements`
	DROP FOREIGN KEY `workspace_entitlements_source_intent_fk`,
	ADD CONSTRAINT `workspace_entitlements_id_scope_unique` UNIQUE(`id`,`workspace_id`,`mode`),
	ADD CONSTRAINT `workspace_entitlements_source_intent_scope_fk` FOREIGN KEY (`source_intent_id`,`workspace_id`,`mode`) REFERENCES `billing_intents`(`intent_id`,`workspace_id`,`mode`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `billing_accounting_event_links` ADD CONSTRAINT `billing_accounting_event_links_provider_event_mode_fk` FOREIGN KEY (`provider_event_id`,`mode`) REFERENCES `billing_accounting_provider_events`(`id`,`mode`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `billing_accounting_event_links` ADD CONSTRAINT `billing_accounting_event_links_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `billing_accounting_event_links` ADD CONSTRAINT `billing_accounting_event_links_ledger_workspace_fk` FOREIGN KEY (`payment_ledger_id`,`workspace_id`,`mode`) REFERENCES `payment_ledger`(`id`,`workspace_id`,`mode`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `billing_handoff_recovery_events` ADD CONSTRAINT `billing_handoff_recovery_events_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `billing_handoff_recovery_events` ADD CONSTRAINT `billing_handoff_recovery_outbox_workspace_fk` FOREIGN KEY (`outbox_id`,`workspace_id`) REFERENCES `billing_outbox`(`id`,`workspace_id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `billing_notification_inbox` ADD CONSTRAINT `billing_notification_inbox_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `billing_notification_inbox` ADD CONSTRAINT `billing_notification_inbox_receipt_workspace_fk` FOREIGN KEY (`receipt_id`,`workspace_id`,`audience`) REFERENCES `billing_notification_receipts`(`id`,`workspace_id`,`audience`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `billing_notification_receipts` ADD CONSTRAINT `billing_notification_receipts_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `billing_notification_receiver_outbox` ADD CONSTRAINT `billing_notification_receiver_outbox_receipt_workspace_fk` FOREIGN KEY (`receipt_id`,`workspace_id`,`mode`,`audience`) REFERENCES `billing_notification_receipts`(`id`,`workspace_id`,`mode`,`audience`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `billing_profile_operator_actions` ADD CONSTRAINT `billing_profile_operator_actions_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `billing_profile_operator_actions` ADD CONSTRAINT `billing_profile_operator_actions_actor_user_id_users_id_fk` FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `billing_provider_operations` ADD CONSTRAINT `billing_provider_operations_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `billing_execution_controls` ADD CONSTRAINT `billing_execution_controls_workspace_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `billing_provider_operations` ADD CONSTRAINT `billing_provider_ops_execution_control_fk` FOREIGN KEY (`workspace_id`,`mode`) REFERENCES `billing_execution_controls`(`workspace_id`,`mode`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `billing_provider_operations` ADD CONSTRAINT `billing_provider_operations_intent_scope_fk` FOREIGN KEY (`intent_id`,`workspace_id`,`mode`,`billing_profile_version`,`authorization_epoch`) REFERENCES `billing_intents`(`intent_id`,`workspace_id`,`mode`,`billing_profile_version`,`authorization_epoch`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `billing_scheduler_tenants` ADD CONSTRAINT `billing_scheduler_tenants_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `billing_scheduler_tenants` ADD CONSTRAINT `billing_scheduler_tenants_enabled_by_user_id_users_id_fk` FOREIGN KEY (`enabled_by_user_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `billing_notification_scheduler_tenants` ADD CONSTRAINT `billing_notification_scheduler_workspace_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `billing_webhook_routes` ADD CONSTRAINT `billing_webhook_routes_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `billing_webhook_routes` ADD CONSTRAINT `billing_webhook_routes_intent_scope_fk` FOREIGN KEY (`intent_id`,`workspace_id`,`mode`) REFERENCES `billing_intents`(`intent_id`,`workspace_id`,`mode`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `messenger_privacy_subjects` ADD CONSTRAINT `messenger_privacy_subject_connection_workspace_fk` FOREIGN KEY (`channel_connection_id`,`workspace_id`) REFERENCES `channelConnections`(`id`,`workspaceId`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `messenger_privacy_subjects` ADD CONSTRAINT `messenger_privacy_subject_epoch_unique` UNIQUE(`workspace_id`,`channel_connection_id`,`user_key`,`privacy_epoch`);--> statement-breakpoint
ALTER TABLE `messenger_provider_attempt_fences` ADD CONSTRAINT `messenger_provider_attempt_fences_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `messenger_provider_attempt_fences` ADD CONSTRAINT `messenger_provider_fence_connection_workspace_fk` FOREIGN KEY (`channel_connection_id`,`workspace_id`,`binding_epoch`) REFERENCES `channelConnections`(`id`,`workspaceId`,`bindingEpoch`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `messenger_provider_attempt_fences` ADD CONSTRAINT `messenger_provider_fence_privacy_subject_fk` FOREIGN KEY (`workspace_id`,`channel_connection_id`,`user_key`,`privacy_epoch`) REFERENCES `messenger_privacy_subjects`(`workspace_id`,`channel_connection_id`,`user_key`,`privacy_epoch`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspace_billing_profiles` ADD CONSTRAINT `workspace_billing_profiles_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspace_billing_profiles` ADD CONSTRAINT `workspace_billing_profiles_verified_by_user_id_users_id_fk` FOREIGN KEY (`verified_by_user_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `billing_accounting_event_links_workspace_status_idx` ON `billing_accounting_event_links` (`workspace_id`,`link_status`);--> statement-breakpoint
CREATE INDEX `billing_accounting_import_cursors_lease_idx` ON `billing_accounting_import_cursors` (`lease_until`,`lease_token`);--> statement-breakpoint
CREATE INDEX `billing_accounting_import_runs_account_mode_idx` ON `billing_accounting_import_runs` (`provider_account_id`,`mode`,`created_at`);--> statement-breakpoint
CREATE INDEX `billing_accounting_provider_events_payment_route_idx` ON `billing_accounting_provider_events` (`mode`,`mollie_payment_id`,`id`);--> statement-breakpoint
CREATE INDEX `billing_accounting_provider_events_account_mode_time_idx` ON `billing_accounting_provider_events` (`provider_account_id`,`mode`,`occurred_at`,`id`);--> statement-breakpoint
CREATE INDEX `billing_handoff_recovery_events_workspace_idx` ON `billing_handoff_recovery_events` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `billing_notification_inbox_workspace_audience_created_idx` ON `billing_notification_inbox` (`workspace_id`,`audience`,`occurred_at`,`id`);--> statement-breakpoint
CREATE INDEX `billing_notification_receiver_outbox_status_created_idx` ON `billing_notification_receiver_outbox` (`status`,`available_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `billing_notification_scheduler_due_idx` ON `billing_notification_scheduler_tenants` (`mode`,`next_due_at`,`last_served_at`);--> statement-breakpoint
CREATE INDEX `billing_profile_operator_actions_workspace_created_idx` ON `billing_profile_operator_actions` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `billing_provider_operations_due_idx` ON `billing_provider_operations` (`workspace_id`,`mode`,`state`,`resolution_due_at`);--> statement-breakpoint
CREATE INDEX `billing_scheduler_tenants_due_idx` ON `billing_scheduler_tenants` (`mode`,`kind`,`enabled`,`next_due_at`,`last_served_at`);--> statement-breakpoint
CREATE INDEX `billing_scheduler_tenants_lease_idx` ON `billing_scheduler_tenants` (`lease_until`,`lease_token`);--> statement-breakpoint
CREATE INDEX `billing_webhook_routes_workspace_mode_idx` ON `billing_webhook_routes` (`workspace_id`,`mode`,`intent_id`);--> statement-breakpoint
CREATE INDEX `messenger_privacy_subject_status_idx` ON `messenger_privacy_subjects` (`workspace_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `messenger_provider_attempt_fences_connection_active_idx` ON `messenger_provider_attempt_fences` (`channel_connection_id`,`status`,`lease_until`);--> statement-breakpoint
CREATE INDEX `workspace_billing_profiles_verification_idx` ON `workspace_billing_profiles` (`verification_status`,`country_code`);--> statement-breakpoint
ALTER TABLE `workspace_entitlement_usage`
	DROP FOREIGN KEY `weu_entitlement_fk`,
	DROP FOREIGN KEY `weu_source_intent_fk`,
	ADD CONSTRAINT `workspace_entitlement_usage_scope_unique` UNIQUE(`entitlement_id`,`workspace_id`,`mode`),
	ADD CONSTRAINT `weu_entitlement_scope_fk` FOREIGN KEY (`entitlement_id`,`workspace_id`,`mode`) REFERENCES `workspace_entitlements`(`id`,`workspace_id`,`mode`) ON DELETE restrict ON UPDATE no action,
	ADD CONSTRAINT `weu_source_intent_scope_fk` FOREIGN KEY (`source_intent_id`,`workspace_id`,`mode`) REFERENCES `billing_intents`(`intent_id`,`workspace_id`,`mode`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspace_entitlement_usage_reservations`
	DROP INDEX `workspace_entitlement_reservations_expiry_idx`,
	DROP FOREIGN KEY `weur_entitlement_fk`,
	ADD INDEX `workspace_entitlement_reservations_expiry_idx` (`workspace_id`,`mode`,`status`,`resolution_due_at`),
	ADD CONSTRAINT `weur_connection_workspace_fk` FOREIGN KEY (`channel_connection_id`,`workspace_id`,`binding_epoch`) REFERENCES `channelConnections`(`id`,`workspaceId`,`bindingEpoch`) ON DELETE restrict ON UPDATE no action,
	ADD CONSTRAINT `weur_entitlement_scope_fk` FOREIGN KEY (`entitlement_id`,`workspace_id`,`mode`) REFERENCES `workspace_entitlements`(`id`,`workspace_id`,`mode`) ON DELETE restrict ON UPDATE no action,
	ADD CONSTRAINT `weur_usage_scope_fk` FOREIGN KEY (`entitlement_id`,`workspace_id`,`mode`) REFERENCES `workspace_entitlement_usage`(`entitlement_id`,`workspace_id`,`mode`) ON DELETE restrict ON UPDATE no action,
	ADD CONSTRAINT `workspace_entitlement_reservation_binding_pair` CHECK ((`channel_connection_id` IS NULL AND `binding_epoch` IS NULL) OR (`channel_connection_id` IS NOT NULL AND `binding_epoch` > 0)),
	ADD CONSTRAINT `workspace_entitlement_reservation_delivery_pair` CHECK ((`delivery_started_at` IS NULL AND `delivery_attempt_token_hash` IS NULL AND `delivery_known_rejected_at` IS NULL) OR (`delivery_started_at` IS NOT NULL AND `delivery_attempt_token_hash` IS NOT NULL));
--> statement-breakpoint
CREATE TRIGGER `billing_outbox_wake_scheduler_after_insert`
AFTER INSERT ON `billing_outbox`
FOR EACH ROW
BEGIN
	IF NEW.`status` IN ('pending','processing') THEN
		UPDATE `billing_scheduler_tenants`
		SET `next_due_at` = LEAST(`next_due_at`,NEW.`available_at`),
			`pending_work_count` = `pending_work_count` + 1
		WHERE `workspace_id`=NEW.`workspace_id` AND `mode`=NEW.`mode`
			AND `kind`='outbox';
	END IF;
	IF NEW.`status`='failed' THEN
		UPDATE `billing_scheduler_tenants`
		SET `dead_letter_count`=`dead_letter_count` + 1
		WHERE `workspace_id`=NEW.`workspace_id` AND `mode`=NEW.`mode`
			AND `kind`='outbox';
	END IF;
END;--> statement-breakpoint
CREATE TRIGGER `billing_outbox_wake_scheduler_after_update`
AFTER UPDATE ON `billing_outbox`
FOR EACH ROW
BEGIN
	IF NEW.`status` IN ('pending','processing') THEN
		UPDATE `billing_scheduler_tenants`
		SET `next_due_at` = LEAST(`next_due_at`,NEW.`available_at`),
			`pending_work_count` = `pending_work_count`
				+ (NEW.`status` IN ('pending','processing'))
				- (OLD.`status` IN ('pending','processing')),
			`dead_letter_count` = `dead_letter_count`
				+ (NEW.`status`='failed') - (OLD.`status`='failed')
		WHERE `workspace_id`=NEW.`workspace_id` AND `mode`=NEW.`mode`
			AND `kind`='outbox';
	ELSEIF OLD.`status` <> NEW.`status` THEN
		UPDATE `billing_scheduler_tenants`
		SET `pending_work_count` = `pending_work_count`
				+ (NEW.`status` IN ('pending','processing'))
				- (OLD.`status` IN ('pending','processing')),
			`dead_letter_count` = `dead_letter_count`
				+ (NEW.`status`='failed') - (OLD.`status`='failed')
		WHERE `workspace_id`=NEW.`workspace_id` AND `mode`=NEW.`mode`
			AND `kind`='outbox';
	END IF;
END;--> statement-breakpoint
CREATE TRIGGER `billing_scheduler_execution_epoch_before_update`
BEFORE UPDATE ON `billing_scheduler_tenants`
FOR EACH ROW
SET
	NEW.`execution_epoch` = IF(
		NEW.`enabled` <> OLD.`enabled`,
		OLD.`execution_epoch` + 1,
		NEW.`execution_epoch`
	),
	NEW.`lease_token` = IF(
		NEW.`enabled` <> OLD.`enabled`,NULL,NEW.`lease_token`
	),
	NEW.`lease_until` = IF(
		NEW.`enabled` <> OLD.`enabled`,NULL,NEW.`lease_until`
	);
