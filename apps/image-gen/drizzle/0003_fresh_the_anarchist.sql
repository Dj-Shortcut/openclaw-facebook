ALTER TABLE `dailyQuota` DROP INDEX `dailyQuota_userId_unique`;--> statement-breakpoint
ALTER TABLE `dailyQuota` ADD CONSTRAINT `dailyQuota_userId_date_unique` UNIQUE(`userId`,`date`);