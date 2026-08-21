import { desc, eq, and, isNotNull, sql } from "drizzle-orm";
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
  InsertPortalHandoffToken,
  InsertUsageStats,
  InsertUser,
  InsertWorkspace,
  InsertWorkspaceKnowledgeSource,
  InsertWorkspaceMember,
  InsertWorkspacePrivacySetting,
  InsertWorkspacePrivacyRequest,
  InsertWorkspaceUpgradeRequest,
  messengerState,
  notificationLog,
  portalHandoffTokens,
  usageStats,
  users,
  workspaceMembers,
  workspacePrivacySettings,
  workspacePrivacyRequests,
  workspaceUpgradeRequests,
  workspaceKnowledgeSources,
  workspaces,
  workspaceUsageDaily,
  type PortalHandoffToken,
  type Workspace,
  type WorkspaceMember,
} from "../drizzle/schema";
import { ENV } from './_core/env';
import {
  ConversationIdentityError,
  resolveMessengerEndpoint,
  resolveWhatsAppEndpoint,
} from "./_core/conversationEndpoint";
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

/**
 * Financial writes must fail closed. Billing modules use this accessor instead
 * of the non-financial helpers that can return development fallbacks.
 */
export async function getDatabaseOrThrow() {
  const db = await getDb();
  if (!db) {
    throw new Error("Database unavailable for billing operation");
  }
  return db;
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

export async function getOrCreateUserWorkspace(user: {
  id: number;
  name?: string | null;
}) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("get_or_create_user_workspace");
    throw new Error("Database unavailable: workspace was not loaded");
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
    .orderBy(desc(workspaceMembers.id))
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
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      createdAt: workspaces.createdAt,
      updatedAt: workspaces.updatedAt,
    })
    .from(workspaces)
    .where(eq(workspaces.slug, workspaceValues.slug))
    .limit(1);

  const workspace = created[0];
  if (!workspace) {
    throw new Error("Workspace was not persisted");
  }
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

export async function getWorkspaceById(workspaceId: number) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("get_workspace_by_id");
    throw new Error("Database unavailable: workspace was not loaded");
  }

  const result = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      createdAt: workspaces.createdAt,
      updatedAt: workspaces.updatedAt,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  return result[0] ?? null;
}

export async function addWorkspaceMember(values: InsertWorkspaceMember) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("add_workspace_member");
    throw new Error("Database unavailable: workspace membership was not persisted");
  }

  await db.insert(workspaceMembers).values(values).onDuplicateKeyUpdate({
    set: {
      role: values.role ?? "member",
    },
  });
  await seedWorkspacePrivacyDefaults(values.workspaceId);

  const membership = await getWorkspaceMembership(values.workspaceId, values.userId);
  if (!membership) {
    throw new Error("Workspace membership insert succeeded but read-back failed");
  }

  return membership;
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
    throw new Error("Database unavailable: workspace membership was not loaded");
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
        providerAccountExternalId: null,
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

function unwrapDriverResult(result: unknown): unknown {
  return Array.isArray(result) ? result[0] : result;
}

function getInsertedId(result: unknown, label: string): number {
  const driverResult = unwrapDriverResult(result);
  const insertId = (driverResult as { insertId?: unknown } | undefined)?.insertId;

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

function getAffectedRows(result: unknown): number {
  const driverResult = unwrapDriverResult(result);
  const affectedRows = (driverResult as { affectedRows?: unknown } | undefined)
    ?.affectedRows;

  if (typeof affectedRows === "number" && Number.isSafeInteger(affectedRows)) {
    return affectedRows;
  }

  if (typeof affectedRows === "bigint") {
    const numericRows = Number(affectedRows);
    return Number.isSafeInteger(numericRows) ? numericRows : 0;
  }

  if (typeof affectedRows === "string") {
    const numericRows = Number(affectedRows);
    return Number.isSafeInteger(numericRows) ? numericRows : 0;
  }

  return 0;
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

export async function listWorkspaceUpgradeRequests(workspaceId: number) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("list_workspace_upgrade_requests");
    throw new Error("Database unavailable: upgrade requests were not loaded");
  }

  return db
    .select()
    .from(workspaceUpgradeRequests)
    .where(eq(workspaceUpgradeRequests.workspaceId, workspaceId))
    .orderBy(desc(workspaceUpgradeRequests.id));
}

