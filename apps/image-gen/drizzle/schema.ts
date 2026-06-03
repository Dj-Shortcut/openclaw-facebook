import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, json, uniqueIndex } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extended with fields for tracking image generation quota.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * Image generation requests table.
 * Tracks each image generation request with metadata and status.
 */
export const imageRequests = mysqlTable("imageRequests", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  prompt: text("prompt").notNull(),
  imageUrl: varchar("imageUrl", { length: 2048 }), // S3 URL for generated image
  imageKey: varchar("imageKey", { length: 512 }), // S3 key for storage reference
  status: mysqlEnum("status", ["pending", "completed", "failed"]).default("pending").notNull(),
  errorMessage: text("errorMessage"), // Error details if generation failed
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  completedAt: timestamp("completedAt"), // When image generation completed
});

export type ImageRequest = typeof imageRequests.$inferSelect;
export type InsertImageRequest = typeof imageRequests.$inferInsert;

/**
 * Daily usage quota tracking table.
 * Tracks the count of images generated per user per day.
 * Reset at midnight UTC.
 */
export const dailyQuota = mysqlTable(
  "dailyQuota",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    date: varchar("date", { length: 10 }).notNull(), // YYYY-MM-DD format in UTC
    imagesGenerated: int("imagesGenerated").default(0).notNull(),
    lastGeneratedAt: timestamp("lastGeneratedAt"), // Timestamp of last generation
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => ({
    userDateUnique: uniqueIndex("dailyQuota_userId_date_unique").on(
      table.userId,
      table.date
    ),
  })
);

export type DailyQuota = typeof dailyQuota.$inferSelect;
export type InsertDailyQuota = typeof dailyQuota.$inferInsert;

/**
 * Usage statistics and analytics table.
 * Aggregated daily statistics for admin dashboard.
 */
export const usageStats = mysqlTable("usageStats", {
  id: int("id").autoincrement().primaryKey(),
  date: varchar("date", { length: 10 }).notNull().unique(), // YYYY-MM-DD format in UTC
  totalImagesGenerated: int("totalImagesGenerated").default(0).notNull(),
  totalUsersActive: int("totalUsersActive").default(0).notNull(),
  totalFailedRequests: int("totalFailedRequests").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type UsageStats = typeof usageStats.$inferSelect;
export type InsertUsageStats = typeof usageStats.$inferInsert;

/**
 * System notifications log.
 * Tracks owner notifications sent for milestones and alerts.
 */
export const notificationLog = mysqlTable("notificationLog", {
  id: int("id").autoincrement().primaryKey(),
  type: mysqlEnum("type", ["milestone", "error", "quota_warning", "system_alert"]).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  content: text("content").notNull(),
  metadata: json("metadata"), // Additional context as JSON
  sent: int("sent").default(0).notNull(), // Boolean: 1 = sent, 0 = failed
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type NotificationLog = typeof notificationLog.$inferSelect;
export type InsertNotificationLog = typeof notificationLog.$inferInsert;

/**
 * Messenger user state tracking table.
 * Persists user conversation stage and metadata across server restarts.
 */
export const messengerState = mysqlTable("messengerState", {
  id: int("id").autoincrement().primaryKey(),
  psid: varchar("psid", { length: 64 }).notNull().unique(), // Facebook Page-Scoped ID
  userKey: varchar("userKey", { length: 64 }).notNull().unique(), // Anonymized PSID
  stage: mysqlEnum("stage", ["IDLE", "AWAITING_PHOTO", "AWAITING_STYLE", "PROCESSING", "RESULT_READY", "FAILURE"]).default("IDLE").notNull(),
  lastPhotoUrl: varchar("lastPhotoUrl", { length: 2048 }), // S3 URL for uploaded photo
  selectedStyle: varchar("selectedStyle", { length: 64 }),
  preferredLang: varchar("preferredLang", { length: 10 }).default("nl").notNull(),
  lastGeneratedUrl: varchar("lastGeneratedUrl", { length: 2048 }),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type MessengerState = typeof messengerState.$inferSelect;
export type InsertMessengerState = typeof messengerState.$inferInsert;

/**
 * Customer portal workspace owned by one or more authenticated customer users.
 * All portal APIs must scope reads and writes through workspace membership.
 */
export const workspaces = mysqlTable("workspaces", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 160 }).notNull(),
  slug: varchar("slug", { length: 160 }).notNull().unique(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Workspace = typeof workspaces.$inferSelect;
export type InsertWorkspace = typeof workspaces.$inferInsert;

export const workspaceMembers = mysqlTable(
  "workspaceMembers",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    userId: int("userId").notNull(),
    role: mysqlEnum("role", ["owner", "admin", "member"]).default("member").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => ({
    workspaceUserUnique: uniqueIndex("workspaceMembers_workspaceId_userId_unique").on(
      table.workspaceId,
      table.userId
    ),
  })
);

export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type InsertWorkspaceMember = typeof workspaceMembers.$inferInsert;

export const aiIdentities = mysqlTable("aiIdentities", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull().unique(),
  name: varchar("name", { length: 120 }).notNull(),
  instructions: text("instructions"),
  tone: varchar("tone", { length: 80 }).default("Helpful").notNull(),
  language: varchar("language", { length: 16 }).default("nl").notNull(),
  modelDefault: varchar("modelDefault", { length: 80 }).default("default").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type AiIdentity = typeof aiIdentities.$inferSelect;
export type InsertAiIdentity = typeof aiIdentities.$inferInsert;

export const channelConnections = mysqlTable(
  "channelConnections",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    channel: mysqlEnum("channel", ["facebook_messenger", "whatsapp", "web"]).notNull(),
    status: mysqlEnum("status", ["connected", "missing_permissions", "token_expired", "webhook_unhealthy", "disconnected"]).default("disconnected").notNull(),
    externalId: varchar("externalId", { length: 160 }),
    displayName: varchar("displayName", { length: 255 }),
    encryptedAccessToken: text("encryptedAccessToken"),
    grantedScopes: json("grantedScopes"),
    lastCheckedAt: timestamp("lastCheckedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => ({
    workspaceChannelUnique: uniqueIndex("channelConnections_workspace_channel_unique").on(
      table.workspaceId,
      table.channel
    ),
  })
);

export type ChannelConnection = typeof channelConnections.$inferSelect;
export type InsertChannelConnection = typeof channelConnections.$inferInsert;

export const workspaceUsageDaily = mysqlTable(
  "workspaceUsageDaily",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    date: varchar("date", { length: 10 }).notNull(),
    messageCount: int("messageCount").default(0).notNull(),
    imageCount: int("imageCount").default(0).notNull(),
    blockedCount: int("blockedCount").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => ({
    workspaceDateUnique: uniqueIndex("workspaceUsageDaily_workspaceId_date_unique").on(
      table.workspaceId,
      table.date
    ),
  })
);

export type WorkspaceUsageDaily = typeof workspaceUsageDaily.$inferSelect;
export type InsertWorkspaceUsageDaily = typeof workspaceUsageDaily.$inferInsert;

export const auditLog = mysqlTable("auditLog", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull(),
  userId: int("userId").notNull(),
  event: varchar("event", { length: 120 }).notNull(),
  metadata: json("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type AuditLog = typeof auditLog.$inferSelect;
export type InsertAuditLog = typeof auditLog.$inferInsert;
