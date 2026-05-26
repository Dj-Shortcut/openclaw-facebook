ALTER TABLE `dailyQuota` DROP INDEX `dailyQuota_userId_unique`;
ALTER TABLE `dailyQuota` ADD UNIQUE INDEX `dailyQuota_userId_date_unique`(`userId`,`date`);