export async function createWorkspaceUpgradeRequest(
  workspaceId: number,
  userId: number,
  values: Pick<
    InsertWorkspaceUpgradeRequest,
    | "currentPlanName"
    | "billingStatus"
    | "upgradeReason"
    | "imagesRemainingToday"
    | "blockedToday"
    | "requestedPlanName"
  >,
  audit?: Pick<InsertAuditLog, "event" | "metadata">
) {
  const db = await getDb();
  const request: InsertWorkspaceUpgradeRequest = {
    workspaceId,
    userId,
    status: "requested",
    currentPlanName: values.currentPlanName,
    billingStatus: values.billingStatus,
    upgradeReason: values.upgradeReason ?? null,
    imagesRemainingToday: values.imagesRemainingToday,
    blockedToday: values.blockedToday,
    requestedPlanName: values.requestedPlanName,
  };

  if (!db) {
    logDatabaseUnavailable("create_workspace_upgrade_request");
    throw new Error("Database unavailable: upgrade request was not persisted");
  }

  return db.transaction(async tx => {
    const insertResult = await tx.insert(workspaceUpgradeRequests).values(request);
    const insertedId = getInsertedId(insertResult, "upgrade request");

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
      .from(workspaceUpgradeRequests)
      .where(eq(workspaceUpgradeRequests.id, insertedId))
      .limit(1);

    if (!created[0]) {
      throw new Error("Upgrade request insert succeeded but read-back failed");
    }

    return created[0];
  });
}

export async function createPortalHandoffToken(values: InsertPortalHandoffToken) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("create_portal_handoff_token");
    throw new Error("Database unavailable: portal handoff token was not persisted");
  }

  const insertResult = await db.insert(portalHandoffTokens).values(values);
  const insertedId = getInsertedId(insertResult, "portal handoff token");

  const created = await db
    .select()
    .from(portalHandoffTokens)
    .where(eq(portalHandoffTokens.id, insertedId))
    .limit(1);

  if (!created[0]) {
    throw new Error("Portal handoff token insert succeeded but read-back failed");
  }

  return created[0];
}

/**
 * Idempotently persists a delivery token.  Callers that deterministically
 * derive the token from an outbox operation can retry an ambiguous Messenger
 * send without minting another claimable link.
 */
export async function createOrGetPortalHandoffToken(
  values: InsertPortalHandoffToken,
  now = new Date()
) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("create_or_get_portal_handoff_token");
    throw new Error("Database unavailable: portal handoff token was not persisted");
  }

  if (!values.deliveryIdempotencyKeyHash) {
    throw new Error("portal handoff delivery key hash is required");
  }
  return db.transaction(async tx => {
    await tx.insert(portalHandoffTokens).values(values).onDuplicateKeyUpdate({
      set: { deliveryIdempotencyKeyHash: values.deliveryIdempotencyKeyHash },
    });
    const stored = await tx.select().from(portalHandoffTokens).where(
      eq(portalHandoffTokens.deliveryIdempotencyKeyHash, values.deliveryIdempotencyKeyHash!)
    ).limit(1).for("update");
    const token = stored[0];
    if (!token) throw new Error("Portal handoff token upsert succeeded but read-back failed");
    if (token.tokenHash !== values.tokenHash || token.workspaceId !== values.workspaceId ||
      token.facebookPageId !== values.facebookPageId ||
      token.messengerSenderUserKey !== values.messengerSenderUserKey || token.purpose !== values.purpose) {
      throw new Error("portal handoff delivery binding mismatch");
    }
    if (token.status === "consumed" || token.status === "expired" || token.expiresAt.getTime() <= now.getTime()) {
      throw new Error("portal handoff delivery is no longer active");
    }
    if (token.status === "revoked") {
      await tx.update(portalHandoffTokens).set({ status: "pending" }).where(and(
        eq(portalHandoffTokens.id, token.id), eq(portalHandoffTokens.status, "revoked")
      ));
      return { ...token, status: "pending" as const };
    }
    if (token.status !== "pending") throw new Error("portal handoff delivery is no longer active");
    return token;
  });
}

