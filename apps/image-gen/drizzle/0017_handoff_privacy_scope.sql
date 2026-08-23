-- CONTRACT PHASE ONLY. Run 0017 after every app and worker Machine uses the
-- reviewed dual-writer release and its reviewed rollback image is also
-- compatible with 0017. This migration intentionally closes legacy Messenger
-- handoff identity writes; it must never run as part of the expand phase.
--
-- Refuse while a handoff transport is in flight. Rewriting an in-flight
-- payload would make the delivery outcome unknowable.
CREATE TEMPORARY TABLE `_0017_handoff_preflight` (
	`violation` tinyint NOT NULL PRIMARY KEY,
	CONSTRAINT `_0017_handoff_preflight_empty` CHECK (`violation` = 0)
);--> statement-breakpoint
INSERT INTO `_0017_handoff_preflight` (`violation`)
SELECT 1 FROM DUAL
WHERE EXISTS (
	SELECT 1
	FROM `billing_outbox`
	WHERE `event_type`='send_portal_handoff'
		AND `delivery_state`='transport_started'
);--> statement-breakpoint
DROP TEMPORARY TABLE `_0017_handoff_preflight`;--> statement-breakpoint

-- Each ALTER is atomic in MySQL. The production migrator fingerprints these
-- durable prefixes and resumes with the first missing step.
-- The data repair is one transaction. A lost connection before COMMIT rolls
-- it all back; a retry after COMMIT is idempotent.
START TRANSACTION;--> statement-breakpoint

-- Preserve only identities that still resolve to the one connected Facebook
-- channel and an active privacy subject. The epoch is an immutable snapshot.
UPDATE `billing_intents` AS `intent`
JOIN `channelConnections` AS `connection`
	ON `connection`.`workspaceId`=`intent`.`workspace_id`
	AND `connection`.`channel`='facebook_messenger'
	AND `connection`.`status`='connected'
	AND `connection`.`externalId`=`intent`.`messenger_page_id`
JOIN `messenger_privacy_subjects` AS `subject`
	ON `subject`.`workspace_id`=`intent`.`workspace_id`
	AND `subject`.`channel_connection_id`=`connection`.`id`
	AND `subject`.`user_key`=`intent`.`messenger_sender_user_key`
	AND `subject`.`status`='active'
SET
	`intent`.`messenger_channel_connection_id`=`connection`.`id`,
	`intent`.`messenger_privacy_epoch`=`subject`.`privacy_epoch`
WHERE
	`intent`.`messenger_sender_user_key` IS NOT NULL
	AND `intent`.`messenger_page_id` IS NOT NULL;--> statement-breakpoint

-- Recovery records may re-arm failed handoffs. Remove them before containing
-- any handoff whose intent no longer owns a valid active privacy identity.
DELETE `recovery`
FROM `billing_handoff_recovery_events` AS `recovery`
JOIN `billing_outbox` AS `outbox`
	ON `outbox`.`id`=`recovery`.`outbox_id`
	AND `outbox`.`workspace_id`=`recovery`.`workspace_id`
LEFT JOIN `billing_intents` AS `intent`
	ON `intent`.`intent_id`=JSON_UNQUOTE(JSON_EXTRACT(`outbox`.`payload`,'$.intentId'))
	AND `intent`.`workspace_id`=`outbox`.`workspace_id`
LEFT JOIN `channelConnections` AS `connection`
	ON `connection`.`id`=`intent`.`messenger_channel_connection_id`
	AND `connection`.`workspaceId`=`intent`.`workspace_id`
LEFT JOIN `messenger_privacy_subjects` AS `subject`
	ON `subject`.`workspace_id`=`intent`.`workspace_id`
	AND `subject`.`channel_connection_id`=`intent`.`messenger_channel_connection_id`
	AND `subject`.`user_key`=`intent`.`messenger_sender_user_key`
WHERE
	`outbox`.`event_type`='send_portal_handoff'
	AND (
		`intent`.`intent_id` IS NULL
		OR `intent`.`messenger_sender_user_key` IS NULL
		OR `intent`.`messenger_page_id` IS NULL
		OR `intent`.`messenger_channel_connection_id` IS NULL
		OR `intent`.`messenger_privacy_epoch` IS NULL
		OR `connection`.`id` IS NULL
		OR `subject`.`id` IS NULL
		OR `subject`.`status`<>'active'
		OR `subject`.`privacy_epoch`<>`intent`.`messenger_privacy_epoch`
	);--> statement-breakpoint

-- Fence invalid jobs exactly once. Re-running the transaction does not bump
-- their delivery epoch again because privacy_erased_at is already set.
UPDATE `billing_outbox` AS `outbox`
LEFT JOIN `billing_intents` AS `intent`
	ON `intent`.`intent_id`=JSON_UNQUOTE(JSON_EXTRACT(`outbox`.`payload`,'$.intentId'))
	AND `intent`.`workspace_id`=`outbox`.`workspace_id`
