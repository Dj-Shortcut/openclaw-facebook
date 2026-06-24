import { desc, eq, and, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  aiIdentities,
  auditLog,
  channelConnections,
  dailyQuota,
  imageRequests,
  InsertAiIdentity,
  InsertAuditLog,
  InsertChannelConnection,
  InsertImageRequest,
  InsertMessengerState,
  InsertNotificationLog,
  InsertUsageStats,
  InsertUser,
  InsertWorkspace,
  InsertWorkspaceKnowledgeSource,
  InsertWorkspaceMember,
  InsertWorkspacePrivacySetting,
  InsertWorkspacePrivacyRequest,
  messengerState,
  notificationLog,
  usageStats,
  users,
  workspaceMembers,
  workspacePrivacySettings,
  workspacePrivacyRequests,
  workspaceKnowledgeSources,
  workspaces,
  workspaceUsageDaily,
} from "../drizzle/schema";
import { ENV } from './_core/env';
import { safeLog } from "./_core/logger";
import {
  getBotTextRateLimitMax,
  getBotTextRateLimitWindowSeconds,
  getImageGenerationDailyLimit,
} from "./_core/quotaPolicy";

let _db: ReturnType<typeof drizzle> | null = null;

function logDatabaseUnavailable(operation: string): void {
  safeLog("database_unavailable", {
    level: "warn",
    operation,
  });
}

// Lazily create the drizzle instance so local tooling can run without a DB.
async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      safeLog("database_connect_failed", {
        level: "warn",
        error,
      });
      _db = null;
    }
  }
  await Promise.resolve();
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("upsert_user");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    safeLog("database_upsert_user_failed", {
      level: "error",
      error,
    });
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("get_user_by_open_id");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

async function getUserById(id: number) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("get_user_by_id");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.id, id)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

function fallbackWorkspaceForUser(userId: number, name?: string | null) {
  return {
    id: userId,
    name: name ? `${name}'s workspace` : "Leaderbot workspace",
    slug: `workspace-${userId}`,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

export async function getOrCreateUserWorkspace(user: {
  id: number;
  name?: string | null;
}) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("get_or_create_user_workspace");
    return fallbackWorkspaceForUser(user.id, user.name);
  }

  const existing = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      createdAt: workspaces.createdAt,
      updatedAt: workspaces.updatedAt,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(eq(workspaceMembers.userId, user.id))
    .limit(1);

  if (existing.length > 0) {
    return existing[0];
  }

  const workspaceValues: InsertWorkspace = {
    name: user.name ? `${user.name}'s workspace` : "Leaderbot workspace",
    slug: `workspace-${user.id}`,
  };
  await db.insert(workspaces).values(workspaceValues).onDuplicateKeyUpdate({
    set: { slug: workspaceValues.slug },
  });

  const created = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.slug, workspaceValues.slug))
    .limit(1);

  const workspace = created[0] ?? fallbackWorkspaceForUser(user.id, user.name);
  const memberValues: InsertWorkspaceMember = {
    workspaceId: workspace.id,
    userId: user.id,
    role: "owner",
  };
  await db.insert(workspaceMembers).values(memberValues).onDuplicateKeyUpdate({
    set: { workspaceId: memberValues.workspaceId },
  });
  await seedWorkspacePrivacyDefaults(workspace.id);

  return workspace;
}

async function seedWorkspacePrivacyDefaults(workspaceId: number) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("seed_workspace_privacy_defaults");
    return;
  }

  const defaults: InsertWorkspacePrivacySetting = {
    workspaceId,
    allowKnowledgeIndexing: DEFAULT_WORKSPACE_PRIVACY_SETTINGS.allowKnowledgeIndexing ? 1 : 0,
    allowUsageAnalytics: DEFAULT_WORKSPACE_PRIVACY_SETTINGS.allowUsageAnalytics ? 1 : 0,
    imageMemoryRetentionDays: DEFAULT_WORKSPACE_PRIVACY_SETTINGS.imageMemoryRetentionDays,
  };

  await db.insert(workspacePrivacySettings).values(defaults).onDuplicateKeyUpdate({
    set: {
      workspaceId,
    },
  });
}