export async function getPortalHandoffTokenByHash(tokenHash: string) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("get_portal_handoff_token_by_hash");
    throw new Error("Database unavailable: portal handoff token was not loaded");
  }

  const result = await db
    .select()
    .from(portalHandoffTokens)
    .where(eq(portalHandoffTokens.tokenHash, tokenHash))
    .limit(1);

  return result[0] ?? null;
}

export async function markPortalHandoffTokenConsumed(tokenHash: string) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("mark_portal_handoff_token_consumed");
    throw new Error("Database unavailable: portal handoff token was not consumed");
  }

  const now = new Date();
  const result = await db
    .update(portalHandoffTokens)
    .set({
      status: "consumed",
      consumedAt: now,
    })
    .where(
      and(
        eq(portalHandoffTokens.tokenHash, tokenHash),
        eq(portalHandoffTokens.status, "pending")
      )
    );

  return getAffectedRows(result) > 0;
}

export type ClaimPortalHandoffTokenForUserResult =
  | {
      ok: true;
      workspace: Pick<Workspace, "id" | "name" | "slug" | "createdAt" | "updatedAt">;
      membership: WorkspaceMember;
      purpose: PortalHandoffToken["purpose"];
      messengerSenderUserKey: string | null;
    }
  | {
      ok: false;
      reason:
        | "invalid"
        | "expired"
        | "already_used"
        | "workspace_not_found"
        | "tenant_boundary";
    };