LEFT JOIN `channelConnections` AS `connection`
	ON `connection`.`id`=`intent`.`messenger_channel_connection_id`
	AND `connection`.`workspaceId`=`intent`.`workspace_id`
LEFT JOIN `messenger_privacy_subjects` AS `subject`
	ON `subject`.`workspace_id`=`intent`.`workspace_id`
	AND `subject`.`channel_connection_id`=`intent`.`messenger_channel_connection_id`
	AND `subject`.`user_key`=`intent`.`messenger_sender_user_key`
SET
	`outbox`.`status`='failed',
	`outbox`.`locked_at`=NULL,
	`outbox`.`lease_token`=NULL,
	`outbox`.`last_error_code`='privacy_erased',
	`outbox`.`delivery_epoch`=`outbox`.`delivery_epoch`+1,
	`outbox`.`delivery_state`='idle',
	`outbox`.`privacy_erased_at`=CURRENT_TIMESTAMP,
	`outbox`.`payload`=JSON_OBJECT(
		'intentId',JSON_UNQUOTE(JSON_EXTRACT(`outbox`.`payload`,'$.intentId')),
		'privacyErased',CAST('true' AS JSON)
	)
WHERE
	`outbox`.`event_type`='send_portal_handoff'
	AND `outbox`.`privacy_erased_at` IS NULL
	AND (
		`intent`.`intent_id` IS NULL
		OR `intent`.`messenger_sender_user_key` IS NULL
		OR `intent`.`messenger_page_id` IS NULL
		OR `intent`.`messenger_channel_connection_id` IS NULL
		OR `intent`.`messenger_privacy_epoch` IS NULL
		OR `connection`.`id` IS NULL
		OR `subject`.`id` IS NULL
		OR `subject`.`status`<>'active'
		OR `subject`.`privacy_epoch`<>`intent`.`messenger_privacy_epoch`
	);--> statement-breakpoint

-- Existing valid jobs receive the same immutable identity snapshot as their
-- intent. This is metadata only; no raw sender id is introduced.
UPDATE `billing_outbox` AS `outbox`
JOIN `billing_intents` AS `intent`
	ON `intent`.`intent_id`=JSON_UNQUOTE(JSON_EXTRACT(`outbox`.`payload`,'$.intentId'))
	AND `intent`.`workspace_id`=`outbox`.`workspace_id`
JOIN `channelConnections` AS `connection`
	ON `connection`.`id`=`intent`.`messenger_channel_connection_id`
	AND `connection`.`workspaceId`=`intent`.`workspace_id`
JOIN `messenger_privacy_subjects` AS `subject`
	ON `subject`.`workspace_id`=`intent`.`workspace_id`
	AND `subject`.`channel_connection_id`=`intent`.`messenger_channel_connection_id`
	AND `subject`.`user_key`=`intent`.`messenger_sender_user_key`
	AND `subject`.`status`='active'
	AND `subject`.`privacy_epoch`=`intent`.`messenger_privacy_epoch`
SET `outbox`.`payload`=JSON_OBJECT(
	'intentId',`intent`.`intent_id`,
	'messengerSenderUserKey',`intent`.`messenger_sender_user_key`,
	'messengerPageId',`intent`.`messenger_page_id`,
	'messengerChannelConnectionId',`intent`.`messenger_channel_connection_id`,
	'messengerPrivacyEpoch',`intent`.`messenger_privacy_epoch`
)
WHERE
	`outbox`.`event_type`='send_portal_handoff'
	AND `outbox`.`privacy_erased_at` IS NULL;--> statement-breakpoint

-- Financial truth is retained. Only the obsolete Messenger identity is
-- removed when it no longer resolves to an active subject.
UPDATE `billing_intents` AS `intent`
LEFT JOIN `channelConnections` AS `connection`
	ON `connection`.`id`=`intent`.`messenger_channel_connection_id`
	AND `connection`.`workspaceId`=`intent`.`workspace_id`
LEFT JOIN `messenger_privacy_subjects` AS `subject`
	ON `subject`.`workspace_id`=`intent`.`workspace_id`
	AND `subject`.`channel_connection_id`=`intent`.`messenger_channel_connection_id`
	AND `subject`.`user_key`=`intent`.`messenger_sender_user_key`
SET
	`intent`.`messenger_sender_user_key`=NULL,
	`intent`.`messenger_page_id`=NULL,
	`intent`.`messenger_channel_connection_id`=NULL,
	`intent`.`messenger_privacy_epoch`=NULL
