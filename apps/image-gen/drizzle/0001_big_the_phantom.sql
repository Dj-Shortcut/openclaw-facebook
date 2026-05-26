CREATE TABLE `dailyQuota` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`date` varchar(10) NOT NULL,
	`imagesGenerated` int NOT NULL DEFAULT 0,
	`lastGeneratedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `dailyQuota_id` PRIMARY KEY(`id`),
	CONSTRAINT `dailyQuota_userId_unique` UNIQUE(`userId`)
);
--> statement-breakpoint
CREATE TABLE `imageRequests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`prompt` text NOT NULL,
	`imageUrl` varchar(2048),
	`imageKey` varchar(512),
	`status` enum('pending','completed','failed') NOT NULL DEFAULT 'pending',
	`errorMessage` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	CONSTRAINT `imageRequests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `notificationLog` (
	`id` int AUTO_INCREMENT NOT NULL,
	`type` enum('milestone','error','quota_warning','system_alert') NOT NULL,
	`title` varchar(255) NOT NULL,
	`content` text NOT NULL,
	`metadata` json,
	`sent` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `notificationLog_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `usageStats` (
	`id` int AUTO_INCREMENT NOT NULL,
	`date` varchar(10) NOT NULL,
	`totalImagesGenerated` int NOT NULL DEFAULT 0,
	`totalUsersActive` int NOT NULL DEFAULT 0,
	`totalFailedRequests` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `usageStats_id` PRIMARY KEY(`id`),
	CONSTRAINT `usageStats_date_unique` UNIQUE(`date`)
);