export async function claimPortalHandoffTokenForUser(input: {
  tokenHash: string;
  userId: number;
  role?: InsertWorkspaceMember["role"];
  now?: Date;
}): Promise<ClaimPortalHandoffTokenForUserResult> {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("claim_portal_handoff_token_for_user");
    throw new Error("Database unavailable: portal handoff token was not claimed");
  }

  const now = input.now ?? new Date();
  const role = input.role ?? "owner";

  return db.transaction(async tx => {
    const tokens = await tx
      .select()
      .from(portalHandoffTokens)
      .where(eq(portalHandoffTokens.tokenHash, input.tokenHash))
      .limit(1)
      .for("update");
    const stored = tokens[0];

    if (!stored) {
      return { ok: false, reason: "invalid" };
    }

    if (stored.status !== "pending") {
      return { ok: false, reason: "already_used" };
    }

    if (stored.expiresAt.getTime() <= now.getTime()) {
      return { ok: false, reason: "expired" };
    }

    const workspaceRows = await tx
      .select({
        id: workspaces.id,
        name: workspaces.name,
        slug: workspaces.slug,
        createdAt: workspaces.createdAt,
        updatedAt: workspaces.updatedAt,
      })
      .from(workspaces)
      .where(eq(workspaces.id, stored.workspaceId))
      .limit(1)
      .for("update");
    const workspace = workspaceRows[0];

    if (!workspace) {
      return { ok: false, reason: "workspace_not_found" };
    }

    if (!stored.facebookPageId) {
      return { ok: false, reason: "tenant_boundary" };
    }

    const connectedPages = await tx
      .select({ id: channelConnections.id })
      .from(channelConnections)
      .where(
        and(
          eq(channelConnections.workspaceId, stored.workspaceId),
          eq(channelConnections.channel, "facebook_messenger"),
          eq(channelConnections.status, "connected"),
          eq(channelConnections.externalId, stored.facebookPageId)
      )
      )
      .limit(2)
      .for("update");

    if (connectedPages.length !== 1) {
      return { ok: false, reason: "tenant_boundary" };
    }

    let priorClaim:
      | { minUserId: number | null; maxUserId: number | null }
      | undefined;
    if (stored.messengerSenderUserKey) {
      const priorClaims = await tx
        .select({
          minUserId: sql<number | null>`MIN(${portalHandoffTokens.claimedByUserId})`,
          maxUserId: sql<number | null>`MAX(${portalHandoffTokens.claimedByUserId})`,
        })
        .from(portalHandoffTokens)
        .where(
          and(
            eq(portalHandoffTokens.workspaceId, stored.workspaceId),
            eq(portalHandoffTokens.facebookPageId, stored.facebookPageId),
            eq(
              portalHandoffTokens.messengerSenderUserKey,
              stored.messengerSenderUserKey
            ),
            eq(portalHandoffTokens.status, "consumed"),
            isNotNull(portalHandoffTokens.claimedByUserId)
          )
        );
      priorClaim = priorClaims[0];
    }
    if (
      priorClaim?.minUserId != null &&
      priorClaim.maxUserId != null &&
      priorClaim.minUserId !== priorClaim.maxUserId
    ) {
      return { ok: false, reason: "invalid" };
    }
    const restrictedUserId = priorClaim?.minUserId ?? null;
    const isRestrictedReentry = restrictedUserId != null;
    if (isRestrictedReentry && restrictedUserId !== input.userId) {
      return { ok: false, reason: "invalid" };
    }

    let membership: WorkspaceMember | undefined;
    if (isRestrictedReentry) {
      const memberships = await tx
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, stored.workspaceId),
            eq(workspaceMembers.userId, input.userId)
          )
        )
        .limit(1)
        .for("update");
      membership = memberships[0];
      if (!membership) {
        return { ok: false, reason: "invalid" };
      }
    }

    const consumeResult = await tx
      .update(portalHandoffTokens)
      .set({
        status: "consumed",
        consumedAt: now,
        claimedByUserId: input.userId,
      })
      .where(
        and(
          eq(portalHandoffTokens.tokenHash, input.tokenHash),
          eq(portalHandoffTokens.status, "pending")
        )
      );

    if (getAffectedRows(consumeResult) === 0) {
      return { ok: false, reason: "already_used" };
    }

    if (!isRestrictedReentry) {
      const memberValues: InsertWorkspaceMember = {
        workspaceId: stored.workspaceId,
        userId: input.userId,
        role,
      };
      await tx.insert(workspaceMembers).values(memberValues).onDuplicateKeyUpdate({
        set: {
          // A handoff proves control of this one onboarding link; it must not
          // silently change privileges that were assigned through a separate
          // workspace-membership workflow. New claims receive the onboarding
          // role, while an existing member keeps their current role.
          workspaceId: stored.workspaceId,
        },
      });
    }

    const privacyDefaults: InsertWorkspacePrivacySetting = {
      workspaceId: stored.workspaceId,
      allowKnowledgeIndexing: DEFAULT_WORKSPACE_PRIVACY_SETTINGS.allowKnowledgeIndexing ? 1 : 0,
      allowUsageAnalytics: DEFAULT_WORKSPACE_PRIVACY_SETTINGS.allowUsageAnalytics ? 1 : 0,
      imageMemoryRetentionDays: DEFAULT_WORKSPACE_PRIVACY_SETTINGS.imageMemoryRetentionDays,
    };
    await tx.insert(workspacePrivacySettings).values(privacyDefaults).onDuplicateKeyUpdate({
      set: {
        workspaceId: stored.workspaceId,
      },
    });

    if (!membership) {
      const memberships = await tx
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, stored.workspaceId),
            eq(workspaceMembers.userId, input.userId)
          )
        )
        .limit(1);
      membership = memberships[0];
    }

    if (!membership) {
      throw new Error("Workspace membership insert succeeded but read-back failed");
    }

    await tx.insert(auditLog).values({
      workspaceId: stored.workspaceId,
      userId: input.userId,
      event: "portal_handoff.claimed",
      metadata: {
        purpose: stored.purpose,
        source: "messenger_handoff",
        hasMessengerSenderUserKey: Boolean(stored.messengerSenderUserKey),
        membershipRole: membership.role,
      },
    });

    return {
      ok: true,
      workspace,
      membership,
      purpose: stored.purpose,
      messengerSenderUserKey: stored.messengerSenderUserKey,
    };
  });
}

export type PortalHandoffReentryBinding = {
  workspaceId: number;
  userId: number;
};

export async function findUniqueConnectedFacebookWorkspaceId(
  facebookPageId: string
): Promise<number | null> {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("find_unique_connected_facebook_workspace");
    throw new Error("Database unavailable: Facebook workspace was not resolved");
  }

  const connections = await db
    .select({ workspaceId: channelConnections.workspaceId })
    .from(channelConnections)
    .where(
      and(
        eq(channelConnections.channel, "facebook_messenger"),
        eq(channelConnections.status, "connected"),
        eq(channelConnections.externalId, facebookPageId)
      )
    )
    .limit(2);

  return connections.length === 1 ? connections[0].workspaceId : null;
}