WHERE
	NOT (
		`intent`.`messenger_sender_user_key` IS NULL
		AND `intent`.`messenger_page_id` IS NULL
		AND `intent`.`messenger_channel_connection_id` IS NULL
		AND `intent`.`messenger_privacy_epoch` IS NULL
	)
	AND (
		`intent`.`messenger_sender_user_key` IS NULL
		OR `intent`.`messenger_page_id` IS NULL
		OR `intent`.`messenger_channel_connection_id` IS NULL
		OR `intent`.`messenger_privacy_epoch` IS NULL
		OR `connection`.`id` IS NULL
		OR `subject`.`id` IS NULL
		OR `subject`.`status`<>'active'
		OR `subject`.`privacy_epoch`<>`intent`.`messenger_privacy_epoch`
	);--> statement-breakpoint

UPDATE `portalHandoffTokens` AS `token`
JOIN `channelConnections` AS `connection`
	ON `connection`.`workspaceId`=`token`.`workspaceId`
	AND `connection`.`channel`='facebook_messenger'
	AND `connection`.`status`='connected'
	AND `connection`.`externalId`=`token`.`facebookPageId`
JOIN `messenger_privacy_subjects` AS `subject`
	ON `subject`.`workspace_id`=`token`.`workspaceId`
	AND `subject`.`channel_connection_id`=`connection`.`id`
	AND `subject`.`user_key`=`token`.`messengerSenderUserKey`
	AND `subject`.`status`='active'
SET
	`token`.`messenger_channel_connection_id`=`connection`.`id`,
	`token`.`messenger_privacy_epoch`=`subject`.`privacy_epoch`
WHERE
	`token`.`messengerSenderUserKey` IS NOT NULL
	AND `token`.`facebookPageId` IS NOT NULL
	AND (
		`token`.`status`='consumed'
		OR (`token`.`status`='pending' AND `token`.`expiresAt`>CURRENT_TIMESTAMP)
	);--> statement-breakpoint

UPDATE `portalHandoffTokens` AS `token`
LEFT JOIN `channelConnections` AS `connection`
	ON `connection`.`id`=`token`.`messenger_channel_connection_id`
	AND `connection`.`workspaceId`=`token`.`workspaceId`
LEFT JOIN `messenger_privacy_subjects` AS `subject`
	ON `subject`.`workspace_id`=`token`.`workspaceId`
	AND `subject`.`channel_connection_id`=`token`.`messenger_channel_connection_id`
	AND `subject`.`user_key`=`token`.`messengerSenderUserKey`
SET
	`token`.`status`='revoked',
	`token`.`messengerSenderUserKey`=NULL,
	`token`.`facebookPageId`=NULL,
	`token`.`messenger_channel_connection_id`=NULL,
	`token`.`messenger_privacy_epoch`=NULL
WHERE
	NOT (
		(`token`.`status`='consumed' OR (`token`.`status`='pending' AND `token`.`expiresAt`>CURRENT_TIMESTAMP))
		AND `token`.`messengerSenderUserKey` IS NOT NULL
		AND `token`.`facebookPageId` IS NOT NULL
		AND `token`.`messenger_channel_connection_id` IS NOT NULL
		AND `token`.`messenger_privacy_epoch` IS NOT NULL
		AND `connection`.`id` IS NOT NULL
		AND `subject`.`id` IS NOT NULL
		AND `subject`.`status`='active'
		AND `subject`.`privacy_epoch`=`token`.`messenger_privacy_epoch`
	);--> statement-breakpoint

COMMIT;--> statement-breakpoint

