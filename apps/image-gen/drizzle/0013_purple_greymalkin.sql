ALTER TABLE `billing_outbox` MODIFY COLUMN `event_type` enum('ensure_subscription','cancel_subscription','payment_warning','manual_review','send_portal_handoff') NOT NULL;--> statement-breakpoint
ALTER TABLE `billing_intents` ADD `messenger_sender_user_key` varchar(96);--> statement-breakpoint
ALTER TABLE `billing_intents` ADD `messenger_page_id` varchar(160);--> statement-breakpoint
ALTER TABLE `portalHandoffTokens` ADD `facebookPageId` varchar(160);--> statement-breakpoint
ALTER TABLE `portalHandoffTokens` ADD `claimedByUserId` int;