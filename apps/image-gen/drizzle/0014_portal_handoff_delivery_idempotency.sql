ALTER TABLE `portalHandoffTokens` ADD `deliveryIdempotencyKeyHash` varchar(96);--> statement-breakpoint
CREATE UNIQUE INDEX `portalHandoffTokens_delivery_key_hash_unique` ON `portalHandoffTokens` (`deliveryIdempotencyKeyHash`);