-- Validate the repaired data again. If an old writer landed between the sweep
-- and this point, the migration refuses and a retry repeats the transaction.
CREATE TEMPORARY TABLE `_0017_handoff_postflight` (
	`violation` tinyint NOT NULL PRIMARY KEY,
	CONSTRAINT `_0017_handoff_postflight_empty` CHECK (`violation` = 0)
);--> statement-breakpoint
INSERT INTO `_0017_handoff_postflight` (`violation`)
SELECT 1 FROM DUAL
WHERE
	EXISTS (
		SELECT 1
		FROM `billing_intents` AS `intent`
		LEFT JOIN `channelConnections` AS `connection`
			ON `connection`.`id`=`intent`.`messenger_channel_connection_id`
			AND `connection`.`workspaceId`=`intent`.`workspace_id`
		LEFT JOIN `messenger_privacy_subjects` AS `subject`
			ON `subject`.`workspace_id`=`intent`.`workspace_id`
			AND `subject`.`channel_connection_id`=`intent`.`messenger_channel_connection_id`
			AND `subject`.`user_key`=`intent`.`messenger_sender_user_key`
		WHERE NOT (
			(`intent`.`messenger_sender_user_key` IS NULL
				AND `intent`.`messenger_page_id` IS NULL
				AND `intent`.`messenger_channel_connection_id` IS NULL
				AND `intent`.`messenger_privacy_epoch` IS NULL)
			OR (`intent`.`messenger_sender_user_key` IS NOT NULL
				AND `intent`.`messenger_page_id` IS NOT NULL
				AND `intent`.`messenger_channel_connection_id` IS NOT NULL
				AND `intent`.`messenger_privacy_epoch`>0
				AND `connection`.`id` IS NOT NULL
				AND `subject`.`id` IS NOT NULL
				AND `subject`.`status`='active'
				AND `subject`.`privacy_epoch`=`intent`.`messenger_privacy_epoch`)
		)
	)
	OR EXISTS (
		SELECT 1
		FROM `portalHandoffTokens` AS `token`
		LEFT JOIN `channelConnections` AS `connection`
			ON `connection`.`id`=`token`.`messenger_channel_connection_id`
			AND `connection`.`workspaceId`=`token`.`workspaceId`
		LEFT JOIN `messenger_privacy_subjects` AS `subject`
			ON `subject`.`workspace_id`=`token`.`workspaceId`
			AND `subject`.`channel_connection_id`=`token`.`messenger_channel_connection_id`
			AND `subject`.`user_key`=`token`.`messengerSenderUserKey`
		WHERE NOT (
			(`token`.`messengerSenderUserKey` IS NULL
				AND `token`.`facebookPageId` IS NULL
				AND `token`.`messenger_channel_connection_id` IS NULL
				AND `token`.`messenger_privacy_epoch` IS NULL)
			OR (`token`.`messengerSenderUserKey` IS NOT NULL
				AND `token`.`facebookPageId` IS NOT NULL
				AND `token`.`messenger_channel_connection_id` IS NOT NULL
				AND `token`.`messenger_privacy_epoch`>0
				AND `connection`.`id` IS NOT NULL
				AND `subject`.`id` IS NOT NULL
				AND `subject`.`status`='active'
				AND `subject`.`privacy_epoch`=`token`.`messenger_privacy_epoch`)
		)
	);--> statement-breakpoint
DROP TEMPORARY TABLE `_0017_handoff_postflight`;--> statement-breakpoint

-- The all-or-none checks deliberately reject an old writer after this point.
-- Each table reaches its final shape in one atomic ALTER.
ALTER TABLE `billing_intents`
	ADD CONSTRAINT `billing_intents_messenger_identity_scope` CHECK ((`messenger_sender_user_key` IS NULL AND `messenger_page_id` IS NULL AND `messenger_channel_connection_id` IS NULL AND `messenger_privacy_epoch` IS NULL) OR (`messenger_sender_user_key` IS NOT NULL AND `messenger_page_id` IS NOT NULL AND `messenger_channel_connection_id` IS NOT NULL AND `messenger_privacy_epoch` > 0)),
	ADD CONSTRAINT `billing_intents_static_messenger_connection_fk` FOREIGN KEY (`messenger_channel_connection_id`,`workspace_id`) REFERENCES `channelConnections`(`id`,`workspaceId`) ON DELETE restrict ON UPDATE no action,
	ADD CONSTRAINT `billing_intents_static_messenger_subject_fk` FOREIGN KEY (`workspace_id`,`messenger_channel_connection_id`,`messenger_sender_user_key`) REFERENCES `messenger_privacy_subjects`(`workspace_id`,`channel_connection_id`,`user_key`) ON DELETE restrict ON UPDATE no action,
	ADD INDEX `billing_intents_messenger_subject_idx` (`workspace_id`,`messenger_channel_connection_id`,`messenger_sender_user_key`,`messenger_privacy_epoch`);--> statement-breakpoint
ALTER TABLE `portalHandoffTokens`
	ADD CONSTRAINT `portal_handoff_tokens_messenger_identity_scope` CHECK ((`messengerSenderUserKey` IS NULL AND `facebookPageId` IS NULL AND `messenger_channel_connection_id` IS NULL AND `messenger_privacy_epoch` IS NULL) OR (`messengerSenderUserKey` IS NOT NULL AND `facebookPageId` IS NOT NULL AND `messenger_channel_connection_id` IS NOT NULL AND `messenger_privacy_epoch` > 0)),
	ADD CONSTRAINT `portal_handoff_tokens_static_connection_fk` FOREIGN KEY (`messenger_channel_connection_id`,`workspaceId`) REFERENCES `channelConnections`(`id`,`workspaceId`) ON DELETE restrict ON UPDATE no action,
	ADD CONSTRAINT `portal_handoff_tokens_static_subject_fk` FOREIGN KEY (`workspaceId`,`messenger_channel_connection_id`,`messengerSenderUserKey`) REFERENCES `messenger_privacy_subjects`(`workspace_id`,`channel_connection_id`,`user_key`) ON DELETE restrict ON UPDATE no action,
	ADD INDEX `portal_handoff_tokens_messenger_subject_idx` (`workspaceId`,`messenger_channel_connection_id`,`messengerSenderUserKey`,`messenger_privacy_epoch`);
