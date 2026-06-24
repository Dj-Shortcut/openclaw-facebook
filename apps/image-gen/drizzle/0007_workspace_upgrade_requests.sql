CREATE TABLE `workspaceUpgradeRequests` (
  `id` int AUTO_INCREMENT NOT NULL,
  `workspaceId` int NOT NULL,
  `userId` int NOT NULL,
  `status` enum('requested','contacted','completed','rejected') NOT NULL DEFAULT 'requested',
  `currentPlanName` varchar(80) NOT NULL,
  `billingStatus` varchar(80) NOT NULL,
  `upgradeReason` varchar(120),
  `imagesRemainingToday` int NOT NULL DEFAULT 0,
  `blockedToday` int NOT NULL DEFAULT 0,
  `requestedPlanName` varchar(80) NOT NULL DEFAULT 'Premium',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  `completedAt` timestamp,
  CONSTRAINT `workspaceUpgradeRequests_id` PRIMARY KEY(`id`),
  KEY `workspaceUpgradeRequests_workspaceId_id_idx` (`workspaceId`,`id`)
);