export async function findPortalHandoffReentryBinding(input: {
  facebookPageId: string;
  messengerSenderUserKey: string;
}): Promise<PortalHandoffReentryBinding | null> {
  const workspaceId = await findUniqueConnectedFacebookWorkspaceId(
    input.facebookPageId
  );
  if (!workspaceId) return null;

  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("find_portal_handoff_reentry_binding");
    throw new Error("Database unavailable: portal handoff binding was not resolved");
  }

  const claims = await db
    .select({ userId: portalHandoffTokens.claimedByUserId })
    .from(portalHandoffTokens)
    .where(
      and(
        eq(portalHandoffTokens.workspaceId, workspaceId),
        eq(portalHandoffTokens.facebookPageId, input.facebookPageId),
        eq(
          portalHandoffTokens.messengerSenderUserKey,
          input.messengerSenderUserKey
        ),
        eq(portalHandoffTokens.status, "consumed"),
        isNotNull(portalHandoffTokens.claimedByUserId)
      )
    )
    .orderBy(desc(portalHandoffTokens.consumedAt), desc(portalHandoffTokens.id))
    .limit(1);
  const userId = claims[0]?.userId;
  if (!userId) return null;

  const memberships = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      )
    )
    .limit(1);

  return memberships.length === 1 ? { workspaceId, userId } : null;
}

export async function revokePortalHandoffToken(tokenHash: string) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("revoke_portal_handoff_token");
    throw new Error("Database unavailable: portal handoff token was not revoked");
  }

  const result = await db
    .update(portalHandoffTokens)
    .set({
      status: "revoked",
    })
    .where(
      and(
        eq(portalHandoffTokens.tokenHash, tokenHash),
        eq(portalHandoffTokens.status, "pending")
      )
    );

  return getAffectedRows(result) > 0;
}

export async function deletePortalHandoffTokensForMessengerUserKey(
  messengerSenderUserKey: string
) {
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("delete_portal_handoff_tokens_for_messenger_user");
    if (process.env.NODE_ENV !== "production") {
      return 0;
    }
    throw new Error("Database unavailable: portal handoff tokens were not deleted");
  }

  const result = await db
    .delete(portalHandoffTokens)
    .where(eq(portalHandoffTokens.messengerSenderUserKey, messengerSenderUserKey));

  return getAffectedRows(result);
}

export class ChannelConnectionClaimConflictError extends Error {
  constructor() {
    super("Channel connection is already claimed by another workspace");
    this.name = "ChannelConnectionClaimConflictError";
  }
}

function normalizeChannelConnectionEndpoint(
  values: InsertChannelConnection
): Readonly<{
  externalId: string | null;
  providerAccountExternalId: string | null;
}> {
  if (values.status === "disconnected") {
    return Object.freeze({
      externalId: null,
      providerAccountExternalId: null,
    });
  }

  if (values.channel === "facebook_messenger") {
    if (
      values.providerAccountExternalId !== undefined &&
      values.providerAccountExternalId !== null
    ) {
      throw new ConversationIdentityError("invalid_input");
    }
    const endpoint = resolveMessengerEndpoint({ entryId: values.externalId });
    return Object.freeze({
      externalId: endpoint.pageId,
      providerAccountExternalId: null,
    });
  }

  if (values.channel === "whatsapp") {
    const endpoint = resolveWhatsAppEndpoint({
      wabaId: values.providerAccountExternalId,
      phoneNumberId: values.externalId,
    });
    return Object.freeze({
      externalId: endpoint.phoneNumberId,
      providerAccountExternalId: endpoint.wabaId,
    });
  }

  return Object.freeze({
    externalId: values.externalId?.trim() || null,
    providerAccountExternalId: null,
  });
}

function isDuplicateKeyError(error: unknown): boolean {
  return databaseErrorChainSome(
    error,
    record => record.code === "ER_DUP_ENTRY" || record.errno === 1062
  );
}

function isRetryableDatabaseLockError(error: unknown): boolean {
  return databaseErrorChainSome(
    error,
    record =>
      record.code === "ER_LOCK_DEADLOCK" ||
      record.code === "ER_LOCK_WAIT_TIMEOUT" ||
      record.errno === 1213 ||
      record.errno === 1205
  );
}

