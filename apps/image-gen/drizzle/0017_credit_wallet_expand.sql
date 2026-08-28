CREATE TEMPORARY TABLE `credit_0017_legacy_effect_preflight` (
	`id` int NOT NULL,
	`invalid_count` int NOT NULL,
	PRIMARY KEY (`id`),
	CONSTRAINT `credit_0017_legacy_effect_preflight_zero` CHECK (`invalid_count`=0)
) AS
SELECT 1 AS `id`, COUNT(*) AS `invalid_count`
FROM `payment_ledger` payment
WHERE payment.`paid_effect_applied` NOT IN (0,1)
	OR (
		SELECT COUNT(*) FROM `billing_intents` intent
		WHERE intent.`mode`=payment.`mode`
			AND intent.`workspace_id`=payment.`workspace_id`
			AND BINARY intent.`mollie_payment_id`=BINARY payment.`mollie_payment_id`
	)>1
	OR EXISTS (
		SELECT 1 FROM `billing_intents` intent
		WHERE intent.`mode`=payment.`mode`
			AND intent.`workspace_id`<>payment.`workspace_id`
			AND BINARY intent.`mollie_payment_id`=BINARY payment.`mollie_payment_id`
	)
	OR EXISTS (
		SELECT 1 FROM `billing_intents` intent
		WHERE intent.`mode`=payment.`mode`
			AND intent.`workspace_id`=payment.`workspace_id`
			AND BINARY intent.`mollie_payment_id`=BINARY payment.`mollie_payment_id`
			AND NOT REGEXP_LIKE(intent.`intent_id`,'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$','c')
	);--> statement-breakpoint