export async function getWorkspaceMembership(workspaceId: number, userId: number) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("get_workspace_membership");
    return workspaceId === userId ? { workspaceId, userId, role: "owner" as const } : null;
  }

  const result = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      )
    )
    .limit(1);

  return result[0] ?? null;
}

export async function listWorkspaceMembers(workspaceId: number) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("list_workspace_members");
    throw new Error("Database unavailable: workspace members were not loaded");
  }

  return db
    .select({
      userId: workspaceMembers.userId,
      role: workspaceMembers.role,
      createdAt: workspaceMembers.createdAt,
      name: users.name,
      email: users.email,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(workspaceMembers.userId, users.id))
    .where(eq(workspaceMembers.workspaceId, workspaceId));
}

export async function updateWorkspace(workspaceId: number, values: { name: string }) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("update_workspace");
    return {
      id: workspaceId,
      name: values.name,
      slug: `workspace-${workspaceId}`,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
  }

  await db.update(workspaces).set({ name: values.name }).where(eq(workspaces.id, workspaceId));

  const result = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  return result[0] ?? {
    id: workspaceId,
    name: values.name,
    slug: `workspace-${workspaceId}`,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

export async function getOrCreateAiIdentity(workspaceId: number) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("get_or_create_ai_identity");
    return {
      id: workspaceId,
      workspaceId,
      name: "Leaderbot",
      instructions: "Help customers with clear, useful answers.",
      tone: "Helpful",
      language: "nl",
      modelDefault: "default",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
  }

  const existing = await db
    .select()
    .from(aiIdentities)
    .where(eq(aiIdentities.workspaceId, workspaceId))
    .limit(1);

  if (existing.length > 0) {
    return existing[0];
  }

  const values: InsertAiIdentity = {
    workspaceId,
    name: "Leaderbot",
    instructions: "Help customers with clear, useful answers.",
  };
  await db.insert(aiIdentities).values(values).onDuplicateKeyUpdate({
    set: { workspaceId },
  });

  const created = await db
    .select()
    .from(aiIdentities)
    .where(eq(aiIdentities.workspaceId, workspaceId))
    .limit(1);

  return created[0];
}

export async function updateAiIdentity(
  workspaceId: number,
  updates: Pick<InsertAiIdentity, "name" | "instructions" | "tone" | "language" | "modelDefault">
) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("update_ai_identity");
    return {
      id: workspaceId,
      workspaceId,
      createdAt: new Date(0),
      updatedAt: new Date(),
      ...updates,
      instructions: updates.instructions ?? null,
    };
  }

  await getOrCreateAiIdentity(workspaceId);
  await db
    .update(aiIdentities)
    .set(updates)
    .where(eq(aiIdentities.workspaceId, workspaceId));

  return getOrCreateAiIdentity(workspaceId);
}

export async function listChannelConnections(workspaceId: number) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("list_channel_connections");
    return [
      {
        id: workspaceId,
        workspaceId,
        channel: "facebook_messenger" as const,
        status: "disconnected" as const,
        externalId: null,
        displayName: null,
        encryptedAccessToken: null,
        grantedScopes: null,
        lastCheckedAt: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ];
  }

  const result = await db
    .select()
    .from(channelConnections)
    .where(eq(channelConnections.workspaceId, workspaceId));

  return result;
}

type WorkspacePrivacySettingsRecord = {
  allowKnowledgeIndexing: number;
  allowUsageAnalytics: number;
  imageMemoryRetentionDays: number;
  createdAt: Date;
  updatedAt: Date;
};

type WorkspacePrivacySettingsModel = {
  allowKnowledgeIndexing: boolean;
  allowUsageAnalytics: boolean;
  imageMemoryRetentionDays: number;
  createdAt: Date;
  updatedAt: Date;
};