function databaseErrorChainSome(
  error: unknown,
  predicate: (record: Record<string, unknown>) => boolean
): boolean {
  const seen = new Set<object>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (predicate(record)) return true;
    current = record.cause;
  }
  return false;
}

/**
 * Claims a provider account for one workspace and then writes its credentials.
 *
 * The provider identity has a global unique key (`channel`, `externalId`). Never
 * use an unscoped duplicate-key update here: a collision may belong to another
 * workspace and must fail closed instead of replacing that tenant's token.
 */
export async function upsertChannelConnection(values: InsertChannelConnection) {
  const { externalId, providerAccountExternalId } =
    normalizeChannelConnectionEndpoint(values);
  const db = await getDb();
  if (!db) {
    logDatabaseUnavailable("upsert_channel_connection");
    throw new Error("Database unavailable: channel connection was not saved");
  }

  const lastCheckedAt = new Date();
  const updateSet = {
    status: values.status,
    externalId,
    providerAccountExternalId,
    displayName: values.displayName ?? null,
    encryptedAccessToken: values.encryptedAccessToken ?? null,
    grantedScopes: values.grantedScopes ?? null,
    lastCheckedAt,
  };

  const writeConnection = () =>
    db.transaction(async tx => {
      if (providerAccountExternalId) {
        const claimedProviderAccount = await tx
          .select({
            id: channelConnections.id,
            workspaceId: channelConnections.workspaceId,
          })
          .from(channelConnections)
          .where(
            and(
              eq(channelConnections.channel, values.channel),
              eq(
                channelConnections.providerAccountExternalId,
                providerAccountExternalId
              )
            )
          )
          .limit(1)
          .for("update");
        if (
          claimedProviderAccount[0] &&
          claimedProviderAccount[0].workspaceId !== values.workspaceId
        ) {
          throw new ChannelConnectionClaimConflictError();
        }
      }

      if (externalId) {
        const claimed = await tx
          .select({
            id: channelConnections.id,
            workspaceId: channelConnections.workspaceId,
          })
          .from(channelConnections)
          .where(
            and(
              eq(channelConnections.channel, values.channel),
              eq(channelConnections.externalId, externalId)
            )
          )
          .limit(1)
          .for("update");
        if (claimed[0] && claimed[0].workspaceId !== values.workspaceId) {
          throw new ChannelConnectionClaimConflictError();
        }
      }

      const existing = await tx
        .select({ id: channelConnections.id })
        .from(channelConnections)
        .where(
          and(
            eq(channelConnections.workspaceId, values.workspaceId),
            eq(channelConnections.channel, values.channel)
          )
        )
        .limit(1)
        .for("update");

      if (existing[0]) {
        await tx
          .update(channelConnections)
          .set(updateSet)
          .where(
            and(
              eq(channelConnections.id, existing[0].id),
              eq(channelConnections.workspaceId, values.workspaceId),
              eq(channelConnections.channel, values.channel)
            )
          );
        return;
      }

      await tx.insert(channelConnections).values({
        ...values,
        externalId,
        providerAccountExternalId,
        lastCheckedAt,
      });
    });

  const maxWriteAttempts = 3;
  for (let attempt = 1; attempt <= maxWriteAttempts; attempt += 1) {
    try {
      await writeConnection();
      break;
    } catch (error) {
      if (error instanceof ChannelConnectionClaimConflictError) throw error;
      const canRetry = attempt < maxWriteAttempts;
      if (
        canRetry &&
        (isRetryableDatabaseLockError(error) || isDuplicateKeyError(error))
      ) {
        const retryDelayMs = 10 * attempt + Math.floor(Math.random() * 15);
        await new Promise<void>(resolve => setTimeout(resolve, retryDelayMs));
        continue;
      }
      if (isDuplicateKeyError(error)) {
        throw new Error(
          "Channel connection update could not be completed after concurrent writes"
        );
      }
      throw error;
    }
  }

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
    providerAccountExternalId: null,
    displayName: null,
    encryptedAccessToken: null,
    grantedScopes: null,
    lastCheckedAt: new Date(),
  }).onDuplicateKeyUpdate({
    set: {
      status: "disconnected",
      externalId: null,
      providerAccountExternalId: null,
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
