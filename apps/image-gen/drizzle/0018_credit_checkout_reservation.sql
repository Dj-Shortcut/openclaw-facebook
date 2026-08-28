DROP PROCEDURE IF EXISTS `credit_create_wallet`;--> statement-breakpoint
CREATE PROCEDURE `credit_reserve_checkout_intent`(
	IN p_intent_id varchar(36), IN p_wallet_id varchar(36),
	IN p_workspace_id int, IN p_mode varchar(8),
	IN p_channel_connection_id int, IN p_binding_epoch int, IN p_privacy_epoch int,
	IN p_user_key varchar(96), IN p_financial_subject_ref varchar(64),
	IN p_authorization_epoch int, IN p_offer_snapshot_code varchar(80),
	IN p_expected_amount decimal(10,2), IN p_credit_count int,
	IN p_description varchar(255), IN p_metadata_hash varchar(64),
	IN p_idempotency_key varchar(96), IN p_checkout_scope_key varchar(160),
	IN p_capability_hash varchar(64), IN p_capability_expires_at timestamp
)
SQL SECURITY DEFINER
credit_reserve_checkout_intent_body: BEGIN
	DECLARE v_count int DEFAULT 0;
	DECLARE v_existing_intent_id varchar(36);
	DECLARE v_existing_wallet_id varchar(36);
	DECLARE v_replay_wallet_id varchar(36);
	DECLARE v_now timestamp DEFAULT CURRENT_TIMESTAMP;
	DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN ROLLBACK; RESIGNAL; END;

	IF NOT (
		REGEXP_LIKE(p_intent_id,'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$','c')
		AND REGEXP_LIKE(p_wallet_id,'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$','c')
		AND p_workspace_id>0 AND p_mode IN ('test','live')
		AND p_channel_connection_id>0 AND p_binding_epoch>0 AND p_privacy_epoch>0
		AND REGEXP_LIKE(p_user_key,'^([0-9a-f]{64}|u2[.]k[1-9][0-9]{0,5}[.][0-9a-f]{64})$','c')
		AND REGEXP_LIKE(p_financial_subject_ref,'^[0-9a-f]{64}$','c')
		AND p_authorization_epoch>0
		AND BINARY p_offer_snapshot_code=BINARY 'premium_images_8_medium_v1'
		AND p_expected_amount=4.99 AND p_credit_count=8
		AND BINARY p_description=BINARY 'Leaderbot - 8 premium beeldcredits'
		AND REGEXP_LIKE(p_metadata_hash,'^[0-9a-f]{64}$','c')
		AND BINARY p_idempotency_key=BINARY CONCAT('credit-payment:',p_intent_id)
		AND REGEXP_LIKE(p_checkout_scope_key,'^credit-checkout:v1:[0-9a-f]{64}$','c')
		AND REGEXP_LIKE(p_capability_hash,'^[0-9a-f]{64}$','c')
		AND p_capability_expires_at>=v_now
		AND p_capability_expires_at<=TIMESTAMPADD(MINUTE,15,v_now)
	) IS TRUE THEN
		SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit checkout reservation input is invalid';
	END IF;

	START TRANSACTION;
	SELECT COUNT(*) INTO v_count FROM `billing_execution_controls`
	WHERE `workspace_id`=p_workspace_id AND `mode`=p_mode
		AND `commercial_enabled`=true AND `authorization_epoch`=p_authorization_epoch FOR UPDATE;
	IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit checkout authorization is disabled or stale'; END IF;

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

	SET v_existing_wallet_id=NULL;
	SELECT MAX(`wallet_id`) INTO v_existing_wallet_id FROM `credit_wallets`
	WHERE BINARY `wallet_id`=BINARY p_wallet_id OR (`workspace_id`=p_workspace_id AND `mode`=p_mode
		AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref) FOR UPDATE;
	IF v_existing_wallet_id IS NOT NULL THEN
		SELECT COUNT(*) INTO v_count FROM `credit_wallets`
		WHERE BINARY `wallet_id`=BINARY p_wallet_id AND `workspace_id`=p_workspace_id AND `mode`=p_mode
			AND `channel_connection_id`=p_channel_connection_id AND `binding_epoch`=p_binding_epoch
			AND `privacy_epoch`=p_privacy_epoch AND BINARY `current_user_key_hash`=BINARY p_user_key
			AND BINARY `financial_subject_ref`=BINARY p_financial_subject_ref
			AND `status`='active' AND `privacy_erased_at` IS NULL FOR UPDATE;
		IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit checkout wallet scope conflicts'; END IF;
	ELSE
		INSERT INTO `credit_wallets` (`wallet_id`,`workspace_id`,`mode`,`channel_connection_id`,`binding_epoch`,
			`privacy_epoch`,`current_user_key_hash`,`financial_subject_ref`,`status`,`credit_balance`,
			`reserved_credits`,`balance_version`,`last_ledger_entry_id`,`privacy_erased_at`)
		VALUES (p_wallet_id,p_workspace_id,p_mode,p_channel_connection_id,p_binding_epoch,p_privacy_epoch,
			p_user_key,p_financial_subject_ref,'active',0,0,1,NULL,NULL);
	END IF;

	SET v_existing_intent_id=NULL;
	SELECT MAX(`intent_id`) INTO v_existing_intent_id FROM `billing_intents`
	WHERE BINARY `intent_id`=BINARY p_intent_id
		OR BINARY `checkout_scope_key`=BINARY p_checkout_scope_key
		OR BINARY `idempotency_key`=BINARY p_idempotency_key
		OR BINARY `checkout_capability_hash`=BINARY p_capability_hash FOR UPDATE;
	IF v_existing_intent_id IS NOT NULL THEN
		SET v_replay_wallet_id=NULL;
		SELECT COUNT(*),MAX(`credit_wallet_id`) INTO v_count,v_replay_wallet_id FROM `billing_intents`
		WHERE BINARY `intent_id`=BINARY p_intent_id
			AND `workspace_id`=p_workspace_id AND `mode`=p_mode
			AND `kind`='credit_purchase' AND `status`='created'
			AND BINARY `plan_code`=BINARY p_offer_snapshot_code
			AND `expected_amount`=p_expected_amount AND BINARY `currency`=BINARY 'EUR'
			AND `interval`='oneoff' AND JSON_TYPE(`entitlements`)='OBJECT' AND JSON_LENGTH(`entitlements`)=0
			AND BINARY `mollie_description`=BINARY p_description
			AND BINARY `idempotency_key`=BINARY p_idempotency_key
			AND BINARY `checkout_scope_key`=BINARY p_checkout_scope_key
			AND BINARY `messenger_sender_user_key`=BINARY p_user_key
			AND `messenger_page_id` IS NULL
			AND `messenger_channel_connection_id`=p_channel_connection_id
			AND `messenger_binding_epoch`=p_binding_epoch AND `messenger_privacy_epoch`=p_privacy_epoch
			AND BINARY `credit_wallet_id`=BINARY p_wallet_id
			AND BINARY `credit_financial_subject_ref`=BINARY p_financial_subject_ref
			AND `credit_count`=p_credit_count AND BINARY `credit_metadata_hash`=BINARY p_metadata_hash
			AND BINARY `checkout_capability_hash`=BINARY p_capability_hash
			AND `checkout_capability_expires_at`>=v_now
			AND `checkout_capability_consumed_at` IS NULL
			AND `checkout_capability_session_nonce_hash` IS NULL
			AND `credit_identity_erased_at` IS NULL
			AND `billing_profile_version`=0 AND `authorization_epoch`=p_authorization_epoch
			AND `mollie_payment_id` IS NULL AND `url_exposed_at` IS NULL AND `paid_at` IS NULL FOR UPDATE;
		IF v_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='credit checkout replay conflicts with immutable request'; END IF;
		COMMIT;
		SELECT 'already_applied' AS `result`,v_existing_intent_id AS `intent_id`,v_replay_wallet_id AS `wallet_id`;
		LEAVE credit_reserve_checkout_intent_body;
	END IF;

	INSERT INTO `billing_intents` (`intent_id`,`workspace_id`,`mode`,`plan_code`,`kind`,`expected_amount`,
		`currency`,`interval`,`entitlements`,`mollie_description`,`status`,`mollie_payment_id`,
		`idempotency_key`,`checkout_scope_key`,`messenger_sender_user_key`,`messenger_page_id`,
		`messenger_channel_connection_id`,`messenger_binding_epoch`,`messenger_privacy_epoch`,
		`credit_wallet_id`,`credit_financial_subject_ref`,`credit_count`,`credit_metadata_hash`,
		`checkout_capability_hash`,`checkout_capability_expires_at`,`checkout_capability_consumed_at`,
		`checkout_capability_session_nonce_hash`,`credit_identity_erased_at`,`billing_profile_version`,
		`authorization_epoch`,`url_exposed_at`,`paid_at`,`created_at`,`updated_at`)
	VALUES (p_intent_id,p_workspace_id,p_mode,p_offer_snapshot_code,'credit_purchase',p_expected_amount,
		'EUR','oneoff',JSON_OBJECT(),p_description,'created',NULL,p_idempotency_key,p_checkout_scope_key,
		p_user_key,NULL,p_channel_connection_id,p_binding_epoch,p_privacy_epoch,p_wallet_id,
		p_financial_subject_ref,p_credit_count,p_metadata_hash,p_capability_hash,p_capability_expires_at,
		NULL,NULL,NULL,0,p_authorization_epoch,NULL,NULL,v_now,v_now);
	COMMIT;
	SELECT 'applied' AS `result`,p_intent_id AS `intent_id`,p_wallet_id AS `wallet_id`;
END;