const DEFAULT_WORKSPACE_PRIVACY_SETTINGS: Omit<
  WorkspacePrivacySettingsModel,
  "createdAt" | "updatedAt"
> = {
  allowKnowledgeIndexing: true,
  allowUsageAnalytics: false,
  imageMemoryRetentionDays: 30,
};

function normalizeWorkspacePrivacySettings(
  record?: WorkspacePrivacySettingsRecord | null,
  fallbackBase = new Date()
): WorkspacePrivacySettingsModel {
  if (!record) {
    return {
      allowKnowledgeIndexing: DEFAULT_WORKSPACE_PRIVACY_SETTINGS.allowKnowledgeIndexing,
      allowUsageAnalytics: DEFAULT_WORKSPACE_PRIVACY_SETTINGS.allowUsageAnalytics,
      imageMemoryRetentionDays: DEFAULT_WORKSPACE_PRIVACY_SETTINGS.imageMemoryRetentionDays,
      createdAt: fallbackBase,
      updatedAt: fallbackBase,
    };
  }

  return {
    allowKnowledgeIndexing: record.allowKnowledgeIndexing === 1,
    allowUsageAnalytics: record.allowUsageAnalytics === 1,
    imageMemoryRetentionDays: record.imageMemoryRetentionDays,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function getInsertedId(result: unknown, label: string): number {
  const insertId = (result as { insertId?: unknown } | undefined)?.insertId;

  if (typeof insertId === "number" && Number.isSafeInteger(insertId) && insertId > 0) {
    return insertId;
  }

  if (typeof insertId === "bigint" && insertId > BigInt(0)) {
    const numericId = Number(insertId);
    if (Number.isSafeInteger(numericId)) {
      return numericId;
    }
  }

  if (typeof insertId === "string") {
    const numericId = Number(insertId);
    if (Number.isSafeInteger(numericId) && numericId > 0) {
      return numericId;
    }
  }

  throw new Error(`${label} insert did not return an id`);
}

export async function listWorkspaceKnowledgeSources(workspaceId: number) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("list_workspace_knowledge_sources");
    throw new Error("Database unavailable: knowledge sources were not loaded");
  }

  const result = await db
    .select()
    .from(workspaceKnowledgeSources)
    .where(eq(workspaceKnowledgeSources.workspaceId, workspaceId))
    .orderBy((table) => table.name);

  return result;
}

export async function registerWorkspaceKnowledgeSource(
  workspaceId: number,
  values: Pick<
    InsertWorkspaceKnowledgeSource,
    "sourceType" | "name" | "sourceReference"
  >
) {
  const db = await getDb();
  const now = new Date();
  const source: InsertWorkspaceKnowledgeSource = {
    workspaceId,
    sourceType: values.sourceType,
    name: values.name,
    sourceReference: values.sourceReference ?? null,
    status: "queued",
    itemCount: 0,
  };

  if (!db) {
    logDatabaseUnavailable("register_workspace_knowledge_source");
    return {
      id: workspaceId,
      ...source,
      lastIndexedAt: null,
      metadata: null,
      createdAt: new Date(0),
      updatedAt: now,
    };
  }

  await db.insert(workspaceKnowledgeSources).values(source).onDuplicateKeyUpdate({
    set: {
      sourceType: source.sourceType,
      sourceReference: source.sourceReference,
      status: "queued",
      itemCount: 0,
      lastIndexedAt: null,
    },
  });

  const created = await db
    .select()
    .from(workspaceKnowledgeSources)
    .where(
      and(
        eq(workspaceKnowledgeSources.workspaceId, workspaceId),
        eq(workspaceKnowledgeSources.name, source.name)
      )
    )
    .limit(1);

  return created[0] ?? {
    id: workspaceId,
    ...source,
    lastIndexedAt: null,
    metadata: null,
    createdAt: new Date(0),
    updatedAt: now,
  };
}

