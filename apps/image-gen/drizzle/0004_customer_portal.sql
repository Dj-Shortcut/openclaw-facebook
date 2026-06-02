CREATE TABLE `workspaces` (
  `id` int AUTO_INCREMENT NOT NULL,
  `name` varchar(160) NOT NULL,
  `slug` varchar(160) NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `workspaces_id` PRIMARY KEY(`id`),
  CONSTRAINT `workspaces_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `workspaceMembers` (
  `id` int AUTO_INCREMENT NOT NULL,
  `workspaceId` int NOT NULL,
  `userId` int NOT NULL,
  `role` enum('owner','admin','member') NOT NULL DEFAULT 'owner',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `workspaceMembers_id` PRIMARY KEY(`id`),
  CONSTRAINT `workspaceMembers_workspaceId_userId_unique` UNIQUE(`workspaceId`,`userId`)
);
--> statement-breakpoint
CREATE TABLE `aiIdentities` (
  `id` int AUTO_INCREMENT NOT NULL,
  `workspaceId` int NOT NULL,
  `name` varchar(120) NOT NULL,
  `instructions` text,
  `tone` varchar(80) NOT NULL DEFAULT 'Helpful',
  `language` varchar(16) NOT NULL DEFAULT 'nl',
  `modelDefault` varchar(80) NOT NULL DEFAULT 'default',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `aiIdentities_id` PRIMARY KEY(`id`),
  CONSTRAINT `aiIdentities_workspaceId_unique` UNIQUE(`workspaceId`)
);
--> statement-breakpoint
CREATE TABLE `channelConnections` (
  `id` int AUTO_INCREMENT NOT NULL,
  `workspaceId` int NOT NULL,
  `channel` enum('facebook_messenger','whatsapp','web') NOT NULL,
  `status` enum('connected','missing_permissions','token_expired','webhook_unhealthy','disconnected') NOT NULL DEFAULT 'disconnected',
  `externalId` varchar(160),
  `displayName` varchar(255),
  `encryptedAccessToken` text,
  `grantedScopes` json,
  `lastCheckedAt` timestamp,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `channelConnections_id` PRIMARY KEY(`id`),
  CONSTRAINT `channelConnections_workspace_channel_external_unique` UNIQUE(`workspaceId`,`channel`,`externalId`)
);
--> statement-breakpoint
CREATE TABLE `workspaceUsageDaily` (
  `id` int AUTO_INCREMENT NOT NULL,
  `workspaceId` int NOT NULL,
  `date` varchar(10) NOT NULL,
  `messageCount` int NOT NULL DEFAULT 0,
  `imageCount` int NOT NULL DEFAULT 0,
  `blockedCount` int NOT NULL DEFAULT 0,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `workspaceUsageDaily_id` PRIMARY KEY(`id`),
  CONSTRAINT `workspaceUsageDaily_workspaceId_date_unique` UNIQUE(`workspaceId`,`date`)
);
--> statement-breakpoint
CREATE TABLE `auditLog` (
  `id` int AUTO_INCREMENT NOT NULL,
  `workspaceId` int NOT NULL,
  `userId` int NOT NULL,
  `event` varchar(120) NOT NULL,
  `metadata` json,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `auditLog_id` PRIMARY KEY(`id`)
);
