CREATE TABLE `portalHandoffTokens` (
  `id` int AUTO_INCREMENT NOT NULL,
  `workspaceId` int NOT NULL,
  `tokenHash` varchar(96) NOT NULL,
  `messengerSenderUserKey` varchar(96),
  `purpose` enum('workspace_onboarding') NOT NULL,
  `status` enum('pending','consumed','expired','revoked') NOT NULL DEFAULT 'pending',
  `expiresAt` timestamp NOT NULL,
  `consumedAt` timestamp,
  `createdByUserId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  `updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `portalHandoffTokens_id` PRIMARY KEY(`id`),
  CONSTRAINT `portalHandoffTokens_tokenHash_unique` UNIQUE(`tokenHash`),
  KEY `portalHandoffTokens_workspace_status_idx` (`workspaceId`,`status`)
);