export async function disableWorkspaceKnowledgeSource(
  workspaceId: number,
  sourceId: number
) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("disable_workspace_knowledge_source");
    throw new Error("Database unavailable: knowledge source was not disabled");
  }

  await db
    .update(workspaceKnowledgeSources)
    .set({ status: "disabled" })
    .where(
      and(
        eq(workspaceKnowledgeSources.workspaceId, workspaceId),
        eq(workspaceKnowledgeSources.id, sourceId)
      )
    );

  const result = await db
    .select()
    .from(workspaceKnowledgeSources)
    .where(
      and(
        eq(workspaceKnowledgeSources.workspaceId, workspaceId),
        eq(workspaceKnowledgeSources.id, sourceId)
      )
    )
    .limit(1);

  if (!result[0]) {
    throw new Error("Knowledge source not found for workspace");
  }

  return result[0];
}

export async function getWorkspaceKnowledgeSummary(workspaceId: number) {
  const sources = await listWorkspaceKnowledgeSources(workspaceId);
  const activeSources = sources.filter(source => source.status === "active");
  return {
    workspaceId,
    totalSources: sources.length,
    activeSources: activeSources.length,
    lastUpdate:
      sources.reduce((last: Date | null, source) => {
        if (!source.updatedAt || (last && source.updatedAt <= last)) {
          return last;
        }
        return source.updatedAt;
      }, null as Date | null) ?? new Date(0),
    sources,
  };
}

export async function getWorkspacePrivacySettings(workspaceId: number) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("get_workspace_privacy_settings");
    return {
      workspaceId,
      ...DEFAULT_WORKSPACE_PRIVACY_SETTINGS,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
  }

  const existing = await db
    .select()
    .from(workspacePrivacySettings)
    .where(eq(workspacePrivacySettings.workspaceId, workspaceId))
    .limit(1);

  const record = existing[0];
  if (record) {
    return {
      workspaceId,
      ...normalizeWorkspacePrivacySettings(record, record.createdAt),
    };
  }

  return {
    workspaceId,
    ...normalizeWorkspacePrivacySettings(undefined, new Date(0)),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export async function updateWorkspacePrivacySettings(
  workspaceId: number,
  updates: {
    allowKnowledgeIndexing: boolean;
    allowUsageAnalytics: boolean;
    imageMemoryRetentionDays: number;
  }
) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("update_workspace_privacy_settings");
    return {
      workspaceId,
      ...updates,
      createdAt: new Date(0),
      updatedAt: new Date(),
    };
  }

  const values: InsertWorkspacePrivacySetting = {
    workspaceId,
    allowKnowledgeIndexing: updates.allowKnowledgeIndexing ? 1 : 0,
    allowUsageAnalytics: updates.allowUsageAnalytics ? 1 : 0,
    imageMemoryRetentionDays: updates.imageMemoryRetentionDays,
  };

  await db.insert(workspacePrivacySettings).values(values).onDuplicateKeyUpdate({
    set: {
      allowKnowledgeIndexing: values.allowKnowledgeIndexing,
      allowUsageAnalytics: values.allowUsageAnalytics,
      imageMemoryRetentionDays: values.imageMemoryRetentionDays,
    },
  });

  return getWorkspacePrivacySettings(workspaceId);
}

export async function listWorkspacePrivacyRequests(workspaceId: number) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("list_workspace_privacy_requests");
    throw new Error("Database unavailable: privacy requests were not loaded");
  }

  const result = await db
    .select()
    .from(workspacePrivacyRequests)
    .where(eq(workspacePrivacyRequests.workspaceId, workspaceId))
    .orderBy(desc(workspacePrivacyRequests.id));

  return result;
}

