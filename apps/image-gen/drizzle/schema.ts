import { decimal, foreignKey, int, mysqlEnum, mysqlTable, text, timestamp, varchar, json, index, uniqueIndex } from "drizzle-orm/mysql-core";

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

export const workspaceKnowledgeSources = mysqlTable(
  "workspaceKnowledgeSources",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    sourceType: mysqlEnum("sourceType", ["upload", "website", "manual_text", "integration"]).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    sourceReference: varchar("sourceReference", { length: 1024 }),
    status: mysqlEnum("status", ["active", "queued", "indexing", "error", "disabled"])
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

export type WorkspaceKnowledgeSource = typeof workspaceKnowledgeSources.$inferSelect;
export type InsertWorkspaceKnowledgeSource = typeof workspaceKnowledgeSources.$inferInsert;

export const workspacePrivacySettings = mysqlTable(
  "workspacePrivacySettings",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    allowKnowledgeIndexing: int("allowKnowledgeIndexing").default(1).notNull(),
    allowUsageAnalytics: int("allowUsageAnalytics").default(0).notNull(),
    imageMemoryRetentionDays: int("imageMemoryRetentionDays").default(30).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => ({
    workspacePrivacySettingsWorkspaceUnique: uniqueIndex(
      "workspacePrivacySettings_workspaceId_unique"
    ).on(table.workspaceId),
  })
);

export type WorkspacePrivacySetting = typeof workspacePrivacySettings.$inferSelect;
export type InsertWorkspacePrivacySetting = typeof workspacePrivacySettings.$inferInsert;

export const workspacePrivacyRequests = mysqlTable(
  "workspacePrivacyRequests",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    userId: int("userId").notNull(),
    requestType: mysqlEnum("requestType", ["export", "deletion"]).notNull(),
    status: mysqlEnum("status", ["requested", "processing", "completed", "rejected"])
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

export type WorkspacePrivacyRequest = typeof workspacePrivacyRequests.$inferSelect;
export type InsertWorkspacePrivacyRequest = typeof workspacePrivacyRequests.$inferInsert;

export const workspaceUpgradeRequests = mysqlTable(
  "workspaceUpgradeRequests",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    userId: int("userId").notNull(),
    status: mysqlEnum("status", ["requested", "contacted", "completed", "rejected"])
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

export type WorkspaceUpgradeRequest = typeof workspaceUpgradeRequests.$inferSelect;
export type InsertWorkspaceUpgradeRequest = typeof workspaceUpgradeRequests.$inferInsert;

export const portalHandoffTokens = mysqlTable(
  "portalHandoffTokens",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspaceId").notNull(),
    tokenHash: varchar("tokenHash", { length: 96 }).notNull(),
    messengerSenderUserKey: varchar("messengerSenderUserKey", { length: 96 }),
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
    nextReconciliationAt: timestamp("next_reconciliation_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("billing_customers_workspace_mode_unique").on(
      table.workspaceId,
      table.mode
    ),
    uniqueIndex(
      "billing_customers_mollie_customer_mode_unique"
    ).on(table.mode, table.mollieCustomerId),
    uniqueIndex(
      "billing_customers_external_reference_unique"
    ).on(table.externalReference),
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

export const billingIntents = mysqlTable(
  "billing_intents",
  {
    intentId: varchar("intent_id", { length: 36 }).primaryKey(),
    workspaceId: int("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    mode: mysqlEnum("mode", ["test", "live"]).notNull(),
    planCode: varchar("plan_code", { length: 80 }).notNull(),
    kind: mysqlEnum("kind", ["subscription_start", "payment_method_change"])
      .default("subscription_start")
      .notNull(),
    expectedAmount: decimal("expected_amount", { precision: 10, scale: 2 }).notNull(),
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
      "api_unknown",
    ])
      .default("created")
      .notNull(),
    molliePaymentId: varchar("mollie_payment_id", { length: 64 }),
    idempotencyKey: varchar("idempotency_key", { length: 96 }).notNull(),
    checkoutScopeKey: varchar("checkout_scope_key", { length: 160 }).notNull(),
    paidAt: timestamp("paid_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    index("billing_intents_workspace_mode_created_idx").on(
      table.workspaceId,
      table.mode,
      table.createdAt
    ),
    uniqueIndex(
      "billing_intents_mollie_payment_mode_unique"
    ).on(table.mode, table.molliePaymentId),
    uniqueIndex("billing_intents_idempotency_unique").on(
      table.idempotencyKey
    ),
    uniqueIndex(
      "billing_intents_checkout_scope_unique"
    ).on(table.checkoutScopeKey),
  ]
);

export type BillingIntent = typeof billingIntents.$inferSelect;
export type InsertBillingIntent = typeof billingIntents.$inferInsert;

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
    recurringAmount: decimal("recurring_amount", { precision: 10, scale: 2 }).notNull(),
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
      name: "billing_subscriptions_source_intent_fk",
      columns: [table.sourceIntentId],
      foreignColumns: [billingIntents.intentId],
    }).onDelete("restrict"),
    // Intentional current-state model: each workspace/mode owns one mutable
    // subscription row. Replacements update this row; this table is not a
    // subscription-history ledger.
    uniqueIndex("billing_subscriptions_workspace_mode_unique").on(
      table.workspaceId,
      table.mode
    ),
    uniqueIndex(
      "billing_subscriptions_mollie_subscription_mode_unique"
    ).on(table.mode, table.mollieSubscriptionId),
    uniqueIndex(
      "billing_subscriptions_idempotency_unique"
    ).on(table.idempotencyKey),
  ]
);

