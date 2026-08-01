CREATE TABLE `billing_customers` (
  `id` int AUTO_INCREMENT NOT NULL,
  `workspace_id` int NOT NULL,
  `mode` enum('test','live') NOT NULL,
  `mollie_customer_id` varchar(64),
  `external_reference` varchar(64) NOT NULL,
  `idempotency_key` varchar(96) NOT NULL,
  `status` enum('provisioning','creating_customer','active','manual_review') NOT NULL DEFAULT 'provisioning',
  `next_reconciliation_at` timestamp NOT NULL DEFAULT (now()),
  `created_at` timestamp NOT NULL DEFAULT (now()),
  `updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `billing_customers_id` PRIMARY KEY(`id`),
  CONSTRAINT `billing_customers_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT,
  CONSTRAINT `billing_customers_workspace_mode_unique` UNIQUE(`workspace_id`,`mode`),
  CONSTRAINT `billing_customers_mollie_customer_mode_unique` UNIQUE(`mode`,`mollie_customer_id`),
  CONSTRAINT `billing_customers_external_reference_unique` UNIQUE(`external_reference`),
  CONSTRAINT `billing_customers_idempotency_unique` UNIQUE(`idempotency_key`)
);
--> statement-breakpoint
CREATE INDEX `billing_customers_mode_reconciliation_idx` ON `billing_customers` (`mode`,`next_reconciliation_at`);
--> statement-breakpoint
CREATE TABLE `billing_intents` (
  `intent_id` varchar(36) NOT NULL,
  `workspace_id` int NOT NULL,
  `mode` enum('test','live') NOT NULL,
  `plan_code` varchar(80) NOT NULL,
  `kind` enum('subscription_start','payment_method_change') NOT NULL DEFAULT 'subscription_start',
  `expected_amount` decimal(10,2) NOT NULL,
  `currency` varchar(3) NOT NULL,
  `interval` varchar(32) NOT NULL,
  `entitlements` json NOT NULL,
  `mollie_description` varchar(255) NOT NULL,
  `status` enum('created','creating_payment','open','paid','failed','canceled','expired','mismatch','api_unknown') NOT NULL DEFAULT 'created',
  `mollie_payment_id` varchar(64),
  `idempotency_key` varchar(96) NOT NULL,
  `checkout_scope_key` varchar(160) NOT NULL,
  `paid_at` timestamp,
  `created_at` timestamp NOT NULL DEFAULT (now()),
  `updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `billing_intents_intent_id` PRIMARY KEY(`intent_id`),
  CONSTRAINT `billing_intents_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT,
  CONSTRAINT `billing_intents_mollie_payment_mode_unique` UNIQUE(`mode`,`mollie_payment_id`),
  CONSTRAINT `billing_intents_idempotency_unique` UNIQUE(`idempotency_key`),
  CONSTRAINT `billing_intents_checkout_scope_unique` UNIQUE(`checkout_scope_key`)
);
--> statement-breakpoint
CREATE INDEX `billing_intents_workspace_mode_created_idx` ON `billing_intents` (`workspace_id`,`mode`,`created_at`);
--> statement-breakpoint
CREATE TABLE `billing_subscriptions` (
  `id` int AUTO_INCREMENT NOT NULL,
  `workspace_id` int NOT NULL,
  `mode` enum('test','live') NOT NULL,
  `plan_code` varchar(80) NOT NULL,
  `mollie_customer_id` varchar(64) NOT NULL,
  `mollie_subscription_id` varchar(64),
  `mollie_mandate_id` varchar(64),
  `source_intent_id` varchar(36) NOT NULL,
  `idempotency_key` varchar(96) NOT NULL,
  `status` enum('provisioning','active','past_due','canceled','completed','suspended','manual_review') NOT NULL DEFAULT 'provisioning',
  `interval` varchar(32) NOT NULL,
  `recurring_amount` decimal(10,2) NOT NULL,
  `currency` varchar(3) NOT NULL,
  `entitlements` json NOT NULL,
  `mollie_description` varchar(255) NOT NULL,
  `current_period_start` timestamp,
  `paid_through` timestamp,
  `next_payment_date` timestamp,
  `grace_until` timestamp,
  `cancel_at_period_end` int NOT NULL DEFAULT 0,
  `canceled_at` timestamp,
  `created_at` timestamp NOT NULL DEFAULT (now()),
  `updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `billing_subscriptions_id` PRIMARY KEY(`id`),
  CONSTRAINT `billing_subscriptions_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT,
  CONSTRAINT `billing_subscriptions_workspace_mode_unique` UNIQUE(`workspace_id`,`mode`),
  CONSTRAINT `billing_subscriptions_mollie_subscription_mode_unique` UNIQUE(`mode`,`mollie_subscription_id`),
  CONSTRAINT `billing_subscriptions_idempotency_unique` UNIQUE(`idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `billing_invoice_sequences` (
  `id` int AUTO_INCREMENT NOT NULL,
  `mode` enum('test','live') NOT NULL,
  `invoice_year` int NOT NULL,
  `next_number` int NOT NULL,
  `updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `billing_invoice_sequences_id` PRIMARY KEY(`id`),
  CONSTRAINT `billing_invoice_sequences_mode_year_unique` UNIQUE(`mode`,`invoice_year`)
);
--> statement-breakpoint
CREATE TABLE `payment_ledger` (
  `id` int AUTO_INCREMENT NOT NULL,
  `mollie_payment_id` varchar(64) NOT NULL,
  `workspace_id` int NOT NULL,
  `mode` enum('test','live') NOT NULL,
  `gross_amount` decimal(10,2) NOT NULL,
  `currency` varchar(3) NOT NULL,
  `status` varchar(32) NOT NULL,
  `payment_method` varchar(40),
  `refunds` json NOT NULL,
  `chargebacks` json NOT NULL,
  `observed_snapshot_hash` varchar(64) NOT NULL,
  `paid_effect_applied` int NOT NULL DEFAULT 0,
  `settlement_id` varchar(64),
  `settlement_amount` decimal(10,2),
  `mollie_fees` decimal(10,2),
  `invoice_number` varchar(40),
  `occurred_at` timestamp NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT (now()),
  `updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `payment_ledger_id` PRIMARY KEY(`id`),
  CONSTRAINT `payment_ledger_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT,
  CONSTRAINT `payment_ledger_payment_mode_unique` UNIQUE(`mode`,`mollie_payment_id`),
  CONSTRAINT `payment_ledger_invoice_unique` UNIQUE(`invoice_number`)
);
--> statement-breakpoint
CREATE INDEX `payment_ledger_workspace_mode_occurred_idx` ON `payment_ledger` (`workspace_id`,`mode`,`occurred_at`);
--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
  `id` int AUTO_INCREMENT NOT NULL,
  `workspace_id` int NOT NULL,
  `mode` enum('test','live') NOT NULL,
  `mollie_resource_id` varchar(64) NOT NULL,
  `snapshot_hash` varchar(64) NOT NULL,
  `received_at` timestamp NOT NULL DEFAULT (now()),
  `processed_at` timestamp,
  `processing_result` varchar(80) NOT NULL,
  CONSTRAINT `webhook_deliveries_id` PRIMARY KEY(`id`),
  CONSTRAINT `webhook_deliveries_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT,
  CONSTRAINT `webhook_deliveries_resource_snapshot_mode_unique` UNIQUE(`workspace_id`,`mode`,`mollie_resource_id`,`snapshot_hash`)
);
--> statement-breakpoint
CREATE TABLE `workspace_entitlements` (
  `id` int AUTO_INCREMENT NOT NULL,
  `workspace_id` int NOT NULL,
  `mode` enum('test','live') NOT NULL,
  `plan_code` varchar(80) NOT NULL,
  `status` enum('inactive','active','grace','blocked','manual_review') NOT NULL DEFAULT 'inactive',
  `quota` json NOT NULL,
  `valid_until` timestamp,
  `source_subscription_id` varchar(64),
  `created_at` timestamp NOT NULL DEFAULT (now()),
  `updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `workspace_entitlements_id` PRIMARY KEY(`id`),
  CONSTRAINT `workspace_entitlements_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT,
  CONSTRAINT `workspace_entitlements_workspace_mode_unique` UNIQUE(`workspace_id`,`mode`)
);
--> statement-breakpoint
CREATE TABLE `billing_outbox` (
  `id` int AUTO_INCREMENT NOT NULL,
  `workspace_id` int NOT NULL,
  `mode` enum('test','live') NOT NULL,
  `event_type` enum('ensure_subscription','cancel_subscription','payment_warning','manual_review') NOT NULL,
  `deduplication_key` varchar(160) NOT NULL,
  `payload` json NOT NULL,
  `status` enum('pending','processing','completed','failed') NOT NULL DEFAULT 'pending',
  `attempt_count` int NOT NULL DEFAULT 0,
  `max_attempts` int NOT NULL DEFAULT 12,
  `available_at` timestamp NOT NULL DEFAULT (now()),
  `locked_at` timestamp,
  `lease_token` varchar(36),
  `last_error_code` varchar(80),
  `created_at` timestamp NOT NULL DEFAULT (now()),
  `updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `billing_outbox_id` PRIMARY KEY(`id`),
  CONSTRAINT `billing_outbox_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT,
  CONSTRAINT `billing_outbox_mode_deduplication_unique` UNIQUE(`mode`,`deduplication_key`)
);
--> statement-breakpoint
CREATE INDEX `billing_outbox_mode_status_available_idx` ON `billing_outbox` (`mode`,`status`,`available_at`);
--> statement-breakpoint
CREATE TABLE `billing_reconciliation_runs` (
  `id` int AUTO_INCREMENT NOT NULL,
  `workspace_id` int NOT NULL,
  `mode` enum('test','live') NOT NULL,
  `period_key` varchar(10) NOT NULL,
  `status` enum('running','completed','failed') NOT NULL DEFAULT 'running',
  `lease_token` varchar(36),
  `lease_until` timestamp NOT NULL,
  `summary` json,
  `started_at` timestamp NOT NULL DEFAULT (now()),
  `completed_at` timestamp,
  CONSTRAINT `billing_reconciliation_runs_id` PRIMARY KEY(`id`),
  CONSTRAINT `billing_reconciliation_runs_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT,
  CONSTRAINT `billing_reconciliation_runs_workspace_mode_period_unique` UNIQUE(`workspace_id`,`mode`,`period_key`)
);
--> statement-breakpoint
CREATE TABLE `billing_reconciliation_anomalies` (
  `id` int AUTO_INCREMENT NOT NULL,
  `run_id` int NOT NULL,
  `workspace_id` int NOT NULL,
  `code` varchar(80) NOT NULL,
  `metadata` json,
  `created_at` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `billing_reconciliation_anomalies_id` PRIMARY KEY(`id`),
  CONSTRAINT `billing_reconciliation_anomalies_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT,
  CONSTRAINT `billing_reconciliation_anomalies_run_workspace_code_unique` UNIQUE(`run_id`,`workspace_id`,`code`)
);