export async function createWorkspacePrivacyRequest(
  workspaceId: number,
  userId: number,
  values: Pick<InsertWorkspacePrivacyRequest, "requestType" | "note">,
  audit?: Pick<InsertAuditLog, "event" | "metadata">
) {
  const db = await getDb();
  const request: InsertWorkspacePrivacyRequest = {
    workspaceId,
    userId,
    requestType: values.requestType,
    note: values.note ?? null,
    status: "requested",
  };

  if (!db) {
    logDatabaseUnavailable("create_workspace_privacy_request");
    throw new Error("Database unavailable: privacy request was not persisted");
  }

  return db.transaction(async tx => {
    const insertResult = await tx.insert(workspacePrivacyRequests).values(request);
    const insertedId = getInsertedId(insertResult, "privacy request");

    if (audit) {
      await tx.insert(auditLog).values({
        workspaceId,
        userId,
        event: audit.event,
        metadata: audit.metadata,
      });
    }

    const created = await tx
      .select()
      .from(workspacePrivacyRequests)
      .where(eq(workspacePrivacyRequests.id, insertedId))
      .limit(1);

    if (!created[0]) {
      throw new Error("Privacy request insert succeeded but read-back failed");
    }

    return created[0];
  });
}

export async function upsertChannelConnection(values: InsertChannelConnection) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("upsert_channel_connection");
    return null;
  }

  await db.insert(channelConnections).values(values).onDuplicateKeyUpdate({
    set: {
      status: values.status,
      externalId: values.externalId ?? null,
      displayName: values.displayName ?? null,
      encryptedAccessToken: values.encryptedAccessToken ?? null,
      grantedScopes: values.grantedScopes ?? null,
      lastCheckedAt: new Date(),
    },
  });

  return listChannelConnections(values.workspaceId);
}

export async function disconnectChannelConnection(
  workspaceId: number,
  channel: "facebook_messenger" | "whatsapp" | "web"
) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("disconnect_channel_connection");
    throw new Error("Database unavailable: channel connection was not disconnected");
  }

  await db.insert(channelConnections).values({
    workspaceId,
    channel,
    status: "disconnected",
    externalId: null,
    displayName: null,
    encryptedAccessToken: null,
    grantedScopes: null,
    lastCheckedAt: new Date(),
  }).onDuplicateKeyUpdate({
    set: {
      status: "disconnected",
      externalId: null,
      displayName: null,
      encryptedAccessToken: null,
      grantedScopes: null,
      lastCheckedAt: new Date(),
    },
  });

  return listChannelConnections(workspaceId);
}

export async function getWorkspaceUsageSummary(workspaceId: number) {
  const imageDailyLimit = getImageGenerationDailyLimit();
  const messageRateLimit = getBotTextRateLimitMax();
  const messageRateLimitWindowSeconds = getBotTextRateLimitWindowSeconds();

  const buildSummary = (usage?: {
    messageCount?: number | null;
    imageCount?: number | null;
    blockedCount?: number | null;
  }) => {
    const messageCount = usage?.messageCount ?? 0;
    const imageCount = usage?.imageCount ?? 0;
    const blockedCount = usage?.blockedCount ?? 0;
    const imagesRemainingToday = Math.max(0, imageDailyLimit - imageCount);
    const isImageLimitReached = imageDailyLimit > 0 && imagesRemainingToday === 0;

    return {
      workspaceId,
      period: "today" as const,
      plan: {
        name: "Free",
        billingStatus: "free" as const,
      },
      messageCount,
      imageCount,
      blockedCount,
      limits: {
        imagesPerDay: imageDailyLimit,
        messagesPerWindow: messageRateLimit,
        messageWindowSeconds: messageRateLimitWindowSeconds,
      },
      remaining: {
        imagesToday: imagesRemainingToday,
      },
      upgrade: {
        recommended: isImageLimitReached || blockedCount > 0,
        reason: isImageLimitReached
          ? "image_limit_reached"
          : blockedCount > 0
            ? "blocked_usage"
            : null,
      },
    };
  };

  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("get_workspace_usage_summary");
    return buildSummary();
  }

  const today = getTodayUTC();
  const result = await db
    .select()
    .from(workspaceUsageDaily)
    .where(
      and(
        eq(workspaceUsageDaily.workspaceId, workspaceId),
        eq(workspaceUsageDaily.date, today)
      )
    )
    .limit(1);

  const usage = result[0];
  return buildSummary(usage);
}

