-- Fail before any implicit-commit DDL when one Page is already claimed by
-- multiple workspaces. Resolving ownership requires an explicit operator
-- decision; this migration must never partially apply, delete, or reassign
-- tenant data before reporting the conflict.
CREATE TEMPORARY TABLE `_0010_abort_duplicate_channel_claims` (
	`guard_value` tinyint NOT NULL,
	CONSTRAINT `_0010_abort_duplicate_channel_claims_pk` PRIMARY KEY (`guard_value`)
);--> statement-breakpoint
INSERT INTO `_0010_abort_duplicate_channel_claims` (`guard_value`) VALUES (1);--> statement-breakpoint
INSERT INTO `_0010_abort_duplicate_channel_claims` (`guard_value`)
SELECT 1
FROM (
	SELECT `channel`, `externalId`
	FROM `channelConnections`
	WHERE `externalId` IS NOT NULL
	GROUP BY `channel`, `externalId`
	HAVING COUNT(*) > 1
	LIMIT 1
) AS `duplicate_channel_claims`;--> statement-breakpoint
DROP TEMPORARY TABLE `_0010_abort_duplicate_channel_claims`;--> statement-breakpoint
ALTER TABLE `channelConnections` ADD CONSTRAINT `channelConnections_channel_externalId_unique` UNIQUE(`channel`,`externalId`);--> statement-breakpoint
CREATE TABLE `workspace_entitlement_usage` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspace_id` int NOT NULL,
	`mode` enum('test','live') NOT NULL,
	`entitlement_id` int NOT NULL,
	`plan_code` varchar(80) NOT NULL,
	`source_intent_id` varchar(36) NOT NULL,
	`period_started_at` timestamp NOT NULL,
	`period_ends_at` timestamp NOT NULL,
	`ai_answers_committed` int NOT NULL DEFAULT 0,
	`ai_answers_reserved` int NOT NULL DEFAULT 0,
	`images_used` int NOT NULL DEFAULT 0,
	`image_usage_date` varchar(10),
	`images_used_today` int NOT NULL DEFAULT 0,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workspace_entitlement_usage_id` PRIMARY KEY(`id`),
	CONSTRAINT `workspace_entitlement_usage_workspace_mode_plan_unique` UNIQUE(`workspace_id`,`mode`,`plan_code`),
	CONSTRAINT `workspace_entitlement_usage_entitlement_unique` UNIQUE(`entitlement_id`)
);
--> statement-breakpoint
CREATE TABLE `workspace_entitlement_usage_reservations` (
	`reservation_id` varchar(36) NOT NULL,
	`workspace_id` int NOT NULL,
	`mode` enum('test','live') NOT NULL,
	`entitlement_id` int NOT NULL,
	`kind` enum('ai_answer','image') NOT NULL,
	`status` enum('reserved','committed','released','expired') NOT NULL DEFAULT 'reserved',
	`idempotency_key` varchar(160) NOT NULL,
	`expires_at` timestamp NOT NULL,
	`committed_at` timestamp,
	`released_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `workspace_entitlement_usage_reservations_reservation_id` PRIMARY KEY(`reservation_id`),
	CONSTRAINT `workspace_entitlement_reservations_idempotency_unique` UNIQUE(`workspace_id`,`mode`,`idempotency_key`)
);
--> statement-breakpoint
ALTER TABLE `billing_intents` MODIFY COLUMN `kind` enum('subscription_start','payment_method_change','startpilot_purchase') NOT NULL DEFAULT 'subscription_start';--> statement-breakpoint
ALTER TABLE `workspace_entitlements` ADD `source_intent_id` varchar(36);--> statement-breakpoint
ALTER TABLE `workspace_entitlement_usage` ADD CONSTRAINT `weu_workspace_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspace_entitlement_usage` ADD CONSTRAINT `weu_entitlement_fk` FOREIGN KEY (`entitlement_id`) REFERENCES `workspace_entitlements`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspace_entitlement_usage` ADD CONSTRAINT `weu_source_intent_fk` FOREIGN KEY (`source_intent_id`) REFERENCES `billing_intents`(`intent_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspace_entitlement_usage_reservations` ADD CONSTRAINT `weur_workspace_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspace_entitlement_usage_reservations` ADD CONSTRAINT `weur_entitlement_fk` FOREIGN KEY (`entitlement_id`) REFERENCES `workspace_entitlements`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `workspace_entitlement_reservations_expiry_idx` ON `workspace_entitlement_usage_reservations` (`mode`,`status`,`expires_at`);--> statement-breakpoint
ALTER TABLE `workspace_entitlements` ADD CONSTRAINT `workspace_entitlements_source_intent_fk` FOREIGN KEY (`source_intent_id`) REFERENCES `billing_intents`(`intent_id`) ON DELETE restrict ON UPDATE no action;