export type BillingSubscription = typeof billingSubscriptions.$inferSelect;
export type InsertBillingSubscription = typeof billingSubscriptions.$inferInsert;

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

export type BillingInvoiceSequence = typeof billingInvoiceSequences.$inferSelect;

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
    observedSnapshotHash: varchar("observed_snapshot_hash", { length: 64 }).notNull(),
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
    uniqueIndex("payment_ledger_invoice_unique").on(
      table.invoiceNumber
    ),
    index("payment_ledger_workspace_mode_occurred_idx").on(
      table.workspaceId,
      table.mode,
      table.occurredAt
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
    uniqueIndex(
      "webhook_deliveries_resource_snapshot_mode_unique"
    ).on(
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
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex("workspace_entitlements_workspace_mode_unique").on(
      table.workspaceId,
      table.mode
    ),
  ]
);

export type WorkspaceEntitlement = typeof workspaceEntitlements.$inferSelect;
export type InsertWorkspaceEntitlement = typeof workspaceEntitlements.$inferInsert;

/** Reliable post-commit work for mandate checks, subscription creation and alerts. */
export const billingOutbox = mysqlTable(
  "billing_outbox",
  {
    id: int("id").autoincrement().primaryKey(),
    workspaceId: int("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    mode: mysqlEnum("mode", ["test", "live"]).notNull(),
    eventType: mysqlEnum("event_type", [
      "ensure_subscription",
      "cancel_subscription",
      "payment_warning",
      "manual_review",
    ]).notNull(),
    deduplicationKey: varchar("deduplication_key", { length: 160 }).notNull(),
    payload: json("payload").notNull(),
    status: mysqlEnum("status", ["pending", "processing", "completed", "failed"])
      .default("pending")
      .notNull(),
    attemptCount: int("attempt_count").default(0).notNull(),
    maxAttempts: int("max_attempts").default(12).notNull(),
    availableAt: timestamp("available_at").defaultNow().notNull(),
    lockedAt: timestamp("locked_at"),
    leaseToken: varchar("lease_token", { length: 36 }),
    lastErrorCode: varchar("last_error_code", { length: 80 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    uniqueIndex(
      "billing_outbox_mode_deduplication_unique"
    ).on(table.mode, table.deduplicationKey),
    index("billing_outbox_mode_status_available_idx").on(
      table.mode,
      table.status,
      table.availableAt
    ),
  ]
);

export type BillingOutboxItem = typeof billingOutbox.$inferSelect;
export type InsertBillingOutboxItem = typeof billingOutbox.$inferInsert;

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
    uniqueIndex(
      "billing_reconciliation_runs_workspace_mode_period_unique"
    ).on(
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
