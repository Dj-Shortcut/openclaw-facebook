CREATE TABLE `workspacePrivacyRequests` (
  `id` int AUTO_INCREMENT NOT NULL,
  `workspaceId` int NOT NULL,
  `userId` int NOT NULL,
  `requestType` enum('export','deletion') NOT NULL,
  `status` enum('requested','processing','completed','rejected') NOT NULL DEFAULT 'requested',
  `note` varchar(500),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  `completedAt` timestamp,
  CONSTRAINT `workspacePrivacyRequests_id` PRIMARY KEY(`id`)
);