export async function insertAuditLog(values: InsertAuditLog) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("insert_audit_log");
    return null;
  }

  return db.insert(auditLog).values(values);
}

/**
 * Get today's date in UTC format (YYYY-MM-DD)
 */
function getTodayUTC(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Check if a user can generate an image today (has quota remaining)
 */
export async function canUserGenerateImage(userId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("check_quota");
    return false;
  }

  const today = getTodayUTC();
  const quota = await db
    .select()
    .from(dailyQuota)
    .where(and(eq(dailyQuota.userId, userId), eq(dailyQuota.date, today)))
    .limit(1);

  if (quota.length === 0) {
    return true; // No quota record yet, user can generate
  }

  return quota[0].imagesGenerated < getImageGenerationDailyLimit();
}

/**
 * Increment user's daily image count
 */
async function incrementUserQuota(userId: number): Promise<void> {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("increment_quota");
    return;
  }

  const today = getTodayUTC();
  const now = new Date();

  // Try to update existing quota record
  const existing = await db
    .select()
    .from(dailyQuota)
    .where(and(eq(dailyQuota.userId, userId), eq(dailyQuota.date, today)))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(dailyQuota)
      .set({ imagesGenerated: existing[0].imagesGenerated + 1, lastGeneratedAt: now })
      .where(eq(dailyQuota.id, existing[0].id));
  } else {
    // Create new quota record for today
    await db.insert(dailyQuota).values({
      userId,
      date: today,
      imagesGenerated: 1,
      lastGeneratedAt: now,
    });
  }
}

/**
 * Atomically reserve daily quota for a user.
 * Returns true only when quota is successfully claimed for the current day.
 */
async function reserveUserDailyQuota(userId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("reserve_quota");
    return false;
  }

  const today = getTodayUTC();
  const now = new Date();
  const dailyLimit = getImageGenerationDailyLimit();
  if (dailyLimit <= 0) {
    return false;
  }

  try {
    await db.insert(dailyQuota).values({
      userId,
      date: today,
      imagesGenerated: 1,
      lastGeneratedAt: now,
    });
    return true;
  } catch {
    // Row likely already exists for (userId, today). Continue with conditional update.
  }

  const result = await db.execute(sql`
    UPDATE dailyQuota
    SET imagesGenerated = imagesGenerated + 1,
        lastGeneratedAt = ${now},
        updatedAt = NOW()
    WHERE userId = ${userId}
      AND date = ${today}
      AND imagesGenerated < ${dailyLimit}
  `);

  const getAffectedRows = (value: unknown): number => {
    if (typeof value === "object" && value !== null && "affectedRows" in value) {
      const maybeAffectedRows = (value as { affectedRows?: unknown }).affectedRows;
      return typeof maybeAffectedRows === "number" ? maybeAffectedRows : 0;
    }

    if (Array.isArray(value) && value.length > 0) {
      return getAffectedRows(value[0]);
    }

    return 0;
  };

  const affectedRows = getAffectedRows(result);
  return affectedRows > 0;
}

/**
 * Releases one reserved daily quota slot when an operation fails after reservation.
 */
async function releaseUserDailyQuota(userId: number): Promise<void> {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("release_quota");
    return;
  }

  const today = getTodayUTC();
  await db.execute(sql`
    UPDATE dailyQuota
    SET imagesGenerated = GREATEST(imagesGenerated - 1, 0),
        updatedAt = NOW()
    WHERE userId = ${userId}
      AND date = ${today}
      AND imagesGenerated > 0
  `);
}

/**
 * Create an image request record
 */
async function createImageRequest(data: InsertImageRequest) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("create_image_request");
    return null;
  }

  const result = await db.insert(imageRequests).values(data);
  return result;
}

/**
 * Update image request with completion details
 */
