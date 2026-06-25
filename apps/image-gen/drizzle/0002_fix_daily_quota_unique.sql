SET @drop_userId_unique_sql := (
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'dailyQuota'
        AND INDEX_NAME = 'dailyQuota_userId_unique'
    ) THEN 'ALTER TABLE `dailyQuota` DROP INDEX `dailyQuota_userId_unique`'
    ELSE 'SELECT 1'
  END
);

SET @drop_userId_date_unique_sql := (
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'dailyQuota'
        AND INDEX_NAME = 'dailyQuota_userId_date_unique'
    ) THEN 'ALTER TABLE `dailyQuota` DROP INDEX `dailyQuota_userId_date_unique`'
    ELSE 'SELECT 1'
  END
);

PREPARE drop_userId_unique_statement FROM @drop_userId_unique_sql;
EXECUTE drop_userId_unique_statement;
DEALLOCATE PREPARE drop_userId_unique_statement;

PREPARE drop_userId_date_unique_statement FROM @drop_userId_date_unique_sql;
EXECUTE drop_userId_date_unique_statement;
DEALLOCATE PREPARE drop_userId_date_unique_statement;

--> statement-breakpoint

ALTER TABLE `dailyQuota` ADD UNIQUE INDEX `dailyQuota_userId_date_unique`(`userId`,`date`);
