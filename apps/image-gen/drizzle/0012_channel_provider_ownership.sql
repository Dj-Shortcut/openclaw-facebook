ALTER TABLE `channelConnections` ADD CONSTRAINT `channelConnections_channel_providerAccountExternalId_unique` UNIQUE(`channel`,`providerAccountExternalId`);