async function updateImageRequest(id: number, updates: { imageUrl?: string; imageKey?: string; status: 'pending' | 'completed' | 'failed'; errorMessage?: string | null; completedAt?: Date }) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("update_image_request");
    return null;
  }

  const result = await db.update(imageRequests).set(updates).where(eq(imageRequests.id, id));
  return result;
}

/**
 * Get all image requests for a user
 */
async function getUserImageRequests(userId: number, limit = 50, offset = 0) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("get_image_requests");
    return [];
  }

  const results = await db
    .select()
    .from(imageRequests)
    .where(eq(imageRequests.userId, userId))
    .orderBy((t) => t.createdAt)
    .limit(limit)
    .offset(offset);

  return results;
}

/**
 * Get all completed image requests for gallery (public)
 */
async function getCompletedImages(limit = 100, offset = 0) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("get_completed_images");
    return [];
  }

  const results = await db
    .select({
      id: imageRequests.id,
      userId: imageRequests.userId,
      prompt: imageRequests.prompt,
      imageUrl: imageRequests.imageUrl,
      createdAt: imageRequests.createdAt,
      userName: users.name,
    })
    .from(imageRequests)
    .innerJoin(users, eq(imageRequests.userId, users.id))
    .where(eq(imageRequests.status, 'completed'))
    .orderBy((t) => t.createdAt)
    .limit(limit)
    .offset(offset);

  return results;
}

/**
 * Get today's usage statistics
 */
async function getTodayStats() {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("get_stats");
    return null;
  }

  const today = getTodayUTC();
  const stats = await db
    .select()
    .from(usageStats)
    .where(eq(usageStats.date, today))
    .limit(1);

  return stats.length > 0 ? stats[0] : null;
}

/**
 * Update or create today's usage statistics
 */
async function updateTodayStats(updates: Partial<InsertUsageStats>) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("update_stats");
    return null;
  }

  const today = getTodayUTC();
  const existing = await getTodayStats();

  if (existing) {
    await db.update(usageStats).set(updates).where(eq(usageStats.date, today));
  } else {
    await db.insert(usageStats).values({
      date: today,
      ...updates,
    });
  }
}

/**
 * Log a notification
 */
async function logNotification(data: InsertNotificationLog) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("log_notification");
    return null;
  }

  const result = await db.insert(notificationLog).values(data);
  return result;
}

/**
 * Get or create messenger state for a PSID
 */
async function getOrCreateMessengerState(psid: string, userKey: string) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("get_or_create_messenger_state");
    return null;
  }

  const existing = await db
    .select()
    .from(messengerState)
    .where(eq(messengerState.psid, psid))
    .limit(1);

  if (existing.length > 0) return existing[0];

  const newState: InsertMessengerState = { psid, userKey, stage: "IDLE" };
  await db.insert(messengerState).values(newState);
  const created = await db
    .select()
    .from(messengerState)
    .where(eq(messengerState.psid, psid))
    .limit(1);
  return created[0];
}

/**
 * Update messenger state
 */
async function updateMessengerState(psid: string, updates: Partial<InsertMessengerState>) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("update_messenger_state");
    return;
  }

  await db
    .update(messengerState)
    .set(updates)
    .where(eq(messengerState.psid, psid));
}

/**
 * Check and increment daily quota for a PSID (Messenger specific)
 */
async function checkAndIncrementMessengerQuota(psid: string): Promise<boolean> {
  void psid;

  if (!(await getDb())) {
    logDatabaseUnavailable("check_and_increment_messenger_quota");
    return true; // Fail open for quota if DB is down
  }

  // Current implementation intentionally stays fail-open for compatibility.
  return true;
}

/**
 * Get recent notifications for admin dashboard
 */
async function getRecentNotifications(limit = 20) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("get_notifications");
    return [];
  }

  const results = await db
    .select()
    .from(notificationLog)
    .orderBy((t) => t.createdAt)
    .limit(limit);

  return results;
}
