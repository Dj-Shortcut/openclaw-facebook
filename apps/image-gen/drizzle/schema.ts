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
  table => ({
    tokenHashUnique: uniqueIndex("portalHandoffTokens_tokenHash_unique").on(
      table.tokenHash
    ),
    deliveryIdempotencyKeyHashUnique: uniqueIndex(
      "portalHandoffTokens_delivery_key_hash_unique"
    ).on(table.deliveryIdempotencyKeyHash),
    workspaceStatusIdx: index("portalHandoffTokens_workspace_status_idx").on(
      table.workspaceId,
      table.status
    ),
  })
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
      sql`${table.enabled} = false OR (${table.operatorRequestId} IS NOT NULL AND ${table.operatorRequestFingerprint} IS NOT NULL AND ${table.enabledByUserId} IS NOT NULL AND ${table.enabledAt} IS NOT NULL)`
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
      name: "messenger_provider_fence_connection_workspace_fk",
      columns: [
        table.channelConnectionId,
        table.workspaceId,
        table.bindingEpoch,
      ],
      foreignColumns: [
        channelConnections.id,
        channelConnections.workspaceId,
        channelConnections.bindingEpoch,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "messenger_provider_fence_privacy_subject_fk",
      columns: [
        table.workspaceId,
        table.channelConnectionId,
        table.userKey,
        table.privacyEpoch,
      ],
      foreignColumns: [
        messengerPrivacySubjects.workspaceId,
        messengerPrivacySubjects.channelConnectionId,
        messengerPrivacySubjects.userKey,
        messengerPrivacySubjects.privacyEpoch,
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
    /** HMAC-derived Messenger identity captured only for an opted-in handoff checkout. */
    messengerSenderUserKey: varchar("messenger_sender_user_key", {
      length: 96,
    }),
    /** Receiving Facebook Page bound to the handoff checkout. */
    messengerPageId: varchar("messenger_page_id", { length: 160 }),
    billingProfileVersion: int("billing_profile_version").notNull(),
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
      table.billingProfileVersion
    ),
    uniqueIndex("billing_intents_scope_unique").on(
      table.intentId,
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
      "create_payment",
      "create_subscription",
      "cancel_payment",
      "cancel_subscription",
    ]).notNull(),
    operationKey: varchar("operation_key", { length: 160 }).notNull(),
    intentId: varchar("intent_id", { length: 36 }).notNull(),
    billingProfileVersion: int("billing_profile_version").notNull(),
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
      ],
      foreignColumns: [
        billingIntents.intentId,
        billingIntents.workspaceId,
        billingIntents.mode,
        billingIntents.billingProfileVersion,
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
    uniqueIndex("payment_ledger_invoice_unique").on(table.invoiceNumber),
    index("payment_ledger_workspace_mode_occurred_idx").on(
      table.workspaceId,
      table.mode,
      table.occurredAt,
      table.id
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
      name: "weur_connection_workspace_fk",
      columns: [
        table.channelConnectionId,
        table.workspaceId,
        table.bindingEpoch,
      ],
      foreignColumns: [
        channelConnections.id,
        channelConnections.workspaceId,
        channelConnections.bindingEpoch,
      ],
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
      columns: [
        table.receiptId,
        table.workspaceId,
        table.mode,
        table.audience,
      ],
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
