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

--> statement-breakpoint

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

--> statement-breakpoint

PREPARE drop_userId_unique_statement FROM @drop_userId_unique_sql;

--> statement-breakpoint

EXECUTE drop_userId_unique_statement;

--> statement-breakpoint

DEALLOCATE PREPARE drop_userId_unique_statement;

--> statement-breakpoint

PREPARE drop_userId_date_unique_statement FROM @drop_userId_date_unique_sql;

--> statement-breakpoint

EXECUTE drop_userId_date_unique_statement;

--> statement-breakpoint

DEALLOCATE PREPARE drop_userId_date_unique_statement;

--> statement-breakpoint

ALTER TABLE `dailyQuota` ADD UNIQUE INDEX `dailyQuota_userId_date_unique`(`userId`,`date`);
