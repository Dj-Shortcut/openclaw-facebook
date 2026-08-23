-- EXPAND PHASE ONLY. Every statement in 0016 must remain compatible with the
-- production writer that understands schema 0015. Do not add all-or-none
-- checks, NOT NULL columns, or any other old-writer fence to this migration.
--
-- Historical provider attempts and entitlement reservations keep the epochs
-- that authorized them. Their referential integrity belongs to the immutable
-- tenant/connection/subject scope, not to a mutable current epoch. Replacing
-- the epoch-bearing foreign keys broadens accepted historical rows; it does
-- not reject any row accepted by the 0015 writer.
--
-- Abort before MySQL auto-commits any permanent DDL if an existing row cannot
-- be attached to that static scope.
CREATE TEMPORARY TABLE `_0016_static_scope_preflight` (
	`violation` tinyint NOT NULL PRIMARY KEY,
	CONSTRAINT `_0016_static_scope_preflight_empty` CHECK (`violation` = 0)
);--> statement-breakpoint
INSERT INTO `_0016_static_scope_preflight` (`violation`)
SELECT 1 FROM DUAL
WHERE
	EXISTS (
		SELECT 1
		FROM `messenger_provider_attempt_fences` AS `fence`
		LEFT JOIN `channelConnections` AS `connection`
			ON `connection`.`id`=`fence`.`channel_connection_id`
			AND `connection`.`workspaceId`=`fence`.`workspace_id`
		WHERE `connection`.`id` IS NULL
	)
	OR EXISTS (
		SELECT 1
		FROM `messenger_provider_attempt_fences` AS `fence`
		LEFT JOIN `messenger_privacy_subjects` AS `subject`
			ON `subject`.`workspace_id`=`fence`.`workspace_id`
			AND `subject`.`channel_connection_id`=`fence`.`channel_connection_id`
			AND `subject`.`user_key`=`fence`.`user_key`
		WHERE `subject`.`id` IS NULL
	)
	OR EXISTS (
		SELECT 1
		FROM `workspace_entitlement_usage_reservations` AS `reservation`
		LEFT JOIN `channelConnections` AS `connection`
			ON `connection`.`id`=`reservation`.`channel_connection_id`
			AND `connection`.`workspaceId`=`reservation`.`workspace_id`
		WHERE `reservation`.`channel_connection_id` IS NOT NULL
			AND (`reservation`.`binding_epoch` IS NULL OR `connection`.`id` IS NULL)
	);--> statement-breakpoint
DROP TEMPORARY TABLE `_0016_static_scope_preflight`;--> statement-breakpoint
ALTER TABLE `messenger_privacy_subjects` ADD `last_erased_at` timestamp(3);--> statement-breakpoint
UPDATE `messenger_privacy_subjects`
SET `last_erased_at`=CASE
	WHEN `last_erased_at` IS NULL OR `erased_at`>`last_erased_at` THEN `erased_at`
	ELSE `last_erased_at`
END
WHERE `erased_at` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `messenger_provider_attempt_fences`
	DROP FOREIGN KEY `messenger_provider_fence_connection_workspace_fk`,
	DROP FOREIGN KEY `messenger_provider_fence_privacy_subject_fk`,
	ADD CONSTRAINT `messenger_provider_fence_static_connection_fk` FOREIGN KEY (`channel_connection_id`,`workspace_id`) REFERENCES `channelConnections`(`id`,`workspaceId`) ON DELETE restrict ON UPDATE no action,
	ADD CONSTRAINT `messenger_provider_fence_static_subject_fk` FOREIGN KEY (`workspace_id`,`channel_connection_id`,`user_key`) REFERENCES `messenger_privacy_subjects`(`workspace_id`,`channel_connection_id`,`user_key`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `workspace_entitlement_usage_reservations`
	DROP FOREIGN KEY `weur_connection_workspace_fk`,
	ADD CONSTRAINT `weur_static_connection_workspace_fk` FOREIGN KEY (`channel_connection_id`,`workspace_id`) REFERENCES `channelConnections`(`id`,`workspaceId`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- Nullable shadow columns are deliberately added during expand. The 0015
-- writer may keep leaving them NULL while the new writer is rolled out. The
-- 0017 contract migration repairs legacy rows and only then fences old writes.
ALTER TABLE `billing_intents`
	ADD `messenger_channel_connection_id` int,
	ADD `messenger_privacy_epoch` int;--> statement-breakpoint
ALTER TABLE `portalHandoffTokens`
	ADD `messenger_channel_connection_id` int,
	ADD `messenger_privacy_epoch` int;
