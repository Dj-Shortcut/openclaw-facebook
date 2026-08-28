import {
  boolean,
  check,
  decimal,
  foreignKey,
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
  json,
  index,
  primaryKey,
  uniqueIndex,
} from "drizzle-orm/mysql-core";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

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
  status: mysqlEnum("status", ["pending", "completed", "failed"])
    .default("pending")
    .notNull(),
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
  type: mysqlEnum("type", [
    "milestone",
    "error",
    "quota_warning",
    "system_alert",
  ]).notNull(),
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
  stage: mysqlEnum("stage", [
    "IDLE",
    "AWAITING_PHOTO",
    "AWAITING_STYLE",
    "PROCESSING",
    "RESULT_READY",
    "FAILURE",
  ])
    .default("IDLE")
    .notNull(),
  lastPhotoUrl: varchar("lastPhotoUrl", { length: 2048 }), // S3 URL for uploaded photo
  selectedStyle: varchar("selectedStyle", { length: 64 }),
  preferredLang: varchar("preferredLang", { length: 10 })
    .default("nl")
    .notNull(),
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
    role: mysqlEnum("role", ["owner", "admin", "member"])
      .default("member")
      .notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => ({
    workspaceUserUnique: uniqueIndex(
      "workspaceMembers_workspaceId_userId_unique"
    ).on(table.workspaceId, table.userId),
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
  modelDefault: varchar("modelDefault", { length: 80 })
    .default("default")
    .notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type AiIdentity = typeof aiIdentities.$inferSelect;
export type InsertAiIdentity = typeof aiIdentities.$inferInsert;

export const channelConnections = mysqlTable(
  "channelConnections",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    channel: mysqlEnum("channel", [
      "facebook_messenger",
      "whatsapp",
      "web",
    ]).notNull(),
    status: mysqlEnum("status", [
      "connected",
      "missing_permissions",
      "token_expired",
      "webhook_unhealthy",
      "disconnected",
    ])
      .default("disconnected")
      .notNull(),
    externalId: varchar("externalId", { length: 160 }),
    providerAccountExternalId: varchar("providerAccountExternalId", {
      length: 160,
    }),
    displayName: varchar("displayName", { length: 255 }),
    encryptedAccessToken: text("encryptedAccessToken"),
    bindingEpoch: int("bindingEpoch").default(1).notNull(),
    grantedScopes: json("grantedScopes"),
    lastCheckedAt: timestamp("lastCheckedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => ({
    workspaceChannelUnique: uniqueIndex(
      "channelConnections_workspace_channel_unique"
    ).on(table.workspaceId, table.channel),
    channelExternalIdUnique: uniqueIndex(
      "channelConnections_channel_externalId_unique"
    ).on(table.channel, table.externalId),
    channelProviderAccountExternalIdUnique: uniqueIndex(
      "channelConnections_channel_providerAccountExternalId_unique"
    ).on(table.channel, table.providerAccountExternalId),
    idWorkspaceUnique: uniqueIndex("channelConnections_id_workspace_unique").on(
      table.id,
      table.workspaceId
    ),
    idWorkspaceBindingUnique: uniqueIndex(
      "channelConnections_id_workspace_binding_unique"
    ).on(table.id, table.workspaceId, table.bindingEpoch),
  })
);

export type ChannelConnection = typeof channelConnections.$inferSelect;
export type InsertChannelConnection = typeof channelConnections.$inferInsert;

export const messengerPrivacySubjects = mysqlTable(
  "messenger_privacy_subjects",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspace_id").notNull(),
    channelConnectionId: int("channel_connection_id").notNull(),
    userKey: varchar("user_key", { length: 96 }).notNull(),
    privacyEpoch: int("privacy_epoch").default(1).notNull(),
    status: mysqlEnum("status", ["active", "erasing", "erased"])
      .default("active")
      .notNull(),
    erasedAt: timestamp("erased_at"),
    lastErasedAt: timestamp("last_erased_at", { fsp: 3 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    foreignKey({
      name: "messenger_privacy_subject_connection_workspace_fk",
      columns: [table.channelConnectionId, table.workspaceId],
      foreignColumns: [channelConnections.id, channelConnections.workspaceId],
    }).onDelete("restrict"),
    uniqueIndex("messenger_privacy_subject_scope_unique").on(
      table.workspaceId,
      table.channelConnectionId,
      table.userKey
    ),
    uniqueIndex("messenger_privacy_subject_epoch_unique").on(
      table.workspaceId,
      table.channelConnectionId,
      table.userKey,
      table.privacyEpoch
    ),
    check(
      "messenger_privacy_subject_epoch_positive",
      sql`${table.privacyEpoch} > 0`
    ),
    check(
      "messenger_privacy_subject_erased_timestamp",
      sql`(${table.status} = 'erased' AND ${table.erasedAt} IS NOT NULL) OR (${table.status} <> 'erased' AND ${table.erasedAt} IS NULL)`
    ),
    index("messenger_privacy_subject_status_idx").on(
      table.workspaceId,
      table.status,
      table.updatedAt
    ),
  ]
);

export const workspaceKnowledgeSources = mysqlTable(
  "workspaceKnowledgeSources",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    sourceType: mysqlEnum("sourceType", [
      "upload",
      "website",
      "manual_text",
      "integration",
    ]).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    sourceReference: varchar("sourceReference", { length: 1024 }),
    status: mysqlEnum("status", [
      "active",
      "queued",
      "indexing",
      "error",
      "disabled",
    ])
      .default("active")
      .notNull(),
    itemCount: int("itemCount").default(0).notNull(),
    lastIndexedAt: timestamp("lastIndexedAt"),
    metadata: json("metadata"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => ({
    workspaceKnowledgeSourceWorkspaceNameUnique: uniqueIndex(
      "workspaceKnowledgeSources_workspaceId_name_unique"
    ).on(table.workspaceId, table.name),
  })
);

export type WorkspaceKnowledgeSource =
  typeof workspaceKnowledgeSources.$inferSelect;
export type InsertWorkspaceKnowledgeSource =
  typeof workspaceKnowledgeSources.$inferInsert;

export const workspacePrivacySettings = mysqlTable(
  "workspacePrivacySettings",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    allowKnowledgeIndexing: int("allowKnowledgeIndexing").default(1).notNull(),
    allowUsageAnalytics: int("allowUsageAnalytics").default(0).notNull(),
    imageMemoryRetentionDays: int("imageMemoryRetentionDays")
      .default(30)
      .notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => ({
    workspacePrivacySettingsWorkspaceUnique: uniqueIndex(
      "workspacePrivacySettings_workspaceId_unique"
    ).on(table.workspaceId),
  })
);

export type WorkspacePrivacySetting =
  typeof workspacePrivacySettings.$inferSelect;
export type InsertWorkspacePrivacySetting =
  typeof workspacePrivacySettings.$inferInsert;

export const workspacePrivacyRequests = mysqlTable(
  "workspacePrivacyRequests",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    userId: int("userId").notNull(),
    requestType: mysqlEnum("requestType", ["export", "deletion"]).notNull(),
    status: mysqlEnum("status", [
      "requested",
      "processing",
      "completed",
      "rejected",
    ])
      .default("requested")
      .notNull(),
    note: varchar("note", { length: 500 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
    completedAt: timestamp("completedAt"),
  },
  table => ({
    workspacePrivacyRequestsWorkspaceIdIdx: index(
      "workspacePrivacyRequests_workspaceId_id_idx"
    ).on(table.workspaceId, table.id),
  })
);

export type WorkspacePrivacyRequest =
  typeof workspacePrivacyRequests.$inferSelect;
export type InsertWorkspacePrivacyRequest =
  typeof workspacePrivacyRequests.$inferInsert;

export const workspaceUpgradeRequests = mysqlTable(
  "workspaceUpgradeRequests",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    userId: int("userId").notNull(),
    status: mysqlEnum("status", [
      "requested",
      "contacted",
      "completed",
      "rejected",
    ])
      .default("requested")
      .notNull(),
    currentPlanName: varchar("currentPlanName", { length: 80 }).notNull(),
    billingStatus: varchar("billingStatus", { length: 80 }).notNull(),
    upgradeReason: varchar("upgradeReason", { length: 120 }),
    imagesRemainingToday: int("imagesRemainingToday").default(0).notNull(),
    blockedToday: int("blockedToday").default(0).notNull(),
    requestedPlanName: varchar("requestedPlanName", { length: 80 })
      .default("Premium")
      .notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
    completedAt: timestamp("completedAt"),
  },
  table => ({
    workspaceUpgradeRequestsWorkspaceIdIdx: index(
      "workspaceUpgradeRequests_workspaceId_id_idx"
    ).on(table.workspaceId, table.id),
  })
);

export type WorkspaceUpgradeRequest =
  typeof workspaceUpgradeRequests.$inferSelect;
export type InsertWorkspaceUpgradeRequest =
  typeof workspaceUpgradeRequests.$inferInsert;

export const portalHandoffTokens = mysqlTable(
  "portalHandoffTokens",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    tokenHash: varchar("tokenHash", { length: 96 }).notNull(),
    capabilityGeneration: int("capability_generation").default(1).notNull(),
    /** SHA-256 of the stable outbox delivery operation; never the raw key. */
    deliveryIdempotencyKeyHash: varchar("deliveryIdempotencyKeyHash", {
      length: 96,
    }),
    messengerSenderUserKey: varchar("messengerSenderUserKey", { length: 96 }),
    facebookPageId: varchar("facebookPageId", { length: 160 }),
    messengerChannelConnectionId: int("messenger_channel_connection_id"),
    messengerPrivacyEpoch: int("messenger_privacy_epoch"),
    claimedByUserId: int("claimedByUserId"),
    purpose: mysqlEnum("purpose", ["workspace_onboarding"]).notNull(),
    status: mysqlEnum("status", ["pending", "consumed", "expired", "revoked"])
      .default("pending")
      .notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    consumedAt: timestamp("consumedAt"),
    createdByUserId: int("createdByUserId"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("portalHandoffTokens_tokenHash_unique").on(table.tokenHash),
    uniqueIndex("portalHandoffTokens_delivery_key_hash_unique").on(
      table.deliveryIdempotencyKeyHash
    ),
    index("portalHandoffTokens_workspace_status_idx").on(
      table.workspaceId,
      table.status
    ),
  ]
);

export type PortalHandoffToken = typeof portalHandoffTokens.$inferSelect;
export type InsertPortalHandoffToken = typeof portalHandoffTokens.$inferInsert;

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
    workspaceDateUnique: uniqueIndex(
      "workspaceUsageDaily_workspaceId_date_unique"
    ).on(table.workspaceId, table.date),
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

/**
 * Mollie billing records are deliberately workspace-scoped. Provider IDs and
 * idempotency keys are backend-only and must never be exposed to model prompts.
 */
export const billingCustomers = mysqlTable(
  "billing_customers",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    mode: mysqlEnum("mode", ["test", "live"]).notNull(),
    mollieCustomerId: varchar("mollie_customer_id", { length: 64 }),
    externalReference: varchar("external_reference", { length: 64 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 96 }).notNull(),
    status: mysqlEnum("status", [
      "provisioning",
      "creating_customer",
      "active",
      "manual_review",
    ])
      .default("provisioning")
      .notNull(),
    nextReconciliationAt: timestamp("next_reconciliation_at")
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("billing_customers_workspace_mode_unique").on(
      table.workspaceId,
      table.mode
    ),
    uniqueIndex("billing_customers_mollie_customer_mode_unique").on(
      table.mode,
      table.mollieCustomerId
    ),
    uniqueIndex("billing_customers_external_reference_unique").on(
      table.externalReference
    ),
    uniqueIndex("billing_customers_idempotency_unique").on(
      table.idempotencyKey
    ),
    index("billing_customers_mode_reconciliation_idx").on(
      table.mode,
      table.nextReconciliationAt
    ),
  ]
);

export type BillingCustomer = typeof billingCustomers.$inferSelect;
export type InsertBillingCustomer = typeof billingCustomers.$inferInsert;

/** Server-owned billing eligibility; checkout request bodies are never authoritative. */
export const workspaceBillingProfiles = mysqlTable(
  "workspace_billing_profiles",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    countryCode: varchar("country_code", { length: 2 }).notNull(),
    customerType: mysqlEnum("customer_type", [
      "consumer",
      "business",
    ]).notNull(),
    verificationStatus: mysqlEnum("verification_status", [
      "unverified",
      "verified",
      "rejected",
      "revoked",
    ])
      .default("unverified")
      .notNull(),
    verificationMethod: varchar("verification_method", { length: 48 }),
    evidenceReferenceHash: varchar("evidence_reference_hash", { length: 96 }),
    verifiedAt: timestamp("verified_at"),
    verificationExpiresAt: timestamp("verification_expires_at"),
    revokedAt: timestamp("revoked_at"),
    verifiedByUserId: int("verified_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    peppolReady: boolean("peppol_ready").default(false).notNull(),
    eligibilityVersion: int("eligibility_version").default(1).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("workspace_billing_profiles_workspace_unique").on(
      table.workspaceId
    ),
    index("workspace_billing_profiles_verification_idx").on(
      table.verificationStatus,
      table.countryCode
    ),
  ]
);

export type WorkspaceBillingProfile =
  typeof workspaceBillingProfiles.$inferSelect;
export type InsertWorkspaceBillingProfile =
  typeof workspaceBillingProfiles.$inferInsert;

/** Linear commercial-billing authorization fence; safety drains remain independent. */
export const billingExecutionControls = mysqlTable(
  "billing_execution_controls",
  {
    workspaceId: int("workspace_id").notNull(),
    mode: mysqlEnum("mode", ["test", "live"]).notNull(),
    commercialEnabled: boolean("commercial_enabled").default(false).notNull(),
    authorizationEpoch: int("authorization_epoch").default(1).notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    foreignKey({
      name: "billing_execution_controls_workspace_fk",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("restrict"),
    primaryKey({ columns: [table.workspaceId, table.mode] }),
    check(
      "billing_execution_controls_epoch_positive",
      sql`${table.authorizationEpoch} > 0`
    ),
  ]
);

/** Metadata-only idempotency and audit fence for privileged profile actions. */
export const billingProfileOperatorActions = mysqlTable(
  "billing_profile_operator_actions",
  {
    requestId: varchar("request_id", { length: 36 }).primaryKey(),
    workspaceId: int("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    actorUserId: int("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    action: mysqlEnum("action", ["attest", "revoke"]).notNull(),
    expectedVersion: int("expected_version").notNull(),
    resultingVersion: int("resulting_version").notNull(),
    requestFingerprint: varchar("request_fingerprint", {
      length: 64,
    }).notNull(),
    reason: varchar("reason", { length: 160 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  table => [
    index("billing_profile_operator_actions_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt
    ),
  ]
);

/** Metadata-only tenant registry used by replica-safe billing schedulers. */
export const billingSchedulerTenants = mysqlTable(
  "billing_scheduler_tenants",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    mode: mysqlEnum("mode", ["test", "live"]).notNull(),
    kind: mysqlEnum("kind", [
      "outbox",
      "reconciliation",
      "profile_expiry",
      "ai_finalization",
    ]).notNull(),
    enabled: boolean("enabled").default(false).notNull(),
    executionEpoch: int("execution_epoch").default(1).notNull(),
    operatorRequestId: varchar("operator_request_id", { length: 36 }),
    operatorRequestFingerprint: varchar("operator_request_fingerprint", {
      length: 64,
    }),
    enabledByUserId: int("enabled_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    enabledAt: timestamp("enabled_at"),
    pendingWorkCount: int("pending_work_count").default(0).notNull(),
    deadLetterCount: int("dead_letter_count").default(0).notNull(),
    nextDueAt: timestamp("next_due_at").defaultNow().notNull(),
    leaseToken: varchar("lease_token", { length: 36 }),
    leaseUntil: timestamp("lease_until"),
    lastServedAt: timestamp("last_served_at"),
    consecutiveFailures: int("consecutive_failures").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("billing_scheduler_tenants_workspace_mode_kind_unique").on(
      table.workspaceId,
      table.mode,
      table.kind
    ),
    index("billing_scheduler_tenants_due_idx").on(
      table.mode,
      table.kind,
      table.enabled,
      table.nextDueAt,
      table.lastServedAt
    ),
    index("billing_scheduler_tenants_lease_idx").on(
      table.leaseUntil,
      table.leaseToken
    ),
    check(
      "billing_scheduler_execution_epoch_positive",
      sql`${table.executionEpoch} > 0`
    ),
    check(
      "billing_scheduler_counters_nonnegative",
      sql`${table.pendingWorkCount} >= 0 AND ${table.deadLetterCount} >= 0`
    ),
    check(
      "billing_scheduler_enabled_audit_required",
      sql`${table.enabled} = false OR ${table.kind} = 'outbox' OR (${table.operatorRequestId} IS NOT NULL AND ${table.operatorRequestFingerprint} IS NOT NULL AND ${table.enabledByUserId} IS NOT NULL AND ${table.enabledAt} IS NOT NULL)`
    ),
    check(
      "billing_scheduler_lease_pair",
      sql`(${table.leaseToken} IS NULL AND ${table.leaseUntil} IS NULL) OR (${table.leaseToken} IS NOT NULL AND ${table.leaseUntil} IS NOT NULL)`
    ),
  ]
);

export const billingNotificationSchedulerTenants = mysqlTable(
  "billing_notification_scheduler_tenants",
  {
    workspaceId: int("workspace_id").notNull(),
    mode: mysqlEnum("mode", ["test", "live"]).notNull(),
    nextDueAt: timestamp("next_due_at").defaultNow().notNull(),
    leaseToken: varchar("lease_token", { length: 36 }),
    leaseUntil: timestamp("lease_until"),
    lastServedAt: timestamp("last_served_at"),
    pendingWorkCount: int("pending_work_count").default(0).notNull(),
    deadLetterCount: int("dead_letter_count").default(0).notNull(),
  },
  table => [
    foreignKey({
      name: "billing_notification_scheduler_workspace_fk",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("restrict"),
    primaryKey({ columns: [table.workspaceId, table.mode] }),
    check(
      "billing_notification_scheduler_pending_nonnegative",
      sql`${table.pendingWorkCount} >= 0`
    ),
    check(
      "billing_notification_scheduler_dead_nonnegative",
      sql`${table.deadLetterCount} >= 0`
    ),
    index("billing_notification_scheduler_due_idx").on(
      table.mode,
      table.nextDueAt,
      table.lastServedAt
    ),
  ]
);

/** One metadata-only liveness row per scheduler process and lane. */
export const billingSchedulerProcessHeartbeats = mysqlTable(
  "billing_scheduler_process_heartbeats",
  {
    processId: varchar("process_id", { length: 96 }).notNull(),
    mode: mysqlEnum("mode", ["test", "live"]).notNull(),
    kind: mysqlEnum("kind", [
      "outbox",
      "reconciliation",
      "profile_expiry",
      "ai_finalization",
      "notification_receiver",
    ]).notNull(),
    status: mysqlEnum("status", ["starting", "polling", "stopped"])
      .default("starting")
      .notNull(),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    lastPollAt: timestamp("last_poll_at").notNull(),
  },
  table => [primaryKey({ columns: [table.processId, table.mode, table.kind] })]
);

export const messengerProviderAttemptFences = mysqlTable(
  "messenger_provider_attempt_fences",
  {
    id: int("id").autoincrement().primaryKey(),
    attemptKeyHash: varchar("attempt_key_hash", { length: 64 }).notNull(),
    workspaceId: int("workspace_id")
      .notNull()
      .references(() => workspaces.id, {
        onDelete: "restrict",
      }),
    channelConnectionId: int("channel_connection_id").notNull(),
    bindingEpoch: int("binding_epoch").notNull(),
    userKey: varchar("user_key", { length: 96 }).notNull(),
    privacyEpoch: int("privacy_epoch").notNull(),
    providerOperation: varchar("provider_operation", { length: 48 }).notNull(),
    attemptNumber: int("attempt_number").notNull(),
    status: mysqlEnum("status", [
      "reserved",
      "started",
      "known_failed",
      "succeeded",
      "ambiguous",
      "contained",
      "abandoned",
    ]).notNull(),
    leaseToken: varchar("lease_token", { length: 36 }).notNull(),
    leaseUntil: timestamp("lease_until").notNull(),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    foreignKey({
      name: "messenger_provider_fence_static_connection_fk",
      columns: [table.channelConnectionId, table.workspaceId],
      foreignColumns: [channelConnections.id, channelConnections.workspaceId],
    }).onDelete("restrict"),
    foreignKey({
      name: "messenger_provider_fence_static_subject_fk",
      columns: [table.workspaceId, table.channelConnectionId, table.userKey],
      foreignColumns: [
        messengerPrivacySubjects.workspaceId,
        messengerPrivacySubjects.channelConnectionId,
        messengerPrivacySubjects.userKey,
      ],
    }).onDelete("restrict"),
    uniqueIndex("messenger_provider_attempt_fences_attempt_unique").on(
      table.attemptKeyHash
    ),
    index("messenger_provider_attempt_fences_connection_active_idx").on(
      table.channelConnectionId,
      table.status,
      table.leaseUntil
    ),
    check(
      "messenger_provider_attempt_epochs_positive",
      sql`${table.bindingEpoch} > 0 AND ${table.privacyEpoch} > 0 AND ${table.attemptNumber} > 0`
    ),
    check(
      "messenger_provider_attempt_started_timestamp",
      sql`${table.status} NOT IN ('started','ambiguous','succeeded') OR ${table.startedAt} IS NOT NULL`
    ),
  ]
);

export const billingIntents = mysqlTable(
  "billing_intents",
  {
    intentId: varchar("intent_id", { length: 36 }).primaryKey(),
    workspaceId: int("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    mode: mysqlEnum("mode", ["test", "live"]).notNull(),
    planCode: varchar("plan_code", { length: 80 }).notNull(),
    kind: mysqlEnum("kind", [
      "subscription_start",
      "payment_method_change",
      "startpilot_purchase",
      "credit_purchase",
    ])
      .default("subscription_start")
      .notNull(),
    expectedAmount: decimal("expected_amount", {
      precision: 10,
      scale: 2,
    }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    interval: varchar("interval", { length: 32 }).notNull(),
    entitlements: json("entitlements").notNull(),
    mollieDescription: varchar("mollie_description", { length: 255 }).notNull(),
    status: mysqlEnum("status", [
      "created",
      "creating_payment",
      "open",
      "paid",
      "failed",
      "canceled",
      "expired",
      "mismatch",
      "contained",
      "api_unknown",
    ])
      .default("created")
      .notNull(),
    molliePaymentId: varchar("mollie_payment_id", { length: 64 }),
    idempotencyKey: varchar("idempotency_key", { length: 96 }).notNull(),
    checkoutScopeKey: varchar("checkout_scope_key", { length: 160 }).notNull(),
    /** Exact privacy-subject key (legacy HMAC or versioned key); never a raw PSID. */
    messengerSenderUserKey: varchar("messenger_sender_user_key", {
      length: 96,
    }),
    /** Receiving Facebook Page bound to the handoff checkout. */
    messengerPageId: varchar("messenger_page_id", { length: 160 }),
    /** Immutable channel scope that authorized the Messenger checkout handoff. */
    messengerChannelConnectionId: int("messenger_channel_connection_id"),
    /** Immutable Page-binding epoch for a direct Messenger credit purchase. */
    messengerBindingEpoch: int("messenger_binding_epoch"),
    /** Privacy epoch snapshot; historical rows never follow a reactivated subject. */
    messengerPrivacyEpoch: int("messenger_privacy_epoch"),
    /** Exact purchased-credit wallet. Only populated for credit_purchase. */
    creditWalletId: varchar("credit_wallet_id", { length: 36 }),
    /** Opaque retained financial subject; never a raw Messenger identifier. */
    creditFinancialSubjectRef: varchar("credit_financial_subject_ref", {
      length: 64,
    }),
    /** Immutable server-owned offer quantity captured at checkout creation. */
    creditCount: int("credit_count"),
    /** Hash of the canonical, non-secret Mollie credit metadata. */
    creditMetadataHash: varchar("credit_metadata_hash", { length: 64 }),
    /** Hash of a short-lived, fragment-delivered single-use checkout capability. */
    checkoutCapabilityHash: varchar("checkout_capability_hash", { length: 64 }),
    checkoutCapabilityExpiresAt: timestamp("checkout_capability_expires_at"),
    checkoutCapabilityConsumedAt: timestamp("checkout_capability_consumed_at"),
    checkoutCapabilitySessionNonceHash: varchar(
      "checkout_capability_session_nonce_hash",
      { length: 64 }
    ),
    /** Set when the current Messenger identity mapping is irreversibly scrubbed. */
    creditIdentityErasedAt: timestamp("credit_identity_erased_at"),
    billingProfileVersion: int("billing_profile_version").notNull(),
    authorizationEpoch: int("authorization_epoch").notNull(),
    urlExposedAt: timestamp("url_exposed_at"),
    paidAt: timestamp("paid_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("billing_intents_scope_profile_unique").on(
      table.intentId,
      table.workspaceId,
      table.mode,
      table.billingProfileVersion,
      table.authorizationEpoch
    ),
    uniqueIndex("billing_intents_scope_unique").on(
      table.intentId,
      table.workspaceId,
      table.mode
    ),
    uniqueIndex("billing_intents_credit_funding_scope_unique").on(
      table.intentId,
      table.creditWalletId,
      table.workspaceId,
      table.mode
    ),
    index("billing_intents_workspace_mode_created_idx").on(
      table.workspaceId,
      table.mode,
      table.createdAt
    ),
    uniqueIndex("billing_intents_mollie_payment_mode_unique").on(
      table.mode,
      table.molliePaymentId
    ),
    uniqueIndex("billing_intents_idempotency_unique").on(table.idempotencyKey),
    uniqueIndex("billing_intents_checkout_scope_unique").on(
      table.checkoutScopeKey
    ),
    uniqueIndex("billing_intents_checkout_capability_unique").on(
      table.checkoutCapabilityHash
    ),
    uniqueIndex("billing_intents_checkout_session_nonce_unique").on(
      table.checkoutCapabilitySessionNonceHash
    ),
    uniqueIndex("billing_intents_credit_payment_binding_unique").on(
      table.intentId,
      table.creditWalletId,
      table.workspaceId,
      table.mode,
      table.creditMetadataHash
    ),
    index("billing_intents_credit_subject_idx").on(
      table.workspaceId,
      table.mode,
      table.messengerChannelConnectionId,
      table.messengerBindingEpoch,
      table.messengerPrivacyEpoch,
      table.creditFinancialSubjectRef
    ),
    index("billing_intents_credit_capability_expiry_idx").on(
      table.kind,
      table.status,
      table.checkoutCapabilityExpiresAt,
      table.intentId
    ),
    check(
      "billing_intents_credit_purchase_shape",
      sql`(((${table.kind} <> 'credit_purchase') AND ${table.creditWalletId} IS NULL AND ${table.messengerBindingEpoch} IS NULL AND ${table.creditFinancialSubjectRef} IS NULL AND ${table.creditCount} IS NULL AND ${table.creditMetadataHash} IS NULL AND ${table.checkoutCapabilityHash} IS NULL AND ${table.checkoutCapabilityExpiresAt} IS NULL AND ${table.checkoutCapabilityConsumedAt} IS NULL AND ${table.checkoutCapabilitySessionNonceHash} IS NULL AND ${table.creditIdentityErasedAt} IS NULL) OR (${table.kind} = 'credit_purchase' AND ${table.interval} = 'oneoff' AND ${table.billingProfileVersion} = 0 AND JSON_TYPE(${table.entitlements}) = 'OBJECT' AND JSON_LENGTH(${table.entitlements}) = 0 AND ${table.expectedAmount} > 0 AND BINARY ${table.currency} = BINARY 'EUR' AND ${table.creditCount} > 0 AND ${table.messengerPageId} IS NULL AND ${table.messengerChannelConnectionId} IS NOT NULL AND ${table.messengerBindingEpoch} > 0 AND ${table.messengerPrivacyEpoch} > 0 AND REGEXP_LIKE(${table.intentId}, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'c') AND REGEXP_LIKE(${table.creditWalletId}, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'c') AND REGEXP_LIKE(${table.creditFinancialSubjectRef}, '^[0-9a-f]{64}$', 'c') AND REGEXP_LIKE(${table.creditMetadataHash}, '^[0-9a-f]{64}$', 'c') AND CHAR_LENGTH(TRIM(${table.planCode})) > 0 AND CHAR_LENGTH(TRIM(${table.mollieDescription})) > 0 AND ((${table.creditIdentityErasedAt} IS NULL AND REGEXP_LIKE(${table.messengerSenderUserKey}, '^([0-9a-f]{64}|u2[.]k[1-9][0-9]{0,5}[.][0-9a-f]{64})$', 'c') AND REGEXP_LIKE(${table.checkoutCapabilityHash}, '^[0-9a-f]{64}$', 'c') AND ${table.checkoutCapabilityExpiresAt} >= ${table.createdAt} AND ${table.checkoutCapabilityExpiresAt} <= TIMESTAMPADD(MINUTE, 15, ${table.createdAt}) AND ((${table.checkoutCapabilityConsumedAt} IS NULL AND ${table.checkoutCapabilitySessionNonceHash} IS NULL) OR (${table.checkoutCapabilityConsumedAt} >= ${table.createdAt} AND ${table.checkoutCapabilityConsumedAt} <= ${table.checkoutCapabilityExpiresAt} AND REGEXP_LIKE(${table.checkoutCapabilitySessionNonceHash}, '^[0-9a-f]{64}$', 'c')))) OR (${table.creditIdentityErasedAt} IS NOT NULL AND ${table.creditIdentityErasedAt} >= ${table.createdAt} AND ${table.messengerSenderUserKey} IS NULL AND ${table.checkoutCapabilityHash} IS NULL AND ${table.checkoutCapabilityExpiresAt} IS NULL AND ${table.checkoutCapabilityConsumedAt} IS NULL AND ${table.checkoutCapabilitySessionNonceHash} IS NULL AND ${table.status} IN ('paid','failed','canceled','expired','mismatch','contained'))))) IS TRUE`
    ),
  ]
);

export type BillingIntent = typeof billingIntents.$inferSelect;
export type InsertBillingIntent = typeof billingIntents.$inferInsert;

/** Durable state for provider writes; contains metadata only, never credentials. */
export const billingProviderOperations = mysqlTable(
  "billing_provider_operations",
  {
    operationId: varchar("operation_id", { length: 36 }).primaryKey(),
    workspaceId: int("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    mode: mysqlEnum("mode", ["test", "live"]).notNull(),
    operationType: mysqlEnum("operation_type", [
      "create_customer",
      "create_payment",
      "create_subscription",
      "cancel_payment",
      "cancel_subscription",
    ]).notNull(),
    operationKey: varchar("operation_key", { length: 160 }).notNull(),
    intentId: varchar("intent_id", { length: 36 }).notNull(),
    billingProfileVersion: int("billing_profile_version").notNull(),
    authorizationEpoch: int("authorization_epoch").notNull(),
    state: mysqlEnum("state", [
      "reserved",
      "transport_started",
      "succeeded",
      "known_failed",
      "ambiguous",
      "reconciliation_only",
      "contained",
    ]).notNull(),
    requestFingerprint: varchar("request_fingerprint", {
      length: 64,
    }).notNull(),
    idempotencyKeyHash: varchar("idempotency_key_hash", {
      length: 64,
    }).notNull(),
    credentialGenerationId: varchar("credential_generation_id", {
      length: 64,
    }).notNull(),
    providerResourceId: varchar("provider_resource_id", { length: 64 }),
    providerCustomerId: varchar("provider_customer_id", { length: 64 }),
    attemptCount: int("attempt_count").default(0).notNull(),
    leaseToken: varchar("lease_token", { length: 36 }).notNull(),
    leaseUntil: timestamp("lease_until").notNull(),
    firstStartedAt: timestamp("first_started_at"),
    retryBefore: timestamp("retry_before"),
    resolutionDueAt: timestamp("resolution_due_at").notNull(),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    foreignKey({
      name: "billing_provider_operations_intent_scope_fk",
      columns: [
        table.intentId,
        table.workspaceId,
        table.mode,
        table.billingProfileVersion,
        table.authorizationEpoch,
      ],
      foreignColumns: [
        billingIntents.intentId,
        billingIntents.workspaceId,
        billingIntents.mode,
        billingIntents.billingProfileVersion,
        billingIntents.authorizationEpoch,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "billing_provider_ops_execution_control_fk",
      columns: [table.workspaceId, table.mode],
      foreignColumns: [
        billingExecutionControls.workspaceId,
        billingExecutionControls.mode,
      ],
    }).onDelete("restrict"),
    uniqueIndex("billing_provider_operations_mode_type_key_unique").on(
      table.mode,
      table.operationType,
      table.operationKey
    ),
    index("billing_provider_operations_due_idx").on(
      table.workspaceId,
      table.mode,
      table.state,
      table.resolutionDueAt
    ),
    check(
      "billing_provider_operations_attempt_nonnegative",
      sql`${table.attemptCount} >= 0`
    ),
    check(
      "billing_provider_operations_started_timestamp",
      sql`${table.state} NOT IN ('transport_started','ambiguous','succeeded') OR ${table.firstStartedAt} IS NOT NULL`
    ),
    check(
      "billing_provider_operations_success_result",
      sql`${table.state} <> 'succeeded' OR (${table.providerResourceId} IS NOT NULL AND ${table.completedAt} IS NOT NULL)`
    ),
  ]
);

export const billingSubscriptions = mysqlTable(
  "billing_subscriptions",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    mode: mysqlEnum("mode", ["test", "live"]).notNull(),
    planCode: varchar("plan_code", { length: 80 }).notNull(),
    mollieCustomerId: varchar("mollie_customer_id", { length: 64 }).notNull(),
    mollieSubscriptionId: varchar("mollie_subscription_id", { length: 64 }),
    mollieMandateId: varchar("mollie_mandate_id", { length: 64 }),
    sourceIntentId: varchar("source_intent_id", { length: 36 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 96 }).notNull(),
    status: mysqlEnum("status", [
      "provisioning",
      "active",
      "past_due",
      "canceled",
      "completed",
      "suspended",
      "manual_review",
    ])
      .default("provisioning")
      .notNull(),
    interval: varchar("interval", { length: 32 }).notNull(),
    recurringAmount: decimal("recurring_amount", {
      precision: 10,
      scale: 2,
    }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    entitlements: json("entitlements").notNull(),
    mollieDescription: varchar("mollie_description", { length: 255 }).notNull(),
    currentPeriodStart: timestamp("current_period_start"),
    paidThrough: timestamp("paid_through"),
    nextPaymentDate: timestamp("next_payment_date"),
    graceUntil: timestamp("grace_until"),
    cancelAtPeriodEnd: int("cancel_at_period_end").default(0).notNull(),
    canceledAt: timestamp("canceled_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    foreignKey({
      name: "billing_subscriptions_source_intent_scope_fk",
      columns: [table.sourceIntentId, table.workspaceId, table.mode],
      foreignColumns: [
        billingIntents.intentId,
        billingIntents.workspaceId,
        billingIntents.mode,
      ],
    }).onDelete("restrict"),
    // Intentional current-state model: each workspace/mode owns one mutable
    // subscription row. Replacements update this row; this table is not a
    // subscription-history ledger.
    uniqueIndex("billing_subscriptions_workspace_mode_unique").on(
      table.workspaceId,
      table.mode
    ),
    uniqueIndex("billing_subscriptions_mollie_subscription_mode_unique").on(
      table.mode,
      table.mollieSubscriptionId
    ),
    uniqueIndex("billing_subscriptions_idempotency_unique").on(
      table.idempotencyKey
    ),
  ]
);

export type BillingSubscription = typeof billingSubscriptions.$inferSelect;
export type InsertBillingSubscription =
  typeof billingSubscriptions.$inferInsert;

export const billingInvoiceSequences = mysqlTable(
  "billing_invoice_sequences",
  {
    id: int("id").autoincrement().primaryKey(),
    mode: mysqlEnum("mode", ["test", "live"]).notNull(),
    invoiceYear: int("invoice_year").notNull(),
    nextNumber: int("next_number").notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("billing_invoice_sequences_mode_year_unique").on(
      table.mode,
      table.invoiceYear
    ),
  ]
);

export type BillingInvoiceSequence =
  typeof billingInvoiceSequences.$inferSelect;

export const paymentLedger = mysqlTable(
  "payment_ledger",
  {
    id: int("id").autoincrement().primaryKey(),
    molliePaymentId: varchar("mollie_payment_id", { length: 64 }).notNull(),
    workspaceId: int("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    mode: mysqlEnum("mode", ["test", "live"]).notNull(),
    grossAmount: decimal("gross_amount", { precision: 10, scale: 2 }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    paymentMethod: varchar("payment_method", { length: 40 }),
    refunds: json("refunds").notNull(),
    chargebacks: json("chargebacks").notNull(),
    observedSnapshotHash: varchar("observed_snapshot_hash", {
      length: 64,
    }).notNull(),
    paidEffectApplied: int("paid_effect_applied").default(0).notNull(),
    paymentEffectOwnerKind: mysqlEnum("payment_effect_owner_kind", [
      "legacy_billing",
      "credit_grant",
    ]),
    paymentEffectOwnerRef: varchar("payment_effect_owner_ref", { length: 36 }),
    paymentEffectClaimedAt: timestamp("payment_effect_claimed_at"),
    creditPurpose: varchar("credit_purpose", { length: 32 }),
    creditIntentId: varchar("credit_intent_id", { length: 36 }),
    creditWalletId: varchar("credit_wallet_id", { length: 36 }),
    creditMetadataHash: varchar("credit_metadata_hash", { length: 64 }),
    settlementId: varchar("settlement_id", { length: 64 }),
    settlementAmount: decimal("settlement_amount", { precision: 10, scale: 2 }),
    mollieFees: decimal("mollie_fees", { precision: 10, scale: 2 }),
    invoiceNumber: varchar("invoice_number", { length: 40 }),
    occurredAt: timestamp("occurred_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("payment_ledger_payment_mode_unique").on(
      table.mode,
      table.molliePaymentId
    ),
    uniqueIndex("payment_ledger_id_workspace_mode_unique").on(
      table.id,
      table.workspaceId,
      table.mode
    ),
    uniqueIndex("payment_ledger_exact_payment_scope_unique").on(
      table.id,
      table.workspaceId,
      table.mode,
      table.molliePaymentId
    ),
    uniqueIndex("payment_ledger_credit_intent_unique").on(
      table.mode,
      table.creditIntentId
    ),
    uniqueIndex("payment_ledger_effect_owner_unique").on(
      table.mode,
      table.paymentEffectOwnerKind,
      table.paymentEffectOwnerRef
    ),
    foreignKey({
      name: "payment_ledger_credit_intent_scope_fk",
      columns: [
        table.creditIntentId,
        table.creditWalletId,
        table.workspaceId,
        table.mode,
        table.creditMetadataHash,
      ],
      foreignColumns: [
        billingIntents.intentId,
        billingIntents.creditWalletId,
        billingIntents.workspaceId,
        billingIntents.mode,
        billingIntents.creditMetadataHash,
      ],
    }).onDelete("restrict"),
    uniqueIndex("payment_ledger_invoice_unique").on(table.invoiceNumber),
    index("payment_ledger_workspace_mode_occurred_idx").on(
      table.workspaceId,
      table.mode,
      table.occurredAt,
      table.id
    ),
    check(
      "payment_ledger_credit_binding_shape",
      sql`((${table.creditPurpose} IS NULL AND ${table.creditIntentId} IS NULL AND ${table.creditWalletId} IS NULL AND ${table.creditMetadataHash} IS NULL AND (${table.paymentEffectOwnerKind} IS NULL OR ${table.paymentEffectOwnerKind} = 'legacy_billing')) OR (BINARY ${table.creditPurpose} = BINARY 'premium_image_credits' AND ${table.paymentEffectOwnerKind} = 'credit_grant' AND BINARY ${table.paymentEffectOwnerRef} = BINARY ${table.creditIntentId} AND REGEXP_LIKE(${table.creditIntentId}, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'c') AND REGEXP_LIKE(${table.creditWalletId}, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'c') AND REGEXP_LIKE(${table.creditMetadataHash}, '^[0-9a-f]{64}$', 'c'))) IS TRUE`
    ),
    check(
      "payment_ledger_effect_owner_shape",
      sql`((${table.paymentEffectOwnerKind} IS NULL AND ${table.paymentEffectOwnerRef} IS NULL AND ${table.paymentEffectClaimedAt} IS NULL AND ${table.paidEffectApplied} IN (0,1)) OR (${table.paymentEffectOwnerKind} IS NOT NULL AND REGEXP_LIKE(${table.paymentEffectOwnerRef}, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'c') AND ((${table.paidEffectApplied} = 0 AND ${table.paymentEffectClaimedAt} IS NULL) OR (${table.paidEffectApplied} = 1 AND ${table.paymentEffectClaimedAt} IS NOT NULL)))) IS TRUE`
    ),
  ]
);

export type PaymentLedgerEntry = typeof paymentLedger.$inferSelect;
export type InsertPaymentLedgerEntry = typeof paymentLedger.$inferInsert;

export const webhookDeliveries = mysqlTable(
  "webhook_deliveries",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    mode: mysqlEnum("mode", ["test", "live"]).notNull(),
    mollieResourceId: varchar("mollie_resource_id", { length: 64 }).notNull(),
    snapshotHash: varchar("snapshot_hash", { length: 64 }).notNull(),
    receivedAt: timestamp("received_at").defaultNow().notNull(),
    processedAt: timestamp("processed_at"),
    processingResult: varchar("processing_result", { length: 80 }).notNull(),
  },
  table => [
    uniqueIndex("webhook_deliveries_resource_snapshot_mode_unique").on(
      table.workspaceId,
      table.mode,
      table.mollieResourceId,
      table.snapshotHash
    ),
  ]
);

export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type InsertWebhookDelivery = typeof webhookDeliveries.$inferInsert;

export const workspaceEntitlements = mysqlTable(
  "workspace_entitlements",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    mode: mysqlEnum("mode", ["test", "live"]).notNull(),
    planCode: varchar("plan_code", { length: 80 }).notNull(),
    status: mysqlEnum("status", [
      "inactive",
      "active",
      "grace",
      "blocked",
      "manual_review",
    ])
      .default("inactive")
      .notNull(),
    quota: json("quota").notNull(),
    validUntil: timestamp("valid_until"),
    sourceSubscriptionId: varchar("source_subscription_id", { length: 64 }),
    sourceIntentId: varchar("source_intent_id", { length: 36 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    foreignKey({
      name: "workspace_entitlements_source_intent_scope_fk",
      columns: [table.sourceIntentId, table.workspaceId, table.mode],
      foreignColumns: [
        billingIntents.intentId,
        billingIntents.workspaceId,
        billingIntents.mode,
      ],
    }).onDelete("restrict"),
    uniqueIndex("workspace_entitlements_workspace_mode_unique").on(
      table.workspaceId,
      table.mode
    ),
    uniqueIndex("workspace_entitlements_id_scope_unique").on(
      table.id,
      table.workspaceId,
      table.mode
    ),
  ]
);

export type WorkspaceEntitlement = typeof workspaceEntitlements.$inferSelect;
export type InsertWorkspaceEntitlement =
  typeof workspaceEntitlements.$inferInsert;

/**
 * Workspace-local counters for finite products. Counters are updated while the
 * row is locked so concurrent provider calls cannot exceed a paid allowance.
 */
export const workspaceEntitlementUsage = mysqlTable(
  "workspace_entitlement_usage",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspace_id").notNull(),
    mode: mysqlEnum("mode", ["test", "live"]).notNull(),
    entitlementId: int("entitlement_id").notNull(),
    planCode: varchar("plan_code", { length: 80 }).notNull(),
    sourceIntentId: varchar("source_intent_id", { length: 36 }).notNull(),
    periodStartedAt: timestamp("period_started_at").notNull(),
    periodEndsAt: timestamp("period_ends_at").notNull(),
    aiAnswersCommitted: int("ai_answers_committed").default(0).notNull(),
    aiAnswersReserved: int("ai_answers_reserved").default(0).notNull(),
    imagesUsed: int("images_used").default(0).notNull(),
    imageUsageDate: varchar("image_usage_date", { length: 10 }),
    imagesUsedToday: int("images_used_today").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    foreignKey({
      name: "weu_workspace_fk",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "weu_entitlement_scope_fk",
      columns: [table.entitlementId, table.workspaceId, table.mode],
      foreignColumns: [
        workspaceEntitlements.id,
        workspaceEntitlements.workspaceId,
        workspaceEntitlements.mode,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "weu_source_intent_scope_fk",
      columns: [table.sourceIntentId, table.workspaceId, table.mode],
      foreignColumns: [
        billingIntents.intentId,
        billingIntents.workspaceId,
        billingIntents.mode,
      ],
    }).onDelete("restrict"),
    uniqueIndex("workspace_entitlement_usage_workspace_mode_plan_unique").on(
      table.workspaceId,
      table.mode,
      table.planCode
    ),
    uniqueIndex("workspace_entitlement_usage_entitlement_unique").on(
      table.entitlementId
    ),
    uniqueIndex("workspace_entitlement_usage_scope_unique").on(
      table.entitlementId,
      table.workspaceId,
      table.mode
    ),
  ]
);

export type WorkspaceEntitlementUsage =
  typeof workspaceEntitlementUsage.$inferSelect;
export type InsertWorkspaceEntitlementUsage =
  typeof workspaceEntitlementUsage.$inferInsert;

/** Short-lived, idempotent reservations; no sender or conversation data. */
export const workspaceEntitlementUsageReservations = mysqlTable(
  "workspace_entitlement_usage_reservations",
  {
    reservationId: varchar("reservation_id", { length: 36 }).primaryKey(),
    workspaceId: int("workspace_id").notNull(),
    mode: mysqlEnum("mode", ["test", "live"]).notNull(),
    entitlementId: int("entitlement_id").notNull(),
    channelConnectionId: int("channel_connection_id"),
    bindingEpoch: int("binding_epoch"),
    kind: mysqlEnum("kind", ["ai_answer", "image"]).notNull(),
    status: mysqlEnum("status", [
      "reserved",
      "committed",
      "released",
      "expired",
    ])
      .default("reserved")
      .notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
    ownerTokenHash: varchar("owner_token_hash", { length: 64 }).notNull(),
    ownerLeaseUntil: timestamp("owner_lease_until").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    deliveryStartedAt: timestamp("delivery_started_at"),
    deliveryKnownRejectedAt: timestamp("delivery_known_rejected_at"),
    deliveryAttemptTokenHash: varchar("delivery_attempt_token_hash", {
      length: 64,
    }),
    resolutionDueAt: timestamp("resolution_due_at").notNull(),
    committedAt: timestamp("committed_at"),
    releasedAt: timestamp("released_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    foreignKey({
      name: "weur_workspace_fk",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "weur_static_connection_workspace_fk",
      columns: [table.channelConnectionId, table.workspaceId],
      foreignColumns: [channelConnections.id, channelConnections.workspaceId],
    }).onDelete("restrict"),
    foreignKey({
      name: "weur_entitlement_scope_fk",
      columns: [table.entitlementId, table.workspaceId, table.mode],
      foreignColumns: [
        workspaceEntitlements.id,
        workspaceEntitlements.workspaceId,
        workspaceEntitlements.mode,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "weur_usage_scope_fk",
      columns: [table.entitlementId, table.workspaceId, table.mode],
      foreignColumns: [
        workspaceEntitlementUsage.entitlementId,
        workspaceEntitlementUsage.workspaceId,
        workspaceEntitlementUsage.mode,
      ],
    }).onDelete("restrict"),
    uniqueIndex("workspace_entitlement_reservations_idempotency_unique").on(
      table.workspaceId,
      table.mode,
      table.idempotencyKey
    ),
    index("workspace_entitlement_reservations_expiry_idx").on(
      table.workspaceId,
      table.mode,
      table.status,
      table.resolutionDueAt
    ),
    check(
      "workspace_entitlement_reservation_binding_pair",
      sql`(${table.channelConnectionId} IS NULL AND ${table.bindingEpoch} IS NULL) OR (${table.channelConnectionId} IS NOT NULL AND ${table.bindingEpoch} > 0)`
    ),
    check(
      "workspace_entitlement_reservation_delivery_pair",
      sql`(${table.deliveryStartedAt} IS NULL AND ${table.deliveryAttemptTokenHash} IS NULL AND ${table.deliveryKnownRejectedAt} IS NULL) OR (${table.deliveryStartedAt} IS NOT NULL AND ${table.deliveryAttemptTokenHash} IS NOT NULL)`
    ),
  ]
);

export type WorkspaceEntitlementUsageReservation =
  typeof workspaceEntitlementUsageReservations.$inferSelect;
export type InsertWorkspaceEntitlementUsageReservation =
  typeof workspaceEntitlementUsageReservations.$inferInsert;

/** Reliable post-commit work for mandate checks, subscription creation and alerts. */
export const billingOutbox = mysqlTable(
  "billing_outbox",
  {
    id: int("id").autoincrement().primaryKey(),
    deliveryId: varchar("delivery_id", { length: 36 })
      .notNull()
      .$defaultFn(() => randomUUID()),
    workspaceId: int("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    mode: mysqlEnum("mode", ["test", "live"]).notNull(),
    eventType: mysqlEnum("event_type", [
      "ensure_subscription",
      "cancel_subscription",
      "cancel_payment",
      "payment_warning",
      "manual_review",
      "send_portal_handoff",
    ]).notNull(),
    deduplicationKey: varchar("deduplication_key", { length: 160 }).notNull(),
    payload: json("payload").notNull(),
    status: mysqlEnum("status", [
      "pending",
      "processing",
      "completed",
      "failed",
    ])
      .default("pending")
      .notNull(),
    attemptCount: int("attempt_count").default(0).notNull(),
    maxAttempts: int("max_attempts").default(12).notNull(),
    availableAt: timestamp("available_at").defaultNow().notNull(),
    lockedAt: timestamp("locked_at"),
    leaseToken: varchar("lease_token", { length: 36 }),
    lastErrorCode: varchar("last_error_code", { length: 80 }),
    deliveryEpoch: int("delivery_epoch").default(0).notNull(),
    deliveryState: mysqlEnum("delivery_state", [
      "idle",
      "preparing",
      "transport_started",
      "transport_succeeded",
      "ambiguous",
    ])
      .default("idle")
      .notNull(),
    privacyErasedAt: timestamp("privacy_erased_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("billing_outbox_id_workspace_unique").on(
      table.id,
      table.workspaceId
    ),
    uniqueIndex("billing_outbox_delivery_id_unique").on(table.deliveryId),
    uniqueIndex("billing_outbox_mode_deduplication_unique").on(
      table.mode,
      table.deduplicationKey
    ),
    index("billing_outbox_mode_status_available_idx").on(
      table.mode,
      table.status,
      table.availableAt
    ),
    check(
      "billing_outbox_attempts_nonnegative",
      sql`${table.attemptCount} >= 0 AND ${table.maxAttempts} > 0`
    ),
    check(
      "billing_outbox_delivery_epoch_nonnegative",
      sql`${table.deliveryEpoch} >= 0`
    ),
    check(
      "billing_outbox_delivery_state_status",
      sql`(${table.deliveryState} NOT IN ('preparing','transport_started') OR ${table.status} = 'processing') AND (${table.deliveryState} <> 'transport_succeeded' OR ${table.status} IN ('processing','completed')) AND (${table.deliveryState} <> 'ambiguous' OR ${table.status} = 'failed')`
    ),
  ]
);

export type BillingOutboxItem = typeof billingOutbox.$inferSelect;
export type InsertBillingOutboxItem = typeof billingOutbox.$inferInsert;

/** Metadata-only routing index for tenant-safe provider webhook dispatch. */
export const billingWebhookRoutes = mysqlTable(
  "billing_webhook_routes",
  {
    mode: mysqlEnum("mode", ["test", "live"]).notNull(),
    molliePaymentId: varchar("mollie_payment_id", { length: 64 }).notNull(),
    workspaceId: int("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    intentId: varchar("intent_id", { length: 36 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  table => [
    foreignKey({
      name: "billing_webhook_routes_intent_scope_fk",
      columns: [table.intentId, table.workspaceId, table.mode],
      foreignColumns: [
        billingIntents.intentId,
        billingIntents.workspaceId,
        billingIntents.mode,
      ],
    }).onDelete("restrict"),
    primaryKey({ columns: [table.mode, table.molliePaymentId] }),
    index("billing_webhook_routes_workspace_mode_idx").on(
      table.workspaceId,
      table.mode,
      table.intentId
    ),
  ]
);

/** First-party notification receiver receipts; payload content is never stored. */
export const billingNotificationReceipts = mysqlTable(
  "billing_notification_receipts",
  {
    id: int("id").autoincrement().primaryKey(),
    sourceId: varchar("source_id", { length: 64 }).notNull(),
    mode: mysqlEnum("mode", ["test", "live"]).notNull(),
    deliveryId: varchar("delivery_id", { length: 36 }).notNull(),
    workspaceId: int("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    audience: mysqlEnum("audience", ["customer", "operator"]).notNull(),
    bodyDigest: varchar("body_digest", { length: 64 }).notNull(),
    receivedAt: timestamp("received_at").defaultNow().notNull(),
  },
  table => [
    uniqueIndex("billing_notification_receipts_source_mode_delivery_unique").on(
      table.sourceId,
      table.mode,
      table.deliveryId
    ),
    uniqueIndex("billing_notification_receipts_id_scope_unique").on(
      table.id,
      table.workspaceId,
      table.audience
    ),
    uniqueIndex("billing_notification_receipts_id_mode_scope_unique").on(
      table.id,
      table.workspaceId,
      table.mode,
      table.audience
    ),
  ]
);

export const billingAccountingImportRuns = mysqlTable(
  "billing_accounting_import_runs",
  {
    runId: varchar("run_id", { length: 36 }).primaryKey(),
    providerAccountId: varchar("provider_account_id", { length: 96 }).notNull(),
    mode: mysqlEnum("mode", ["test", "live"]).notNull(),
    status: mysqlEnum("status", [
      "pending",
      "fetching",
      "staged",
      "applied",
      "manual_review",
    ]).notNull(),
    cursor: varchar("cursor", { length: 255 }),
    errorCode: varchar("error_code", { length: 80 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  table => [
    index("billing_accounting_import_runs_account_mode_idx").on(
      table.providerAccountId,
      table.mode,
      table.createdAt
    ),
  ]
);

export const billingAccountingImportCursors = mysqlTable(
  "billing_accounting_import_cursors",
  {
    providerAccountId: varchar("provider_account_id", { length: 96 }).notNull(),
    mode: mysqlEnum("mode", ["test", "live"]).notNull(),
    cursor: varchar("cursor", { length: 255 }),
    highWaterProviderEventId: varchar("high_water_provider_event_id", {
      length: 96,
    }),
    pendingHighWaterProviderEventId: varchar(
      "pending_high_water_provider_event_id",
      { length: 96 }
    ),
    leaseToken: varchar("lease_token", { length: 36 }),
    leaseUntil: timestamp("lease_until"),
    consecutiveFailures: int("consecutive_failures").default(0).notNull(),
    lastSuccessfulAt: timestamp("last_successful_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    primaryKey({ columns: [table.providerAccountId, table.mode] }),
    index("billing_accounting_import_cursors_lease_idx").on(
      table.leaseUntil,
      table.leaseToken
    ),
  ]
);

export const billingAccountingProviderEvents = mysqlTable(
  "billing_accounting_provider_events",
  {
    id: int("id").autoincrement().primaryKey(),
    providerAccountId: varchar("provider_account_id", { length: 96 }).notNull(),
    mode: mysqlEnum("mode", ["test", "live"]).notNull(),
    providerEventId: varchar("provider_event_id", { length: 96 }).notNull(),
    providerType: varchar("provider_type", { length: 64 }).notNull(),
    eventType: mysqlEnum("event_type", [
      "payment",
      "refund",
      "chargeback",
      "fee",
      "settlement",
      "unknown",
    ]).notNull(),
    eventDigest: varchar("event_digest", { length: 64 }).notNull(),
    amount: decimal("amount", { precision: 12, scale: 2 }).notNull(),
    netAmount: decimal("net_amount", { precision: 12, scale: 2 }).notNull(),
    deductionAmount: decimal("deduction_amount", { precision: 12, scale: 2 }),
    currency: varchar("currency", { length: 3 }).notNull(),
    occurredAt: timestamp("occurred_at").notNull(),
    molliePaymentId: varchar("mollie_payment_id", { length: 64 }),
    settlementId: varchar("settlement_id", { length: 96 }),
    status: mysqlEnum("status", ["staged", "applied", "quarantined"]).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  table => [
    uniqueIndex("billing_accounting_provider_events_account_mode_id_unique").on(
      table.providerAccountId,
      table.mode,
      table.providerEventId
    ),
    uniqueIndex("billing_accounting_provider_events_id_mode_unique").on(
      table.id,
      table.mode
    ),
    index("billing_accounting_provider_events_payment_route_idx").on(
      table.mode,
      table.molliePaymentId,
      table.id
    ),
    index("billing_accounting_provider_events_account_mode_time_idx").on(
      table.providerAccountId,
      table.mode,
      table.occurredAt,
      table.id
    ),
  ]
);

export const billingAccountingEventLinks = mysqlTable(
  "billing_accounting_event_links",
  {
    id: int("id").autoincrement().primaryKey(),
    providerEventId: int("provider_event_id").notNull(),
    mode: mysqlEnum("mode", ["test", "live"]).notNull(),
    workspaceId: int("workspace_id").references(() => workspaces.id, {
      onDelete: "restrict",
    }),
    paymentLedgerId: int("payment_ledger_id"),
    linkStatus: mysqlEnum("link_status", [
      "linked",
      "unknown",
      "conflict",
      "account_level",
    ]).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  table => [
    foreignKey({
      name: "billing_accounting_event_links_provider_event_mode_fk",
      columns: [table.providerEventId, table.mode],
      foreignColumns: [
        billingAccountingProviderEvents.id,
        billingAccountingProviderEvents.mode,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "billing_accounting_event_links_ledger_workspace_fk",
      columns: [table.paymentLedgerId, table.workspaceId, table.mode],
      foreignColumns: [
        paymentLedger.id,
        paymentLedger.workspaceId,
        paymentLedger.mode,
      ],
    }).onDelete("restrict"),
    check(
      "billing_accounting_event_links_status_target_check",
      sql`(${table.linkStatus} = 'linked' AND ${table.workspaceId} IS NOT NULL AND ${table.paymentLedgerId} IS NOT NULL) OR (${table.linkStatus} <> 'linked' AND ${table.paymentLedgerId} IS NULL)`
    ),
    uniqueIndex("billing_accounting_event_links_event_unique").on(
      table.providerEventId
    ),
    index("billing_accounting_event_links_workspace_status_idx").on(
      table.workspaceId,
      table.linkStatus
    ),
  ]
);

export const billingNotificationReceiverOutbox = mysqlTable(
  "billing_notification_receiver_outbox",
  {
    id: int("id").autoincrement().primaryKey(),
    receiptId: int("receipt_id").notNull(),
    workspaceId: int("workspace_id").notNull(),
    mode: mysqlEnum("mode", ["test", "live"]).notNull(),
    audience: mysqlEnum("audience", ["customer", "operator"]).notNull(),
    eventType: varchar("event_type", { length: 48 }).notNull(),
    reason: varchar("reason", { length: 96 }).notNull(),
    status: mysqlEnum("status", [
      "pending",
      "processing",
      "delivered",
      "dead_letter",
    ])
      .default("pending")
      .notNull(),
    attemptCount: int("attempt_count").default(0).notNull(),
    maxAttempts: int("max_attempts").default(8).notNull(),
    availableAt: timestamp("available_at").defaultNow().notNull(),
    lockedAt: timestamp("locked_at"),
    leaseToken: varchar("lease_token", { length: 36 }),
    lastErrorCode: varchar("last_error_code", { length: 80 }),
    deliveredAt: timestamp("delivered_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  table => [
    foreignKey({
      name: "billing_notification_receiver_outbox_receipt_workspace_fk",
      columns: [table.receiptId, table.workspaceId, table.mode, table.audience],
      foreignColumns: [
        billingNotificationReceipts.id,
        billingNotificationReceipts.workspaceId,
        billingNotificationReceipts.mode,
        billingNotificationReceipts.audience,
      ],
    }).onDelete("restrict"),
    uniqueIndex("billing_notification_receiver_outbox_receipt_unique").on(
      table.receiptId
    ),
    index("billing_notification_receiver_outbox_status_created_idx").on(
      table.status,
      table.availableAt,
      table.createdAt
    ),
    check(
      "billing_notification_receiver_attempts_valid",
      sql`${table.attemptCount} >= 0 AND ${table.maxAttempts} > 0 AND ${table.attemptCount} <= ${table.maxAttempts}`
    ),
    check(
      "billing_notification_receiver_lease_state",
      sql`(${table.status} = 'processing' AND ${table.lockedAt} IS NOT NULL AND ${table.leaseToken} IS NOT NULL) OR (${table.status} <> 'processing' AND ${table.lockedAt} IS NULL AND ${table.leaseToken} IS NULL)`
    ),
    check(
      "billing_notification_receiver_delivery_state",
      sql`(${table.status} = 'delivered' AND ${table.deliveredAt} IS NOT NULL) OR (${table.status} <> 'delivered' AND ${table.deliveredAt} IS NULL)`
    ),
  ]
);

/** Tenant-scoped, metadata-only portal/operator inbox materialized by the receiver worker. */
export const billingNotificationInbox = mysqlTable(
  "billing_notification_inbox",
  {
    id: int("id").autoincrement().primaryKey(),
    receiptId: int("receipt_id").notNull(),
    workspaceId: int("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    audience: mysqlEnum("audience", ["customer", "operator"]).notNull(),
    eventType: varchar("event_type", { length: 48 }).notNull(),
    reason: varchar("reason", { length: 96 }).notNull(),
    occurredAt: timestamp("occurred_at").defaultNow().notNull(),
    readAt: timestamp("read_at"),
  },
  table => [
    foreignKey({
      name: "billing_notification_inbox_receipt_workspace_fk",
      columns: [table.receiptId, table.workspaceId, table.audience],
      foreignColumns: [
        billingNotificationReceipts.id,
        billingNotificationReceipts.workspaceId,
        billingNotificationReceipts.audience,
      ],
    }).onDelete("restrict"),
    uniqueIndex("billing_notification_inbox_receipt_unique").on(
      table.receiptId
    ),
    index("billing_notification_inbox_workspace_audience_created_idx").on(
      table.workspaceId,
      table.audience,
      table.occurredAt,
      table.id
    ),
  ]
);

export const billingHandoffRecoveryEvents = mysqlTable(
  "billing_handoff_recovery_events",
  {
    id: int("id").autoincrement().primaryKey(),
    outboxId: int("outbox_id").notNull(),
    workspaceId: int("workspace_id")
      .notNull()
      .references(() => workspaces.id, {
        onDelete: "restrict",
      }),
    eventIdHash: varchar("event_id_hash", { length: 64 }).notNull(),
    source: varchar("source", { length: 48 }).notNull(),
    eventTimestamp: timestamp("event_timestamp").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  table => [
    foreignKey({
      name: "billing_handoff_recovery_outbox_workspace_fk",
      columns: [table.outboxId, table.workspaceId],
      foreignColumns: [billingOutbox.id, billingOutbox.workspaceId],
    }).onDelete("cascade"),
    uniqueIndex("billing_handoff_recovery_events_outbox_event_unique").on(
      table.outboxId,
      table.eventIdHash
    ),
    index("billing_handoff_recovery_events_workspace_idx").on(
      table.workspaceId,
      table.createdAt
    ),
  ]
);

export const billingReconciliationRuns = mysqlTable(
  "billing_reconciliation_runs",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    mode: mysqlEnum("mode", ["test", "live"]).notNull(),
    periodKey: varchar("period_key", { length: 10 }).notNull(),
    status: mysqlEnum("status", ["running", "completed", "failed"])
      .default("running")
      .notNull(),
    leaseToken: varchar("lease_token", { length: 36 }),
    leaseUntil: timestamp("lease_until").notNull(),
    summary: json("summary"),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  table => [
    uniqueIndex("billing_reconciliation_runs_workspace_mode_period_unique").on(
      table.workspaceId,
      table.mode,
      table.periodKey
    ),
  ]
);

export type BillingReconciliationRun =
  typeof billingReconciliationRuns.$inferSelect;
export type InsertBillingReconciliationRun =
  typeof billingReconciliationRuns.$inferInsert;

export const billingReconciliationAnomalies = mysqlTable(
  "billing_reconciliation_anomalies",
  {
    id: int("id").autoincrement().primaryKey(),
    runId: int("run_id").notNull(),
    workspaceId: int("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    code: varchar("code", { length: 80 }).notNull(),
    metadata: json("metadata"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  table => [
    foreignKey({
      name: "billing_reconciliation_anomalies_run_fk",
      columns: [table.runId],
      foreignColumns: [billingReconciliationRuns.id],
    }).onDelete("cascade"),
    uniqueIndex(
      "billing_reconciliation_anomalies_run_workspace_code_unique"
    ).on(table.runId, table.workspaceId, table.code),
  ]
);

export type BillingReconciliationAnomaly =
  typeof billingReconciliationAnomalies.$inferSelect;
export type InsertBillingReconciliationAnomaly =
  typeof billingReconciliationAnomalies.$inferInsert;

/**
 * One purchased-credit wallet per immutable Messenger privacy binding. The
 * current user mapping is nullable so erasure can break the link while the
 * opaque financial reference and accounting evidence remain retained.
 */
export const creditWallets = mysqlTable(
  "credit_wallets",
  {
    walletId: varchar("wallet_id", { length: 36 }).primaryKey(),
    workspaceId: int("workspace_id").notNull(),
    mode: mysqlEnum("mode", ["test", "live"]).notNull(),
    channelConnectionId: int("channel_connection_id").notNull(),
    bindingEpoch: int("binding_epoch").notNull(),
    privacyEpoch: int("privacy_epoch").notNull(),
    currentUserKeyHash: varchar("current_user_key_hash", { length: 96 }),
    financialSubjectRef: varchar("financial_subject_ref", {
      length: 64,
    }).notNull(),
    status: mysqlEnum("status", ["active", "frozen", "erased"])
      .default("active")
      .notNull(),
    creditBalance: int("credit_balance").default(0).notNull(),
    reservedCredits: int("reserved_credits").default(0).notNull(),
    balanceVersion: int("balance_version").default(1).notNull(),
    lastLedgerEntryId: varchar("last_ledger_entry_id", { length: 36 }),
    privacyErasedAt: timestamp("privacy_erased_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    foreignKey({
      name: "credit_wallets_connection_workspace_fk",
      columns: [table.channelConnectionId, table.workspaceId],
      foreignColumns: [channelConnections.id, channelConnections.workspaceId],
    }).onDelete("restrict"),
    foreignKey({
      name: "credit_wallets_privacy_subject_fk",
      columns: [
        table.workspaceId,
        table.channelConnectionId,
        table.currentUserKeyHash,
      ],
      foreignColumns: [
        messengerPrivacySubjects.workspaceId,
        messengerPrivacySubjects.channelConnectionId,
        messengerPrivacySubjects.userKey,
      ],
    }).onDelete("restrict"),
    uniqueIndex("credit_wallets_financial_subject_unique").on(
      table.workspaceId,
      table.mode,
      table.financialSubjectRef
    ),
    uniqueIndex("credit_wallets_active_subject_unique").on(
      table.workspaceId,
      table.mode,
      table.channelConnectionId,
      table.bindingEpoch,
      table.privacyEpoch,
      table.currentUserKeyHash
    ),
    uniqueIndex("credit_wallets_exact_scope_unique").on(
      table.walletId,
      table.workspaceId,
      table.mode,
      table.channelConnectionId,
      table.bindingEpoch,
      table.privacyEpoch,
      table.financialSubjectRef
    ),
    index("credit_wallets_subject_lookup_idx").on(
      table.workspaceId,
      table.channelConnectionId,
      table.currentUserKeyHash,
      table.status
    ),
    check(
      "credit_wallets_epochs_positive",
      sql`${table.bindingEpoch} > 0 AND ${table.privacyEpoch} > 0`
    ),
    check(
      "credit_wallets_identity_hashes_valid",
      sql`REGEXP_LIKE(${table.financialSubjectRef}, '^[0-9a-f]{64}$', 'c') AND (${table.currentUserKeyHash} IS NULL OR REGEXP_LIKE(${table.currentUserKeyHash}, '^([0-9a-f]{64}|u2[.]k[1-9][0-9]{0,5}[.][0-9a-f]{64})$', 'c'))`
    ),
    check(
      "credit_wallets_id_valid",
      sql`REGEXP_LIKE(${table.walletId}, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'c') AND (${table.lastLedgerEntryId} IS NULL OR REGEXP_LIKE(${table.lastLedgerEntryId}, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'c'))`
    ),
    check(
      "credit_wallets_counters_valid",
      sql`${table.reservedCredits} >= 0 AND ${table.reservedCredits} <= GREATEST(${table.creditBalance}, 0) AND (${table.status} <> 'active' OR ${table.creditBalance} >= 0) AND ${table.balanceVersion} > 0 AND ((${table.balanceVersion} = 1 AND ${table.lastLedgerEntryId} IS NULL AND ${table.creditBalance} = 0 AND ${table.reservedCredits} = 0) OR (${table.balanceVersion} > 1 AND ${table.lastLedgerEntryId} IS NOT NULL))`
    ),
    check(
      "credit_wallets_erasure_shape",
      sql`(${table.status} = 'erased' AND ${table.currentUserKeyHash} IS NULL AND ${table.privacyErasedAt} IS NOT NULL AND ${table.privacyErasedAt} >= ${table.createdAt} AND ${table.reservedCredits} = 0) OR (${table.status} <> 'erased' AND ${table.currentUserKeyHash} IS NOT NULL AND ${table.privacyErasedAt} IS NULL)`
    ),
  ]
);

export type CreditWallet = typeof creditWallets.$inferSelect;
export type InsertCreditWallet = typeof creditWallets.$inferInsert;

/** A bounded paid-credit claim for one generation request. */
export const creditReservations = mysqlTable(
  "credit_reservations",
  {
    reservationId: varchar("reservation_id", { length: 36 }).primaryKey(),
    walletId: varchar("wallet_id", { length: 36 }).notNull(),
    workspaceId: int("workspace_id").notNull(),
    mode: mysqlEnum("mode", ["test", "live"]).notNull(),
    channelConnectionId: int("channel_connection_id").notNull(),
    bindingEpoch: int("binding_epoch").notNull(),
    privacyEpoch: int("privacy_epoch").notNull(),
    financialSubjectRef: varchar("financial_subject_ref", {
      length: 64,
    }).notNull(),
    reservedCreditCount: int("reserved_credit_count").notNull(),
    generationRequestKeyHash: varchar("generation_request_key_hash", {
      length: 64,
    }),
    ownerTokenHash: varchar("owner_token_hash", { length: 64 }),
    status: mysqlEnum("status", [
      "initializing",
      "reserved",
      "committed",
      "released",
      "expired",
    ])
      .default("initializing")
      .notNull(),
    transportState: mysqlEnum("transport_state", [
      "pretransport",
      "transport_started",
      "known_accepted",
      "known_rejected",
    ])
      .default("pretransport")
      .notNull(),
    transportStartedAt: timestamp("transport_started_at"),
    providerAcceptedAt: timestamp("provider_accepted_at"),
    providerRejectedAt: timestamp("provider_rejected_at"),
    providerRejectedStatus: int("provider_rejected_status"),
    stateVersion: int("state_version").default(1).notNull(),
    ownerLeaseUntil: timestamp("owner_lease_until").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    resolutionDueAt: timestamp("resolution_due_at").notNull(),
    committedAt: timestamp("committed_at"),
    releasedAt: timestamp("released_at"),
    holdLedgerEntryId: varchar("hold_ledger_entry_id", { length: 36 }),
    terminalLedgerEntryId: varchar("terminal_ledger_entry_id", { length: 36 }),
    terminalEvidenceHash: varchar("terminal_evidence_hash", { length: 64 }),
    operationalScrubbedAt: timestamp("operational_scrubbed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    foreignKey({
      name: "credit_reservations_wallet_scope_fk",
      columns: [
        table.walletId,
        table.workspaceId,
        table.mode,
        table.channelConnectionId,
        table.bindingEpoch,
        table.privacyEpoch,
        table.financialSubjectRef,
      ],
      foreignColumns: [
        creditWallets.walletId,
        creditWallets.workspaceId,
        creditWallets.mode,
        creditWallets.channelConnectionId,
        creditWallets.bindingEpoch,
        creditWallets.privacyEpoch,
        creditWallets.financialSubjectRef,
      ],
    }).onDelete("restrict"),
    uniqueIndex("credit_reservations_generation_unique").on(
      table.walletId,
      table.workspaceId,
      table.mode,
      table.channelConnectionId,
      table.bindingEpoch,
      table.privacyEpoch,
      table.generationRequestKeyHash
    ),
    uniqueIndex("credit_reservations_exact_scope_unique").on(
      table.reservationId,
      table.walletId,
      table.workspaceId,
      table.mode,
      table.channelConnectionId,
      table.bindingEpoch,
      table.privacyEpoch,
      table.financialSubjectRef,
      table.reservedCreditCount
    ),
    uniqueIndex("credit_reservations_ledger_scope_unique").on(
      table.reservationId,
      table.walletId,
      table.workspaceId,
      table.mode,
      table.reservedCreditCount
    ),
    index("credit_reservations_expiry_idx").on(
      table.workspaceId,
      table.mode,
      table.status,
      table.transportState,
      table.expiresAt
    ),
    check(
      "credit_reservations_values_valid",
      sql`${table.reservedCreditCount} > 0 AND ${table.stateVersion} > 0`
    ),
    check(
      "credit_reservations_ids_valid",
      sql`REGEXP_LIKE(${table.reservationId}, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'c') AND REGEXP_LIKE(${table.walletId}, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'c') AND (${table.holdLedgerEntryId} IS NULL OR REGEXP_LIKE(${table.holdLedgerEntryId}, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'c')) AND (${table.terminalLedgerEntryId} IS NULL OR REGEXP_LIKE(${table.terminalLedgerEntryId}, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'c'))`
    ),
    check(
      "credit_reservations_hashes_valid",
      sql`((${table.operationalScrubbedAt} IS NULL AND ${table.generationRequestKeyHash} IS NOT NULL AND ${table.ownerTokenHash} IS NOT NULL AND REGEXP_LIKE(${table.generationRequestKeyHash}, '^[0-9a-f]{64}$', 'c') AND REGEXP_LIKE(${table.ownerTokenHash}, '^[0-9a-f]{64}$', 'c')) OR (${table.operationalScrubbedAt} IS NOT NULL AND ${table.status} IN ('committed','released','expired') AND ${table.generationRequestKeyHash} IS NULL AND ${table.ownerTokenHash} IS NULL AND ${table.operationalScrubbedAt} >= ${table.resolutionDueAt})) IS TRUE`
    ),
    check(
      "credit_reservations_terminal_state",
      sql`((${table.status} = 'initializing' AND ${table.transportState} = 'pretransport' AND ${table.stateVersion} = 1 AND ${table.holdLedgerEntryId} IS NULL AND ${table.committedAt} IS NULL AND ${table.releasedAt} IS NULL AND ${table.terminalLedgerEntryId} IS NULL AND ${table.terminalEvidenceHash} IS NULL) OR (${table.status} = 'reserved' AND ${table.stateVersion} = 2 AND ${table.holdLedgerEntryId} IS NOT NULL AND ${table.committedAt} IS NULL AND ${table.releasedAt} IS NULL AND ${table.terminalLedgerEntryId} IS NULL AND ${table.terminalEvidenceHash} IS NULL) OR (${table.status} = 'committed' AND ${table.transportState} = 'known_accepted' AND ${table.stateVersion} = 3 AND ${table.holdLedgerEntryId} IS NOT NULL AND ${table.committedAt} IS NOT NULL AND ${table.releasedAt} IS NULL AND ${table.terminalLedgerEntryId} IS NOT NULL AND ${table.terminalEvidenceHash} IS NOT NULL AND REGEXP_LIKE(${table.terminalEvidenceHash}, '^[0-9a-f]{64}$', 'c')) OR (${table.status} IN ('released','expired') AND ${table.transportState} IN ('pretransport','known_rejected') AND ${table.stateVersion} = 3 AND ${table.holdLedgerEntryId} IS NOT NULL AND ${table.releasedAt} IS NOT NULL AND ${table.committedAt} IS NULL AND ${table.terminalLedgerEntryId} IS NOT NULL AND ${table.terminalEvidenceHash} IS NOT NULL AND REGEXP_LIKE(${table.terminalEvidenceHash}, '^[0-9a-f]{64}$', 'c'))) IS TRUE`
    ),
    check(
      "credit_reservations_transport_evidence",
      sql`((${table.transportState} = 'pretransport' AND ${table.transportStartedAt} IS NULL AND ${table.providerAcceptedAt} IS NULL AND ${table.providerRejectedAt} IS NULL AND ${table.providerRejectedStatus} IS NULL) OR (${table.transportState} = 'transport_started' AND ${table.transportStartedAt} IS NOT NULL AND ${table.providerAcceptedAt} IS NULL AND ${table.providerRejectedAt} IS NULL AND ${table.providerRejectedStatus} IS NULL) OR (${table.transportState} = 'known_accepted' AND ${table.transportStartedAt} IS NOT NULL AND ${table.providerAcceptedAt} IS NOT NULL AND ${table.providerAcceptedAt} >= ${table.transportStartedAt} AND ${table.providerRejectedAt} IS NULL AND ${table.providerRejectedStatus} IS NULL) OR (${table.transportState} = 'known_rejected' AND ${table.transportStartedAt} IS NOT NULL AND ${table.providerAcceptedAt} IS NULL AND ${table.providerRejectedAt} IS NOT NULL AND ${table.providerRejectedAt} >= ${table.transportStartedAt} AND ${table.providerRejectedStatus} BETWEEN 400 AND 499 AND ${table.providerRejectedStatus} NOT IN (408,429))) IS TRUE`
    ),
    check(
      "credit_reservations_timestamp_order",
      sql`${table.createdAt} <= ${table.ownerLeaseUntil} AND ${table.ownerLeaseUntil} <= ${table.expiresAt} AND ${table.expiresAt} <= ${table.resolutionDueAt} AND (${table.transportStartedAt} IS NULL OR (${table.transportStartedAt} >= ${table.createdAt} AND ${table.transportStartedAt} <= ${table.resolutionDueAt})) AND (${table.providerAcceptedAt} IS NULL OR (${table.providerAcceptedAt} >= ${table.createdAt} AND ${table.providerAcceptedAt} <= ${table.resolutionDueAt})) AND (${table.providerRejectedAt} IS NULL OR (${table.providerRejectedAt} >= ${table.createdAt} AND ${table.providerRejectedAt} <= ${table.resolutionDueAt})) AND (${table.committedAt} IS NULL OR (${table.committedAt} >= ${table.createdAt} AND ${table.committedAt} <= ${table.resolutionDueAt})) AND (${table.releasedAt} IS NULL OR ${table.releasedAt} >= ${table.createdAt})`
    ),
  ]
);

export type CreditReservation = typeof creditReservations.$inferSelect;
export type InsertCreditReservation = typeof creditReservations.$inferInsert;

/**
 * Immutable purchased-credit evidence. A payment can create one grant, a
 * reservation can create one spend, and a full refund/chargeback can occupy
 * only the single adjustment slot of its exact root grant.
 */
export const creditLedger = mysqlTable(
  "credit_ledger",
  {
    entryId: varchar("entry_id", { length: 36 }).primaryKey(),
    walletId: varchar("wallet_id", { length: 36 }).notNull(),
    workspaceId: int("workspace_id").notNull(),
    mode: mysqlEnum("mode", ["test", "live"]).notNull(),
    channelConnectionId: int("channel_connection_id").notNull(),
    bindingEpoch: int("binding_epoch").notNull(),
    privacyEpoch: int("privacy_epoch").notNull(),
    financialSubjectRef: varchar("financial_subject_ref", {
      length: 64,
    }).notNull(),
    sourceIntentId: varchar("source_intent_id", { length: 36 }),
    authorizationEpoch: int("authorization_epoch"),
    paymentLedgerId: int("payment_ledger_id"),
    providerPaymentId: varchar("provider_payment_id", { length: 64 }),
    offerId: varchar("offer_id", { length: 80 }),
    paymentAmount: decimal("payment_amount", {
      precision: 10,
      scale: 2,
    }),
    currency: varchar("currency", { length: 3 }),
    purchasedCreditCount: int("purchased_credit_count"),
    providerDescription: varchar("provider_description", { length: 255 }),
    entryKind: mysqlEnum("entry_kind", [
      "purchase_grant",
      "reservation_hold",
      "generation_spend",
      "reservation_release",
      "refund_debit",
      "chargeback_debit",
      "chargeback_restore",
    ]).notNull(),
    balanceDelta: int("balance_delta").notNull(),
    reservedDelta: int("reserved_delta").notNull(),
    eventKeyHash: varchar("event_key_hash", { length: 64 }).notNull(),
    providerEventHash: varchar("provider_event_hash", { length: 64 }),
    providerEffectId: varchar("provider_effect_id", { length: 64 }),
    providerEffectType: mysqlEnum("provider_effect_type", [
      "refund",
      "chargeback",
    ]),
    providerEffectStatus: mysqlEnum("provider_effect_status", [
      "refunded",
      "active",
      "reversed",
    ]),
    providerEffectAmount: decimal("provider_effect_amount", {
      precision: 10,
      scale: 2,
    }),
    providerEffectCurrency: varchar("provider_effect_currency", { length: 3 }),
    providerEffectEvidence: json("provider_effect_evidence"),
    grantPaymentId: varchar("grant_payment_id", { length: 64 }),
    reservationId: varchar("reservation_id", { length: 36 }),
    reservationCreditCount: int("reservation_credit_count"),
    reservationTerminalSlot: int("reservation_terminal_slot"),
    reservationTerminalStatus: mysqlEnum("reservation_terminal_status", [
      "committed",
      "released",
      "expired",
    ]),
    rootGrantEntryId: varchar("root_grant_entry_id", { length: 36 }),
    rootAdjustmentSlot: int("root_adjustment_slot"),
    evidenceHash: varchar("evidence_hash", {
      length: 64,
    }).notNull(),
    previousEntryId: varchar("previous_entry_id", { length: 36 }),
    walletVersionBefore: int("wallet_version_before").notNull(),
    walletVersionAfter: int("wallet_version_after").notNull(),
    balanceBefore: int("balance_before").notNull(),
    reservedBefore: int("reserved_before").notNull(),
    balanceAfter: int("balance_after").notNull(),
    reservedAfter: int("reserved_after").notNull(),
    occurredAt: timestamp("occurred_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  table => [
    foreignKey({
      name: "credit_ledger_wallet_scope_fk",
      columns: [
        table.walletId,
        table.workspaceId,
        table.mode,
        table.channelConnectionId,
        table.bindingEpoch,
        table.privacyEpoch,
        table.financialSubjectRef,
      ],
      foreignColumns: [
        creditWallets.walletId,
        creditWallets.workspaceId,
        creditWallets.mode,
        creditWallets.channelConnectionId,
        creditWallets.bindingEpoch,
        creditWallets.privacyEpoch,
        creditWallets.financialSubjectRef,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "credit_ledger_financial_intent_fk",
      columns: [
        table.sourceIntentId,
        table.walletId,
        table.workspaceId,
        table.mode,
      ],
      foreignColumns: [
        billingIntents.intentId,
        billingIntents.creditWalletId,
        billingIntents.workspaceId,
        billingIntents.mode,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "credit_ledger_reservation_scope_fk",
      columns: [
        table.reservationId,
        table.walletId,
        table.workspaceId,
        table.mode,
        table.reservationCreditCount,
      ],
      foreignColumns: [
        creditReservations.reservationId,
        creditReservations.walletId,
        creditReservations.workspaceId,
        creditReservations.mode,
        creditReservations.reservedCreditCount,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "credit_ledger_payment_scope_fk",
      columns: [
        table.paymentLedgerId,
        table.workspaceId,
        table.mode,
        table.providerPaymentId,
      ],
      foreignColumns: [
        paymentLedger.id,
        paymentLedger.workspaceId,
        paymentLedger.mode,
        paymentLedger.molliePaymentId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "credit_ledger_root_grant_wallet_fk",
      columns: [
        table.rootGrantEntryId,
        table.walletId,
        table.workspaceId,
        table.mode,
      ],
      foreignColumns: [
        table.entryId,
        table.walletId,
        table.workspaceId,
        table.mode,
      ],
    }).onDelete("restrict"),
    uniqueIndex("credit_ledger_wallet_entry_unique").on(
      table.entryId,
      table.walletId,
      table.workspaceId,
      table.mode
    ),
    uniqueIndex("credit_ledger_event_unique").on(
      table.mode,
      table.eventKeyHash
    ),
    uniqueIndex("credit_ledger_grant_payment_unique").on(
      table.mode,
      table.grantPaymentId
    ),
    uniqueIndex("credit_ledger_reservation_effect_unique").on(
      table.mode,
      table.reservationId,
      table.entryKind
    ),
    uniqueIndex("credit_ledger_reservation_terminal_unique").on(
      table.mode,
      table.reservationId,
      table.reservationTerminalSlot
    ),
    uniqueIndex("credit_ledger_root_adjustment_unique").on(
      table.mode,
      table.rootGrantEntryId,
      table.rootAdjustmentSlot
    ),
    uniqueIndex("credit_ledger_provider_effect_unique").on(
      table.mode,
      table.providerEventHash
    ),
    uniqueIndex("credit_ledger_provider_effect_slot_unique").on(
      table.mode,
      table.providerEffectId,
      table.rootAdjustmentSlot
    ),
    uniqueIndex("credit_ledger_wallet_version_unique").on(
      table.walletId,
      table.walletVersionAfter
    ),
    index("credit_ledger_wallet_time_idx").on(
      table.walletId,
      table.occurredAt,
      table.entryId
    ),
    check(
      "credit_ledger_values_valid",
      sql`(${table.balanceDelta} <> 0 OR ${table.reservedDelta} <> 0) AND REGEXP_LIKE(${table.eventKeyHash}, '^[0-9a-f]{64}$', 'c') AND REGEXP_LIKE(${table.evidenceHash}, '^[0-9a-f]{64}$', 'c') AND ${table.walletVersionBefore} > 0 AND ${table.walletVersionAfter} = ${table.walletVersionBefore} + 1 AND ${table.balanceAfter} = ${table.balanceBefore} + ${table.balanceDelta} AND ${table.reservedAfter} = ${table.reservedBefore} + ${table.reservedDelta} AND ${table.reservedBefore} >= 0 AND ${table.reservedAfter} >= 0 AND ${table.reservedAfter} <= GREATEST(${table.balanceAfter}, 0) AND ${table.occurredAt} <= ${table.createdAt}`
    ),
    check(
      "credit_ledger_ids_valid",
      sql`REGEXP_LIKE(${table.entryId}, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'c') AND REGEXP_LIKE(${table.walletId}, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'c') AND (${table.previousEntryId} IS NULL OR REGEXP_LIKE(${table.previousEntryId}, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'c')) AND (${table.reservationId} IS NULL OR REGEXP_LIKE(${table.reservationId}, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'c')) AND (${table.rootGrantEntryId} IS NULL OR REGEXP_LIKE(${table.rootGrantEntryId}, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'c'))`
    ),
    check(
      "credit_ledger_entry_shape",
      sql`((${table.entryKind} = 'purchase_grant' AND ${table.balanceDelta} = ${table.purchasedCreditCount} AND ${table.reservedDelta} = 0 AND ${table.grantPaymentId} IS NOT NULL AND ${table.providerPaymentId} IS NOT NULL AND ${table.grantPaymentId} = ${table.providerPaymentId} AND ${table.sourceIntentId} IS NOT NULL AND ${table.authorizationEpoch} IS NOT NULL AND ${table.authorizationEpoch} > 0 AND ${table.paymentLedgerId} IS NOT NULL AND ${table.offerId} IS NOT NULL AND ${table.paymentAmount} IS NOT NULL AND ${table.paymentAmount} > 0 AND ${table.currency} IS NOT NULL AND ${table.currency} = 'EUR' AND ${table.purchasedCreditCount} IS NOT NULL AND ${table.purchasedCreditCount} > 0 AND ${table.providerDescription} IS NOT NULL AND ${table.reservationId} IS NULL AND ${table.reservationCreditCount} IS NULL AND ${table.reservationTerminalSlot} IS NULL AND ${table.rootGrantEntryId} IS NULL AND ${table.rootAdjustmentSlot} IS NULL AND ${table.providerEventHash} IS NULL) OR (${table.entryKind} = 'reservation_hold' AND ${table.balanceDelta} = 0 AND ${table.reservationCreditCount} IS NOT NULL AND ${table.reservedDelta} = ${table.reservationCreditCount} AND ${table.reservationCreditCount} > 0 AND ${table.reservationId} IS NOT NULL AND ${table.reservationTerminalSlot} IS NULL AND ${table.sourceIntentId} IS NULL AND ${table.authorizationEpoch} IS NULL AND ${table.paymentLedgerId} IS NULL AND ${table.providerPaymentId} IS NULL AND ${table.offerId} IS NULL AND ${table.paymentAmount} IS NULL AND ${table.currency} IS NULL AND ${table.purchasedCreditCount} IS NULL AND ${table.providerDescription} IS NULL AND ${table.grantPaymentId} IS NULL AND ${table.rootGrantEntryId} IS NULL AND ${table.rootAdjustmentSlot} IS NULL AND ${table.providerEventHash} IS NULL) OR (${table.entryKind} = 'generation_spend' AND ${table.reservationCreditCount} IS NOT NULL AND ${table.balanceDelta} = -${table.reservationCreditCount} AND ${table.reservedDelta} = -${table.reservationCreditCount} AND ${table.reservationCreditCount} > 0 AND ${table.reservationId} IS NOT NULL AND ${table.reservationTerminalSlot} = 1 AND ${table.sourceIntentId} IS NULL AND ${table.authorizationEpoch} IS NULL AND ${table.paymentLedgerId} IS NULL AND ${table.providerPaymentId} IS NULL AND ${table.offerId} IS NULL AND ${table.paymentAmount} IS NULL AND ${table.currency} IS NULL AND ${table.purchasedCreditCount} IS NULL AND ${table.providerDescription} IS NULL AND ${table.grantPaymentId} IS NULL AND ${table.rootGrantEntryId} IS NULL AND ${table.rootAdjustmentSlot} IS NULL AND ${table.providerEventHash} IS NULL) OR (${table.entryKind} = 'reservation_release' AND ${table.reservationCreditCount} IS NOT NULL AND ${table.balanceDelta} = 0 AND ${table.reservedDelta} = -${table.reservationCreditCount} AND ${table.reservationCreditCount} > 0 AND ${table.reservationId} IS NOT NULL AND ${table.reservationTerminalSlot} = 1 AND ${table.sourceIntentId} IS NULL AND ${table.authorizationEpoch} IS NULL AND ${table.paymentLedgerId} IS NULL AND ${table.providerPaymentId} IS NULL AND ${table.offerId} IS NULL AND ${table.paymentAmount} IS NULL AND ${table.currency} IS NULL AND ${table.purchasedCreditCount} IS NULL AND ${table.providerDescription} IS NULL AND ${table.grantPaymentId} IS NULL AND ${table.rootGrantEntryId} IS NULL AND ${table.rootAdjustmentSlot} IS NULL AND ${table.providerEventHash} IS NULL) OR (${table.entryKind} IN ('refund_debit','chargeback_debit') AND ${table.purchasedCreditCount} IS NOT NULL AND ${table.balanceDelta} = -${table.purchasedCreditCount} AND ${table.reservedDelta} = 0 AND ${table.sourceIntentId} IS NOT NULL AND ${table.authorizationEpoch} IS NOT NULL AND ${table.authorizationEpoch} > 0 AND ${table.paymentLedgerId} IS NOT NULL AND ${table.providerPaymentId} IS NOT NULL AND ${table.offerId} IS NOT NULL AND ${table.paymentAmount} IS NOT NULL AND ${table.paymentAmount} > 0 AND ${table.currency} IS NOT NULL AND ${table.currency} = 'EUR' AND ${table.purchasedCreditCount} > 0 AND ${table.providerDescription} IS NOT NULL AND ${table.grantPaymentId} IS NULL AND ${table.reservationId} IS NULL AND ${table.reservationCreditCount} IS NULL AND ${table.reservationTerminalSlot} IS NULL AND ${table.rootGrantEntryId} IS NOT NULL AND ${table.rootAdjustmentSlot} = 1 AND ${table.providerEventHash} IS NOT NULL AND CHAR_LENGTH(${table.providerEventHash}) = 64) OR (${table.entryKind} = 'chargeback_restore' AND ${table.purchasedCreditCount} IS NOT NULL AND ${table.balanceDelta} = ${table.purchasedCreditCount} AND ${table.reservedDelta} = 0 AND ${table.sourceIntentId} IS NOT NULL AND ${table.authorizationEpoch} IS NOT NULL AND ${table.authorizationEpoch} > 0 AND ${table.paymentLedgerId} IS NOT NULL AND ${table.providerPaymentId} IS NOT NULL AND ${table.offerId} IS NOT NULL AND ${table.paymentAmount} IS NOT NULL AND ${table.paymentAmount} > 0 AND ${table.currency} IS NOT NULL AND ${table.currency} = 'EUR' AND ${table.purchasedCreditCount} > 0 AND ${table.providerDescription} IS NOT NULL AND ${table.grantPaymentId} IS NULL AND ${table.reservationId} IS NULL AND ${table.reservationCreditCount} IS NULL AND ${table.reservationTerminalSlot} IS NULL AND ${table.rootGrantEntryId} IS NOT NULL AND ${table.rootAdjustmentSlot} = 2 AND ${table.providerEventHash} IS NOT NULL AND CHAR_LENGTH(${table.providerEventHash}) = 64)) IS TRUE`
    ),
    check(
      "credit_ledger_required_fields_total",
      sql`(CASE WHEN ${table.entryKind} = 'purchase_grant' THEN ${table.sourceIntentId} IS NOT NULL AND ${table.authorizationEpoch} IS NOT NULL AND ${table.paymentLedgerId} IS NOT NULL AND ${table.providerPaymentId} IS NOT NULL AND ${table.offerId} IS NOT NULL AND ${table.paymentAmount} IS NOT NULL AND ${table.currency} IS NOT NULL AND ${table.purchasedCreditCount} IS NOT NULL AND ${table.providerDescription} IS NOT NULL AND ${table.grantPaymentId} IS NOT NULL WHEN ${table.entryKind} = 'reservation_hold' THEN ${table.reservationId} IS NOT NULL AND ${table.reservationCreditCount} IS NOT NULL WHEN ${table.entryKind} IN ('generation_spend','reservation_release') THEN ${table.reservationId} IS NOT NULL AND ${table.reservationCreditCount} IS NOT NULL AND ${table.reservationTerminalStatus} IS NOT NULL WHEN ${table.entryKind} IN ('refund_debit','chargeback_debit','chargeback_restore') THEN ${table.sourceIntentId} IS NOT NULL AND ${table.authorizationEpoch} IS NOT NULL AND ${table.paymentLedgerId} IS NOT NULL AND ${table.providerPaymentId} IS NOT NULL AND ${table.offerId} IS NOT NULL AND ${table.paymentAmount} IS NOT NULL AND ${table.currency} IS NOT NULL AND ${table.purchasedCreditCount} IS NOT NULL AND ${table.providerDescription} IS NOT NULL AND ${table.rootGrantEntryId} IS NOT NULL AND ${table.providerEventHash} IS NOT NULL AND ${table.providerEffectId} IS NOT NULL AND ${table.providerEffectType} IS NOT NULL AND ${table.providerEffectStatus} IS NOT NULL AND ${table.providerEffectAmount} IS NOT NULL AND ${table.providerEffectCurrency} IS NOT NULL ELSE false END) IS TRUE`
    ),
    check(
      "credit_ledger_effect_shape",
      sql`((${table.entryKind} NOT IN ('refund_debit','chargeback_debit','chargeback_restore') AND ${table.providerEventHash} IS NULL AND ${table.providerEffectId} IS NULL AND ${table.providerEffectType} IS NULL AND ${table.providerEffectStatus} IS NULL AND ${table.providerEffectAmount} IS NULL AND ${table.providerEffectCurrency} IS NULL) OR (${table.entryKind} = 'refund_debit' AND ${table.providerEventHash} IS NOT NULL AND ${table.providerEffectId} IS NOT NULL AND REGEXP_LIKE(${table.providerEventHash}, '^[0-9a-f]{64}$', 'c') AND ${table.providerEffectId} REGEXP '^[A-Za-z0-9_-]{1,64}$' AND ${table.providerEffectType} = 'refund' AND ${table.providerEffectStatus} = 'refunded' AND ${table.providerEffectAmount} = ${table.paymentAmount} AND BINARY ${table.providerEffectCurrency} = BINARY ${table.currency}) OR (${table.entryKind} = 'chargeback_debit' AND ${table.providerEventHash} IS NOT NULL AND ${table.providerEffectId} IS NOT NULL AND REGEXP_LIKE(${table.providerEventHash}, '^[0-9a-f]{64}$', 'c') AND ${table.providerEffectId} REGEXP '^[A-Za-z0-9_-]{1,64}$' AND ${table.providerEffectType} = 'chargeback' AND ${table.providerEffectStatus} = 'active' AND ${table.providerEffectAmount} = ${table.paymentAmount} AND BINARY ${table.providerEffectCurrency} = BINARY ${table.currency}) OR (${table.entryKind} = 'chargeback_restore' AND ${table.providerEventHash} IS NOT NULL AND ${table.providerEffectId} IS NOT NULL AND REGEXP_LIKE(${table.providerEventHash}, '^[0-9a-f]{64}$', 'c') AND ${table.providerEffectId} REGEXP '^[A-Za-z0-9_-]{1,64}$' AND ${table.providerEffectType} = 'chargeback' AND ${table.providerEffectStatus} = 'reversed' AND ${table.providerEffectAmount} = ${table.paymentAmount} AND BINARY ${table.providerEffectCurrency} = BINARY ${table.currency})) IS TRUE`
    ),
    check(
      "credit_ledger_provider_effect_evidence_shape",
      sql`(${table.entryKind} = 'refund_debit' AND ${table.providerEffectEvidence} IS NOT NULL AND JSON_TYPE(${table.providerEffectEvidence}) = 'ARRAY' AND JSON_LENGTH(${table.providerEffectEvidence}) > 0) OR (${table.entryKind} <> 'refund_debit' AND ${table.providerEffectEvidence} IS NULL)`
    ),
    check(
      "credit_ledger_reservation_terminal_shape",
      sql`((${table.entryKind} = 'generation_spend' AND ${table.reservationTerminalStatus} = 'committed') OR (${table.entryKind} = 'reservation_release' AND ${table.reservationTerminalStatus} IN ('released','expired')) OR (${table.entryKind} NOT IN ('generation_spend','reservation_release') AND ${table.reservationTerminalStatus} IS NULL)) IS TRUE`
    ),
    check(
      "credit_ledger_chain_shape",
      sql`(${table.walletVersionBefore} = 1 AND ${table.previousEntryId} IS NULL) OR (${table.walletVersionBefore} > 1 AND ${table.previousEntryId} IS NOT NULL)`
    ),
    check(
      "credit_ledger_financial_bytes",
      sql`(${table.currency} IS NULL OR BINARY ${table.currency} = BINARY 'EUR') AND (${table.providerEffectCurrency} IS NULL OR BINARY ${table.providerEffectCurrency} = BINARY 'EUR')`
    ),
  ]
);

export type CreditLedgerEntry = typeof creditLedger.$inferSelect;
export type InsertCreditLedgerEntry = typeof creditLedger.$inferInsert;
