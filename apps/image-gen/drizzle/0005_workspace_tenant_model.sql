CREATE TABLE `workspaceKnowledgeSources` (
  `id` int AUTO_INCREMENT NOT NULL,
  `workspaceId` int NOT NULL,
  `sourceType` enum('upload','website','manual_text','integration') NOT NULL,
  `name` varchar(200) NOT NULL,
  `sourceReference` varchar(1024),
  `status` enum('active','queued','indexing','error','disabled') NOT NULL DEFAULT 'active',
  `itemCount` int NOT NULL DEFAULT 0,
  `lastIndexedAt` timestamp,
  `metadata` json,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `workspaceKnowledgeSources_id` PRIMARY KEY(`id`),
  CONSTRAINT `workspaceKnowledgeSources_workspaceId_name_unique` UNIQUE(`workspaceId`,`name`)
);
--> statement-breakpoint
CREATE TABLE `workspacePrivacySettings` (
  `id` int AUTO_INCREMENT NOT NULL,
  `workspaceId` int NOT NULL,
  `allowKnowledgeIndexing` int NOT NULL DEFAULT 1,
  `allowUsageAnalytics` int NOT NULL DEFAULT 0,
  `imageMemoryRetentionDays` int NOT NULL DEFAULT 30,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `workspacePrivacySettings_id` PRIMARY KEY(`id`),
  CONSTRAINT `workspacePrivacySettings_workspaceId_unique` UNIQUE(`workspaceId`)
);