DROP TEMPORARY TABLE `credit_0017_legacy_effect_preflight`;--> statement-breakpoint
ALTER TABLE `billing_outbox` MODIFY COLUMN `event_type` enum('ensure_subscription','cancel_subscription','cancel_payment','credit_adjustment_retry','payment_warning','manual_review','send_portal_handoff') NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_ledger`
	ADD CONSTRAINT `payment_ledger_exact_payment_scope_unique` UNIQUE(`id`,`workspace_id`,`mode`,`mollie_payment_id`);--> statement-breakpoint
ALTER TABLE `payment_ledger`
	ADD `payment_effect_owner_kind` enum('legacy_billing','credit_grant'),
	ADD `payment_effect_owner_ref` varchar(36),
	ADD `payment_effect_claimed_at` timestamp,
	ADD `credit_purpose` varchar(32),
	ADD `credit_intent_id` varchar(36),
	ADD `credit_wallet_id` varchar(36),
	ADD `credit_metadata_hash` varchar(64),
	ADD CONSTRAINT `payment_ledger_credit_intent_unique` UNIQUE(`mode`,`credit_intent_id`);--> statement-breakpoint
UPDATE `payment_ledger` payment
JOIN `billing_intents` intent
	ON intent.`mode`=payment.`mode`
	AND intent.`workspace_id`=payment.`workspace_id`
	AND BINARY intent.`mollie_payment_id`=BINARY payment.`mollie_payment_id`
	AND intent.`kind`<>'credit_purchase'
SET payment.`payment_effect_owner_kind`='legacy_billing',
	payment.`payment_effect_owner_ref`=intent.`intent_id`,
	payment.`payment_effect_claimed_at`=CASE
		WHEN payment.`paid_effect_applied`=1 THEN COALESCE(payment.`updated_at`,payment.`occurred_at`)
		ELSE NULL
	END;--> statement-breakpoint
ALTER TABLE `payment_ledger`
	ADD CONSTRAINT `payment_ledger_effect_owner_unique` UNIQUE(`mode`,`payment_effect_owner_kind`,`payment_effect_owner_ref`),
	ADD CONSTRAINT `payment_ledger_credit_binding_shape` CHECK (((`credit_purpose` IS NULL AND `credit_intent_id` IS NULL AND `credit_wallet_id` IS NULL AND `credit_metadata_hash` IS NULL AND (`payment_effect_owner_kind` IS NULL OR `payment_effect_owner_kind`='legacy_billing')) OR (BINARY `credit_purpose`=BINARY 'premium_image_credits' AND `payment_effect_owner_kind`='credit_grant' AND BINARY `payment_effect_owner_ref`=BINARY `credit_intent_id` AND REGEXP_LIKE(`credit_intent_id`,'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$','c') AND REGEXP_LIKE(`credit_wallet_id`,'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$','c') AND REGEXP_LIKE(`credit_metadata_hash`,'^[0-9a-f]{64}$','c'))) IS TRUE),
	ADD CONSTRAINT `payment_ledger_effect_owner_shape` CHECK (((`payment_effect_owner_kind` IS NULL AND `payment_effect_owner_ref` IS NULL AND `payment_effect_claimed_at` IS NULL AND `paid_effect_applied` IN (0,1)) OR (`payment_effect_owner_kind` IS NOT NULL AND REGEXP_LIKE(`payment_effect_owner_ref`, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'c') AND ((`paid_effect_applied` = 0 AND `payment_effect_claimed_at` IS NULL) OR (`paid_effect_applied` = 1 AND `payment_effect_claimed_at` IS NOT NULL)))) IS TRUE);--> statement-breakpoint
ALTER TABLE `billing_intents`
	MODIFY COLUMN `kind` enum('subscription_start','payment_method_change','startpilot_purchase','credit_purchase') NOT NULL DEFAULT 'subscription_start',
	ADD `messenger_binding_epoch` int,
	ADD `credit_wallet_id` varchar(36),
	ADD `credit_financial_subject_ref` varchar(64),
	ADD `credit_count` int,
	ADD `credit_metadata_hash` varchar(64),
	ADD `checkout_capability_hash` varchar(64),
	ADD `checkout_capability_expires_at` timestamp,
	ADD `checkout_capability_consumed_at` timestamp,
	ADD `checkout_capability_session_nonce_hash` varchar(64),
	ADD `credit_identity_erased_at` timestamp,
	ADD CONSTRAINT `billing_intents_credit_funding_scope_unique` UNIQUE(`intent_id`,`credit_wallet_id`,`workspace_id`,`mode`),
	ADD CONSTRAINT `billing_intents_checkout_capability_unique` UNIQUE(`checkout_capability_hash`),
	ADD CONSTRAINT `billing_intents_checkout_session_nonce_unique` UNIQUE(`checkout_capability_session_nonce_hash`),
	ADD CONSTRAINT `billing_intents_credit_payment_binding_unique` UNIQUE(`intent_id`,`credit_wallet_id`,`workspace_id`,`mode`,`credit_metadata_hash`),
	ADD CONSTRAINT `billing_intents_credit_purchase_shape` CHECK ((((`kind`<>'credit_purchase') AND `credit_wallet_id` IS NULL AND `messenger_binding_epoch` IS NULL AND `credit_financial_subject_ref` IS NULL AND `credit_count` IS NULL AND `credit_metadata_hash` IS NULL AND `checkout_capability_hash` IS NULL AND `checkout_capability_expires_at` IS NULL AND `checkout_capability_consumed_at` IS NULL AND `checkout_capability_session_nonce_hash` IS NULL AND `credit_identity_erased_at` IS NULL) OR (`kind`='credit_purchase' AND `interval`='oneoff' AND `billing_profile_version`=0 AND JSON_TYPE(`entitlements`)='OBJECT' AND JSON_LENGTH(`entitlements`)=0 AND `expected_amount`>0 AND BINARY `currency`=BINARY 'EUR' AND `credit_count`>0 AND `messenger_page_id` IS NULL AND `messenger_channel_connection_id` IS NOT NULL AND `messenger_binding_epoch`>0 AND `messenger_privacy_epoch`>0 AND REGEXP_LIKE(`intent_id`,'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$','c') AND REGEXP_LIKE(`credit_wallet_id`,'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$','c') AND REGEXP_LIKE(`credit_financial_subject_ref`,'^[0-9a-f]{64}$','c') AND REGEXP_LIKE(`credit_metadata_hash`,'^[0-9a-f]{64}$','c') AND CHAR_LENGTH(TRIM(`plan_code`))>0 AND CHAR_LENGTH(TRIM(`mollie_description`))>0 AND ((`credit_identity_erased_at` IS NULL AND REGEXP_LIKE(`messenger_sender_user_key`,'^([0-9a-f]{64}|u2[.]k[1-9][0-9]{0,5}[.][0-9a-f]{64})$','c') AND REGEXP_LIKE(`checkout_capability_hash`,'^[0-9a-f]{64}$','c') AND `checkout_capability_expires_at`>=`created_at` AND `checkout_capability_expires_at`<=TIMESTAMPADD(MINUTE,15,`created_at`) AND ((`checkout_capability_consumed_at` IS NULL AND `checkout_capability_session_nonce_hash` IS NULL) OR (`checkout_capability_consumed_at`>=`created_at` AND `checkout_capability_consumed_at`<=`checkout_capability_expires_at` AND REGEXP_LIKE(`checkout_capability_session_nonce_hash`,'^[0-9a-f]{64}$','c')))) OR (`credit_identity_erased_at` IS NOT NULL AND `credit_identity_erased_at`>=`created_at` AND `messenger_sender_user_key` IS NULL AND `checkout_capability_hash` IS NULL AND `checkout_capability_expires_at` IS NULL AND `checkout_capability_consumed_at` IS NULL AND `checkout_capability_session_nonce_hash` IS NULL AND `status` IN ('paid','failed','canceled','expired','mismatch','contained'))))) IS TRUE);--> statement-breakpoint
CREATE INDEX `billing_intents_credit_subject_idx` ON `billing_intents` (`workspace_id`,`mode`,`messenger_channel_connection_id`,`messenger_binding_epoch`,`messenger_privacy_epoch`,`credit_financial_subject_ref`);--> statement-breakpoint
CREATE TABLE `credit_ledger` (
	`entry_id` varchar(36) NOT NULL,
	`wallet_id` varchar(36) NOT NULL,
	`workspace_id` int NOT NULL,
	`mode` enum('test','live') NOT NULL,
	`channel_connection_id` int NOT NULL,
	`binding_epoch` int NOT NULL,
	`privacy_epoch` int NOT NULL,
	`financial_subject_ref` varchar(64) NOT NULL,
	`source_intent_id` varchar(36),
	`authorization_epoch` int,
	`payment_ledger_id` int,
	`provider_payment_id` varchar(64),
	`offer_id` varchar(80),
	`payment_amount` decimal(10,2),
	`currency` varchar(3),
	`purchased_credit_count` int,
	`provider_description` varchar(255),
	`entry_kind` enum('purchase_grant','reservation_hold','generation_spend','reservation_release','refund_debit','chargeback_debit','chargeback_restore') NOT NULL,
	`balance_delta` int NOT NULL,
	`reserved_delta` int NOT NULL,
	`event_key_hash` varchar(64) NOT NULL,
	`provider_event_hash` varchar(64),
	`provider_effect_id` varchar(64),
	`provider_effect_type` enum('refund','chargeback'),
	`provider_effect_status` enum('refunded','active','reversed'),
	`provider_effect_amount` decimal(10,2),
	`provider_effect_currency` varchar(3),
	`provider_effect_evidence` json,
	`grant_payment_id` varchar(64),
	`reservation_id` varchar(36),
	`reservation_credit_count` int,
	`reservation_terminal_slot` int,
	`reservation_terminal_status` enum('committed','released','expired'),
	`root_grant_entry_id` varchar(36),
	`root_adjustment_slot` int,
	`evidence_hash` varchar(64) NOT NULL,
	`previous_entry_id` varchar(36),
	`wallet_version_before` int NOT NULL,
	`wallet_version_after` int NOT NULL,
	`balance_before` int NOT NULL,
	`reserved_before` int NOT NULL,
	`balance_after` int NOT NULL,
	`reserved_after` int NOT NULL,
	`occurred_at` timestamp NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `credit_ledger_entry_id` PRIMARY KEY(`entry_id`),
	CONSTRAINT `credit_ledger_wallet_entry_unique` UNIQUE(`entry_id`,`wallet_id`,`workspace_id`,`mode`),
	CONSTRAINT `credit_ledger_event_unique` UNIQUE(`mode`,`event_key_hash`),
	CONSTRAINT `credit_ledger_grant_payment_unique` UNIQUE(`mode`,`grant_payment_id`),
	CONSTRAINT `credit_ledger_reservation_effect_unique` UNIQUE(`mode`,`reservation_id`,`entry_kind`),
	CONSTRAINT `credit_ledger_reservation_terminal_unique` UNIQUE(`mode`,`reservation_id`,`reservation_terminal_slot`),
	CONSTRAINT `credit_ledger_root_adjustment_unique` UNIQUE(`mode`,`root_grant_entry_id`,`root_adjustment_slot`),
	CONSTRAINT `credit_ledger_provider_effect_unique` UNIQUE(`mode`,`provider_event_hash`),
	CONSTRAINT `credit_ledger_provider_effect_slot_unique` UNIQUE(`mode`,`provider_effect_id`,`root_adjustment_slot`),
	CONSTRAINT `credit_ledger_wallet_version_unique` UNIQUE(`wallet_id`,`wallet_version_after`),
	CONSTRAINT `credit_ledger_values_valid` CHECK((`credit_ledger`.`balance_delta` <> 0 OR `credit_ledger`.`reserved_delta` <> 0) AND REGEXP_LIKE(`credit_ledger`.`event_key_hash`, '^[0-9a-f]{64}$', 'c') AND REGEXP_LIKE(`credit_ledger`.`evidence_hash`, '^[0-9a-f]{64}$', 'c') AND `credit_ledger`.`wallet_version_before` > 0 AND `credit_ledger`.`wallet_version_after` = `credit_ledger`.`wallet_version_before` + 1 AND `credit_ledger`.`balance_after` = `credit_ledger`.`balance_before` + `credit_ledger`.`balance_delta` AND `credit_ledger`.`reserved_after` = `credit_ledger`.`reserved_before` + `credit_ledger`.`reserved_delta` AND `credit_ledger`.`reserved_before` >= 0 AND `credit_ledger`.`reserved_after` >= 0 AND `credit_ledger`.`reserved_after` <= GREATEST(`credit_ledger`.`balance_after`, 0) AND `credit_ledger`.`occurred_at` <= `credit_ledger`.`created_at`),
	CONSTRAINT `credit_ledger_ids_valid` CHECK(REGEXP_LIKE(`credit_ledger`.`entry_id`, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'c') AND REGEXP_LIKE(`credit_ledger`.`wallet_id`, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'c') AND (`credit_ledger`.`previous_entry_id` IS NULL OR REGEXP_LIKE(`credit_ledger`.`previous_entry_id`, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'c')) AND (`credit_ledger`.`reservation_id` IS NULL OR REGEXP_LIKE(`credit_ledger`.`reservation_id`, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'c')) AND (`credit_ledger`.`root_grant_entry_id` IS NULL OR REGEXP_LIKE(`credit_ledger`.`root_grant_entry_id`, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'c'))),
	CONSTRAINT `credit_ledger_entry_shape` CHECK((`credit_ledger`.`entry_kind` = 'purchase_grant' AND `credit_ledger`.`balance_delta` = `credit_ledger`.`purchased_credit_count` AND `credit_ledger`.`reserved_delta` = 0 AND `credit_ledger`.`grant_payment_id` IS NOT NULL AND `credit_ledger`.`provider_payment_id` IS NOT NULL AND `credit_ledger`.`grant_payment_id` = `credit_ledger`.`provider_payment_id` AND `credit_ledger`.`source_intent_id` IS NOT NULL AND `credit_ledger`.`authorization_epoch` IS NOT NULL AND `credit_ledger`.`authorization_epoch` > 0 AND `credit_ledger`.`payment_ledger_id` IS NOT NULL AND `credit_ledger`.`offer_id` IS NOT NULL AND `credit_ledger`.`payment_amount` IS NOT NULL AND `credit_ledger`.`payment_amount` > 0 AND `credit_ledger`.`currency` IS NOT NULL AND `credit_ledger`.`currency` = 'EUR' AND `credit_ledger`.`purchased_credit_count` IS NOT NULL AND `credit_ledger`.`purchased_credit_count` > 0 AND `credit_ledger`.`provider_description` IS NOT NULL AND `credit_ledger`.`reservation_id` IS NULL AND `credit_ledger`.`reservation_credit_count` IS NULL AND `credit_ledger`.`reservation_terminal_slot` IS NULL AND `credit_ledger`.`root_grant_entry_id` IS NULL AND `credit_ledger`.`root_adjustment_slot` IS NULL AND `credit_ledger`.`provider_event_hash` IS NULL) OR (`credit_ledger`.`entry_kind` = 'reservation_hold' AND `credit_ledger`.`balance_delta` = 0 AND `credit_ledger`.`reservation_credit_count` IS NOT NULL AND `credit_ledger`.`reserved_delta` = `credit_ledger`.`reservation_credit_count` AND `credit_ledger`.`reservation_credit_count` > 0 AND `credit_ledger`.`reservation_id` IS NOT NULL AND `credit_ledger`.`reservation_terminal_slot` IS NULL AND `credit_ledger`.`source_intent_id` IS NULL AND `credit_ledger`.`authorization_epoch` IS NULL AND `credit_ledger`.`payment_ledger_id` IS NULL AND `credit_ledger`.`provider_payment_id` IS NULL AND `credit_ledger`.`offer_id` IS NULL AND `credit_ledger`.`payment_amount` IS NULL AND `credit_ledger`.`currency` IS NULL AND `credit_ledger`.`purchased_credit_count` IS NULL AND `credit_ledger`.`provider_description` IS NULL AND `credit_ledger`.`grant_payment_id` IS NULL AND `credit_ledger`.`root_grant_entry_id` IS NULL AND `credit_ledger`.`root_adjustment_slot` IS NULL AND `credit_ledger`.`provider_event_hash` IS NULL) OR (`credit_ledger`.`entry_kind` = 'generation_spend' AND `credit_ledger`.`reservation_credit_count` IS NOT NULL AND `credit_ledger`.`balance_delta` = -`credit_ledger`.`reservation_credit_count` AND `credit_ledger`.`reserved_delta` = -`credit_ledger`.`reservation_credit_count` AND `credit_ledger`.`reservation_credit_count` > 0 AND `credit_ledger`.`reservation_id` IS NOT NULL AND `credit_ledger`.`reservation_terminal_slot` = 1 AND `credit_ledger`.`source_intent_id` IS NULL AND `credit_ledger`.`authorization_epoch` IS NULL AND `credit_ledger`.`payment_ledger_id` IS NULL AND `credit_ledger`.`provider_payment_id` IS NULL AND `credit_ledger`.`offer_id` IS NULL AND `credit_ledger`.`payment_amount` IS NULL AND `credit_ledger`.`currency` IS NULL AND `credit_ledger`.`purchased_credit_count` IS NULL AND `credit_ledger`.`provider_description` IS NULL AND `credit_ledger`.`grant_payment_id` IS NULL AND `credit_ledger`.`root_grant_entry_id` IS NULL AND `credit_ledger`.`root_adjustment_slot` IS NULL AND `credit_ledger`.`provider_event_hash` IS NULL) OR (`credit_ledger`.`entry_kind` = 'reservation_release' AND `credit_ledger`.`reservation_credit_count` IS NOT NULL AND `credit_ledger`.`balance_delta` = 0 AND `credit_ledger`.`reserved_delta` = -`credit_ledger`.`reservation_credit_count` AND `credit_ledger`.`reservation_credit_count` > 0 AND `credit_ledger`.`reservation_id` IS NOT NULL AND `credit_ledger`.`reservation_terminal_slot` = 1 AND `credit_ledger`.`source_intent_id` IS NULL AND `credit_ledger`.`authorization_epoch` IS NULL AND `credit_ledger`.`payment_ledger_id` IS NULL AND `credit_ledger`.`provider_payment_id` IS NULL AND `credit_ledger`.`offer_id` IS NULL AND `credit_ledger`.`payment_amount` IS NULL AND `credit_ledger`.`currency` IS NULL AND `credit_ledger`.`purchased_credit_count` IS NULL AND `credit_ledger`.`provider_description` IS NULL AND `credit_ledger`.`grant_payment_id` IS NULL AND `credit_ledger`.`root_grant_entry_id` IS NULL AND `credit_ledger`.`root_adjustment_slot` IS NULL AND `credit_ledger`.`provider_event_hash` IS NULL) OR (`credit_ledger`.`entry_kind` IN ('refund_debit','chargeback_debit') AND `credit_ledger`.`purchased_credit_count` IS NOT NULL AND `credit_ledger`.`balance_delta` = -`credit_ledger`.`purchased_credit_count` AND `credit_ledger`.`reserved_delta` = 0 AND `credit_ledger`.`source_intent_id` IS NOT NULL AND `credit_ledger`.`authorization_epoch` IS NOT NULL AND `credit_ledger`.`authorization_epoch` > 0 AND `credit_ledger`.`payment_ledger_id` IS NOT NULL AND `credit_ledger`.`provider_payment_id` IS NOT NULL AND `credit_ledger`.`offer_id` IS NOT NULL AND `credit_ledger`.`payment_amount` IS NOT NULL AND `credit_ledger`.`payment_amount` > 0 AND `credit_ledger`.`currency` IS NOT NULL AND `credit_ledger`.`currency` = 'EUR' AND `credit_ledger`.`purchased_credit_count` > 0 AND `credit_ledger`.`provider_description` IS NOT NULL AND `credit_ledger`.`grant_payment_id` IS NULL AND `credit_ledger`.`reservation_id` IS NULL AND `credit_ledger`.`reservation_credit_count` IS NULL AND `credit_ledger`.`reservation_terminal_slot` IS NULL AND `credit_ledger`.`root_grant_entry_id` IS NOT NULL AND `credit_ledger`.`root_adjustment_slot` = 1 AND `credit_ledger`.`provider_event_hash` IS NOT NULL AND CHAR_LENGTH(`credit_ledger`.`provider_event_hash`) = 64) OR (`credit_ledger`.`entry_kind` = 'chargeback_restore' AND `credit_ledger`.`purchased_credit_count` IS NOT NULL AND `credit_ledger`.`balance_delta` = `credit_ledger`.`purchased_credit_count` AND `credit_ledger`.`reserved_delta` = 0 AND `credit_ledger`.`source_intent_id` IS NOT NULL AND `credit_ledger`.`authorization_epoch` IS NOT NULL AND `credit_ledger`.`authorization_epoch` > 0 AND `credit_ledger`.`payment_ledger_id` IS NOT NULL AND `credit_ledger`.`provider_payment_id` IS NOT NULL AND `credit_ledger`.`offer_id` IS NOT NULL AND `credit_ledger`.`payment_amount` IS NOT NULL AND `credit_ledger`.`payment_amount` > 0 AND `credit_ledger`.`currency` IS NOT NULL AND `credit_ledger`.`currency` = 'EUR' AND `credit_ledger`.`purchased_credit_count` > 0 AND `credit_ledger`.`provider_description` IS NOT NULL AND `credit_ledger`.`grant_payment_id` IS NULL AND `credit_ledger`.`reservation_id` IS NULL AND `credit_ledger`.`reservation_credit_count` IS NULL AND `credit_ledger`.`reservation_terminal_slot` IS NULL AND `credit_ledger`.`root_grant_entry_id` IS NOT NULL AND `credit_ledger`.`root_adjustment_slot` = 2 AND `credit_ledger`.`provider_event_hash` IS NOT NULL AND CHAR_LENGTH(`credit_ledger`.`provider_event_hash`) = 64)),
	CONSTRAINT `credit_ledger_required_fields_total` CHECK((CASE WHEN `credit_ledger`.`entry_kind`='purchase_grant' THEN `credit_ledger`.`source_intent_id` IS NOT NULL AND `credit_ledger`.`authorization_epoch` IS NOT NULL AND `credit_ledger`.`payment_ledger_id` IS NOT NULL AND `credit_ledger`.`provider_payment_id` IS NOT NULL AND `credit_ledger`.`offer_id` IS NOT NULL AND `credit_ledger`.`payment_amount` IS NOT NULL AND `credit_ledger`.`currency` IS NOT NULL AND `credit_ledger`.`purchased_credit_count` IS NOT NULL AND `credit_ledger`.`provider_description` IS NOT NULL AND `credit_ledger`.`grant_payment_id` IS NOT NULL WHEN `credit_ledger`.`entry_kind`='reservation_hold' THEN `credit_ledger`.`reservation_id` IS NOT NULL AND `credit_ledger`.`reservation_credit_count` IS NOT NULL WHEN `credit_ledger`.`entry_kind` IN ('generation_spend','reservation_release') THEN `credit_ledger`.`reservation_id` IS NOT NULL AND `credit_ledger`.`reservation_credit_count` IS NOT NULL AND `credit_ledger`.`reservation_terminal_status` IS NOT NULL WHEN `credit_ledger`.`entry_kind` IN ('refund_debit','chargeback_debit','chargeback_restore') THEN `credit_ledger`.`source_intent_id` IS NOT NULL AND `credit_ledger`.`authorization_epoch` IS NOT NULL AND `credit_ledger`.`payment_ledger_id` IS NOT NULL AND `credit_ledger`.`provider_payment_id` IS NOT NULL AND `credit_ledger`.`offer_id` IS NOT NULL AND `credit_ledger`.`payment_amount` IS NOT NULL AND `credit_ledger`.`currency` IS NOT NULL AND `credit_ledger`.`purchased_credit_count` IS NOT NULL AND `credit_ledger`.`provider_description` IS NOT NULL AND `credit_ledger`.`root_grant_entry_id` IS NOT NULL AND `credit_ledger`.`provider_event_hash` IS NOT NULL AND `credit_ledger`.`provider_effect_id` IS NOT NULL AND `credit_ledger`.`provider_effect_type` IS NOT NULL AND `credit_ledger`.`provider_effect_status` IS NOT NULL AND `credit_ledger`.`provider_effect_amount` IS NOT NULL AND `credit_ledger`.`provider_effect_currency` IS NOT NULL ELSE false END) IS TRUE),
	CONSTRAINT `credit_ledger_effect_shape` CHECK(((`credit_ledger`.`entry_kind` NOT IN ('refund_debit','chargeback_debit','chargeback_restore') AND `credit_ledger`.`provider_event_hash` IS NULL AND `credit_ledger`.`provider_effect_id` IS NULL AND `credit_ledger`.`provider_effect_type` IS NULL AND `credit_ledger`.`provider_effect_status` IS NULL AND `credit_ledger`.`provider_effect_amount` IS NULL AND `credit_ledger`.`provider_effect_currency` IS NULL) OR (`credit_ledger`.`entry_kind` = 'refund_debit' AND `credit_ledger`.`provider_event_hash` IS NOT NULL AND `credit_ledger`.`provider_effect_id` IS NOT NULL AND REGEXP_LIKE(`credit_ledger`.`provider_event_hash`, '^[0-9a-f]{64}$', 'c') AND `credit_ledger`.`provider_effect_id` REGEXP '^[A-Za-z0-9_-]{1,64}$' AND `credit_ledger`.`provider_effect_type` = 'refund' AND `credit_ledger`.`provider_effect_status` = 'refunded' AND `credit_ledger`.`provider_effect_amount` = `credit_ledger`.`payment_amount` AND BINARY `credit_ledger`.`provider_effect_currency` = BINARY `credit_ledger`.`currency`) OR (`credit_ledger`.`entry_kind` = 'chargeback_debit' AND `credit_ledger`.`provider_event_hash` IS NOT NULL AND `credit_ledger`.`provider_effect_id` IS NOT NULL AND REGEXP_LIKE(`credit_ledger`.`provider_event_hash`, '^[0-9a-f]{64}$', 'c') AND `credit_ledger`.`provider_effect_id` REGEXP '^[A-Za-z0-9_-]{1,64}$' AND `credit_ledger`.`provider_effect_type` = 'chargeback' AND `credit_ledger`.`provider_effect_status` = 'active' AND `credit_ledger`.`provider_effect_amount` = `credit_ledger`.`payment_amount` AND BINARY `credit_ledger`.`provider_effect_currency` = BINARY `credit_ledger`.`currency`) OR (`credit_ledger`.`entry_kind` = 'chargeback_restore' AND `credit_ledger`.`provider_event_hash` IS NOT NULL AND `credit_ledger`.`provider_effect_id` IS NOT NULL AND REGEXP_LIKE(`credit_ledger`.`provider_event_hash`, '^[0-9a-f]{64}$', 'c') AND `credit_ledger`.`provider_effect_id` REGEXP '^[A-Za-z0-9_-]{1,64}$' AND `credit_ledger`.`provider_effect_type` = 'chargeback' AND `credit_ledger`.`provider_effect_status` = 'reversed' AND `credit_ledger`.`provider_effect_amount` = `credit_ledger`.`payment_amount` AND BINARY `credit_ledger`.`provider_effect_currency` = BINARY `credit_ledger`.`currency`)) IS TRUE),
	CONSTRAINT `credit_ledger_provider_effect_evidence_shape` CHECK((`credit_ledger`.`entry_kind`='refund_debit' AND `credit_ledger`.`provider_effect_evidence` IS NOT NULL AND JSON_TYPE(`credit_ledger`.`provider_effect_evidence`)='ARRAY' AND JSON_LENGTH(`credit_ledger`.`provider_effect_evidence`)>0) OR (`credit_ledger`.`entry_kind`<>'refund_debit' AND `credit_ledger`.`provider_effect_evidence` IS NULL)),
	CONSTRAINT `credit_ledger_reservation_terminal_shape` CHECK(((`credit_ledger`.`entry_kind` = 'generation_spend' AND `credit_ledger`.`reservation_terminal_status` = 'committed') OR (`credit_ledger`.`entry_kind` = 'reservation_release' AND `credit_ledger`.`reservation_terminal_status` IN ('released','expired')) OR (`credit_ledger`.`entry_kind` NOT IN ('generation_spend','reservation_release') AND `credit_ledger`.`reservation_terminal_status` IS NULL)) IS TRUE),
	CONSTRAINT `credit_ledger_chain_shape` CHECK((`credit_ledger`.`wallet_version_before` = 1 AND `credit_ledger`.`previous_entry_id` IS NULL) OR (`credit_ledger`.`wallet_version_before` > 1 AND `credit_ledger`.`previous_entry_id` IS NOT NULL)),
	CONSTRAINT `credit_ledger_financial_bytes` CHECK((`credit_ledger`.`currency` IS NULL OR BINARY `credit_ledger`.`currency` = BINARY 'EUR') AND (`credit_ledger`.`provider_effect_currency` IS NULL OR BINARY `credit_ledger`.`provider_effect_currency` = BINARY 'EUR'))
);
--> statement-breakpoint
CREATE TABLE `credit_reservations` (
	`reservation_id` varchar(36) NOT NULL,
	`wallet_id` varchar(36) NOT NULL,
	`workspace_id` int NOT NULL,
	`mode` enum('test','live') NOT NULL,
	`channel_connection_id` int NOT NULL,
	`binding_epoch` int NOT NULL,
	`privacy_epoch` int NOT NULL,
	`financial_subject_ref` varchar(64) NOT NULL,
	`reserved_credit_count` int NOT NULL,
	`generation_request_key_hash` varchar(64),
	`owner_token_hash` varchar(64),
	`status` enum('initializing','reserved','committed','released','expired') NOT NULL DEFAULT 'initializing',
	`transport_state` enum('pretransport','transport_started','known_accepted','known_rejected') NOT NULL DEFAULT 'pretransport',
	`transport_started_at` timestamp,
	`provider_accepted_at` timestamp,
	`provider_rejected_at` timestamp,
	`provider_rejected_status` int,
	`state_version` int NOT NULL DEFAULT 1,
	`owner_lease_until` timestamp NOT NULL,
	`expires_at` timestamp NOT NULL,
	`resolution_due_at` timestamp NOT NULL,
	`committed_at` timestamp,
	`released_at` timestamp,
	`hold_ledger_entry_id` varchar(36),
	`terminal_ledger_entry_id` varchar(36),
	`terminal_evidence_hash` varchar(64),
	`operational_scrubbed_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `credit_reservations_reservation_id` PRIMARY KEY(`reservation_id`),
	CONSTRAINT `credit_reservations_generation_unique` UNIQUE(`wallet_id`,`workspace_id`,`mode`,`channel_connection_id`,`binding_epoch`,`privacy_epoch`,`generation_request_key_hash`),
	CONSTRAINT `credit_reservations_exact_scope_unique` UNIQUE(`reservation_id`,`wallet_id`,`workspace_id`,`mode`,`channel_connection_id`,`binding_epoch`,`privacy_epoch`,`financial_subject_ref`,`reserved_credit_count`),
	CONSTRAINT `credit_reservations_ledger_scope_unique` UNIQUE(`reservation_id`,`wallet_id`,`workspace_id`,`mode`,`reserved_credit_count`),
	CONSTRAINT `credit_reservations_values_valid` CHECK(`credit_reservations`.`reserved_credit_count` > 0 AND `credit_reservations`.`state_version` > 0),
	CONSTRAINT `credit_reservations_ids_valid` CHECK(REGEXP_LIKE(`credit_reservations`.`reservation_id`, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'c') AND REGEXP_LIKE(`credit_reservations`.`wallet_id`, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'c') AND (`credit_reservations`.`hold_ledger_entry_id` IS NULL OR REGEXP_LIKE(`credit_reservations`.`hold_ledger_entry_id`, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'c')) AND (`credit_reservations`.`terminal_ledger_entry_id` IS NULL OR REGEXP_LIKE(`credit_reservations`.`terminal_ledger_entry_id`, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'c'))),
	CONSTRAINT `credit_reservations_hashes_valid` CHECK(((`credit_reservations`.`operational_scrubbed_at` IS NULL AND `credit_reservations`.`generation_request_key_hash` IS NOT NULL AND `credit_reservations`.`owner_token_hash` IS NOT NULL AND REGEXP_LIKE(`credit_reservations`.`generation_request_key_hash`, '^[0-9a-f]{64}$', 'c') AND REGEXP_LIKE(`credit_reservations`.`owner_token_hash`, '^[0-9a-f]{64}$', 'c')) OR (`credit_reservations`.`operational_scrubbed_at` IS NOT NULL AND `credit_reservations`.`status` IN ('committed','released','expired') AND `credit_reservations`.`generation_request_key_hash` IS NULL AND `credit_reservations`.`owner_token_hash` IS NULL AND `credit_reservations`.`operational_scrubbed_at` >= `credit_reservations`.`resolution_due_at`)) IS TRUE),
	CONSTRAINT `credit_reservations_terminal_state` CHECK(((`credit_reservations`.`status` = 'initializing' AND `credit_reservations`.`transport_state` = 'pretransport' AND `credit_reservations`.`state_version` = 1 AND `credit_reservations`.`hold_ledger_entry_id` IS NULL AND `credit_reservations`.`committed_at` IS NULL AND `credit_reservations`.`released_at` IS NULL AND `credit_reservations`.`terminal_ledger_entry_id` IS NULL AND `credit_reservations`.`terminal_evidence_hash` IS NULL) OR (`credit_reservations`.`status` = 'reserved' AND `credit_reservations`.`state_version` = 2 AND `credit_reservations`.`hold_ledger_entry_id` IS NOT NULL AND `credit_reservations`.`committed_at` IS NULL AND `credit_reservations`.`released_at` IS NULL AND `credit_reservations`.`terminal_ledger_entry_id` IS NULL AND `credit_reservations`.`terminal_evidence_hash` IS NULL) OR (`credit_reservations`.`status` = 'committed' AND `credit_reservations`.`transport_state` = 'known_accepted' AND `credit_reservations`.`state_version` = 3 AND `credit_reservations`.`hold_ledger_entry_id` IS NOT NULL AND `credit_reservations`.`committed_at` IS NOT NULL AND `credit_reservations`.`released_at` IS NULL AND `credit_reservations`.`terminal_ledger_entry_id` IS NOT NULL AND `credit_reservations`.`terminal_evidence_hash` IS NOT NULL AND REGEXP_LIKE(`credit_reservations`.`terminal_evidence_hash`, '^[0-9a-f]{64}$', 'c')) OR (`credit_reservations`.`status` IN ('released','expired') AND `credit_reservations`.`transport_state` IN ('pretransport','known_rejected') AND `credit_reservations`.`state_version` = 3 AND `credit_reservations`.`hold_ledger_entry_id` IS NOT NULL AND `credit_reservations`.`released_at` IS NOT NULL AND `credit_reservations`.`committed_at` IS NULL AND `credit_reservations`.`terminal_ledger_entry_id` IS NOT NULL AND `credit_reservations`.`terminal_evidence_hash` IS NOT NULL AND REGEXP_LIKE(`credit_reservations`.`terminal_evidence_hash`, '^[0-9a-f]{64}$', 'c'))) IS TRUE),
	CONSTRAINT `credit_reservations_transport_evidence` CHECK(((`credit_reservations`.`transport_state`='pretransport' AND `credit_reservations`.`transport_started_at` IS NULL AND `credit_reservations`.`provider_accepted_at` IS NULL AND `credit_reservations`.`provider_rejected_at` IS NULL AND `credit_reservations`.`provider_rejected_status` IS NULL) OR (`credit_reservations`.`transport_state`='transport_started' AND `credit_reservations`.`transport_started_at` IS NOT NULL AND `credit_reservations`.`provider_accepted_at` IS NULL AND `credit_reservations`.`provider_rejected_at` IS NULL AND `credit_reservations`.`provider_rejected_status` IS NULL) OR (`credit_reservations`.`transport_state`='known_accepted' AND `credit_reservations`.`transport_started_at` IS NOT NULL AND `credit_reservations`.`provider_accepted_at` IS NOT NULL AND `credit_reservations`.`provider_accepted_at`>=`credit_reservations`.`transport_started_at` AND `credit_reservations`.`provider_rejected_at` IS NULL AND `credit_reservations`.`provider_rejected_status` IS NULL) OR (`credit_reservations`.`transport_state`='known_rejected' AND `credit_reservations`.`transport_started_at` IS NOT NULL AND `credit_reservations`.`provider_accepted_at` IS NULL AND `credit_reservations`.`provider_rejected_at` IS NOT NULL AND `credit_reservations`.`provider_rejected_at`>=`credit_reservations`.`transport_started_at` AND `credit_reservations`.`provider_rejected_status` BETWEEN 400 AND 499 AND `credit_reservations`.`provider_rejected_status` NOT IN (408,429))) IS TRUE),
	CONSTRAINT `credit_reservations_timestamp_order` CHECK(`credit_reservations`.`created_at` <= `credit_reservations`.`owner_lease_until` AND `credit_reservations`.`owner_lease_until` <= `credit_reservations`.`expires_at` AND `credit_reservations`.`expires_at` <= `credit_reservations`.`resolution_due_at` AND (`credit_reservations`.`transport_started_at` IS NULL OR (`credit_reservations`.`transport_started_at`>=`credit_reservations`.`created_at` AND `credit_reservations`.`transport_started_at`<=`credit_reservations`.`resolution_due_at`)) AND (`credit_reservations`.`provider_accepted_at` IS NULL OR (`credit_reservations`.`provider_accepted_at`>=`credit_reservations`.`created_at` AND `credit_reservations`.`provider_accepted_at`<=`credit_reservations`.`resolution_due_at`)) AND (`credit_reservations`.`provider_rejected_at` IS NULL OR (`credit_reservations`.`provider_rejected_at`>=`credit_reservations`.`created_at` AND `credit_reservations`.`provider_rejected_at`<=`credit_reservations`.`resolution_due_at`)) AND (`credit_reservations`.`committed_at` IS NULL OR (`credit_reservations`.`committed_at` >= `credit_reservations`.`created_at` AND `credit_reservations`.`committed_at` <= `credit_reservations`.`resolution_due_at`)) AND (`credit_reservations`.`released_at` IS NULL OR `credit_reservations`.`released_at` >= `credit_reservations`.`created_at`))
);
--> statement-breakpoint
CREATE TABLE `credit_wallets` (
	`wallet_id` varchar(36) NOT NULL,
	`workspace_id` int NOT NULL,
	`mode` enum('test','live') NOT NULL,
	`channel_connection_id` int NOT NULL,
	`binding_epoch` int NOT NULL,
	`privacy_epoch` int NOT NULL,
	`current_user_key_hash` varchar(96),
	`financial_subject_ref` varchar(64) NOT NULL,
	`status` enum('active','frozen','erased') NOT NULL DEFAULT 'active',
	`credit_balance` int NOT NULL DEFAULT 0,
	`reserved_credits` int NOT NULL DEFAULT 0,
	`balance_version` int NOT NULL DEFAULT 1,
	`last_ledger_entry_id` varchar(36),
	`privacy_erased_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `credit_wallets_wallet_id` PRIMARY KEY(`wallet_id`),
	CONSTRAINT `credit_wallets_financial_subject_unique` UNIQUE(`workspace_id`,`mode`,`financial_subject_ref`),
	CONSTRAINT `credit_wallets_active_subject_unique` UNIQUE(`workspace_id`,`mode`,`channel_connection_id`,`binding_epoch`,`privacy_epoch`,`current_user_key_hash`),
	CONSTRAINT `credit_wallets_exact_scope_unique` UNIQUE(`wallet_id`,`workspace_id`,`mode`,`channel_connection_id`,`binding_epoch`,`privacy_epoch`,`financial_subject_ref`),
	CONSTRAINT `credit_wallets_epochs_positive` CHECK(`credit_wallets`.`binding_epoch` > 0 AND `credit_wallets`.`privacy_epoch` > 0),
	CONSTRAINT `credit_wallets_identity_hashes_valid` CHECK(REGEXP_LIKE(`credit_wallets`.`financial_subject_ref`, '^[0-9a-f]{64}$', 'c') AND (`credit_wallets`.`current_user_key_hash` IS NULL OR REGEXP_LIKE(`credit_wallets`.`current_user_key_hash`, '^([0-9a-f]{64}|u2[.]k[1-9][0-9]{0,5}[.][0-9a-f]{64})$', 'c'))),
	CONSTRAINT `credit_wallets_id_valid` CHECK(REGEXP_LIKE(`credit_wallets`.`wallet_id`, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'c') AND (`credit_wallets`.`last_ledger_entry_id` IS NULL OR REGEXP_LIKE(`credit_wallets`.`last_ledger_entry_id`, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'c'))),
	CONSTRAINT `credit_wallets_counters_valid` CHECK(`credit_wallets`.`reserved_credits` >= 0 AND `credit_wallets`.`reserved_credits` <= GREATEST(`credit_wallets`.`credit_balance`, 0) AND (`credit_wallets`.`status` <> 'active' OR `credit_wallets`.`credit_balance` >= 0) AND `credit_wallets`.`balance_version` > 0 AND ((`credit_wallets`.`balance_version` = 1 AND `credit_wallets`.`last_ledger_entry_id` IS NULL AND `credit_wallets`.`credit_balance` = 0 AND `credit_wallets`.`reserved_credits` = 0) OR (`credit_wallets`.`balance_version` > 1 AND `credit_wallets`.`last_ledger_entry_id` IS NOT NULL))),
	CONSTRAINT `credit_wallets_erasure_shape` CHECK((`credit_wallets`.`status` = 'erased' AND `credit_wallets`.`current_user_key_hash` IS NULL AND `credit_wallets`.`privacy_erased_at` IS NOT NULL AND `credit_wallets`.`privacy_erased_at` >= `credit_wallets`.`created_at` AND `credit_wallets`.`reserved_credits` = 0) OR (`credit_wallets`.`status` <> 'erased' AND `credit_wallets`.`current_user_key_hash` IS NOT NULL AND `credit_wallets`.`privacy_erased_at` IS NULL))
);
--> statement-breakpoint
ALTER TABLE `credit_ledger` ADD CONSTRAINT `credit_ledger_wallet_scope_fk` FOREIGN KEY (`wallet_id`,`workspace_id`,`mode`,`channel_connection_id`,`binding_epoch`,`privacy_epoch`,`financial_subject_ref`) REFERENCES `credit_wallets`(`wallet_id`,`workspace_id`,`mode`,`channel_connection_id`,`binding_epoch`,`privacy_epoch`,`financial_subject_ref`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `credit_ledger` ADD CONSTRAINT `credit_ledger_financial_intent_fk` FOREIGN KEY (`source_intent_id`,`wallet_id`,`workspace_id`,`mode`) REFERENCES `billing_intents`(`intent_id`,`credit_wallet_id`,`workspace_id`,`mode`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `credit_ledger` ADD CONSTRAINT `credit_ledger_reservation_scope_fk` FOREIGN KEY (`reservation_id`,`wallet_id`,`workspace_id`,`mode`,`reservation_credit_count`) REFERENCES `credit_reservations`(`reservation_id`,`wallet_id`,`workspace_id`,`mode`,`reserved_credit_count`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `credit_ledger` ADD CONSTRAINT `credit_ledger_payment_scope_fk` FOREIGN KEY (`payment_ledger_id`,`workspace_id`,`mode`,`provider_payment_id`) REFERENCES `payment_ledger`(`id`,`workspace_id`,`mode`,`mollie_payment_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `credit_ledger` ADD CONSTRAINT `credit_ledger_root_grant_wallet_fk` FOREIGN KEY (`root_grant_entry_id`,`wallet_id`,`workspace_id`,`mode`) REFERENCES `credit_ledger`(`entry_id`,`wallet_id`,`workspace_id`,`mode`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `credit_reservations` ADD CONSTRAINT `credit_reservations_wallet_scope_fk` FOREIGN KEY (`wallet_id`,`workspace_id`,`mode`,`channel_connection_id`,`binding_epoch`,`privacy_epoch`,`financial_subject_ref`) REFERENCES `credit_wallets`(`wallet_id`,`workspace_id`,`mode`,`channel_connection_id`,`binding_epoch`,`privacy_epoch`,`financial_subject_ref`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `credit_wallets` ADD CONSTRAINT `credit_wallets_connection_workspace_fk` FOREIGN KEY (`channel_connection_id`,`workspace_id`) REFERENCES `channelConnections`(`id`,`workspaceId`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `credit_wallets` ADD CONSTRAINT `credit_wallets_privacy_subject_fk` FOREIGN KEY (`workspace_id`,`channel_connection_id`,`current_user_key_hash`) REFERENCES `messenger_privacy_subjects`(`workspace_id`,`channel_connection_id`,`user_key`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payment_ledger` ADD CONSTRAINT `payment_ledger_credit_intent_scope_fk` FOREIGN KEY (`credit_intent_id`,`credit_wallet_id`,`workspace_id`,`mode`,`credit_metadata_hash`) REFERENCES `billing_intents`(`intent_id`,`credit_wallet_id`,`workspace_id`,`mode`,`credit_metadata_hash`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `credit_ledger_wallet_time_idx` ON `credit_ledger` (`wallet_id`,`occurred_at`,`entry_id`);--> statement-breakpoint
CREATE INDEX `credit_reservations_expiry_idx` ON `credit_reservations` (`workspace_id`,`mode`,`status`,`transport_state`,`expires_at`);--> statement-breakpoint
CREATE INDEX `credit_wallets_subject_lookup_idx` ON `credit_wallets` (`workspace_id`,`channel_connection_id`,`current_user_key_hash`,`status`);--> statement-breakpoint
CREATE TRIGGER `credit_payment_ledger_before_insert`
BEFORE INSERT ON `payment_ledger`
FOR EACH ROW
BEGIN
	IF NEW.`paid_effect_applied`<>0
		OR NEW.`payment_effect_owner_kind` IS NOT NULL
		OR NEW.`payment_effect_owner_ref` IS NOT NULL
		OR NEW.`payment_effect_claimed_at` IS NOT NULL
		OR NEW.`credit_purpose` IS NOT NULL
		OR NEW.`credit_intent_id` IS NOT NULL
		OR NEW.`credit_wallet_id` IS NOT NULL
		OR NEW.`credit_metadata_hash` IS NOT NULL THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='new payment ledger evidence must start unclaimed';
	END IF;
END;--> statement-breakpoint
CREATE TRIGGER `credit_payment_ledger_before_update`
BEFORE UPDATE ON `payment_ledger`
FOR EACH ROW
BEGIN
	DECLARE v_legacy_count int DEFAULT 0;
	DECLARE v_credit_grant_count int DEFAULT 0;
	IF OLD.`id`<>NEW.`id` OR OLD.`workspace_id`<>NEW.`workspace_id`
		OR OLD.`mode`<>NEW.`mode`
		OR BINARY OLD.`mollie_payment_id`<>BINARY NEW.`mollie_payment_id`
		OR OLD.`created_at`<>NEW.`created_at` THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='payment ledger identity is immutable';
	END IF;
	IF NEW.`paid_effect_applied` NOT IN (0,1)
		OR NEW.`paid_effect_applied`<OLD.`paid_effect_applied` THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='payment effect claim is monotonic';
	END IF;
	IF OLD.`payment_effect_owner_kind` IS NOT NULL AND (
		NOT (BINARY OLD.`payment_effect_owner_kind`<=>BINARY NEW.`payment_effect_owner_kind`)
		OR NOT (BINARY OLD.`payment_effect_owner_ref`<=>BINARY NEW.`payment_effect_owner_ref`)
		OR NOT (OLD.`payment_effect_claimed_at`<=>NEW.`payment_effect_claimed_at`)
		OR NOT (BINARY OLD.`credit_purpose`<=>BINARY NEW.`credit_purpose`)
		OR NOT (BINARY OLD.`credit_intent_id`<=>BINARY NEW.`credit_intent_id`)
		OR NOT (BINARY OLD.`credit_wallet_id`<=>BINARY NEW.`credit_wallet_id`)
		OR NOT (BINARY OLD.`credit_metadata_hash`<=>BINARY NEW.`credit_metadata_hash`)
	) THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='payment effect ownership is immutable';
	END IF;
	IF OLD.`paid_effect_applied`=0 AND NEW.`paid_effect_applied`=1
		AND NEW.`payment_effect_owner_kind` IS NULL THEN
		SELECT COUNT(*) INTO v_legacy_count
		FROM `billing_intents`
		WHERE `workspace_id`=NEW.`workspace_id` AND `mode`=NEW.`mode`
			AND BINARY `mollie_payment_id`=BINARY NEW.`mollie_payment_id`
			AND `kind`='credit_purchase';
		IF v_legacy_count<>0 THEN
			SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit payment cannot use legacy paid effect';
		END IF;
	ELSEIF OLD.`paid_effect_applied`=0 AND NEW.`paid_effect_applied`=1
		AND NEW.`payment_effect_owner_kind`='legacy_billing'
		AND NEW.`payment_effect_claimed_at` IS NULL THEN
		SELECT COUNT(*) INTO v_legacy_count FROM `billing_intents`
		WHERE `workspace_id`=NEW.`workspace_id` AND `mode`=NEW.`mode`
			AND BINARY `intent_id`=BINARY NEW.`payment_effect_owner_ref`
			AND BINARY `mollie_payment_id`=BINARY NEW.`mollie_payment_id`
			AND `kind`<>'credit_purchase';
		IF v_legacy_count<>1 THEN
			SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='legacy payment owner is invalid';
		END IF;
		SET NEW.`payment_effect_claimed_at`=CURRENT_TIMESTAMP;
	ELSEIF OLD.`paid_effect_applied`=0 AND NEW.`paid_effect_applied`=1
		AND NEW.`payment_effect_owner_kind`='credit_grant' THEN
		SELECT COUNT(*) INTO v_credit_grant_count
		FROM `credit_ledger`
		WHERE `workspace_id`=NEW.`workspace_id` AND `mode`=NEW.`mode`
			AND `entry_kind`='purchase_grant'
			AND BINARY `source_intent_id`=BINARY NEW.`credit_intent_id`
			AND BINARY `wallet_id`=BINARY NEW.`credit_wallet_id`
			AND BINARY `provider_payment_id`=BINARY NEW.`mollie_payment_id`
			AND BINARY `evidence_hash`=BINARY NEW.`observed_snapshot_hash`;
		IF v_credit_grant_count<>1 OR NEW.`payment_effect_claimed_at` IS NULL THEN
			SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit payment claim requires one exact committed grant';
		END IF;
	END IF;
END;--> statement-breakpoint
CREATE TRIGGER `credit_billing_intents_before_insert`
BEFORE INSERT ON `billing_intents`
FOR EACH ROW
BEGIN
	DECLARE v_scope_count int DEFAULT 0;
	IF NEW.`kind`='credit_purchase' THEN
		SELECT COUNT(*) INTO v_scope_count
		FROM `billing_execution_controls` control
		JOIN `channelConnections` connection
			ON connection.`workspaceId`=control.`workspace_id`
			AND connection.`id`=NEW.`messenger_channel_connection_id`
		JOIN `messenger_privacy_subjects` subject
			ON subject.`workspace_id`=control.`workspace_id`
			AND subject.`channel_connection_id`=connection.`id`
			AND BINARY subject.`user_key`=BINARY NEW.`messenger_sender_user_key`
		JOIN `credit_wallets` wallet
			ON wallet.`workspace_id`=control.`workspace_id`
			AND wallet.`mode`=control.`mode`
			AND wallet.`channel_connection_id`=connection.`id`
			AND wallet.`binding_epoch`=connection.`bindingEpoch`
			AND wallet.`privacy_epoch`=subject.`privacy_epoch`
			AND BINARY wallet.`wallet_id`=BINARY NEW.`credit_wallet_id`
			AND BINARY wallet.`financial_subject_ref`=BINARY NEW.`credit_financial_subject_ref`
			AND BINARY wallet.`current_user_key_hash`=BINARY subject.`user_key`
		WHERE control.`workspace_id`=NEW.`workspace_id` AND control.`mode`=NEW.`mode`
			AND control.`commercial_enabled`=true
			AND control.`authorization_epoch`=NEW.`authorization_epoch`
			AND connection.`channel`='facebook_messenger'
			AND connection.`status`='connected'
			AND connection.`bindingEpoch`=NEW.`messenger_binding_epoch`
			AND subject.`status`='active'
			AND subject.`privacy_epoch`=NEW.`messenger_privacy_epoch`
			AND wallet.`status`='active';
		IF v_scope_count<>1 THEN
			SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit purchase requires exact current wallet authorization';
		END IF;
	END IF;
END;--> statement-breakpoint
CREATE TRIGGER `credit_billing_intents_before_update`
BEFORE UPDATE ON `billing_intents`
FOR EACH ROW
BEGIN
	IF OLD.`kind`='credit_purchase' OR NEW.`kind`='credit_purchase' THEN
		IF OLD.`kind`<>NEW.`kind`
			OR OLD.`workspace_id`<>NEW.`workspace_id` OR OLD.`mode`<>NEW.`mode`
			OR NOT (BINARY OLD.`credit_wallet_id`<=>BINARY NEW.`credit_wallet_id`)
			OR NOT (OLD.`messenger_channel_connection_id`<=>NEW.`messenger_channel_connection_id`)
			OR NOT (OLD.`messenger_binding_epoch`<=>NEW.`messenger_binding_epoch`)
			OR NOT (OLD.`messenger_privacy_epoch`<=>NEW.`messenger_privacy_epoch`)
			OR NOT (BINARY OLD.`credit_financial_subject_ref`<=>BINARY NEW.`credit_financial_subject_ref`)
			OR NOT (BINARY OLD.`plan_code`<=>BINARY NEW.`plan_code`)
			OR NOT (OLD.`expected_amount`<=>NEW.`expected_amount`)
			OR NOT (BINARY OLD.`currency`<=>BINARY NEW.`currency`)
			OR NOT (OLD.`credit_count`<=>NEW.`credit_count`)
			OR NOT (BINARY OLD.`credit_metadata_hash`<=>BINARY NEW.`credit_metadata_hash`)
			OR NOT (BINARY OLD.`mollie_description`<=>BINARY NEW.`mollie_description`)
			OR OLD.`billing_profile_version`<>NEW.`billing_profile_version`
			OR OLD.`authorization_epoch`<>NEW.`authorization_epoch`
			OR OLD.`created_at`<>NEW.`created_at` THEN
			SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit purchase scope and offer snapshot are immutable';
		END IF;
		IF OLD.`credit_identity_erased_at` IS NULL AND NEW.`credit_identity_erased_at` IS NULL THEN
			IF NOT (BINARY OLD.`messenger_sender_user_key`<=>BINARY NEW.`messenger_sender_user_key`)
				OR NOT (BINARY OLD.`checkout_capability_hash`<=>BINARY NEW.`checkout_capability_hash`)
				OR NOT (OLD.`checkout_capability_expires_at`<=>NEW.`checkout_capability_expires_at`) THEN
				SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit identity and capability are immutable before erasure';
			END IF;
			IF OLD.`checkout_capability_consumed_at` IS NOT NULL AND (
				NOT (OLD.`checkout_capability_consumed_at`<=>NEW.`checkout_capability_consumed_at`)
				OR NOT (BINARY OLD.`checkout_capability_session_nonce_hash`<=>BINARY NEW.`checkout_capability_session_nonce_hash`)
			) THEN
				SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit capability consumption is set once';
			END IF;
		ELSEIF OLD.`credit_identity_erased_at` IS NULL AND NEW.`credit_identity_erased_at` IS NOT NULL THEN
			IF NEW.`messenger_sender_user_key` IS NOT NULL OR NEW.`checkout_capability_hash` IS NOT NULL
				OR NEW.`checkout_capability_expires_at` IS NOT NULL
				OR NEW.`checkout_capability_consumed_at` IS NOT NULL
				OR NEW.`checkout_capability_session_nonce_hash` IS NOT NULL
				OR NEW.`status` NOT IN ('paid','failed','canceled','expired','mismatch','contained') THEN
				SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit identity erasure must revoke capability and contain work';
			END IF;
		ELSEIF NOT (OLD.`credit_identity_erased_at`<=>NEW.`credit_identity_erased_at`)
			OR NEW.`messenger_sender_user_key` IS NOT NULL THEN
			SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit identity erasure is irreversible';
		END IF;
		IF OLD.`url_exposed_at` IS NOT NULL AND NOT (OLD.`url_exposed_at`<=>NEW.`url_exposed_at`) THEN
			SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit checkout exposure is set once';
		END IF;
		IF OLD.`paid_at` IS NOT NULL AND NOT (OLD.`paid_at`<=>NEW.`paid_at`) THEN
			SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit paid timestamp is set once';
		END IF;
	END IF;
END;--> statement-breakpoint
CREATE TRIGGER `credit_wallets_before_insert`
BEFORE INSERT ON `credit_wallets`
FOR EACH ROW
BEGIN
	DECLARE v_current_count int DEFAULT 0;
	IF NEW.`status`<>'active' OR NEW.`credit_balance`<>0 OR NEW.`reserved_credits`<>0
		OR NEW.`balance_version`<>1 OR NEW.`last_ledger_entry_id` IS NOT NULL
		OR NEW.`current_user_key_hash` IS NULL OR NEW.`privacy_erased_at` IS NOT NULL THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='new credit wallet must start active and empty';
	END IF;
	SELECT COUNT(*) INTO v_current_count
	FROM `channelConnections` connection
	JOIN `messenger_privacy_subjects` subject
		ON subject.`workspace_id`=connection.`workspaceId`
		AND subject.`channel_connection_id`=connection.`id`
		AND BINARY subject.`user_key`=BINARY NEW.`current_user_key_hash`
	WHERE connection.`id`=NEW.`channel_connection_id`
		AND connection.`workspaceId`=NEW.`workspace_id`
		AND connection.`channel`='facebook_messenger'
		AND connection.`status`='connected'
		AND connection.`bindingEpoch`=NEW.`binding_epoch`
		AND subject.`status`='active'
		AND subject.`privacy_epoch`=NEW.`privacy_epoch`;
	IF v_current_count<>1 THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit wallet requires exact current Messenger subject';
	END IF;
END;--> statement-breakpoint
CREATE TRIGGER `credit_wallets_before_update`
BEFORE UPDATE ON `credit_wallets`
FOR EACH ROW
BEGIN
	DECLARE v_projection_count int DEFAULT 0;
	IF BINARY OLD.`wallet_id`<>BINARY NEW.`wallet_id`
		OR OLD.`workspace_id`<>NEW.`workspace_id` OR OLD.`mode`<>NEW.`mode`
		OR OLD.`channel_connection_id`<>NEW.`channel_connection_id`
		OR OLD.`binding_epoch`<>NEW.`binding_epoch`
		OR OLD.`privacy_epoch`<>NEW.`privacy_epoch`
		OR BINARY OLD.`financial_subject_ref`<>BINARY NEW.`financial_subject_ref`
		OR OLD.`created_at`<>NEW.`created_at` THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit wallet retained scope is immutable';
	END IF;
	IF OLD.`status`='erased' AND NEW.`status`<>'erased'
		OR OLD.`status`='frozen' AND NEW.`status`='active' THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit wallet cannot reactivate automatically';
	END IF;
	IF NOT (BINARY OLD.`current_user_key_hash`<=>BINARY NEW.`current_user_key_hash`)
		AND NOT (OLD.`current_user_key_hash` IS NOT NULL AND NEW.`current_user_key_hash` IS NULL
			AND NEW.`status`='erased' AND NEW.`privacy_erased_at` IS NOT NULL) THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit wallet user binding may only be erased';
	END IF;
	IF OLD.`privacy_erased_at` IS NOT NULL AND NOT (OLD.`privacy_erased_at`<=>NEW.`privacy_erased_at`) THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='wallet privacy erasure timestamp is set once';
	END IF;
	IF OLD.`credit_balance`<>NEW.`credit_balance` OR OLD.`reserved_credits`<>NEW.`reserved_credits`
		OR NOT (BINARY OLD.`last_ledger_entry_id`<=>BINARY NEW.`last_ledger_entry_id`) THEN
		IF NEW.`balance_version`<>OLD.`balance_version`+1 OR NEW.`last_ledger_entry_id` IS NULL THEN
			SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='wallet projection requires exactly one ledger version';
		END IF;
		SELECT COUNT(*) INTO v_projection_count
		FROM `credit_ledger` entry
		WHERE BINARY entry.`entry_id`=BINARY NEW.`last_ledger_entry_id`
			AND BINARY entry.`wallet_id`=BINARY NEW.`wallet_id`
			AND entry.`workspace_id`=NEW.`workspace_id`
			AND entry.`mode`=NEW.`mode`
			AND entry.`wallet_version_before`=OLD.`balance_version`
			AND entry.`wallet_version_after`=NEW.`balance_version`
			AND (BINARY entry.`previous_entry_id`<=>BINARY OLD.`last_ledger_entry_id`)
			AND entry.`balance_before`=OLD.`credit_balance`
			AND entry.`reserved_before`=OLD.`reserved_credits`
			AND entry.`balance_after`=NEW.`credit_balance`
			AND entry.`reserved_after`=NEW.`reserved_credits`;
		IF v_projection_count<>1 THEN
			SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='wallet projection requires the exact inserted ledger entry';
		END IF;
	ELSEIF NEW.`balance_version`<>OLD.`balance_version` THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='wallet version cannot move without a ledger projection';
	END IF;
	IF NEW.`status`='erased' AND NEW.`reserved_credits`<>0 THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='wallet with active holds cannot be erased';
	END IF;
END;--> statement-breakpoint
CREATE TRIGGER `credit_wallets_before_delete`
BEFORE DELETE ON `credit_wallets`
FOR EACH ROW
BEGIN
	DECLARE v_reference_count int DEFAULT 0;
	IF NOT (OLD.`status`='active' AND OLD.`credit_balance`=0 AND OLD.`reserved_credits`=0
		AND OLD.`balance_version`=1 AND OLD.`last_ledger_entry_id` IS NULL
		AND OLD.`privacy_erased_at` IS NULL) THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit wallet financial evidence cannot be deleted';
	END IF;
	SELECT
		(SELECT COUNT(*) FROM `billing_intents` intent
			WHERE BINARY intent.`credit_wallet_id`=BINARY OLD.`wallet_id`
				AND intent.`workspace_id`=OLD.`workspace_id` AND intent.`mode`=OLD.`mode`)
		+ (SELECT COUNT(*) FROM `payment_ledger` payment
			WHERE BINARY payment.`credit_wallet_id`=BINARY OLD.`wallet_id`
				AND payment.`workspace_id`=OLD.`workspace_id` AND payment.`mode`=OLD.`mode`)
		+ (SELECT COUNT(*) FROM `credit_reservations` reservation
			WHERE BINARY reservation.`wallet_id`=BINARY OLD.`wallet_id`
				AND reservation.`workspace_id`=OLD.`workspace_id` AND reservation.`mode`=OLD.`mode`)
		+ (SELECT COUNT(*) FROM `credit_ledger` entry
			WHERE BINARY entry.`wallet_id`=BINARY OLD.`wallet_id`
				AND entry.`workspace_id`=OLD.`workspace_id` AND entry.`mode`=OLD.`mode`)
	INTO v_reference_count;
	IF v_reference_count<>0 THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit wallet financial evidence cannot be deleted';
	END IF;
END;--> statement-breakpoint
CREATE TRIGGER `credit_reservations_before_insert`
BEFORE INSERT ON `credit_reservations`
FOR EACH ROW
BEGIN
	DECLARE v_scope_count int DEFAULT 0;
	IF NEW.`status`<>'initializing' OR NEW.`state_version`<>1
		OR NEW.`transport_state`<>'pretransport'
		OR NEW.`transport_started_at` IS NOT NULL OR NEW.`provider_accepted_at` IS NOT NULL
		OR NEW.`provider_rejected_at` IS NOT NULL OR NEW.`provider_rejected_status` IS NOT NULL
		OR NEW.`hold_ledger_entry_id` IS NOT NULL OR NEW.`terminal_ledger_entry_id` IS NOT NULL
		OR NEW.`terminal_evidence_hash` IS NOT NULL OR NEW.`committed_at` IS NOT NULL
		OR NEW.`released_at` IS NOT NULL OR NEW.`operational_scrubbed_at` IS NOT NULL
		OR NEW.`created_at`>NEW.`owner_lease_until`
		OR NEW.`owner_lease_until`>TIMESTAMPADD(MINUTE,2,NEW.`created_at`)
		OR NEW.`expires_at`>TIMESTAMPADD(MINUTE,15,NEW.`created_at`)
		OR NEW.`resolution_due_at`>TIMESTAMPADD(DAY,1,NEW.`created_at`) THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='new credit reservation must start pristine and bounded';
	END IF;
	SELECT COUNT(*) INTO v_scope_count
	FROM `channelConnections` connection
	JOIN `messenger_privacy_subjects` subject
		ON subject.`workspace_id`=connection.`workspaceId`
		AND subject.`channel_connection_id`=connection.`id`
	JOIN `credit_wallets` wallet
		ON wallet.`workspace_id`=connection.`workspaceId`
		AND wallet.`channel_connection_id`=connection.`id`
		AND wallet.`mode`=NEW.`mode`
		AND BINARY wallet.`wallet_id`=BINARY NEW.`wallet_id`
		AND BINARY wallet.`financial_subject_ref`=BINARY NEW.`financial_subject_ref`
		AND BINARY wallet.`current_user_key_hash`=BINARY subject.`user_key`
	WHERE connection.`workspaceId`=NEW.`workspace_id`
		AND connection.`id`=NEW.`channel_connection_id`
		AND connection.`channel`='facebook_messenger' AND connection.`status`='connected'
		AND connection.`bindingEpoch`=NEW.`binding_epoch`
		AND subject.`status`='active' AND subject.`privacy_epoch`=NEW.`privacy_epoch`
		AND wallet.`status`='active' AND wallet.`binding_epoch`=NEW.`binding_epoch`
		AND wallet.`privacy_epoch`=NEW.`privacy_epoch`
		AND wallet.`credit_balance`-wallet.`reserved_credits`>=NEW.`reserved_credit_count`;
	IF v_scope_count<>1 THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit reservation requires current available wallet scope';
	END IF;
END;--> statement-breakpoint
CREATE TRIGGER `credit_reservations_before_update`
BEFORE UPDATE ON `credit_reservations`
FOR EACH ROW
BEGIN
	IF BINARY OLD.`reservation_id`<>BINARY NEW.`reservation_id`
		OR BINARY OLD.`wallet_id`<>BINARY NEW.`wallet_id`
		OR OLD.`workspace_id`<>NEW.`workspace_id` OR OLD.`mode`<>NEW.`mode`
		OR OLD.`channel_connection_id`<>NEW.`channel_connection_id`
		OR OLD.`binding_epoch`<>NEW.`binding_epoch` OR OLD.`privacy_epoch`<>NEW.`privacy_epoch`
		OR BINARY OLD.`financial_subject_ref`<>BINARY NEW.`financial_subject_ref`
		OR OLD.`reserved_credit_count`<>NEW.`reserved_credit_count`
		OR NOT (BINARY OLD.`generation_request_key_hash`<=>BINARY NEW.`generation_request_key_hash`)
			AND NEW.`operational_scrubbed_at` IS NULL
		OR NOT (BINARY OLD.`owner_token_hash`<=>BINARY NEW.`owner_token_hash`)
			AND NEW.`operational_scrubbed_at` IS NULL
		OR OLD.`owner_lease_until`<>NEW.`owner_lease_until`
		OR OLD.`expires_at`<>NEW.`expires_at` OR OLD.`resolution_due_at`<>NEW.`resolution_due_at`
		OR OLD.`created_at`<>NEW.`created_at` THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit reservation scope is immutable';
	END IF;
	IF OLD.`transport_state`='pretransport' AND NEW.`transport_state` NOT IN ('pretransport','transport_started')
		OR OLD.`transport_state`='transport_started' AND NEW.`transport_state` NOT IN ('transport_started','known_accepted','known_rejected')
		OR OLD.`transport_state`='known_accepted' AND NEW.`transport_state`<>'known_accepted'
		OR OLD.`transport_state`='known_rejected' AND NEW.`transport_state`<>'known_rejected' THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit reservation transport transition is invalid';
	END IF;
	IF OLD.`transport_started_at` IS NOT NULL AND NOT (OLD.`transport_started_at`<=>NEW.`transport_started_at`)
		OR OLD.`provider_accepted_at` IS NOT NULL AND NOT (OLD.`provider_accepted_at`<=>NEW.`provider_accepted_at`)
		OR OLD.`provider_rejected_at` IS NOT NULL AND NOT (OLD.`provider_rejected_at`<=>NEW.`provider_rejected_at`)
		OR OLD.`provider_rejected_status` IS NOT NULL AND NOT (OLD.`provider_rejected_status`<=>NEW.`provider_rejected_status`) THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit reservation transport evidence is set once';
	END IF;
	IF (NEW.`provider_rejected_at` IS NOT NULL OR NEW.`provider_rejected_status` IS NOT NULL)
		AND NEW.`transport_state`<>'known_rejected' THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit reservation rejected evidence transition is invalid';
	END IF;
	IF OLD.`status`='initializing' AND NOT (NEW.`status`='reserved' AND NEW.`state_version`=2)
		OR OLD.`status`='reserved' AND NOT (
			(NEW.`status`='reserved' AND NEW.`state_version`=2)
			OR (NEW.`status` IN ('committed','released','expired') AND NEW.`state_version`=3)
		)
		OR OLD.`status` IN ('committed','released','expired')
			AND NOT (NEW.`status`=OLD.`status` AND NEW.`state_version`=3) THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit reservation state transition is invalid';
	END IF;
	IF OLD.`hold_ledger_entry_id` IS NOT NULL AND NOT (BINARY OLD.`hold_ledger_entry_id`<=>BINARY NEW.`hold_ledger_entry_id`)
		OR OLD.`terminal_ledger_entry_id` IS NOT NULL AND NOT (BINARY OLD.`terminal_ledger_entry_id`<=>BINARY NEW.`terminal_ledger_entry_id`)
		OR OLD.`terminal_evidence_hash` IS NOT NULL AND NOT (BINARY OLD.`terminal_evidence_hash`<=>BINARY NEW.`terminal_evidence_hash`)
		OR OLD.`committed_at` IS NOT NULL AND NOT (OLD.`committed_at`<=>NEW.`committed_at`)
		OR OLD.`released_at` IS NOT NULL AND NOT (OLD.`released_at`<=>NEW.`released_at`)
		OR OLD.`operational_scrubbed_at` IS NOT NULL AND NOT (OLD.`operational_scrubbed_at`<=>NEW.`operational_scrubbed_at`) THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit reservation evidence is set once';
	END IF;
END;--> statement-breakpoint
CREATE TRIGGER `credit_reservations_before_delete`
BEFORE DELETE ON `credit_reservations`
FOR EACH ROW
BEGIN
	SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit reservation evidence cannot be deleted';
END;--> statement-breakpoint
CREATE TRIGGER `credit_ledger_before_insert`
BEFORE INSERT ON `credit_ledger`
FOR EACH ROW
BEGIN
	DECLARE v_wallet_count int DEFAULT 0;
	DECLARE v_effect_count int DEFAULT 0;
	DECLARE v_root_count int DEFAULT 0;
	DECLARE v_reservation_count int DEFAULT 0;
	DECLARE v_refund_count int DEFAULT 0;
	DECLARE v_refund_distinct int DEFAULT 0;
	DECLARE v_refunded_count int DEFAULT 0;
	DECLARE v_refund_invalid int DEFAULT 0;
	DECLARE v_refund_total decimal(10,2) DEFAULT 0;
	SELECT COUNT(*) INTO v_wallet_count
	FROM `credit_wallets`
	WHERE BINARY `wallet_id`=BINARY NEW.`wallet_id`
		AND `workspace_id`=NEW.`workspace_id` AND `mode`=NEW.`mode`
		AND `channel_connection_id`=NEW.`channel_connection_id`
		AND `binding_epoch`=NEW.`binding_epoch` AND `privacy_epoch`=NEW.`privacy_epoch`
		AND BINARY `financial_subject_ref`=BINARY NEW.`financial_subject_ref`
		AND `balance_version`=NEW.`wallet_version_before`
		AND (`last_ledger_entry_id`<=>NEW.`previous_entry_id`)
		AND `credit_balance`=NEW.`balance_before`
		AND `reserved_credits`=NEW.`reserved_before`;
	IF v_wallet_count<>1 THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit ledger chain does not match locked wallet';
	END IF;
	IF NEW.`entry_kind`='purchase_grant' THEN
		SELECT COUNT(*) INTO v_effect_count
		FROM `billing_intents` intent
		JOIN `billing_provider_operations` operation
			ON operation.`workspace_id`=intent.`workspace_id`
			AND operation.`mode`=intent.`mode`
			AND BINARY operation.`intent_id`=BINARY intent.`intent_id`
		JOIN `payment_ledger` payment
			ON payment.`workspace_id`=intent.`workspace_id`
			AND payment.`mode`=intent.`mode`
			AND BINARY payment.`mollie_payment_id`=BINARY intent.`mollie_payment_id`
		JOIN `credit_wallets` wallet
			ON wallet.`workspace_id`=intent.`workspace_id` AND wallet.`mode`=intent.`mode`
			AND BINARY wallet.`wallet_id`=BINARY intent.`credit_wallet_id`
		JOIN `channelConnections` connection
			ON connection.`workspaceId`=wallet.`workspace_id` AND connection.`id`=wallet.`channel_connection_id`
		JOIN `messenger_privacy_subjects` subject
			ON subject.`workspace_id`=wallet.`workspace_id`
			AND subject.`channel_connection_id`=wallet.`channel_connection_id`
			AND BINARY subject.`user_key`=BINARY wallet.`current_user_key_hash`
		WHERE intent.`kind`='credit_purchase' AND intent.`status`='paid'
			AND intent.`url_exposed_at` IS NOT NULL AND intent.`credit_identity_erased_at` IS NULL
			AND intent.`checkout_capability_consumed_at` IS NOT NULL
			AND REGEXP_LIKE(intent.`checkout_capability_session_nonce_hash`,'^[0-9a-f]{64}$','c')
			AND BINARY intent.`intent_id`=BINARY NEW.`source_intent_id`
			AND intent.`workspace_id`=NEW.`workspace_id` AND intent.`mode`=NEW.`mode`
			AND BINARY intent.`credit_wallet_id`=BINARY NEW.`wallet_id`
			AND intent.`messenger_channel_connection_id`=NEW.`channel_connection_id`
			AND intent.`messenger_binding_epoch`=NEW.`binding_epoch`
			AND intent.`messenger_privacy_epoch`=NEW.`privacy_epoch`
			AND BINARY intent.`messenger_sender_user_key`=BINARY wallet.`current_user_key_hash`
			AND BINARY intent.`credit_financial_subject_ref`=BINARY NEW.`financial_subject_ref`
			AND intent.`authorization_epoch`=NEW.`authorization_epoch`
			AND BINARY intent.`mollie_payment_id`=BINARY NEW.`provider_payment_id`
			AND BINARY intent.`plan_code`=BINARY NEW.`offer_id`
			AND intent.`expected_amount`=NEW.`payment_amount`
			AND BINARY intent.`currency`=BINARY NEW.`currency`
			AND intent.`credit_count`=NEW.`purchased_credit_count`
			AND BINARY intent.`mollie_description`=BINARY NEW.`provider_description`
			AND operation.`operation_type`='create_payment' AND operation.`state` IN ('succeeded','contained')
			AND operation.`billing_profile_version`=0
			AND operation.`provider_customer_id` IS NULL
			AND BINARY operation.`request_fingerprint`=BINARY intent.`credit_metadata_hash`
			AND BINARY operation.`provider_resource_id`=BINARY NEW.`provider_payment_id`
			AND operation.`authorization_epoch`=intent.`authorization_epoch`
			AND payment.`id`=NEW.`payment_ledger_id` AND payment.`status`='paid'
			AND payment.`gross_amount`=NEW.`payment_amount`
			AND BINARY payment.`currency`=BINARY NEW.`currency`
			AND BINARY payment.`observed_snapshot_hash`=BINARY NEW.`evidence_hash`
			AND payment.`paid_effect_applied`=0 AND payment.`payment_effect_owner_kind` IS NULL
			AND payment.`credit_purpose` IS NULL AND payment.`credit_intent_id` IS NULL
			AND wallet.`status`='active' AND wallet.`reserved_credits`>=0
			AND connection.`channel`='facebook_messenger' AND connection.`status`='connected'
			AND connection.`bindingEpoch`=wallet.`binding_epoch`
			AND subject.`status`='active' AND subject.`privacy_epoch`=wallet.`privacy_epoch`;
		IF v_effect_count<>1 THEN
			SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='purchase grant lacks exact exposed paid credit evidence';
		END IF;
	ELSEIF NEW.`entry_kind`='reservation_hold' THEN
		SELECT COUNT(*) INTO v_reservation_count FROM `credit_reservations`
		WHERE BINARY `reservation_id`=BINARY NEW.`reservation_id`
			AND BINARY `wallet_id`=BINARY NEW.`wallet_id`
			AND `workspace_id`=NEW.`workspace_id` AND `mode`=NEW.`mode`
			AND `reserved_credit_count`=NEW.`reservation_credit_count`
			AND `status`='initializing' AND `state_version`=1
			AND `hold_ledger_entry_id` IS NULL;
		IF v_reservation_count<>1 OR NEW.`balance_after`-NEW.`reserved_after`<0 THEN
			SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='reservation hold lacks pristine available reservation';
		END IF;
	ELSEIF NEW.`entry_kind` IN ('generation_spend','reservation_release') THEN
		SELECT COUNT(*) INTO v_reservation_count FROM `credit_reservations`
		WHERE BINARY `reservation_id`=BINARY NEW.`reservation_id`
			AND BINARY `wallet_id`=BINARY NEW.`wallet_id`
			AND `workspace_id`=NEW.`workspace_id` AND `mode`=NEW.`mode`
			AND `reserved_credit_count`=NEW.`reservation_credit_count`
			AND `status`='reserved' AND `state_version`=2
			AND `hold_ledger_entry_id` IS NOT NULL AND `terminal_ledger_entry_id` IS NULL;
		IF v_reservation_count<>1 THEN
			SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='reservation terminal effect requires one held reservation';
		END IF;
		IF NEW.`entry_kind`='generation_spend' THEN
			SELECT COUNT(*) INTO v_effect_count
			FROM `credit_wallets` wallet
			JOIN `channelConnections` connection
				ON connection.`workspaceId`=wallet.`workspace_id`
				AND connection.`id`=wallet.`channel_connection_id`
			JOIN `messenger_privacy_subjects` subject
				ON subject.`workspace_id`=wallet.`workspace_id`
				AND subject.`channel_connection_id`=wallet.`channel_connection_id`
				AND BINARY subject.`user_key`=BINARY wallet.`current_user_key_hash`
			WHERE BINARY wallet.`wallet_id`=BINARY NEW.`wallet_id`
				AND wallet.`workspace_id`=NEW.`workspace_id` AND wallet.`mode`=NEW.`mode`
				AND wallet.`status`='active'
				AND connection.`channel`='facebook_messenger' AND connection.`status`='connected'
				AND connection.`bindingEpoch`=NEW.`binding_epoch`
				AND subject.`status`='active' AND subject.`privacy_epoch`=NEW.`privacy_epoch`;
			IF v_effect_count<>1 THEN
				SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='generation spend requires current active Messenger scope';
			END IF;
		END IF;
	ELSEIF NEW.`entry_kind` IN ('refund_debit','chargeback_debit','chargeback_restore') THEN
		IF NEW.`reserved_before`<>0 THEN
			SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='financial adjustment waits for active holds';
		END IF;
		SELECT COUNT(*) INTO v_root_count
		FROM `credit_ledger` root
		JOIN `billing_intents` intent
			ON intent.`workspace_id`=root.`workspace_id` AND intent.`mode`=root.`mode`
			AND BINARY intent.`intent_id`=BINARY root.`source_intent_id`
		JOIN `payment_ledger` payment
			ON payment.`id`=root.`payment_ledger_id`
			AND payment.`workspace_id`=root.`workspace_id` AND payment.`mode`=root.`mode`
			AND BINARY payment.`mollie_payment_id`=BINARY root.`provider_payment_id`
		WHERE root.`entry_kind`='purchase_grant'
			AND BINARY root.`entry_id`=BINARY NEW.`root_grant_entry_id`
			AND BINARY root.`wallet_id`=BINARY NEW.`wallet_id`
			AND root.`workspace_id`=NEW.`workspace_id` AND root.`mode`=NEW.`mode`
			AND BINARY root.`source_intent_id`=BINARY NEW.`source_intent_id`
			AND root.`payment_ledger_id`=NEW.`payment_ledger_id`
			AND BINARY root.`provider_payment_id`=BINARY NEW.`provider_payment_id`
			AND root.`payment_amount`=NEW.`payment_amount`
			AND BINARY root.`currency`=BINARY NEW.`currency`
			AND root.`purchased_credit_count`=NEW.`purchased_credit_count`
			AND payment.`paid_effect_applied`=1
			AND payment.`status`='paid'
			AND payment.`payment_effect_owner_kind`='credit_grant'
			AND BINARY payment.`payment_effect_owner_ref`=BINARY root.`source_intent_id`
			AND BINARY payment.`credit_wallet_id`=BINARY root.`wallet_id`
			AND payment.`gross_amount`=root.`payment_amount`
			AND BINARY payment.`currency`=BINARY root.`currency`
			AND BINARY payment.`observed_snapshot_hash`=BINARY NEW.`evidence_hash`;
		IF v_root_count<>1 THEN
			SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='financial adjustment lacks exact root payment evidence';
		END IF;
		IF NEW.`entry_kind`='refund_debit' THEN
			SELECT COUNT(*) INTO v_effect_count FROM `payment_ledger` payment
			WHERE payment.`id`=NEW.`payment_ledger_id`
				AND JSON_TYPE(NEW.`provider_effect_evidence`)='ARRAY'
				AND JSON_LENGTH(NEW.`provider_effect_evidence`)>0
				AND BINARY CAST(payment.`refunds` AS CHAR)=BINARY CAST(NEW.`provider_effect_evidence` AS CHAR);
			SELECT COUNT(*),COUNT(DISTINCT BINARY `effect_id`),
				COALESCE(SUM(CASE WHEN `effect_status`='refunded' THEN 1 ELSE 0 END),0),
				COALESCE(SUM(CASE WHEN `effect_status`='refunded'
					AND REGEXP_LIKE(`effect_amount_raw`,'^(0|[1-9][0-9]{0,7})[.][0-9]{2}$','c')
					THEN CAST(`effect_amount_raw` AS DECIMAL(10,2)) ELSE 0 END),0),
				COALESCE(SUM(CASE WHEN `effect_id` IS NULL
					OR NOT REGEXP_LIKE(`effect_id`,'^[A-Za-z0-9_-]{1,64}$','c')
					OR NOT REGEXP_LIKE(`effect_status`,'^[a-z][a-z_]{0,23}$','c')
					OR NOT REGEXP_LIKE(`effect_amount_raw`,'^(0|[1-9][0-9]{0,7})[.][0-9]{2}$','c')
					OR `effect_amount_raw`='0.00'
					OR NOT (BINARY `effect_currency`=BINARY NEW.`provider_effect_currency`)
					THEN 1 ELSE 0 END),0)
			INTO v_refund_count,v_refund_distinct,v_refunded_count,v_refund_total,v_refund_invalid
			FROM JSON_TABLE(NEW.`provider_effect_evidence`,'$[*]' COLUMNS(
				`effect_id` varchar(64) PATH '$.id',
				`effect_status` varchar(24) PATH '$.status',
				`effect_amount_raw` varchar(32) PATH '$.amount.value',
				`effect_currency` varchar(3) PATH '$.amount.currency'
			)) effect;
			IF v_effect_count<>1 OR v_refund_count<>JSON_LENGTH(NEW.`provider_effect_evidence`)
				OR v_refund_distinct<>v_refund_count OR v_refunded_count=0 OR v_refund_invalid<>0
				OR v_refund_total<>NEW.`provider_effect_amount`
				OR BINARY NEW.`provider_effect_id`<>BINARY SHA2(CONCAT(
					'credit-refund-set-v1',CHAR(10),NEW.`mode`,CHAR(10),NEW.`provider_payment_id`,CHAR(10),
					CAST(NEW.`provider_effect_evidence` AS CHAR)
				),256) THEN
				SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='refund aggregate evidence is invalid';
			END IF;
		ELSE
			SELECT COUNT(*) INTO v_effect_count
			FROM `payment_ledger` payment,
			JSON_TABLE(payment.`chargebacks`,'$[*]' COLUMNS(
				`effect_id` varchar(64) PATH '$.id',
				`effect_amount_raw` varchar(32) PATH '$.amount.value',
				`effect_currency` varchar(3) PATH '$.amount.currency',
				`reversed_at` varchar(40) PATH '$.reversedAt' NULL ON EMPTY
			)) effect
			WHERE payment.`id`=NEW.`payment_ledger_id`
				AND BINARY effect.`effect_id`=BINARY NEW.`provider_effect_id`
				AND REGEXP_LIKE(effect.`effect_amount_raw`,'^(0|[1-9][0-9]{0,7})[.][0-9]{2}$','c')
				AND effect.`effect_amount_raw`<>'0.00'
				AND CAST(effect.`effect_amount_raw` AS DECIMAL(10,2))=NEW.`provider_effect_amount`
				AND BINARY effect.`effect_currency`=BINARY NEW.`provider_effect_currency`
				AND ((NEW.`entry_kind`='chargeback_debit' AND effect.`reversed_at` IS NULL)
					OR (NEW.`entry_kind`='chargeback_restore' AND effect.`reversed_at` IS NOT NULL));
		END IF;
		IF v_effect_count<>1 OR BINARY NEW.`provider_event_hash`<>BINARY SHA2(CONCAT(
			'credit-provider-effect-v1',CHAR(10),NEW.`mode`,CHAR(10),NEW.`provider_payment_id`,CHAR(10),
			NEW.`provider_effect_type`,CHAR(10),NEW.`provider_effect_id`,CHAR(10),NEW.`provider_effect_status`,CHAR(10),
			CAST(NEW.`provider_effect_amount` AS CHAR),CHAR(10),NEW.`provider_effect_currency`,CHAR(10),NEW.`evidence_hash`
		),256) THEN
			SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='financial adjustment provider effect is invalid';
		END IF;
		IF NEW.`entry_kind`='chargeback_restore' THEN
			SELECT COUNT(*) INTO v_effect_count FROM `credit_ledger`
			WHERE `mode`=NEW.`mode` AND BINARY `root_grant_entry_id`=BINARY NEW.`root_grant_entry_id`
				AND `entry_kind`='chargeback_debit'
				AND BINARY `provider_effect_id`=BINARY NEW.`provider_effect_id`;
			IF v_effect_count<>1 THEN
				SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='chargeback restore requires exact prior debit';
			END IF;
		END IF;
	END IF;
END;--> statement-breakpoint
CREATE TRIGGER `credit_ledger_after_insert`
AFTER INSERT ON `credit_ledger`
FOR EACH ROW
BEGIN
	UPDATE `credit_wallets`
	SET `credit_balance`=NEW.`balance_after`,
		`reserved_credits`=NEW.`reserved_after`,
		`balance_version`=NEW.`wallet_version_after`,
		`last_ledger_entry_id`=NEW.`entry_id`,
		`status`=CASE
			WHEN `status`='active' AND NEW.`entry_kind`='chargeback_debit' THEN 'frozen'
			WHEN `status`='active' AND NEW.`entry_kind`='refund_debit' AND NEW.`balance_after`<0 THEN 'frozen'
			ELSE `status`
		END
	WHERE BINARY `wallet_id`=BINARY NEW.`wallet_id`
		AND `workspace_id`=NEW.`workspace_id` AND `mode`=NEW.`mode`
		AND `balance_version`=NEW.`wallet_version_before`
		AND (`last_ledger_entry_id`<=>NEW.`previous_entry_id`)
		AND `credit_balance`=NEW.`balance_before`
		AND `reserved_credits`=NEW.`reserved_before`;
	IF ROW_COUNT()<>1 THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit wallet projector compare-and-swap failed';
	END IF;
	IF NEW.`entry_kind`='reservation_hold' THEN
		UPDATE `credit_reservations`
		SET `status`='reserved',`state_version`=2,`hold_ledger_entry_id`=NEW.`entry_id`
		WHERE BINARY `reservation_id`=BINARY NEW.`reservation_id`
			AND `status`='initializing' AND `state_version`=1 AND `hold_ledger_entry_id` IS NULL;
		IF ROW_COUNT()<>1 THEN
			SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit reservation hold projector failed';
		END IF;
	ELSEIF NEW.`entry_kind`='generation_spend' THEN
		UPDATE `credit_reservations`
		SET `status`='committed',`state_version`=3,`committed_at`=NEW.`occurred_at`,
			`terminal_ledger_entry_id`=NEW.`entry_id`,`terminal_evidence_hash`=NEW.`evidence_hash`
		WHERE BINARY `reservation_id`=BINARY NEW.`reservation_id`
			AND `status`='reserved' AND `state_version`=2 AND `terminal_ledger_entry_id` IS NULL;
		IF ROW_COUNT()<>1 THEN
			SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit reservation commit projector failed';
		END IF;
	ELSEIF NEW.`entry_kind`='reservation_release' THEN
		UPDATE `credit_reservations`
		SET `status`=NEW.`reservation_terminal_status`,`state_version`=3,`released_at`=NEW.`occurred_at`,
			`terminal_ledger_entry_id`=NEW.`entry_id`,`terminal_evidence_hash`=NEW.`evidence_hash`
		WHERE BINARY `reservation_id`=BINARY NEW.`reservation_id`
			AND `status`='reserved' AND `state_version`=2 AND `terminal_ledger_entry_id` IS NULL;
		IF ROW_COUNT()<>1 THEN
			SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit reservation release projector failed';
		END IF;
	END IF;
END;--> statement-breakpoint
CREATE TRIGGER `credit_ledger_before_update`
BEFORE UPDATE ON `credit_ledger`
FOR EACH ROW
BEGIN
	SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit ledger is append only';
END;--> statement-breakpoint
CREATE TRIGGER `credit_ledger_before_delete`
BEFORE DELETE ON `credit_ledger`
FOR EACH ROW
BEGIN
	SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit ledger is append only';
END;--> statement-breakpoint
CREATE PROCEDURE `credit_create_wallet`(
	IN p_wallet_id varchar(36), IN p_workspace_id int, IN p_mode varchar(8),
	IN p_channel_connection_id int, IN p_binding_epoch int, IN p_privacy_epoch int,
	IN p_user_key varchar(96), IN p_financial_subject_ref varchar(64)
)
SQL SECURITY DEFINER
credit_create_wallet_body: BEGIN
	DECLARE v_count int DEFAULT 0;
	DECLARE v_existing_wallet_id varchar(36);
	DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN ROLLBACK; RESIGNAL; END;
	START TRANSACTION;
	SELECT COUNT(*) INTO v_count FROM `billing_execution_controls`
	WHERE `workspace_id`=p_workspace_id AND `mode`=p_mode FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit wallet control scope is unavailable'; END IF;
	SELECT COUNT(*) INTO v_count FROM `channelConnections`
	WHERE `workspaceId`=p_workspace_id AND `id`=p_channel_connection_id
		AND `channel`='facebook_messenger' AND `status`='connected'
		AND `bindingEpoch`=p_binding_epoch FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit wallet connection scope is stale'; END IF;
	SELECT COUNT(*) INTO v_count FROM `messenger_privacy_subjects`
	WHERE `workspace_id`=p_workspace_id AND `channel_connection_id`=p_channel_connection_id
		AND BINARY `user_key`=BINARY p_user_key AND `privacy_epoch`=p_privacy_epoch
		AND `status`='active' FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit wallet privacy scope is stale'; END IF;
	SET v_existing_wallet_id=NULL;
	SELECT MAX(`wallet_id`) INTO v_existing_wallet_id FROM `credit_wallets`
	WHERE (`wallet_id`=p_wallet_id OR (`workspace_id`=p_workspace_id AND `mode`=p_mode
		AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref)) FOR UPDATE;
	IF v_existing_wallet_id IS NOT NULL THEN
		SELECT COUNT(*) INTO v_count FROM `credit_wallets`
		WHERE BINARY `wallet_id`=BINARY p_wallet_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode
			AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
			AND `privacy_epoch`=p_privacy_epoch AND BINARY `current_user_key_hash`=BINARY p_user_key
			AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref
			AND `status` IN ('active','frozen') FOR UPDATE;
		IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit wallet replay conflicts with existing scope'; END IF;
		COMMIT;
		SELECT 'already_applied' AS `result`,p_wallet_id AS `wallet_id`;
		LEAVE credit_create_wallet_body;
	END IF;
	INSERT INTO `credit_wallets` (`wallet_id`,`workspace_id`,`mode`,`channel_connection_id`,`binding_epoch`,
		`privacy_epoch`,`current_user_key_hash`,`financial_subject_ref`,`status`,`credit_balance`,
		`reserved_credits`,`balance_version`,`last_ledger_entry_id`,`privacy_erased_at`)
	VALUES (p_wallet_id,p_workspace_id,p_mode,p_channel_connection_id,p_binding_epoch,p_privacy_epoch,
		p_user_key,p_financial_subject_ref,'active',0,0,1,NULL,NULL);
	COMMIT;
	SELECT 'applied' AS `result`,p_wallet_id AS `wallet_id`;
END;--> statement-breakpoint
CREATE PROCEDURE `credit_consume_checkout_capability`(
	IN p_workspace_id int, IN p_mode varchar(8), IN p_channel_connection_id int,
	IN p_binding_epoch int, IN p_privacy_epoch int, IN p_user_key varchar(96),
	IN p_wallet_id varchar(36), IN p_financial_subject_ref varchar(64),
	IN p_intent_id varchar(36), IN p_capability_hash varchar(64), IN p_session_nonce_hash varchar(64)
)
SQL SECURITY DEFINER
credit_consume_capability_body: BEGIN
	DECLARE v_count int DEFAULT 0;
	DECLARE v_control_enabled int;
	DECLARE v_control_epoch int;
	DECLARE v_intent_epoch int;
	DECLARE v_consumed_at timestamp;
	DECLARE v_expires_at timestamp;
	DECLARE v_stored_nonce varchar(64);
	DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN ROLLBACK; RESIGNAL; END;
	IF p_capability_hash IS NULL OR p_session_nonce_hash IS NULL
		OR NOT REGEXP_LIKE(p_capability_hash,'^[0-9a-f]{64}$','c')
		OR NOT REGEXP_LIKE(p_session_nonce_hash,'^[0-9a-f]{64}$','c') THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit checkout capability proof is malformed';
	END IF;
	START TRANSACTION;
	SET v_control_enabled=NULL; SET v_control_epoch=NULL;
	SELECT `commercial_enabled`,`authorization_epoch` INTO v_control_enabled,v_control_epoch
	FROM `billing_execution_controls`
	WHERE `workspace_id`=p_workspace_id AND `mode`=p_mode FOR UPDATE;
	IF v_control_enabled IS NULL OR v_control_epoch IS NULL OR v_control_enabled<>1 THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit checkout is disabled';
	END IF;
	SELECT COUNT(*) INTO v_count FROM `channelConnections`
	WHERE `workspaceId`=p_workspace_id AND `id`=p_channel_connection_id
		AND `channel`='facebook_messenger' AND `status`='connected'
		AND `bindingEpoch`=p_binding_epoch FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit checkout connection scope is stale'; END IF;
	SELECT COUNT(*) INTO v_count FROM `messenger_privacy_subjects`
	WHERE `workspace_id`=p_workspace_id AND `channel_connection_id`=p_channel_connection_id
		AND BINARY `user_key`=BINARY p_user_key AND `privacy_epoch`=p_privacy_epoch
		AND `status`='active' FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit checkout privacy scope is stale'; END IF;
	SELECT COUNT(*) INTO v_count FROM `credit_wallets`
	WHERE BINARY `wallet_id`=BINARY p_wallet_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
		AND `privacy_epoch`=p_privacy_epoch AND BINARY `current_user_key_hash`=BINARY p_user_key
		AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref AND `status`='active' FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit checkout wallet scope is stale'; END IF;
	SET v_consumed_at=NULL; SET v_stored_nonce=NULL; SET v_expires_at=NULL; SET v_intent_epoch=NULL;
	SELECT `authorization_epoch`,`checkout_capability_consumed_at`,`checkout_capability_session_nonce_hash`,
		`checkout_capability_expires_at` INTO v_intent_epoch,v_consumed_at,v_stored_nonce,v_expires_at
	FROM `billing_intents`
	WHERE BINARY `intent_id`=BINARY p_intent_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `kind`='credit_purchase' AND BINARY `credit_wallet_id`=BINARY p_wallet_id
		AND `messenger_channel_connection_id`=p_channel_connection_id
		AND `messenger_binding_epoch`=p_binding_epoch AND `messenger_privacy_epoch`=p_privacy_epoch
		AND BINARY `messenger_sender_user_key`=BINARY p_user_key
		AND BINARY `credit_financial_subject_ref`=BINARY p_financial_subject_ref
		AND BINARY `checkout_capability_hash`=BINARY p_capability_hash
		AND `credit_identity_erased_at` IS NULL FOR UPDATE;
	IF v_intent_epoch IS NULL OR v_intent_epoch<>v_control_epoch THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit checkout authorization epoch is stale';
	END IF;
	IF v_consumed_at IS NOT NULL THEN
		IF NOT (BINARY v_stored_nonce<=>BINARY p_session_nonce_hash) THEN
			SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit checkout capability was claimed by another browser session';
		END IF;
		IF CURRENT_TIMESTAMP>v_expires_at THEN
			SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit checkout capability is expired';
		END IF;
		COMMIT;
		SELECT 'already_applied' AS `result`,p_intent_id AS `intent_id`;
		LEAVE credit_consume_capability_body;
	END IF;
	SELECT COUNT(*) INTO v_count FROM `billing_intents`
	WHERE BINARY `intent_id`=BINARY p_intent_id AND `status`='created'
		AND `mollie_payment_id` IS NULL AND `url_exposed_at` IS NULL
		AND `checkout_capability_consumed_at` IS NULL
		AND CURRENT_TIMESTAMP<=v_expires_at FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit checkout capability is expired or no longer pristine'; END IF;
	UPDATE `billing_intents`
	SET `checkout_capability_consumed_at`=CURRENT_TIMESTAMP,
		`checkout_capability_session_nonce_hash`=p_session_nonce_hash
	WHERE BINARY `intent_id`=BINARY p_intent_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `checkout_capability_consumed_at` IS NULL;
	IF ROW_COUNT()<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit checkout capability claim lost its fence'; END IF;
	COMMIT;
	SELECT 'applied' AS `result`,p_intent_id AS `intent_id`;
END;--> statement-breakpoint
CREATE PROCEDURE `credit_grant_purchase`(
	IN p_workspace_id int, IN p_mode varchar(8), IN p_channel_connection_id int,
	IN p_binding_epoch int, IN p_privacy_epoch int, IN p_user_key varchar(96),
	IN p_wallet_id varchar(36), IN p_financial_subject_ref varchar(64),
	IN p_intent_id varchar(36), IN p_provider_payment_id varchar(64),
	IN p_entry_id varchar(36), IN p_evidence_hash varchar(64)
)
SQL SECURITY DEFINER
credit_grant_purchase_body: BEGIN
	DECLARE v_count int DEFAULT 0;
	DECLARE v_balance int; DECLARE v_reserved int; DECLARE v_version int;
	DECLARE v_previous varchar(36); DECLARE v_offer varchar(80); DECLARE v_amount decimal(10,2);
	DECLARE v_currency varchar(3); DECLARE v_credits int; DECLARE v_description varchar(255);
	DECLARE v_authorization_epoch int; DECLARE v_metadata_hash varchar(64); DECLARE v_payment_ledger_id int;
	DECLARE v_event_hash varchar(64); DECLARE v_existing_entry varchar(36);
	DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN ROLLBACK; RESIGNAL; END;
	IF NOT REGEXP_LIKE(p_entry_id,'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$','c')
		OR NOT REGEXP_LIKE(p_evidence_hash,'^[0-9a-f]{64}$','c') THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit grant evidence is malformed';
	END IF;
	SET v_event_hash=SHA2(CONCAT('credit-grant-v1',CHAR(10),p_mode,CHAR(10),p_intent_id,CHAR(10),p_provider_payment_id),256);
	SET v_existing_entry=NULL;
	SELECT MAX(`entry_id`) INTO v_existing_entry FROM `credit_ledger`
	WHERE `mode`=p_mode AND (`grant_payment_id`=p_provider_payment_id OR `event_key_hash`=v_event_hash);
	IF v_existing_entry IS NOT NULL THEN
		SELECT COUNT(*) INTO v_count
		FROM `credit_ledger` entry
		JOIN `billing_intents` intent
			ON intent.`workspace_id`=entry.`workspace_id` AND intent.`mode`=entry.`mode`
			AND BINARY intent.`intent_id`=BINARY entry.`source_intent_id`
		JOIN `payment_ledger` payment
			ON payment.`id`=entry.`payment_ledger_id` AND payment.`workspace_id`=entry.`workspace_id`
			AND payment.`mode`=entry.`mode` AND BINARY payment.`mollie_payment_id`=BINARY entry.`provider_payment_id`
		WHERE BINARY entry.`entry_id`=BINARY p_entry_id AND entry.`entry_kind`='purchase_grant'
			AND entry.`workspace_id`=p_workspace_id AND entry.`mode`=p_mode
			AND entry.`channel_connection_id`=p_channel_connection_id
			AND entry.`binding_epoch`=p_binding_epoch AND entry.`privacy_epoch`=p_privacy_epoch
			AND BINARY entry.`wallet_id`=BINARY p_wallet_id
			AND BINARY entry.`financial_subject_ref`=BINARY p_financial_subject_ref
			AND BINARY entry.`source_intent_id`=BINARY p_intent_id
			AND BINARY entry.`provider_payment_id`=BINARY p_provider_payment_id
			AND BINARY entry.`event_key_hash`=BINARY v_event_hash
			AND BINARY entry.`evidence_hash`=BINARY p_evidence_hash
			AND intent.`kind`='credit_purchase' AND BINARY intent.`credit_wallet_id`=BINARY p_wallet_id
			AND intent.`messenger_channel_connection_id`=p_channel_connection_id
			AND intent.`messenger_binding_epoch`=p_binding_epoch
			AND intent.`messenger_privacy_epoch`=p_privacy_epoch
			AND BINARY intent.`credit_financial_subject_ref`=BINARY p_financial_subject_ref
			AND BINARY intent.`mollie_payment_id`=BINARY p_provider_payment_id
			AND payment.`paid_effect_applied`=1 AND payment.`payment_effect_owner_kind`='credit_grant'
			AND BINARY payment.`payment_effect_owner_ref`=BINARY p_intent_id
			AND BINARY payment.`credit_wallet_id`=BINARY p_wallet_id;
		IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit grant replay conflicts with existing payment effect'; END IF;
		SELECT 'already_applied' AS `result`,p_entry_id AS `entry_id`;
		LEAVE credit_grant_purchase_body;
	END IF;
	START TRANSACTION;
	SELECT COUNT(*) INTO v_count FROM `billing_execution_controls`
	WHERE `workspace_id`=p_workspace_id AND `mode`=p_mode FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit grant control scope is unavailable'; END IF;
	SELECT COUNT(*) INTO v_count FROM `channelConnections`
	WHERE `workspaceId`=p_workspace_id AND `id`=p_channel_connection_id
		AND `channel`='facebook_messenger' AND `status`='connected'
		AND `bindingEpoch`=p_binding_epoch FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit grant connection scope is stale'; END IF;
	SELECT COUNT(*) INTO v_count FROM `messenger_privacy_subjects`
	WHERE `workspace_id`=p_workspace_id AND `channel_connection_id`=p_channel_connection_id
		AND BINARY `user_key`=BINARY p_user_key AND `privacy_epoch`=p_privacy_epoch
		AND `status`='active' FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit grant privacy scope is stale'; END IF;
	SELECT `credit_balance`,`reserved_credits`,`balance_version`,`last_ledger_entry_id`
	INTO v_balance,v_reserved,v_version,v_previous FROM `credit_wallets`
	WHERE BINARY `wallet_id`=BINARY p_wallet_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
		AND `privacy_epoch`=p_privacy_epoch AND BINARY `current_user_key_hash`=BINARY p_user_key
		AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref AND `status`='active' FOR UPDATE;
	SELECT `plan_code`,`expected_amount`,`currency`,`credit_count`,`mollie_description`,
		`authorization_epoch`,`credit_metadata_hash`
	INTO v_offer,v_amount,v_currency,v_credits,v_description,v_authorization_epoch,v_metadata_hash
	FROM `billing_intents`
	WHERE BINARY `intent_id`=BINARY p_intent_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `kind`='credit_purchase' AND `status`='paid' AND `url_exposed_at` IS NOT NULL
		AND `checkout_capability_consumed_at` IS NOT NULL
		AND REGEXP_LIKE(`checkout_capability_session_nonce_hash`,'^[0-9a-f]{64}$','c')
		AND `credit_identity_erased_at` IS NULL AND BINARY `credit_wallet_id`=BINARY p_wallet_id
		AND `messenger_channel_connection_id`=p_channel_connection_id
		AND `messenger_binding_epoch`=p_binding_epoch AND `messenger_privacy_epoch`=p_privacy_epoch
		AND BINARY `messenger_sender_user_key`=BINARY p_user_key
		AND BINARY `credit_financial_subject_ref`=BINARY p_financial_subject_ref
		AND BINARY `mollie_payment_id`=BINARY p_provider_payment_id FOR UPDATE;
	IF v_credits IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit grant intent evidence is unavailable'; END IF;
	SELECT COUNT(*) INTO v_count FROM `billing_provider_operations`
	WHERE `workspace_id`=p_workspace_id AND `mode`=p_mode AND BINARY `intent_id`=BINARY p_intent_id
		AND `operation_type`='create_payment' AND `state` IN ('succeeded','contained')
		AND `billing_profile_version`=0 AND `provider_customer_id` IS NULL
		AND BINARY `provider_resource_id`=BINARY p_provider_payment_id
		AND BINARY `request_fingerprint`=BINARY v_metadata_hash FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit grant provider operation is not exact'; END IF;
	SET v_payment_ledger_id=NULL;
	SELECT `id` INTO v_payment_ledger_id FROM `payment_ledger`
	WHERE `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND BINARY `mollie_payment_id`=BINARY p_provider_payment_id AND `status`='paid'
		AND `gross_amount`=v_amount AND BINARY `currency`=BINARY v_currency
		AND BINARY `observed_snapshot_hash`=BINARY p_evidence_hash FOR UPDATE;
	IF v_payment_ledger_id IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit grant paid snapshot is unavailable'; END IF;
	SET v_existing_entry=NULL;
	SELECT MAX(`entry_id`) INTO v_existing_entry FROM `credit_ledger`
	WHERE `mode`=p_mode AND (`grant_payment_id`=p_provider_payment_id OR `event_key_hash`=v_event_hash) FOR UPDATE;
	IF v_existing_entry IS NOT NULL THEN
		SELECT COUNT(*) INTO v_count FROM `credit_ledger` entry JOIN `payment_ledger` payment
			ON payment.`id`=entry.`payment_ledger_id` AND payment.`workspace_id`=entry.`workspace_id`
			AND payment.`mode`=entry.`mode` AND BINARY payment.`mollie_payment_id`=BINARY entry.`provider_payment_id`
		WHERE BINARY entry.`entry_id`=BINARY p_entry_id AND entry.`workspace_id`=p_workspace_id
			AND entry.`mode`=p_mode AND BINARY entry.`wallet_id`=BINARY p_wallet_id
			AND BINARY entry.`source_intent_id`=BINARY p_intent_id
			AND BINARY entry.`provider_payment_id`=BINARY p_provider_payment_id
			AND BINARY entry.`evidence_hash`=BINARY p_evidence_hash
			AND payment.`paid_effect_applied`=1 AND payment.`payment_effect_owner_kind`='credit_grant'
			AND BINARY payment.`payment_effect_owner_ref`=BINARY p_intent_id FOR UPDATE;
		IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit grant replay conflicts with existing payment effect'; END IF;
		COMMIT;
		SELECT 'already_applied' AS `result`,p_entry_id AS `entry_id`;
		LEAVE credit_grant_purchase_body;
	END IF;
	SELECT COUNT(*) INTO v_count FROM `payment_ledger`
	WHERE `id`=v_payment_ledger_id AND `paid_effect_applied`=0
		AND `payment_effect_owner_kind` IS NULL AND `payment_effect_owner_ref` IS NULL
		AND `credit_purpose` IS NULL AND `credit_intent_id` IS NULL
		AND `credit_wallet_id` IS NULL AND `credit_metadata_hash` IS NULL FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit payment effect is already owned'; END IF;
	INSERT INTO `credit_ledger` (`entry_id`,`wallet_id`,`workspace_id`,`mode`,`channel_connection_id`,
		`binding_epoch`,`privacy_epoch`,`financial_subject_ref`,`source_intent_id`,`authorization_epoch`,
		`payment_ledger_id`,`provider_payment_id`,`offer_id`,`payment_amount`,`currency`,
		`purchased_credit_count`,`provider_description`,`entry_kind`,`balance_delta`,`reserved_delta`,
		`event_key_hash`,`grant_payment_id`,`evidence_hash`,`previous_entry_id`,`wallet_version_before`,
		`wallet_version_after`,`balance_before`,`reserved_before`,`balance_after`,`reserved_after`,`occurred_at`)
	VALUES (p_entry_id,p_wallet_id,p_workspace_id,p_mode,p_channel_connection_id,p_binding_epoch,p_privacy_epoch,
		p_financial_subject_ref,p_intent_id,v_authorization_epoch,v_payment_ledger_id,p_provider_payment_id,
		v_offer,v_amount,v_currency,v_credits,v_description,'purchase_grant',v_credits,0,v_event_hash,
		p_provider_payment_id,p_evidence_hash,v_previous,v_version,v_version+1,v_balance,v_reserved,
		v_balance+v_credits,v_reserved,CURRENT_TIMESTAMP);
	UPDATE `payment_ledger` SET `paid_effect_applied`=1,`payment_effect_owner_kind`='credit_grant',
		`payment_effect_owner_ref`=p_intent_id,`payment_effect_claimed_at`=CURRENT_TIMESTAMP,
		`credit_purpose`='premium_image_credits',`credit_intent_id`=p_intent_id,
		`credit_wallet_id`=p_wallet_id,`credit_metadata_hash`=v_metadata_hash
	WHERE `id`=v_payment_ledger_id AND `paid_effect_applied`=0 AND `payment_effect_owner_kind` IS NULL;
	IF ROW_COUNT()<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit payment effect claim lost its fence'; END IF;
	COMMIT;
	SELECT 'applied' AS `result`,p_entry_id AS `entry_id`;
END;--> statement-breakpoint
CREATE PROCEDURE `credit_create_reservation_hold`(
	IN p_workspace_id int, IN p_mode varchar(8), IN p_channel_connection_id int,
	IN p_binding_epoch int, IN p_privacy_epoch int, IN p_user_key varchar(96),
	IN p_wallet_id varchar(36), IN p_financial_subject_ref varchar(64),
	IN p_reservation_id varchar(36), IN p_generation_request_key_hash varchar(64),
	IN p_owner_token_hash varchar(64), IN p_reserved_credit_count int,
	IN p_entry_id varchar(36), IN p_evidence_hash varchar(64)
)
SQL SECURITY DEFINER
credit_hold_body: BEGIN
	DECLARE v_count int DEFAULT 0; DECLARE v_balance int; DECLARE v_reserved int;
	DECLARE v_version int; DECLARE v_previous varchar(36); DECLARE v_existing varchar(36);
	DECLARE v_event_hash varchar(64); DECLARE v_now timestamp;
	DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN ROLLBACK; RESIGNAL; END;
	IF p_reserved_credit_count<=0 OR NOT REGEXP_LIKE(p_generation_request_key_hash,'^[0-9a-f]{64}$','c')
		OR NOT REGEXP_LIKE(p_owner_token_hash,'^[0-9a-f]{64}$','c')
		OR NOT REGEXP_LIKE(p_evidence_hash,'^[0-9a-f]{64}$','c') THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit reservation proof is malformed';
	END IF;
	SET v_event_hash=SHA2(CONCAT('credit-reservation-v1',CHAR(10),p_mode,CHAR(10),p_reservation_id,CHAR(10),'hold'),256);
	SET v_now=CURRENT_TIMESTAMP;
	START TRANSACTION;
	SELECT COUNT(*) INTO v_count FROM `billing_execution_controls`
	WHERE `workspace_id`=p_workspace_id AND `mode`=p_mode FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit reservation control scope is unavailable'; END IF;
	SELECT COUNT(*) INTO v_count FROM `channelConnections`
	WHERE `workspaceId`=p_workspace_id AND `id`=p_channel_connection_id
		AND `channel`='facebook_messenger' AND `status`='connected' AND `bindingEpoch`=p_binding_epoch FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit reservation connection scope is stale'; END IF;
	SELECT COUNT(*) INTO v_count FROM `messenger_privacy_subjects`
	WHERE `workspace_id`=p_workspace_id AND `channel_connection_id`=p_channel_connection_id
		AND BINARY `user_key`=BINARY p_user_key AND `privacy_epoch`=p_privacy_epoch AND `status`='active' FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit reservation privacy scope is stale'; END IF;
	SELECT `credit_balance`,`reserved_credits`,`balance_version`,`last_ledger_entry_id`
	INTO v_balance,v_reserved,v_version,v_previous FROM `credit_wallets`
	WHERE BINARY `wallet_id`=BINARY p_wallet_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
		AND `privacy_epoch`=p_privacy_epoch AND BINARY `current_user_key_hash`=BINARY p_user_key
		AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref AND `status`='active' FOR UPDATE;
	SET v_existing=NULL;
	SELECT MAX(`reservation_id`) INTO v_existing FROM `credit_reservations`
	WHERE (`reservation_id`=p_reservation_id OR (`workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
		AND `privacy_epoch`=p_privacy_epoch AND BINARY `wallet_id`=BINARY p_wallet_id
		AND BINARY `generation_request_key_hash`=BINARY p_generation_request_key_hash)) FOR UPDATE;
	IF v_existing IS NOT NULL THEN
		SELECT COUNT(*) INTO v_count FROM `credit_reservations` reservation
		JOIN `credit_ledger` entry ON BINARY entry.`entry_id`=BINARY reservation.`hold_ledger_entry_id`
		WHERE BINARY reservation.`reservation_id`=BINARY p_reservation_id
			AND BINARY reservation.`wallet_id`=BINARY p_wallet_id
			AND reservation.`workspace_id`=p_workspace_id AND reservation.`mode`=p_mode
			AND reservation.`channel_connection_id`=p_channel_connection_id
			AND reservation.`binding_epoch`=p_binding_epoch AND reservation.`privacy_epoch`=p_privacy_epoch
			AND BINARY reservation.`financial_subject_ref`=BINARY p_financial_subject_ref
			AND BINARY reservation.`generation_request_key_hash`=BINARY p_generation_request_key_hash
			AND BINARY reservation.`owner_token_hash`=BINARY p_owner_token_hash
			AND reservation.`reserved_credit_count`=p_reserved_credit_count
			AND reservation.`status` IN ('reserved','committed','released','expired')
			AND BINARY entry.`entry_id`=BINARY p_entry_id
			AND BINARY entry.`event_key_hash`=BINARY v_event_hash
			AND BINARY entry.`evidence_hash`=BINARY p_evidence_hash FOR UPDATE;
		IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit reservation replay conflicts with existing hold'; END IF;
		COMMIT; SELECT 'already_applied' AS `result`,p_reservation_id AS `reservation_id`;
		LEAVE credit_hold_body;
	END IF;
	IF v_balance-v_reserved<p_reserved_credit_count THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='purchased credit balance is exhausted'; END IF;
	INSERT INTO `credit_reservations` (`reservation_id`,`wallet_id`,`workspace_id`,`mode`,`channel_connection_id`,
		`binding_epoch`,`privacy_epoch`,`financial_subject_ref`,`reserved_credit_count`,
		`generation_request_key_hash`,`owner_token_hash`,`status`,`state_version`,`owner_lease_until`,
		`expires_at`,`resolution_due_at`,`created_at`)
	VALUES (p_reservation_id,p_wallet_id,p_workspace_id,p_mode,p_channel_connection_id,p_binding_epoch,
		p_privacy_epoch,p_financial_subject_ref,p_reserved_credit_count,p_generation_request_key_hash,
		p_owner_token_hash,'initializing',1,TIMESTAMPADD(MINUTE,2,v_now),TIMESTAMPADD(MINUTE,15,v_now),
		TIMESTAMPADD(DAY,1,v_now),v_now);
	INSERT INTO `credit_ledger` (`entry_id`,`wallet_id`,`workspace_id`,`mode`,`channel_connection_id`,
		`binding_epoch`,`privacy_epoch`,`financial_subject_ref`,`entry_kind`,`balance_delta`,`reserved_delta`,
		`event_key_hash`,`reservation_id`,`reservation_credit_count`,`evidence_hash`,`previous_entry_id`,
		`wallet_version_before`,`wallet_version_after`,`balance_before`,`reserved_before`,`balance_after`,
		`reserved_after`,`occurred_at`)
	VALUES (p_entry_id,p_wallet_id,p_workspace_id,p_mode,p_channel_connection_id,p_binding_epoch,p_privacy_epoch,
		p_financial_subject_ref,'reservation_hold',0,p_reserved_credit_count,v_event_hash,p_reservation_id,
		p_reserved_credit_count,p_evidence_hash,v_previous,v_version,v_version+1,v_balance,v_reserved,
		v_balance,v_reserved+p_reserved_credit_count,v_now);
	COMMIT; SELECT 'applied' AS `result`,p_reservation_id AS `reservation_id`;
END;--> statement-breakpoint
CREATE PROCEDURE `credit_mark_reservation_transport_started`(
	IN p_workspace_id int, IN p_mode varchar(8), IN p_channel_connection_id int,
	IN p_binding_epoch int, IN p_privacy_epoch int, IN p_user_key varchar(96),
	IN p_wallet_id varchar(36), IN p_financial_subject_ref varchar(64),
	IN p_reservation_id varchar(36), IN p_owner_token_hash varchar(64)
)
SQL SECURITY DEFINER
credit_transport_started_body: BEGIN
	DECLARE v_count int DEFAULT 0; DECLARE v_status varchar(16); DECLARE v_transport varchar(24);
	DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN ROLLBACK; RESIGNAL; END;
	IF NOT REGEXP_LIKE(p_owner_token_hash,'^[0-9a-f]{64}$','c') THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit transport proof is malformed';
	END IF;
	START TRANSACTION;
	SELECT COUNT(*) INTO v_count FROM `billing_execution_controls`
	WHERE `workspace_id`=p_workspace_id AND `mode`=p_mode FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit transport control scope is unavailable'; END IF;
	SELECT COUNT(*) INTO v_count FROM `channelConnections`
	WHERE `workspaceId`=p_workspace_id AND `id`=p_channel_connection_id
		AND `channel`='facebook_messenger' AND `status`='connected' AND `bindingEpoch`=p_binding_epoch FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit transport connection scope is stale'; END IF;
	SELECT COUNT(*) INTO v_count FROM `messenger_privacy_subjects`
	WHERE `workspace_id`=p_workspace_id AND `channel_connection_id`=p_channel_connection_id
		AND BINARY `user_key`=BINARY p_user_key AND `privacy_epoch`=p_privacy_epoch AND `status`='active' FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit transport privacy scope is stale'; END IF;
	SELECT COUNT(*) INTO v_count FROM `credit_wallets`
	WHERE BINARY `wallet_id`=BINARY p_wallet_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
		AND `privacy_epoch`=p_privacy_epoch AND BINARY `current_user_key_hash`=BINARY p_user_key
		AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref AND `status`='active' FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit transport wallet scope is stale'; END IF;
	SET v_status=NULL; SET v_transport=NULL;
	SELECT `status`,`transport_state` INTO v_status,v_transport FROM `credit_reservations`
	WHERE BINARY `reservation_id`=BINARY p_reservation_id AND BINARY `wallet_id`=BINARY p_wallet_id
		AND `workspace_id`=p_workspace_id AND `mode`=p_mode AND `channel_connection_id`=p_channel_connection_id
		AND `binding_epoch`=p_binding_epoch AND `privacy_epoch`=p_privacy_epoch
		AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref
		AND BINARY `owner_token_hash`=BINARY p_owner_token_hash FOR UPDATE;
	IF v_status='reserved' AND v_transport IN ('transport_started','known_accepted') THEN
		COMMIT; SELECT 'already_applied' AS `result`,p_reservation_id AS `reservation_id`; LEAVE credit_transport_started_body;
	END IF;
	IF v_status<>'reserved' OR v_transport<>'pretransport' THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit transport requires one owned pretransport hold';
	END IF;
	UPDATE `credit_reservations` SET `transport_state`='transport_started',`transport_started_at`=CURRENT_TIMESTAMP
	WHERE BINARY `reservation_id`=BINARY p_reservation_id AND `status`='reserved' AND `transport_state`='pretransport';
	IF ROW_COUNT()<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit transport fence was lost'; END IF;
	COMMIT; SELECT 'applied' AS `result`,p_reservation_id AS `reservation_id`;
END;--> statement-breakpoint
CREATE PROCEDURE `credit_mark_reservation_provider_accepted`(
	IN p_workspace_id int, IN p_mode varchar(8), IN p_channel_connection_id int,
	IN p_binding_epoch int, IN p_privacy_epoch int, IN p_user_key varchar(96),
	IN p_wallet_id varchar(36), IN p_financial_subject_ref varchar(64),
	IN p_reservation_id varchar(36), IN p_owner_token_hash varchar(64)
)
SQL SECURITY DEFINER
credit_provider_accepted_body: BEGIN
	DECLARE v_count int DEFAULT 0; DECLARE v_status varchar(16); DECLARE v_transport varchar(24);
	DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN ROLLBACK; RESIGNAL; END;
	IF NOT REGEXP_LIKE(p_owner_token_hash,'^[0-9a-f]{64}$','c') THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit provider acceptance proof is malformed';
	END IF;
	START TRANSACTION;
	SELECT COUNT(*) INTO v_count FROM `billing_execution_controls`
	WHERE `workspace_id`=p_workspace_id AND `mode`=p_mode FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit provider acceptance control scope is unavailable'; END IF;
	SELECT COUNT(*) INTO v_count FROM `channelConnections`
	WHERE `workspaceId`=p_workspace_id AND `id`=p_channel_connection_id
		AND `channel`='facebook_messenger' FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit provider acceptance connection scope is stale'; END IF;
	SELECT COUNT(*) INTO v_count FROM `messenger_privacy_subjects`
	WHERE `workspace_id`=p_workspace_id AND `channel_connection_id`=p_channel_connection_id
		AND BINARY `user_key`=BINARY p_user_key
		AND ((`privacy_epoch`=p_privacy_epoch AND `status`='active')
			OR (`privacy_epoch`=p_privacy_epoch+1 AND `status` IN ('erasing','erased'))) FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit provider acceptance privacy scope is stale'; END IF;
	SELECT COUNT(*) INTO v_count FROM `credit_wallets`
	WHERE BINARY `wallet_id`=BINARY p_wallet_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
		AND `privacy_epoch`=p_privacy_epoch AND BINARY `current_user_key_hash`=BINARY p_user_key
		AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref
		AND `status` IN ('active','frozen') FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit provider acceptance wallet scope is stale'; END IF;
	SET v_status=NULL; SET v_transport=NULL;
	SELECT `status`,`transport_state` INTO v_status,v_transport FROM `credit_reservations`
	WHERE BINARY `reservation_id`=BINARY p_reservation_id AND BINARY `wallet_id`=BINARY p_wallet_id
		AND `workspace_id`=p_workspace_id AND `mode`=p_mode AND `channel_connection_id`=p_channel_connection_id
		AND `binding_epoch`=p_binding_epoch AND `privacy_epoch`=p_privacy_epoch
		AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref
		AND BINARY `owner_token_hash`=BINARY p_owner_token_hash FOR UPDATE;
	IF v_status IN ('reserved','committed') AND v_transport='known_accepted' THEN
		COMMIT; SELECT 'already_applied' AS `result`,p_reservation_id AS `reservation_id`; LEAVE credit_provider_accepted_body;
	END IF;
	IF v_status<>'reserved' OR v_transport<>'transport_started' THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit provider acceptance requires one started hold';
	END IF;
	UPDATE `credit_reservations` SET `transport_state`='known_accepted',`provider_accepted_at`=CURRENT_TIMESTAMP
	WHERE BINARY `reservation_id`=BINARY p_reservation_id AND `status`='reserved' AND `transport_state`='transport_started';
	IF ROW_COUNT()<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit provider acceptance fence was lost'; END IF;
	COMMIT; SELECT 'applied' AS `result`,p_reservation_id AS `reservation_id`;
END;--> statement-breakpoint
CREATE PROCEDURE `credit_commit_reservation`(
	IN p_workspace_id int, IN p_mode varchar(8), IN p_channel_connection_id int,
	IN p_binding_epoch int, IN p_privacy_epoch int, IN p_user_key varchar(96),
	IN p_wallet_id varchar(36), IN p_financial_subject_ref varchar(64),
	IN p_reservation_id varchar(36), IN p_owner_token_hash varchar(64),
	IN p_entry_id varchar(36), IN p_evidence_hash varchar(64)
)
SQL SECURITY DEFINER
credit_commit_body: BEGIN
	DECLARE v_count int DEFAULT 0; DECLARE v_balance int; DECLARE v_reserved int;
	DECLARE v_version int; DECLARE v_previous varchar(36); DECLARE v_units int;
	DECLARE v_event_hash varchar(64); DECLARE v_terminal_entry varchar(36);
	DECLARE v_terminal_evidence varchar(64); DECLARE v_status varchar(16);
	DECLARE v_owner varchar(64); DECLARE v_transport varchar(24);
	DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN ROLLBACK; RESIGNAL; END;
	IF p_owner_token_hash IS NULL OR p_evidence_hash IS NULL OR p_entry_id IS NULL
		OR NOT REGEXP_LIKE(p_owner_token_hash,'^[0-9a-f]{64}$','c')
		OR NOT REGEXP_LIKE(p_evidence_hash,'^[0-9a-f]{64}$','c')
		OR NOT REGEXP_LIKE(p_entry_id,'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$','c') THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit commit proof is malformed';
	END IF;
	SET v_event_hash=SHA2(CONCAT('credit-reservation-v1',CHAR(10),p_mode,CHAR(10),p_reservation_id,CHAR(10),'commit'),256);
	START TRANSACTION;
	SELECT COUNT(*) INTO v_count FROM `billing_execution_controls`
	WHERE `workspace_id`=p_workspace_id AND `mode`=p_mode FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit commit control scope is unavailable'; END IF;
	SELECT COUNT(*) INTO v_count FROM `channelConnections`
	WHERE `workspaceId`=p_workspace_id AND `id`=p_channel_connection_id
		AND `channel`='facebook_messenger' FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit commit connection scope is stale'; END IF;
	SELECT COUNT(*) INTO v_count FROM `messenger_privacy_subjects`
	WHERE `workspace_id`=p_workspace_id AND `channel_connection_id`=p_channel_connection_id
		AND BINARY `user_key`=BINARY p_user_key
		AND ((`privacy_epoch`=p_privacy_epoch AND `status`='active')
			OR (`privacy_epoch`=p_privacy_epoch+1 AND `status` IN ('erasing','erased'))) FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit commit privacy scope is stale'; END IF;
	SET v_version=NULL;
	SELECT `credit_balance`,`reserved_credits`,`balance_version`,`last_ledger_entry_id`
	INTO v_balance,v_reserved,v_version,v_previous FROM `credit_wallets`
	WHERE BINARY `wallet_id`=BINARY p_wallet_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
		AND `privacy_epoch`=p_privacy_epoch
		AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref
		AND `status` IN ('active','frozen','erased') FOR UPDATE;
	IF v_version IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit commit wallet scope is stale'; END IF;
	SET v_status=NULL; SET v_terminal_entry=NULL; SET v_terminal_evidence=NULL;
	SELECT `status`,`transport_state`,`reserved_credit_count`,`owner_token_hash`,`terminal_ledger_entry_id`,`terminal_evidence_hash`
	INTO v_status,v_transport,v_units,v_owner,v_terminal_entry,v_terminal_evidence FROM `credit_reservations`
	WHERE BINARY `reservation_id`=BINARY p_reservation_id AND BINARY `wallet_id`=BINARY p_wallet_id
		AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
		AND `privacy_epoch`=p_privacy_epoch AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref FOR UPDATE;
	IF v_status='committed' THEN
		SELECT COUNT(*) INTO v_count FROM `credit_ledger`
		WHERE BINARY `entry_id`=BINARY p_entry_id AND BINARY `wallet_id`=BINARY p_wallet_id
			AND `workspace_id`=p_workspace_id AND `mode`=p_mode
			AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
			AND `privacy_epoch`=p_privacy_epoch
			AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref
			AND BINARY `reservation_id`=BINARY p_reservation_id
			AND `entry_kind`='generation_spend' AND `reservation_terminal_status`='committed'
			AND BINARY `event_key_hash`=BINARY v_event_hash
			AND BINARY `evidence_hash`=BINARY p_evidence_hash FOR UPDATE;
		IF v_count<>1 OR NOT ((BINARY v_terminal_entry<=>BINARY p_entry_id)
			AND (BINARY v_terminal_evidence<=>BINARY p_evidence_hash)
			AND (v_owner IS NULL OR BINARY v_owner=BINARY p_owner_token_hash)) THEN
			SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit commit replay conflicts with terminal evidence';
		END IF;
		COMMIT; SELECT 'already_applied' AS `result`,p_reservation_id AS `reservation_id`; LEAVE credit_commit_body;
	END IF;
	SELECT COUNT(*) INTO v_count FROM `credit_wallets`
	WHERE BINARY `wallet_id`=BINARY p_wallet_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
		AND `privacy_epoch`=p_privacy_epoch AND BINARY `current_user_key_hash`=BINARY p_user_key
		AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref
		AND `status` IN ('active','frozen') FOR UPDATE;
	IF v_count<>1 OR v_status<>'reserved' OR v_transport<>'known_accepted' OR v_reserved<v_units THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit commit requires one current held reservation';
	END IF;
	IF NOT (BINARY p_owner_token_hash<=>BINARY v_owner) THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit commit owner token is stale';
	END IF;
	INSERT INTO `credit_ledger` (`entry_id`,`wallet_id`,`workspace_id`,`mode`,`channel_connection_id`,
		`binding_epoch`,`privacy_epoch`,`financial_subject_ref`,`entry_kind`,`balance_delta`,`reserved_delta`,
		`event_key_hash`,`reservation_id`,`reservation_credit_count`,`reservation_terminal_slot`,
		`reservation_terminal_status`,`evidence_hash`,`previous_entry_id`,`wallet_version_before`,
		`wallet_version_after`,`balance_before`,`reserved_before`,`balance_after`,`reserved_after`,`occurred_at`)
	VALUES (p_entry_id,p_wallet_id,p_workspace_id,p_mode,p_channel_connection_id,p_binding_epoch,p_privacy_epoch,
		p_financial_subject_ref,'generation_spend',-v_units,-v_units,v_event_hash,p_reservation_id,v_units,1,
		'committed',p_evidence_hash,v_previous,v_version,v_version+1,v_balance,v_reserved,
		v_balance-v_units,v_reserved-v_units,CURRENT_TIMESTAMP);
	COMMIT; SELECT 'applied' AS `result`,p_reservation_id AS `reservation_id`;
END;--> statement-breakpoint
CREATE PROCEDURE `credit_release_reservation`(
	IN p_workspace_id int, IN p_mode varchar(8), IN p_channel_connection_id int,
	IN p_binding_epoch int, IN p_privacy_epoch int, IN p_user_key varchar(96),
	IN p_wallet_id varchar(36), IN p_financial_subject_ref varchar(64),
	IN p_reservation_id varchar(36), IN p_owner_token_hash varchar(64),
	IN p_entry_id varchar(36), IN p_evidence_hash varchar(64)
)
SQL SECURITY DEFINER
credit_release_body: BEGIN
	DECLARE v_count int DEFAULT 0; DECLARE v_balance int; DECLARE v_reserved int;
	DECLARE v_version int; DECLARE v_previous varchar(36); DECLARE v_units int;
	DECLARE v_event_hash varchar(64); DECLARE v_terminal_entry varchar(36);
	DECLARE v_terminal_evidence varchar(64); DECLARE v_status varchar(16); DECLARE v_owner varchar(64);
	DECLARE v_transport varchar(24);
	DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN ROLLBACK; RESIGNAL; END;
	IF p_owner_token_hash IS NULL OR p_evidence_hash IS NULL OR p_entry_id IS NULL
		OR NOT REGEXP_LIKE(p_owner_token_hash,'^[0-9a-f]{64}$','c')
		OR NOT REGEXP_LIKE(p_evidence_hash,'^[0-9a-f]{64}$','c')
		OR NOT REGEXP_LIKE(p_entry_id,'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$','c') THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit release proof is malformed';
	END IF;
	SET v_event_hash=SHA2(CONCAT('credit-reservation-v1',CHAR(10),p_mode,CHAR(10),p_reservation_id,CHAR(10),'release'),256);
	START TRANSACTION;
	SELECT COUNT(*) INTO v_count FROM `billing_execution_controls`
	WHERE `workspace_id`=p_workspace_id AND `mode`=p_mode FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit release control scope is unavailable'; END IF;
	SELECT COUNT(*) INTO v_count FROM `channelConnections`
	WHERE `workspaceId`=p_workspace_id AND `id`=p_channel_connection_id
		AND `channel`='facebook_messenger' FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit release connection scope is unavailable'; END IF;
	SELECT COUNT(*) INTO v_count FROM `messenger_privacy_subjects`
	WHERE `workspace_id`=p_workspace_id AND `channel_connection_id`=p_channel_connection_id
		AND BINARY `user_key`=BINARY p_user_key
		AND ((`privacy_epoch`=p_privacy_epoch AND `status`='active')
			OR (`privacy_epoch`=p_privacy_epoch+1 AND `status` IN ('erasing','erased'))) FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit release privacy scope is stale'; END IF;
	SET v_version=NULL;
	SELECT `credit_balance`,`reserved_credits`,`balance_version`,`last_ledger_entry_id`
	INTO v_balance,v_reserved,v_version,v_previous FROM `credit_wallets`
	WHERE BINARY `wallet_id`=BINARY p_wallet_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
		AND `privacy_epoch`=p_privacy_epoch
		AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref
		AND `status` IN ('active','frozen','erased') FOR UPDATE;
	IF v_version IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit release wallet scope is stale'; END IF;
	SET v_status=NULL;
	SELECT `status`,`transport_state`,`reserved_credit_count`,`owner_token_hash`,`terminal_ledger_entry_id`,`terminal_evidence_hash`
	INTO v_status,v_transport,v_units,v_owner,v_terminal_entry,v_terminal_evidence FROM `credit_reservations`
	WHERE BINARY `reservation_id`=BINARY p_reservation_id AND BINARY `wallet_id`=BINARY p_wallet_id
		AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
		AND `privacy_epoch`=p_privacy_epoch AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref FOR UPDATE;
	IF v_status='released' THEN
		SELECT COUNT(*) INTO v_count FROM `credit_ledger`
		WHERE BINARY `entry_id`=BINARY p_entry_id AND BINARY `wallet_id`=BINARY p_wallet_id
			AND `workspace_id`=p_workspace_id AND `mode`=p_mode
			AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
			AND `privacy_epoch`=p_privacy_epoch
			AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref
			AND BINARY `reservation_id`=BINARY p_reservation_id
			AND `entry_kind`='reservation_release' AND `reservation_terminal_status`='released'
			AND BINARY `event_key_hash`=BINARY v_event_hash
			AND BINARY `evidence_hash`=BINARY p_evidence_hash FOR UPDATE;
		IF v_count<>1 OR NOT ((BINARY v_terminal_entry<=>BINARY p_entry_id)
			AND (BINARY v_terminal_evidence<=>BINARY p_evidence_hash)
			AND (v_owner IS NULL OR BINARY v_owner=BINARY p_owner_token_hash)) THEN
			SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit release replay conflicts with terminal evidence';
		END IF;
		COMMIT; SELECT 'already_applied' AS `result`,p_reservation_id AS `reservation_id`; LEAVE credit_release_body;
	END IF;
	SELECT COUNT(*) INTO v_count FROM `credit_wallets`
	WHERE BINARY `wallet_id`=BINARY p_wallet_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
		AND `privacy_epoch`=p_privacy_epoch AND BINARY `current_user_key_hash`=BINARY p_user_key
		AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref
		AND `status` IN ('active','frozen') FOR UPDATE;
	IF v_count<>1 OR v_status<>'reserved' OR v_transport<>'pretransport'
		OR NOT (BINARY v_owner<=>BINARY p_owner_token_hash) OR v_reserved<v_units THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit release requires one owned held reservation';
	END IF;
	INSERT INTO `credit_ledger` (`entry_id`,`wallet_id`,`workspace_id`,`mode`,`channel_connection_id`,
		`binding_epoch`,`privacy_epoch`,`financial_subject_ref`,`entry_kind`,`balance_delta`,`reserved_delta`,
		`event_key_hash`,`reservation_id`,`reservation_credit_count`,`reservation_terminal_slot`,
		`reservation_terminal_status`,`evidence_hash`,`previous_entry_id`,`wallet_version_before`,
		`wallet_version_after`,`balance_before`,`reserved_before`,`balance_after`,`reserved_after`,`occurred_at`)
	VALUES (p_entry_id,p_wallet_id,p_workspace_id,p_mode,p_channel_connection_id,p_binding_epoch,p_privacy_epoch,
		p_financial_subject_ref,'reservation_release',0,-v_units,v_event_hash,p_reservation_id,v_units,1,
		'released',p_evidence_hash,v_previous,v_version,v_version+1,v_balance,v_reserved,
		v_balance,v_reserved-v_units,CURRENT_TIMESTAMP);
	COMMIT; SELECT 'applied' AS `result`,p_reservation_id AS `reservation_id`;
END;--> statement-breakpoint
CREATE PROCEDURE `credit_release_rejected_reservation`(
	IN p_workspace_id int, IN p_mode varchar(8), IN p_channel_connection_id int,
	IN p_binding_epoch int, IN p_privacy_epoch int, IN p_user_key varchar(96),
	IN p_wallet_id varchar(36), IN p_financial_subject_ref varchar(64),
	IN p_reservation_id varchar(36), IN p_owner_token_hash varchar(64),
	IN p_rejection_status int, IN p_entry_id varchar(36), IN p_evidence_hash varchar(64)
)
SQL SECURITY DEFINER
credit_release_rejected_body: BEGIN
	DECLARE v_count int DEFAULT 0; DECLARE v_balance int; DECLARE v_reserved int;
	DECLARE v_version int; DECLARE v_previous varchar(36); DECLARE v_units int;
	DECLARE v_event_hash varchar(64); DECLARE v_terminal_entry varchar(36);
	DECLARE v_terminal_evidence varchar(64); DECLARE v_status varchar(16); DECLARE v_owner varchar(64);
	DECLARE v_transport varchar(24); DECLARE v_rejection_status int;
	DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN ROLLBACK; RESIGNAL; END;
	IF p_owner_token_hash IS NULL OR p_evidence_hash IS NULL OR p_entry_id IS NULL
		OR NOT REGEXP_LIKE(p_owner_token_hash,'^[0-9a-f]{64}$','c')
		OR NOT REGEXP_LIKE(p_evidence_hash,'^[0-9a-f]{64}$','c')
		OR NOT REGEXP_LIKE(p_entry_id,'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$','c')
		OR p_rejection_status NOT BETWEEN 400 AND 499 OR p_rejection_status IN (408,429) THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit rejected release proof is malformed';
	END IF;
	SET v_event_hash=SHA2(CONCAT('credit-reservation-v1',CHAR(10),p_mode,CHAR(10),p_reservation_id,CHAR(10),'provider_rejected:',p_rejection_status),256);
	START TRANSACTION;
	SELECT COUNT(*) INTO v_count FROM `billing_execution_controls`
	WHERE `workspace_id`=p_workspace_id AND `mode`=p_mode FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit rejected release control scope is unavailable'; END IF;
	SELECT COUNT(*) INTO v_count FROM `channelConnections`
	WHERE `workspaceId`=p_workspace_id AND `id`=p_channel_connection_id
		AND `channel`='facebook_messenger' FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit rejected release connection scope is unavailable'; END IF;
	SELECT COUNT(*) INTO v_count FROM `messenger_privacy_subjects`
	WHERE `workspace_id`=p_workspace_id AND `channel_connection_id`=p_channel_connection_id
		AND BINARY `user_key`=BINARY p_user_key
		AND ((`privacy_epoch`=p_privacy_epoch AND `status`='active')
			OR (`privacy_epoch`=p_privacy_epoch+1 AND `status` IN ('erasing','erased'))) FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit rejected release privacy scope is stale'; END IF;
	SET v_version=NULL;
	SELECT `credit_balance`,`reserved_credits`,`balance_version`,`last_ledger_entry_id`
	INTO v_balance,v_reserved,v_version,v_previous FROM `credit_wallets`
	WHERE BINARY `wallet_id`=BINARY p_wallet_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
		AND `privacy_epoch`=p_privacy_epoch
		AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref
		AND `status` IN ('active','frozen','erased') FOR UPDATE;
	IF v_version IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit rejected release wallet scope is stale'; END IF;
	SET v_status=NULL;
	SELECT `status`,`transport_state`,`reserved_credit_count`,`owner_token_hash`,`terminal_ledger_entry_id`,`terminal_evidence_hash`,`provider_rejected_status`
	INTO v_status,v_transport,v_units,v_owner,v_terminal_entry,v_terminal_evidence,v_rejection_status FROM `credit_reservations`
	WHERE BINARY `reservation_id`=BINARY p_reservation_id AND BINARY `wallet_id`=BINARY p_wallet_id
		AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
		AND `privacy_epoch`=p_privacy_epoch AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref FOR UPDATE;
	IF v_status='released' AND v_transport='known_rejected' THEN
		SELECT COUNT(*) INTO v_count FROM `credit_ledger`
		WHERE BINARY `entry_id`=BINARY p_entry_id AND BINARY `wallet_id`=BINARY p_wallet_id
			AND `workspace_id`=p_workspace_id AND `mode`=p_mode
			AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
			AND `privacy_epoch`=p_privacy_epoch
			AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref
			AND BINARY `reservation_id`=BINARY p_reservation_id
			AND `entry_kind`='reservation_release' AND `reservation_terminal_status`='released'
			AND BINARY `event_key_hash`=BINARY v_event_hash
			AND BINARY `evidence_hash`=BINARY p_evidence_hash FOR UPDATE;
		IF v_count<>1 OR v_rejection_status<>p_rejection_status
			OR NOT ((BINARY v_terminal_entry<=>BINARY p_entry_id)
				AND (BINARY v_terminal_evidence<=>BINARY p_evidence_hash)
				AND (v_owner IS NULL OR BINARY v_owner=BINARY p_owner_token_hash)) THEN
			SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit rejected release replay conflicts with terminal evidence';
		END IF;
		COMMIT; SELECT 'already_applied' AS `result`,p_reservation_id AS `reservation_id`; LEAVE credit_release_rejected_body;
	END IF;
	SELECT COUNT(*) INTO v_count FROM `credit_wallets`
	WHERE BINARY `wallet_id`=BINARY p_wallet_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
		AND `privacy_epoch`=p_privacy_epoch AND BINARY `current_user_key_hash`=BINARY p_user_key
		AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref
		AND `status` IN ('active','frozen') FOR UPDATE;
	IF v_count<>1 OR v_status<>'reserved' OR v_transport<>'transport_started'
		OR NOT (BINARY v_owner<=>BINARY p_owner_token_hash) OR v_reserved<v_units THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit rejected release requires one owned started hold';
	END IF;
	UPDATE `credit_reservations`
	SET `transport_state`='known_rejected',`provider_rejected_at`=CURRENT_TIMESTAMP,`provider_rejected_status`=p_rejection_status
	WHERE BINARY `reservation_id`=BINARY p_reservation_id AND `status`='reserved' AND `state_version`=2
		AND `transport_state`='transport_started' AND `provider_rejected_at` IS NULL AND `provider_rejected_status` IS NULL;
	IF ROW_COUNT()<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit rejected release transport projector failed'; END IF;
	INSERT INTO `credit_ledger` (`entry_id`,`wallet_id`,`workspace_id`,`mode`,`channel_connection_id`,
		`binding_epoch`,`privacy_epoch`,`financial_subject_ref`,`entry_kind`,`balance_delta`,`reserved_delta`,
		`event_key_hash`,`reservation_id`,`reservation_credit_count`,`reservation_terminal_slot`,
		`reservation_terminal_status`,`evidence_hash`,`previous_entry_id`,`wallet_version_before`,
		`wallet_version_after`,`balance_before`,`reserved_before`,`balance_after`,`reserved_after`,`occurred_at`)
	VALUES (p_entry_id,p_wallet_id,p_workspace_id,p_mode,p_channel_connection_id,p_binding_epoch,p_privacy_epoch,
		p_financial_subject_ref,'reservation_release',0,-v_units,v_event_hash,p_reservation_id,v_units,1,
		'released',p_evidence_hash,v_previous,v_version,v_version+1,v_balance,v_reserved,
		v_balance,v_reserved-v_units,CURRENT_TIMESTAMP);
	COMMIT; SELECT 'applied' AS `result`,p_reservation_id AS `reservation_id`;
END;--> statement-breakpoint
CREATE PROCEDURE `credit_expire_reservation`(
	IN p_workspace_id int, IN p_mode varchar(8), IN p_channel_connection_id int,
	IN p_binding_epoch int, IN p_privacy_epoch int, IN p_user_key varchar(96),
	IN p_wallet_id varchar(36), IN p_financial_subject_ref varchar(64),
	IN p_reservation_id varchar(36), IN p_owner_token_hash varchar(64),
	IN p_entry_id varchar(36), IN p_evidence_hash varchar(64)
)
SQL SECURITY DEFINER
credit_expire_body: BEGIN
	DECLARE v_count int DEFAULT 0; DECLARE v_balance int; DECLARE v_reserved int;
	DECLARE v_version int; DECLARE v_previous varchar(36); DECLARE v_units int;
	DECLARE v_event_hash varchar(64); DECLARE v_terminal_entry varchar(36);
	DECLARE v_terminal_evidence varchar(64); DECLARE v_status varchar(16); DECLARE v_owner varchar(64);
	DECLARE v_transport varchar(24);
	DECLARE v_expires_at timestamp;
	DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN ROLLBACK; RESIGNAL; END;
	IF p_owner_token_hash IS NULL OR p_evidence_hash IS NULL OR p_entry_id IS NULL
		OR NOT REGEXP_LIKE(p_owner_token_hash,'^[0-9a-f]{64}$','c')
		OR NOT REGEXP_LIKE(p_evidence_hash,'^[0-9a-f]{64}$','c')
		OR NOT REGEXP_LIKE(p_entry_id,'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$','c') THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit expiry proof is malformed';
	END IF;
	SET v_event_hash=SHA2(CONCAT('credit-reservation-v1',CHAR(10),p_mode,CHAR(10),p_reservation_id,CHAR(10),'expire'),256);
	START TRANSACTION;
	SELECT COUNT(*) INTO v_count FROM `billing_execution_controls`
	WHERE `workspace_id`=p_workspace_id AND `mode`=p_mode FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit expiry control scope is unavailable'; END IF;
	SELECT COUNT(*) INTO v_count FROM `channelConnections`
	WHERE `workspaceId`=p_workspace_id AND `id`=p_channel_connection_id
		AND `channel`='facebook_messenger' FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit expiry connection scope is unavailable'; END IF;
	SELECT COUNT(*) INTO v_count FROM `messenger_privacy_subjects`
	WHERE `workspace_id`=p_workspace_id AND `channel_connection_id`=p_channel_connection_id
		AND BINARY `user_key`=BINARY p_user_key
		AND ((`privacy_epoch`=p_privacy_epoch AND `status`='active')
			OR (`privacy_epoch`=p_privacy_epoch+1 AND `status` IN ('erasing','erased'))) FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit expiry privacy scope is stale'; END IF;
	SET v_version=NULL;
	SELECT `credit_balance`,`reserved_credits`,`balance_version`,`last_ledger_entry_id`
	INTO v_balance,v_reserved,v_version,v_previous FROM `credit_wallets`
	WHERE BINARY `wallet_id`=BINARY p_wallet_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
		AND `privacy_epoch`=p_privacy_epoch
		AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref
		AND `status` IN ('active','frozen','erased') FOR UPDATE;
	IF v_version IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit expiry wallet scope is stale'; END IF;
	SET v_status=NULL;
	SELECT `status`,`transport_state`,`reserved_credit_count`,`owner_token_hash`,`expires_at`,`terminal_ledger_entry_id`,`terminal_evidence_hash`
	INTO v_status,v_transport,v_units,v_owner,v_expires_at,v_terminal_entry,v_terminal_evidence FROM `credit_reservations`
	WHERE BINARY `reservation_id`=BINARY p_reservation_id AND BINARY `wallet_id`=BINARY p_wallet_id
		AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
		AND `privacy_epoch`=p_privacy_epoch AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref FOR UPDATE;
	IF v_status='expired' THEN
		SELECT COUNT(*) INTO v_count FROM `credit_ledger`
		WHERE BINARY `entry_id`=BINARY p_entry_id AND BINARY `wallet_id`=BINARY p_wallet_id
			AND `workspace_id`=p_workspace_id AND `mode`=p_mode
			AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
			AND `privacy_epoch`=p_privacy_epoch
			AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref
			AND BINARY `reservation_id`=BINARY p_reservation_id
			AND `entry_kind`='reservation_release' AND `reservation_terminal_status`='expired'
			AND BINARY `event_key_hash`=BINARY v_event_hash
			AND BINARY `evidence_hash`=BINARY p_evidence_hash FOR UPDATE;
		IF v_count<>1 OR NOT ((BINARY v_terminal_entry<=>BINARY p_entry_id)
			AND (BINARY v_terminal_evidence<=>BINARY p_evidence_hash)
			AND (v_owner IS NULL OR BINARY v_owner=BINARY p_owner_token_hash)) THEN
			SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit expiry replay conflicts with terminal evidence';
		END IF;
		COMMIT; SELECT 'already_applied' AS `result`,p_reservation_id AS `reservation_id`; LEAVE credit_expire_body;
	END IF;
	SELECT COUNT(*) INTO v_count FROM `credit_wallets`
	WHERE BINARY `wallet_id`=BINARY p_wallet_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
		AND `privacy_epoch`=p_privacy_epoch AND BINARY `current_user_key_hash`=BINARY p_user_key
		AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref
		AND `status` IN ('active','frozen') FOR UPDATE;
	IF v_count<>1 OR v_status<>'reserved' OR v_transport<>'pretransport'
		OR NOT (BINARY v_owner<=>BINARY p_owner_token_hash)
		OR CURRENT_TIMESTAMP<v_expires_at OR v_reserved<v_units THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit expiry requires one expired owned hold';
	END IF;
	INSERT INTO `credit_ledger` (`entry_id`,`wallet_id`,`workspace_id`,`mode`,`channel_connection_id`,
		`binding_epoch`,`privacy_epoch`,`financial_subject_ref`,`entry_kind`,`balance_delta`,`reserved_delta`,
		`event_key_hash`,`reservation_id`,`reservation_credit_count`,`reservation_terminal_slot`,
		`reservation_terminal_status`,`evidence_hash`,`previous_entry_id`,`wallet_version_before`,
		`wallet_version_after`,`balance_before`,`reserved_before`,`balance_after`,`reserved_after`,`occurred_at`)
	VALUES (p_entry_id,p_wallet_id,p_workspace_id,p_mode,p_channel_connection_id,p_binding_epoch,p_privacy_epoch,
		p_financial_subject_ref,'reservation_release',0,-v_units,v_event_hash,p_reservation_id,v_units,1,
		'expired',p_evidence_hash,v_previous,v_version,v_version+1,v_balance,v_reserved,
		v_balance,v_reserved-v_units,CURRENT_TIMESTAMP);
	COMMIT; SELECT 'applied' AS `result`,p_reservation_id AS `reservation_id`;
END;--> statement-breakpoint
CREATE PROCEDURE `credit_scrub_terminal_reservation`(
	IN p_workspace_id int, IN p_mode varchar(8), IN p_channel_connection_id int,
	IN p_binding_epoch int, IN p_privacy_epoch int, IN p_wallet_id varchar(36),
	IN p_financial_subject_ref varchar(64), IN p_reservation_id varchar(36)
)
SQL SECURITY DEFINER
credit_scrub_body: BEGIN
	DECLARE v_count int DEFAULT 0; DECLARE v_status varchar(16); DECLARE v_scrubbed_at timestamp;
	DECLARE v_resolution_due_at timestamp;
	DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN ROLLBACK; RESIGNAL; END;
	START TRANSACTION;
	SELECT COUNT(*) INTO v_count FROM `billing_execution_controls`
	WHERE `workspace_id`=p_workspace_id AND `mode`=p_mode FOR UPDATE;
	SELECT COUNT(*) INTO v_count FROM `channelConnections`
	WHERE `workspaceId`=p_workspace_id AND `id`=p_channel_connection_id FOR UPDATE;
	SELECT COUNT(*) INTO v_count FROM `credit_wallets`
	WHERE BINARY `wallet_id`=BINARY p_wallet_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
		AND `privacy_epoch`=p_privacy_epoch AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit reservation scrub wallet scope is invalid'; END IF;
	SET v_status=NULL;
	SELECT `status`,`operational_scrubbed_at`,`resolution_due_at`
	INTO v_status,v_scrubbed_at,v_resolution_due_at FROM `credit_reservations`
	WHERE BINARY `reservation_id`=BINARY p_reservation_id AND BINARY `wallet_id`=BINARY p_wallet_id
		AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
		AND `privacy_epoch`=p_privacy_epoch AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref FOR UPDATE;
	IF v_scrubbed_at IS NOT NULL THEN
		COMMIT; SELECT 'already_applied' AS `result`,p_reservation_id AS `reservation_id`; LEAVE credit_scrub_body;
	END IF;
	IF v_status NOT IN ('committed','released','expired') OR CURRENT_TIMESTAMP<v_resolution_due_at THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit reservation is not eligible for bounded scrub';
	END IF;
	UPDATE `credit_reservations` SET `generation_request_key_hash`=NULL,`owner_token_hash`=NULL,
		`operational_scrubbed_at`=CURRENT_TIMESTAMP
	WHERE BINARY `reservation_id`=BINARY p_reservation_id AND `operational_scrubbed_at` IS NULL;
	IF ROW_COUNT()<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit reservation scrub lost its fence'; END IF;
	COMMIT; SELECT 'applied' AS `result`,p_reservation_id AS `reservation_id`;
END;--> statement-breakpoint
CREATE PROCEDURE `credit_freeze_wallet_for_review`(
	IN p_workspace_id int, IN p_mode varchar(8), IN p_channel_connection_id int,
	IN p_binding_epoch int, IN p_privacy_epoch int, IN p_wallet_id varchar(36),
	IN p_financial_subject_ref varchar(64), IN p_intent_id varchar(36),
	IN p_payment_ledger_id int, IN p_provider_payment_id varchar(64), IN p_snapshot_hash varchar(64)
)
SQL SECURITY DEFINER
credit_freeze_body: BEGIN
	DECLARE v_count int DEFAULT 0; DECLARE v_status varchar(16);
	IF p_payment_ledger_id IS NULL OR p_payment_ledger_id<1
		OR NOT REGEXP_LIKE(p_intent_id,'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$','c')
		OR NOT REGEXP_LIKE(p_provider_payment_id,'^tr_[A-Za-z0-9]{1,60}$','c')
		OR NOT REGEXP_LIKE(p_snapshot_hash,'^[0-9a-f]{64}$','c') THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit review payment evidence is malformed';
	END IF;
	SELECT COUNT(*) INTO v_count FROM `billing_execution_controls`
	WHERE `workspace_id`=p_workspace_id AND `mode`=p_mode FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit review control scope is unavailable'; END IF;
	SELECT COUNT(*) INTO v_count FROM `channelConnections`
	WHERE `workspaceId`=p_workspace_id AND `id`=p_channel_connection_id
		AND `channel`='facebook_messenger' FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit review connection scope is invalid'; END IF;
	SET v_status=NULL;
	SELECT `status` INTO v_status FROM `credit_wallets`
	WHERE BINARY `wallet_id`=BINARY p_wallet_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
		AND `privacy_epoch`=p_privacy_epoch
		AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref FOR UPDATE;
	IF v_status IS NULL THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit review wallet scope is invalid';
	END IF;
	SELECT COUNT(*) INTO v_count FROM `billing_intents` intent
	JOIN `payment_ledger` payment ON payment.`id`=p_payment_ledger_id
		AND payment.`workspace_id`=intent.`workspace_id` AND payment.`mode`=intent.`mode`
		AND BINARY payment.`mollie_payment_id`=BINARY p_provider_payment_id
	WHERE BINARY intent.`intent_id`=BINARY p_intent_id
		AND intent.`workspace_id`=p_workspace_id AND intent.`mode`=p_mode
		AND intent.`kind`='credit_purchase' AND intent.`status` IN ('paid','contained')
		AND BINARY intent.`credit_wallet_id`=BINARY p_wallet_id
		AND intent.`messenger_channel_connection_id`=p_channel_connection_id
		AND intent.`messenger_binding_epoch`=p_binding_epoch
		AND intent.`messenger_privacy_epoch`=p_privacy_epoch
		AND BINARY intent.`credit_financial_subject_ref`=BINARY p_financial_subject_ref
		AND BINARY intent.`mollie_payment_id`=BINARY p_provider_payment_id
		AND payment.`status`='paid' AND payment.`paid_effect_applied`=1
		AND payment.`payment_effect_owner_kind`='credit_grant'
		AND BINARY payment.`payment_effect_owner_ref`=BINARY p_intent_id
		AND payment.`credit_purpose`='premium_image_credits'
		AND BINARY payment.`credit_intent_id`=BINARY p_intent_id
		AND BINARY payment.`credit_wallet_id`=BINARY p_wallet_id
		AND BINARY payment.`credit_metadata_hash`=BINARY intent.`credit_metadata_hash`
		AND payment.`gross_amount`=4.99 AND BINARY payment.`currency`=BINARY 'EUR'
		AND BINARY payment.`observed_snapshot_hash`=BINARY p_snapshot_hash
		AND ((JSON_TYPE(payment.`refunds`)='ARRAY' AND JSON_LENGTH(payment.`refunds`)>0)
			OR (JSON_TYPE(payment.`chargebacks`)='ARRAY' AND JSON_LENGTH(payment.`chargebacks`)>0)) FOR UPDATE;
	IF v_count<>1 THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit review lacks exact adjusted payment evidence';
	END IF;
	IF v_status='active' THEN
		UPDATE `credit_wallets` SET `status`='frozen'
		WHERE BINARY `wallet_id`=BINARY p_wallet_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode
			AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
			AND `privacy_epoch`=p_privacy_epoch
			AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref AND `status`='active';
		IF ROW_COUNT()<>1 THEN
			SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit review wallet freeze lost its fence';
		END IF;
		SELECT 'applied' AS `result`,p_wallet_id AS `wallet_id`;
	ELSEIF v_status IN ('frozen','erased') THEN
		SELECT 'already_applied' AS `result`,p_wallet_id AS `wallet_id`;
	ELSE
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit review wallet status is invalid';
	END IF;
END;--> statement-breakpoint
CREATE PROCEDURE `credit_erase_wallet`(
	IN p_workspace_id int, IN p_mode varchar(8), IN p_channel_connection_id int,
	IN p_binding_epoch int, IN p_privacy_epoch int, IN p_erasure_privacy_epoch int,
	IN p_user_key varchar(96),
	IN p_wallet_id varchar(36), IN p_financial_subject_ref varchar(64)
)
SQL SECURITY DEFINER
credit_erase_body: BEGIN
	DECLARE v_count int DEFAULT 0; DECLARE v_holds int DEFAULT 0; DECLARE v_provider_pending int DEFAULT 0;
	DECLARE v_wallet_status varchar(16); DECLARE v_wallet_user varchar(96);
	DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN ROLLBACK; RESIGNAL; END;
	START TRANSACTION;
	IF p_erasure_privacy_epoch<>p_privacy_epoch+1 THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit erasure privacy epoch is stale';
	END IF;
	SELECT COUNT(*) INTO v_count FROM `billing_execution_controls`
	WHERE `workspace_id`=p_workspace_id AND `mode`=p_mode FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit erasure control scope is unavailable'; END IF;
	SELECT COUNT(*) INTO v_count FROM `channelConnections`
	WHERE `workspaceId`=p_workspace_id AND `id`=p_channel_connection_id FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit erasure connection scope is unavailable'; END IF;
	SELECT COUNT(*) INTO v_count FROM `messenger_privacy_subjects`
	WHERE `workspace_id`=p_workspace_id AND `channel_connection_id`=p_channel_connection_id
		AND BINARY `user_key`=BINARY p_user_key AND `privacy_epoch`=p_erasure_privacy_epoch
		AND `status` IN ('erasing','erased') FOR UPDATE;
	SET v_wallet_status=NULL; SET v_wallet_user=NULL;
	SELECT `status`,`current_user_key_hash` INTO v_wallet_status,v_wallet_user FROM `credit_wallets`
	WHERE BINARY `wallet_id`=BINARY p_wallet_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
		AND `privacy_epoch`=p_privacy_epoch AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref FOR UPDATE;
	IF v_count<>1 OR NOT (BINARY v_wallet_user=BINARY p_user_key) THEN
		IF NOT (v_wallet_status='erased' AND v_wallet_user IS NULL) THEN
			SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit erasure requires the exact erasing privacy subject';
		END IF;
	END IF;
	SELECT COUNT(*) INTO v_count FROM `billing_intents`
	WHERE `kind`='credit_purchase' AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND BINARY `credit_wallet_id`=BINARY p_wallet_id
		AND `messenger_channel_connection_id`=p_channel_connection_id
		AND `messenger_binding_epoch`=p_binding_epoch AND `messenger_privacy_epoch`=p_privacy_epoch
		AND BINARY `credit_financial_subject_ref`=BINARY p_financial_subject_ref FOR UPDATE;
	SELECT COUNT(*) INTO v_provider_pending FROM `billing_provider_operations` operation
	JOIN `billing_intents` intent ON intent.`workspace_id`=operation.`workspace_id`
		AND intent.`mode`=operation.`mode` AND BINARY intent.`intent_id`=BINARY operation.`intent_id`
	WHERE intent.`kind`='credit_purchase' AND intent.`workspace_id`=p_workspace_id AND intent.`mode`=p_mode
		AND BINARY intent.`credit_wallet_id`=BINARY p_wallet_id
		AND operation.`operation_type`='create_payment'
		AND (operation.`state` IN ('transport_started','ambiguous','reconciliation_only')
			OR (operation.`state`='succeeded' AND NOT EXISTS (
				SELECT 1 FROM `payment_ledger` payment
				WHERE payment.`workspace_id`=operation.`workspace_id` AND payment.`mode`=operation.`mode`
					AND BINARY payment.`mollie_payment_id`=BINARY operation.`provider_resource_id`
					AND payment.`status` IN ('paid','failed','canceled','expired')
			))) FOR UPDATE;
	IF v_wallet_status='erased' AND v_wallet_user IS NULL THEN
		COMMIT;
		SELECT 'already_applied' AS `result`,p_wallet_id AS `wallet_id`;
		LEAVE credit_erase_body;
	END IF;
	SELECT COUNT(*) INTO v_holds FROM `credit_reservations`
	WHERE BINARY `wallet_id`=BINARY p_wallet_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `status` IN ('initializing','reserved') FOR UPDATE;
	UPDATE `billing_intents`
	SET `status`=CASE WHEN `status` IN ('paid','failed','canceled','expired','mismatch') THEN `status` ELSE 'contained' END,
		`messenger_sender_user_key`=NULL,`checkout_capability_hash`=NULL,
		`checkout_capability_expires_at`=NULL,`checkout_capability_consumed_at`=NULL,
		`checkout_capability_session_nonce_hash`=NULL,`credit_identity_erased_at`=CURRENT_TIMESTAMP
	WHERE `kind`='credit_purchase' AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND BINARY `credit_wallet_id`=BINARY p_wallet_id
		AND `messenger_channel_connection_id`=p_channel_connection_id
		AND `messenger_binding_epoch`=p_binding_epoch AND `messenger_privacy_epoch`=p_privacy_epoch
		AND BINARY `credit_financial_subject_ref`=BINARY p_financial_subject_ref
		AND `credit_identity_erased_at` IS NULL;
	IF v_provider_pending>0 THEN
		UPDATE `credit_wallets` SET `status`='frozen'
		WHERE BINARY `wallet_id`=BINARY p_wallet_id AND `status` IN ('active','frozen');
		COMMIT; SELECT 'pending_provider' AS `result`,p_wallet_id AS `wallet_id`; LEAVE credit_erase_body;
	END IF;
	IF v_holds>0 THEN
		UPDATE `credit_wallets` SET `status`='frozen'
		WHERE BINARY `wallet_id`=BINARY p_wallet_id AND `status` IN ('active','frozen');
		COMMIT; SELECT 'pending_holds' AS `result`,p_wallet_id AS `wallet_id`; LEAVE credit_erase_body;
	END IF;
	UPDATE `credit_wallets` SET `status`='erased',`current_user_key_hash`=NULL,
		`privacy_erased_at`=CURRENT_TIMESTAMP
	WHERE BINARY `wallet_id`=BINARY p_wallet_id AND `status` IN ('active','frozen')
		AND BINARY `current_user_key_hash`=BINARY p_user_key AND `reserved_credits`=0;
	IF ROW_COUNT()<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit wallet erasure lost its fence'; END IF;
	COMMIT;
	SELECT 'erased' AS `result`,p_wallet_id AS `wallet_id`;
END;--> statement-breakpoint
CREATE PROCEDURE `credit_apply_refund_debit`(
	IN p_workspace_id int, IN p_mode varchar(8), IN p_channel_connection_id int,
	IN p_binding_epoch int, IN p_privacy_epoch int, IN p_wallet_id varchar(36),
	IN p_financial_subject_ref varchar(64), IN p_root_grant_entry_id varchar(36),
	IN p_entry_id varchar(36), IN p_evidence_hash varchar(64)
)
SQL SECURITY DEFINER
credit_refund_body: BEGIN
	DECLARE v_count int DEFAULT 0; DECLARE v_balance int; DECLARE v_reserved int;
	DECLARE v_version int; DECLARE v_previous varchar(36); DECLARE v_status varchar(16);
	DECLARE v_intent_id varchar(36); DECLARE v_payment_ledger_id int; DECLARE v_payment_id varchar(64);
	DECLARE v_offer varchar(80); DECLARE v_amount decimal(10,2); DECLARE v_currency varchar(3);
	DECLARE v_payment_amount decimal(10,2); DECLARE v_payment_currency varchar(3);
	DECLARE v_credits int; DECLARE v_description varchar(255); DECLARE v_authorization_epoch int;
	DECLARE v_event_hash varchar(64); DECLARE v_provider_event_hash varchar(64); DECLARE v_existing varchar(36);
	DECLARE v_existing_kind varchar(32); DECLARE v_provider_effect_id varchar(64); DECLARE v_refunds json;
	DECLARE v_refund_count int DEFAULT 0; DECLARE v_refund_distinct int DEFAULT 0;
	DECLARE v_refunded_count int DEFAULT 0;
	DECLARE v_refund_invalid int DEFAULT 0; DECLARE v_refund_total decimal(10,2) DEFAULT 0;
	DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN ROLLBACK; RESIGNAL; END;
	SELECT `source_intent_id`,`payment_ledger_id` INTO v_intent_id,v_payment_ledger_id
	FROM `credit_ledger` WHERE BINARY `entry_id`=BINARY p_root_grant_entry_id AND `entry_kind`='purchase_grant';
	IF v_intent_id IS NULL OR v_payment_ledger_id IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='refund root grant is unavailable'; END IF;
	START TRANSACTION;
	SELECT COUNT(*) INTO v_count FROM `billing_execution_controls`
	WHERE `workspace_id`=p_workspace_id AND `mode`=p_mode FOR UPDATE;
	SELECT COUNT(*) INTO v_count FROM `channelConnections`
	WHERE `workspaceId`=p_workspace_id AND `id`=p_channel_connection_id FOR UPDATE;
	SELECT `credit_balance`,`reserved_credits`,`balance_version`,`last_ledger_entry_id`,`status`
	INTO v_balance,v_reserved,v_version,v_previous,v_status FROM `credit_wallets`
	WHERE BINARY `wallet_id`=BINARY p_wallet_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
		AND `privacy_epoch`=p_privacy_epoch AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref FOR UPDATE;
	SELECT COUNT(*) INTO v_count FROM `billing_intents`
	WHERE BINARY `intent_id`=BINARY v_intent_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `kind`='credit_purchase' AND BINARY `credit_wallet_id`=BINARY p_wallet_id FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='refund intent scope is invalid'; END IF;
	SELECT `provider_payment_id`,`offer_id`,`payment_amount`,`currency`,`purchased_credit_count`,
		`provider_description`,`authorization_epoch`
	INTO v_payment_id,v_offer,v_amount,v_currency,v_credits,v_description,v_authorization_epoch FROM `credit_ledger`
	WHERE BINARY `entry_id`=BINARY p_root_grant_entry_id AND `entry_kind`='purchase_grant'
		AND BINARY `wallet_id`=BINARY p_wallet_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
		AND `privacy_epoch`=p_privacy_epoch AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref
		AND `payment_ledger_id`=v_payment_ledger_id FOR UPDATE;
	SET v_existing=NULL; SET v_existing_kind=NULL;
	SELECT MAX(`entry_id`),MAX(`entry_kind`) INTO v_existing,v_existing_kind FROM `credit_ledger`
	WHERE `mode`=p_mode AND BINARY `root_grant_entry_id`=BINARY p_root_grant_entry_id
		AND `root_adjustment_slot`=1 FOR UPDATE;
	IF v_existing IS NOT NULL THEN
		IF v_existing_kind<>'refund_debit' THEN
			UPDATE `credit_wallets` SET `status`=CASE WHEN `status`='active' THEN 'frozen' ELSE `status` END
			WHERE BINARY `wallet_id`=BINARY p_wallet_id;
			COMMIT; SELECT 'manual_review' AS `result`,p_root_grant_entry_id AS `root_grant_entry_id`;
			LEAVE credit_refund_body;
		END IF;
		SELECT COUNT(*) INTO v_count FROM `credit_ledger`
		WHERE BINARY `entry_id`=BINARY p_entry_id AND `entry_kind`='refund_debit'
			AND BINARY `wallet_id`=BINARY p_wallet_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode
			AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
			AND `privacy_epoch`=p_privacy_epoch
			AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref
			AND BINARY `root_grant_entry_id`=BINARY p_root_grant_entry_id
			AND `provider_effect_type`='refund' AND `provider_effect_status`='refunded'
			AND `provider_effect_evidence` IS NOT NULL
			AND BINARY `evidence_hash`=BINARY p_evidence_hash FOR UPDATE;
		IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='refund replay conflicts with existing adjustment'; END IF;
		COMMIT; SELECT 'already_applied' AS `result`,p_entry_id AS `entry_id`; LEAVE credit_refund_body;
	END IF;
	SET v_refunds=NULL; SET v_payment_amount=NULL; SET v_payment_currency=NULL;
	SELECT `refunds`,`gross_amount`,`currency` INTO v_refunds,v_payment_amount,v_payment_currency
	FROM `payment_ledger`
	WHERE `id`=v_payment_ledger_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode AND `status`='paid'
		AND `paid_effect_applied`=1 AND `payment_effect_owner_kind`='credit_grant'
		AND BINARY `payment_effect_owner_ref`=BINARY v_intent_id
		AND BINARY `credit_wallet_id`=BINARY p_wallet_id
		AND BINARY `mollie_payment_id`=BINARY v_payment_id
		AND `gross_amount`=v_amount AND BINARY `currency`=BINARY v_currency
		AND BINARY `observed_snapshot_hash`=BINARY p_evidence_hash FOR UPDATE;
	IF v_refunds IS NULL OR JSON_TYPE(v_refunds)<>'ARRAY' OR JSON_LENGTH(v_refunds)=0
		OR v_payment_amount<>v_amount OR NOT (BINARY v_payment_currency=BINARY v_currency) THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='refund evidence is incomplete or mismatched';
	END IF;
	SELECT COUNT(*),COUNT(DISTINCT BINARY `effect_id`),
		COALESCE(SUM(CASE WHEN `effect_status`='refunded' THEN 1 ELSE 0 END),0),
		COALESCE(SUM(CASE WHEN `effect_status`='refunded'
			AND REGEXP_LIKE(`effect_amount_raw`,'^(0|[1-9][0-9]{0,7})[.][0-9]{2}$','c')
			THEN CAST(`effect_amount_raw` AS DECIMAL(10,2)) ELSE 0 END),0),
		COALESCE(SUM(CASE WHEN `effect_id` IS NULL OR NOT REGEXP_LIKE(`effect_id`,'^[A-Za-z0-9_-]{1,64}$','c')
			OR NOT REGEXP_LIKE(`effect_status`,'^[a-z][a-z_]{0,23}$','c')
			OR NOT REGEXP_LIKE(`effect_amount_raw`,'^(0|[1-9][0-9]{0,7})[.][0-9]{2}$','c')
			OR `effect_amount_raw`='0.00'
			OR NOT (BINARY `effect_currency`=BINARY v_currency) THEN 1 ELSE 0 END),0)
	INTO v_refund_count,v_refund_distinct,v_refunded_count,v_refund_total,v_refund_invalid
	FROM JSON_TABLE(v_refunds,'$[*]' COLUMNS(
		`effect_id` varchar(64) PATH '$.id',`effect_status` varchar(24) PATH '$.status',
		`effect_amount_raw` varchar(32) PATH '$.amount.value',`effect_currency` varchar(3) PATH '$.amount.currency'
	)) effect;
	IF v_refund_count<>JSON_LENGTH(v_refunds) OR v_refund_distinct<>v_refund_count
		OR v_refunded_count=0 OR v_refund_invalid<>0 OR v_refund_total<>v_amount THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='refund set is incomplete or mismatched';
	END IF;
	SET v_provider_effect_id=SHA2(CONCAT('credit-refund-set-v1',CHAR(10),p_mode,CHAR(10),v_payment_id,
		CHAR(10),CAST(v_refunds AS CHAR)),256);
	SET v_provider_event_hash=SHA2(CONCAT('credit-provider-effect-v1',CHAR(10),p_mode,CHAR(10),v_payment_id,
		CHAR(10),'refund',CHAR(10),v_provider_effect_id,CHAR(10),'refunded',CHAR(10),CAST(v_amount AS CHAR),
		CHAR(10),v_currency,CHAR(10),p_evidence_hash),256);
	SET v_event_hash=SHA2(CONCAT('credit-adjustment-v1',CHAR(10),p_mode,CHAR(10),p_root_grant_entry_id,
		CHAR(10),'refund_debit',CHAR(10),v_provider_effect_id),256);
	SELECT COUNT(*) INTO v_count FROM `credit_ledger`
	WHERE `mode`=p_mode AND BINARY `provider_event_hash`=BINARY v_provider_event_hash FOR UPDATE;
	IF v_count<>0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='refund provider evidence collides with another adjustment'; END IF;
	IF v_reserved>0 THEN
		UPDATE `credit_wallets` SET `status`=CASE WHEN `status`='active' THEN 'frozen' ELSE `status` END
		WHERE BINARY `wallet_id`=BINARY p_wallet_id;
		COMMIT; SELECT 'pending_holds' AS `result`,p_root_grant_entry_id AS `root_grant_entry_id`; LEAVE credit_refund_body;
	END IF;
	IF v_balance<v_credits THEN
		UPDATE `credit_wallets` SET `status`=CASE WHEN `status`='active' THEN 'frozen' ELSE `status` END
		WHERE BINARY `wallet_id`=BINARY p_wallet_id;
		COMMIT; SELECT 'manual_review' AS `result`,p_root_grant_entry_id AS `root_grant_entry_id`; LEAVE credit_refund_body;
	END IF;
	INSERT INTO `credit_ledger` (`entry_id`,`wallet_id`,`workspace_id`,`mode`,`channel_connection_id`,`binding_epoch`,
		`privacy_epoch`,`financial_subject_ref`,`source_intent_id`,`authorization_epoch`,`payment_ledger_id`,
		`provider_payment_id`,`offer_id`,`payment_amount`,`currency`,`purchased_credit_count`,`provider_description`,
		`entry_kind`,`balance_delta`,`reserved_delta`,`event_key_hash`,`provider_event_hash`,`provider_effect_id`,
		`provider_effect_type`,`provider_effect_status`,`provider_effect_amount`,`provider_effect_currency`,
		`provider_effect_evidence`,
		`root_grant_entry_id`,`root_adjustment_slot`,`evidence_hash`,`previous_entry_id`,`wallet_version_before`,
		`wallet_version_after`,`balance_before`,`reserved_before`,`balance_after`,`reserved_after`,`occurred_at`)
	VALUES (p_entry_id,p_wallet_id,p_workspace_id,p_mode,p_channel_connection_id,p_binding_epoch,p_privacy_epoch,
		p_financial_subject_ref,v_intent_id,v_authorization_epoch,v_payment_ledger_id,v_payment_id,v_offer,v_amount,
		v_currency,v_credits,v_description,'refund_debit',-v_credits,0,v_event_hash,v_provider_event_hash,
		v_provider_effect_id,'refund','refunded',v_amount,v_currency,v_refunds,p_root_grant_entry_id,1,p_evidence_hash,
		v_previous,v_version,v_version+1,v_balance,v_reserved,v_balance-v_credits,v_reserved,CURRENT_TIMESTAMP);
	COMMIT; SELECT 'applied' AS `result`,p_entry_id AS `entry_id`;
END;--> statement-breakpoint
CREATE PROCEDURE `credit_apply_chargeback_debit`(
	IN p_workspace_id int, IN p_mode varchar(8), IN p_channel_connection_id int,
	IN p_binding_epoch int, IN p_privacy_epoch int, IN p_wallet_id varchar(36),
	IN p_financial_subject_ref varchar(64), IN p_root_grant_entry_id varchar(36),
	IN p_provider_effect_id varchar(64), IN p_entry_id varchar(36), IN p_evidence_hash varchar(64)
)
SQL SECURITY DEFINER
credit_chargeback_body: BEGIN
	DECLARE v_count int DEFAULT 0; DECLARE v_balance int; DECLARE v_reserved int;
	DECLARE v_version int; DECLARE v_previous varchar(36); DECLARE v_wallet_status varchar(16);
	DECLARE v_intent_id varchar(36); DECLARE v_payment_ledger_id int; DECLARE v_payment_id varchar(64);
	DECLARE v_offer varchar(80); DECLARE v_amount decimal(10,2); DECLARE v_currency varchar(3);
	DECLARE v_credits int; DECLARE v_description varchar(255); DECLARE v_authorization_epoch int;
	DECLARE v_event_hash varchar(64); DECLARE v_provider_event_hash varchar(64); DECLARE v_existing varchar(36);
	DECLARE v_existing_kind varchar(32);
	DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN ROLLBACK; RESIGNAL; END;
	SELECT `source_intent_id`,`payment_ledger_id` INTO v_intent_id,v_payment_ledger_id
	FROM `credit_ledger` WHERE BINARY `entry_id`=BINARY p_root_grant_entry_id AND `entry_kind`='purchase_grant';
	IF v_intent_id IS NULL OR v_payment_ledger_id IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='chargeback root grant is unavailable'; END IF;
	START TRANSACTION;
	SELECT COUNT(*) INTO v_count FROM `billing_execution_controls`
	WHERE `workspace_id`=p_workspace_id AND `mode`=p_mode FOR UPDATE;
	SELECT COUNT(*) INTO v_count FROM `channelConnections`
	WHERE `workspaceId`=p_workspace_id AND `id`=p_channel_connection_id FOR UPDATE;
	SELECT `credit_balance`,`reserved_credits`,`balance_version`,`last_ledger_entry_id`,`status`
	INTO v_balance,v_reserved,v_version,v_previous,v_wallet_status FROM `credit_wallets`
	WHERE BINARY `wallet_id`=BINARY p_wallet_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
		AND `privacy_epoch`=p_privacy_epoch AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref FOR UPDATE;
	SELECT COUNT(*) INTO v_count FROM `billing_intents`
	WHERE BINARY `intent_id`=BINARY v_intent_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `kind`='credit_purchase' AND BINARY `credit_wallet_id`=BINARY p_wallet_id FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='chargeback intent scope is invalid'; END IF;
	SELECT `provider_payment_id`,`offer_id`,`payment_amount`,`currency`,`purchased_credit_count`,
		`provider_description`,`authorization_epoch`
	INTO v_payment_id,v_offer,v_amount,v_currency,v_credits,v_description,v_authorization_epoch FROM `credit_ledger`
	WHERE BINARY `entry_id`=BINARY p_root_grant_entry_id AND `entry_kind`='purchase_grant'
		AND BINARY `wallet_id`=BINARY p_wallet_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
		AND `privacy_epoch`=p_privacy_epoch AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref
		AND `payment_ledger_id`=v_payment_ledger_id FOR UPDATE;
	SET v_existing=NULL; SET v_existing_kind=NULL;
	SELECT MAX(`entry_id`),MAX(`entry_kind`) INTO v_existing,v_existing_kind FROM `credit_ledger`
	WHERE `mode`=p_mode AND BINARY `root_grant_entry_id`=BINARY p_root_grant_entry_id
		AND `root_adjustment_slot`=1 FOR UPDATE;
	IF v_existing_kind='refund_debit' THEN
		UPDATE `credit_wallets` SET `status`=CASE WHEN `status`='active' THEN 'frozen' ELSE `status` END
		WHERE BINARY `wallet_id`=BINARY p_wallet_id;
		COMMIT; SELECT 'manual_review' AS `result`,p_root_grant_entry_id AS `root_grant_entry_id`;
		LEAVE credit_chargeback_body;
	END IF;
	IF v_existing IS NOT NULL THEN
		SELECT COUNT(*) INTO v_count FROM `credit_ledger`
		WHERE BINARY `entry_id`=BINARY p_entry_id AND `entry_kind`='chargeback_debit'
			AND BINARY `wallet_id`=BINARY p_wallet_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode
			AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
			AND `privacy_epoch`=p_privacy_epoch
			AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref
			AND BINARY `root_grant_entry_id`=BINARY p_root_grant_entry_id
			AND BINARY `provider_effect_id`=BINARY p_provider_effect_id
			AND `provider_effect_type`='chargeback' AND `provider_effect_status`='active'
			AND BINARY `evidence_hash`=BINARY p_evidence_hash FOR UPDATE;
		IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='chargeback replay conflicts with existing adjustment'; END IF;
		COMMIT; SELECT 'already_applied' AS `result`,p_entry_id AS `entry_id`; LEAVE credit_chargeback_body;
	END IF;
	SELECT COUNT(*) INTO v_count FROM `payment_ledger`
	WHERE `id`=v_payment_ledger_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode AND `status`='paid'
		AND `paid_effect_applied`=1 AND `payment_effect_owner_kind`='credit_grant'
		AND BINARY `payment_effect_owner_ref`=BINARY v_intent_id
		AND BINARY `credit_wallet_id`=BINARY p_wallet_id
		AND BINARY `mollie_payment_id`=BINARY v_payment_id
		AND `gross_amount`=v_amount AND BINARY `currency`=BINARY v_currency
		AND BINARY `observed_snapshot_hash`=BINARY p_evidence_hash FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='chargeback payment evidence is incomplete or mismatched'; END IF;
	SELECT COUNT(*) INTO v_count FROM `payment_ledger` payment,
	JSON_TABLE(payment.`chargebacks`,'$[*]' COLUMNS(
		`effect_id` varchar(64) PATH '$.id',`effect_amount_raw` varchar(32) PATH '$.amount.value',
		`effect_currency` varchar(3) PATH '$.amount.currency',`reversed_at` varchar(40) PATH '$.reversedAt' NULL ON EMPTY
	)) effect
	WHERE payment.`id`=v_payment_ledger_id AND BINARY effect.`effect_id`=BINARY p_provider_effect_id
		AND effect.`reversed_at` IS NULL
		AND REGEXP_LIKE(effect.`effect_amount_raw`,'^(0|[1-9][0-9]{0,7})[.][0-9]{2}$','c')
		AND effect.`effect_amount_raw`<>'0.00'
		AND CAST(effect.`effect_amount_raw` AS DECIMAL(10,2))=v_amount
		AND BINARY effect.`effect_currency`=BINARY v_currency;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='chargeback provider effect is incomplete or mismatched'; END IF;
	SET v_provider_event_hash=SHA2(CONCAT('credit-provider-effect-v1',CHAR(10),p_mode,CHAR(10),v_payment_id,
		CHAR(10),'chargeback',CHAR(10),p_provider_effect_id,CHAR(10),'active',CHAR(10),CAST(v_amount AS CHAR),
		CHAR(10),v_currency,CHAR(10),p_evidence_hash),256);
	SET v_event_hash=SHA2(CONCAT('credit-adjustment-v1',CHAR(10),p_mode,CHAR(10),p_root_grant_entry_id,
		CHAR(10),'chargeback_debit',CHAR(10),p_provider_effect_id),256);
	SELECT COUNT(*) INTO v_count FROM `credit_ledger`
	WHERE `mode`=p_mode AND BINARY `provider_event_hash`=BINARY v_provider_event_hash FOR UPDATE;
	IF v_count<>0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='chargeback provider evidence collides with another adjustment'; END IF;
	IF v_wallet_status='active' THEN
		UPDATE `credit_wallets` SET `status`='frozen' WHERE BINARY `wallet_id`=BINARY p_wallet_id AND `status`='active';
	END IF;
	IF v_reserved>0 THEN
		COMMIT; SELECT 'pending_holds' AS `result`,p_root_grant_entry_id AS `root_grant_entry_id`; LEAVE credit_chargeback_body;
	END IF;
	INSERT INTO `credit_ledger` (`entry_id`,`wallet_id`,`workspace_id`,`mode`,`channel_connection_id`,`binding_epoch`,
		`privacy_epoch`,`financial_subject_ref`,`source_intent_id`,`authorization_epoch`,`payment_ledger_id`,
		`provider_payment_id`,`offer_id`,`payment_amount`,`currency`,`purchased_credit_count`,`provider_description`,
		`entry_kind`,`balance_delta`,`reserved_delta`,`event_key_hash`,`provider_event_hash`,`provider_effect_id`,
		`provider_effect_type`,`provider_effect_status`,`provider_effect_amount`,`provider_effect_currency`,
		`root_grant_entry_id`,`root_adjustment_slot`,`evidence_hash`,`previous_entry_id`,`wallet_version_before`,
		`wallet_version_after`,`balance_before`,`reserved_before`,`balance_after`,`reserved_after`,`occurred_at`)
	VALUES (p_entry_id,p_wallet_id,p_workspace_id,p_mode,p_channel_connection_id,p_binding_epoch,p_privacy_epoch,
		p_financial_subject_ref,v_intent_id,v_authorization_epoch,v_payment_ledger_id,v_payment_id,v_offer,v_amount,
		v_currency,v_credits,v_description,'chargeback_debit',-v_credits,0,v_event_hash,v_provider_event_hash,
		p_provider_effect_id,'chargeback','active',v_amount,v_currency,p_root_grant_entry_id,1,p_evidence_hash,
		v_previous,v_version,v_version+1,v_balance,v_reserved,v_balance-v_credits,v_reserved,CURRENT_TIMESTAMP);
	COMMIT; SELECT 'applied' AS `result`,p_entry_id AS `entry_id`;
END;--> statement-breakpoint
CREATE PROCEDURE `credit_apply_chargeback_restore`(
	IN p_workspace_id int, IN p_mode varchar(8), IN p_channel_connection_id int,
	IN p_binding_epoch int, IN p_privacy_epoch int, IN p_wallet_id varchar(36),
	IN p_financial_subject_ref varchar(64), IN p_root_grant_entry_id varchar(36),
	IN p_provider_effect_id varchar(64), IN p_entry_id varchar(36), IN p_evidence_hash varchar(64)
)
SQL SECURITY DEFINER
credit_restore_body: BEGIN
	DECLARE v_count int DEFAULT 0; DECLARE v_balance int; DECLARE v_reserved int;
	DECLARE v_version int; DECLARE v_previous varchar(36); DECLARE v_intent_id varchar(36);
	DECLARE v_payment_ledger_id int; DECLARE v_payment_id varchar(64); DECLARE v_offer varchar(80);
	DECLARE v_amount decimal(10,2); DECLARE v_currency varchar(3); DECLARE v_credits int;
	DECLARE v_description varchar(255); DECLARE v_authorization_epoch int;
	DECLARE v_event_hash varchar(64); DECLARE v_provider_event_hash varchar(64); DECLARE v_existing varchar(36);
	DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN ROLLBACK; RESIGNAL; END;
	SELECT `source_intent_id`,`payment_ledger_id` INTO v_intent_id,v_payment_ledger_id
	FROM `credit_ledger` WHERE BINARY `entry_id`=BINARY p_root_grant_entry_id AND `entry_kind`='purchase_grant';
	IF v_intent_id IS NULL OR v_payment_ledger_id IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='chargeback restore root grant is unavailable'; END IF;
	START TRANSACTION;
	SELECT COUNT(*) INTO v_count FROM `billing_execution_controls`
	WHERE `workspace_id`=p_workspace_id AND `mode`=p_mode FOR UPDATE;
	SELECT COUNT(*) INTO v_count FROM `channelConnections`
	WHERE `workspaceId`=p_workspace_id AND `id`=p_channel_connection_id FOR UPDATE;
	SELECT `credit_balance`,`reserved_credits`,`balance_version`,`last_ledger_entry_id`
	INTO v_balance,v_reserved,v_version,v_previous FROM `credit_wallets`
	WHERE BINARY `wallet_id`=BINARY p_wallet_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
		AND `privacy_epoch`=p_privacy_epoch AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref FOR UPDATE;
	SELECT COUNT(*) INTO v_count FROM `billing_intents`
	WHERE BINARY `intent_id`=BINARY v_intent_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `kind`='credit_purchase' AND BINARY `credit_wallet_id`=BINARY p_wallet_id FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='chargeback restore intent scope is invalid'; END IF;
	SELECT `provider_payment_id`,`offer_id`,`payment_amount`,`currency`,`purchased_credit_count`,
		`provider_description`,`authorization_epoch`
	INTO v_payment_id,v_offer,v_amount,v_currency,v_credits,v_description,v_authorization_epoch FROM `credit_ledger`
	WHERE BINARY `entry_id`=BINARY p_root_grant_entry_id AND `entry_kind`='purchase_grant'
		AND BINARY `wallet_id`=BINARY p_wallet_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
		AND `privacy_epoch`=p_privacy_epoch AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref
		AND `payment_ledger_id`=v_payment_ledger_id FOR UPDATE;
	SET v_existing=NULL;
	SELECT MAX(`entry_id`) INTO v_existing FROM `credit_ledger`
	WHERE `mode`=p_mode AND BINARY `root_grant_entry_id`=BINARY p_root_grant_entry_id
		AND `root_adjustment_slot`=2 FOR UPDATE;
	IF v_existing IS NOT NULL THEN
		SELECT COUNT(*) INTO v_count FROM `credit_ledger`
		WHERE BINARY `entry_id`=BINARY p_entry_id AND `entry_kind`='chargeback_restore'
			AND BINARY `wallet_id`=BINARY p_wallet_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode
			AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
			AND `privacy_epoch`=p_privacy_epoch
			AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref
			AND BINARY `root_grant_entry_id`=BINARY p_root_grant_entry_id
			AND BINARY `provider_effect_id`=BINARY p_provider_effect_id
			AND `provider_effect_type`='chargeback' AND `provider_effect_status`='reversed'
			AND BINARY `evidence_hash`=BINARY p_evidence_hash FOR UPDATE;
		IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='chargeback restore replay conflicts with existing adjustment'; END IF;
		COMMIT; SELECT 'already_applied' AS `result`,p_entry_id AS `entry_id`; LEAVE credit_restore_body;
	END IF;
	SELECT COUNT(*) INTO v_count FROM `payment_ledger`
	WHERE `id`=v_payment_ledger_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode AND `status`='paid'
		AND `paid_effect_applied`=1 AND `payment_effect_owner_kind`='credit_grant'
		AND BINARY `payment_effect_owner_ref`=BINARY v_intent_id
		AND BINARY `credit_wallet_id`=BINARY p_wallet_id
		AND BINARY `mollie_payment_id`=BINARY v_payment_id
		AND `gross_amount`=v_amount AND BINARY `currency`=BINARY v_currency
		AND BINARY `observed_snapshot_hash`=BINARY p_evidence_hash FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='chargeback restore payment evidence is incomplete or mismatched'; END IF;
	SELECT COUNT(*) INTO v_count FROM `payment_ledger` payment,
	JSON_TABLE(payment.`chargebacks`,'$[*]' COLUMNS(
		`effect_id` varchar(64) PATH '$.id',`effect_amount_raw` varchar(32) PATH '$.amount.value',
		`effect_currency` varchar(3) PATH '$.amount.currency',`reversed_at` varchar(40) PATH '$.reversedAt' NULL ON EMPTY
	)) effect
	WHERE payment.`id`=v_payment_ledger_id AND BINARY effect.`effect_id`=BINARY p_provider_effect_id
		AND effect.`reversed_at` IS NOT NULL
		AND REGEXP_LIKE(effect.`effect_amount_raw`,'^(0|[1-9][0-9]{0,7})[.][0-9]{2}$','c')
		AND effect.`effect_amount_raw`<>'0.00'
		AND CAST(effect.`effect_amount_raw` AS DECIMAL(10,2))=v_amount
		AND BINARY effect.`effect_currency`=BINARY v_currency;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='chargeback restore evidence is incomplete or mismatched'; END IF;
	SELECT COUNT(*) INTO v_count FROM `credit_ledger`
	WHERE `mode`=p_mode AND BINARY `root_grant_entry_id`=BINARY p_root_grant_entry_id
		AND `entry_kind`='chargeback_debit' AND BINARY `provider_effect_id`=BINARY p_provider_effect_id FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='chargeback restore requires one exact prior debit'; END IF;
	SET v_provider_event_hash=SHA2(CONCAT('credit-provider-effect-v1',CHAR(10),p_mode,CHAR(10),v_payment_id,
		CHAR(10),'chargeback',CHAR(10),p_provider_effect_id,CHAR(10),'reversed',CHAR(10),CAST(v_amount AS CHAR),
		CHAR(10),v_currency,CHAR(10),p_evidence_hash),256);
	SET v_event_hash=SHA2(CONCAT('credit-adjustment-v1',CHAR(10),p_mode,CHAR(10),p_root_grant_entry_id,
		CHAR(10),'chargeback_restore',CHAR(10),p_provider_effect_id),256);
	SELECT COUNT(*) INTO v_count FROM `credit_ledger`
	WHERE `mode`=p_mode AND BINARY `provider_event_hash`=BINARY v_provider_event_hash FOR UPDATE;
	IF v_count<>0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='chargeback restore evidence collides with another adjustment'; END IF;
	IF v_reserved<>0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='chargeback restore waits for active holds'; END IF;
	INSERT INTO `credit_ledger` (`entry_id`,`wallet_id`,`workspace_id`,`mode`,`channel_connection_id`,`binding_epoch`,
		`privacy_epoch`,`financial_subject_ref`,`source_intent_id`,`authorization_epoch`,`payment_ledger_id`,
		`provider_payment_id`,`offer_id`,`payment_amount`,`currency`,`purchased_credit_count`,`provider_description`,
		`entry_kind`,`balance_delta`,`reserved_delta`,`event_key_hash`,`provider_event_hash`,`provider_effect_id`,
		`provider_effect_type`,`provider_effect_status`,`provider_effect_amount`,`provider_effect_currency`,
		`root_grant_entry_id`,`root_adjustment_slot`,`evidence_hash`,`previous_entry_id`,`wallet_version_before`,
		`wallet_version_after`,`balance_before`,`reserved_before`,`balance_after`,`reserved_after`,`occurred_at`)
	VALUES (p_entry_id,p_wallet_id,p_workspace_id,p_mode,p_channel_connection_id,p_binding_epoch,p_privacy_epoch,
		p_financial_subject_ref,v_intent_id,v_authorization_epoch,v_payment_ledger_id,v_payment_id,v_offer,v_amount,
		v_currency,v_credits,v_description,'chargeback_restore',v_credits,0,v_event_hash,v_provider_event_hash,
		p_provider_effect_id,'chargeback','reversed',v_amount,v_currency,p_root_grant_entry_id,2,p_evidence_hash,
		v_previous,v_version,v_version+1,v_balance,v_reserved,v_balance+v_credits,v_reserved,CURRENT_TIMESTAMP);
	COMMIT; SELECT 'applied_review_required' AS `result`,p_entry_id AS `entry_id`;
END;--> statement-breakpoint
